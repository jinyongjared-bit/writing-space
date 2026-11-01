'use strict';

const FIXED_CATEGORIES = [
  { id: 'novel', name: '长篇小说', icon: '◈', color: '#6c6be8', description: '用分卷与章节组织一个完整的世界。' },
  { id: 'short', name: '短篇文章', icon: '◇', color: '#1677ff', description: '把一个完整的想法，写成一篇精炼的文章。' },
  { id: 'essay', name: '日常随笔', icon: '☼', color: '#e99a25', description: '记录此刻的生活、心情与思考。' },
  { id: 'inspiration', name: '灵感合集', icon: '✦', color: '#b56ac9', description: '收集片段、场景与闪现的想法，为下一次创作留下种子。' },
  { id: 'reading', name: '读书笔记', icon: '▤', color: '#29a36a', description: '摘录触动你的句子，也留下自己的回答。' }
];

const STATUS_LABELS = { draft: '草稿', writing: '写作中', done: '已完成' };
const DEFAULT_AI_REVIEW_PROMPT = `你是一名严谨、克制并尊重作者个人风格的中文编辑。请对文章进行专业审校，重点检查：

1. 错别字、漏字、多字、标点误用、搭配不当和明显语病。
2. 语句是否通顺，指代是否明确，时态、视角和语气是否一致。
3. 段落划分、衔接、信息顺序和阅读节奏是否合理。
4. 重复表达、含混表达、过度书面化或口语化之处。
5. 为能精确修改的问题给出可直接替换的文本；确定性不足时只给建议，不要勉强自动改写。
6. 不要为了“显得更好”而大幅改写，也不要抹去作者的文风。
7. 如果文章类型是长篇小说：额外梳理本章/片段的“事件—动机—冲突—转折—结果”链条，检查人物行为动机、时间线、空间关系、伏笔回收、信息前后矛盾和节奏问题。缺少上下文时明确标注“需结合前后章节确认”，不要自行补造设定。

优先找出确定性高、修改收益明显的问题；相同类别分别列出，以便作者按类别集中审核。`;
const AI_ISSUE_CATEGORY_LABELS = {
  typo: '错别字',
  grammar: '语病',
  punctuation: '标点',
  wording: '措辞',
  paragraph: '段落',
  consistency: '一致性',
  plot: '情节'
};
const AI_CONFIDENCE_LABELS = { high: '高置信度', medium: '中置信度', low: '低置信度' };
const appBridge = window.writingAPI || createBrowserWritingAPI();
const dom = {};
let store = createDefaultStore();
let activeView = { type: 'category', id: 'novel' };
let editingId = null;
let editorDraft = null;
let editorSnapshot = '';
let editorDirty = false;
let saveTimer = null;
let saveQueue = Promise.resolve();
let composing = false;
let previewFollowing = true;
let programmaticPreviewScroll = false;
let confirmResolver = null;
let undoStack = [];
let redoStack = [];
let lastEditorValue = '';
let exportMode = 'single';
let exportCandidates = [];
let aiConfigured = false;
let aiReviewRunning = false;
let editorSyncBasis = null;
let syncBusy = false;
let syncStatus = null;
let syncTimer = null;

function createDefaultStore() {
  return {
    schemaVersion: 1,
    customCategories: [],
    articles: [],
    preferences: {
      theme: 'system',
      dailyGoal: 1000,
      listMode: 'cards',
      editorLayout: 'split',
      editorWidth: 50,
      assistantOpen: true,
      assistantWidth: null,
      assistantTab: 'outline',
      aiReviewPrompt: DEFAULT_AI_REVIEW_PROMPT
    },
    dailyStats: {},
    updatedAt: new Date().toISOString()
  };
}

function createBrowserWritingAPI() {
  const storageKey = 'immersive-writing-browser-preview';
  return {
    platform: 'browser',
    isPreview: true,
    loadStore: async () => {
      try { return { success: true, data: JSON.parse(localStorage.getItem(storageKey) || 'null') }; }
      catch (error) { return { success: false, error: error.message }; }
    },
    saveStore: async (data) => {
      try { localStorage.setItem(storageKey, JSON.stringify(data)); return { success: true, savedAt: isoNow() }; }
      catch (error) { return { success: false, error: error.message }; }
    },
    importText: async () => ({ success: true, canceled: true, files: [] }),
    exportText: async () => ({ success: true, canceled: true }),
    exportArticles: async () => ({ success: true, canceled: true }),
    createBackup: async () => ({ success: true, canceled: true }),
    readBackup: async () => ({ success: true, canceled: true }),
    openDataFolder: async () => ({ success: true }),
    getAIConfig: async () => ({ success: true, configured: false, encryptionAvailable: false }),
    saveAIApiKey: async () => ({ success: false, error: '请在桌面版中配置 API Key' }),
    removeAIApiKey: async () => ({ success: true, configured: false }),
    reviewArticle: async () => ({ success: false, error: 'AI 校验请在桌面版中使用' }),
    minimize: async () => {}, maximizeToggle: async () => {}, closeWindow: async () => {}
  };
}

function byId(id) { return document.getElementById(id); }
function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function isoNow() { return new Date().toISOString(); }
function todayKey() { return new Date().toISOString().slice(0, 10); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(value) {
  const text = stripMarkdown(value);
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return chinese + latin;
}

function relativeTime(iso) {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function allCategories() { return [...FIXED_CATEGORIES, ...store.customCategories]; }
function categoryById(id) { return allCategories().find((category) => category.id === id) || FIXED_CATEGORIES[0]; }
function activeArticles() { return store.articles.filter((article) => !article.deletedAt); }
function trashedArticles() { return store.articles.filter((article) => article.deletedAt); }

function hydrateStore(value) {
  const defaults = createDefaultStore();
  return {
    ...defaults,
    ...value,
    preferences: { ...defaults.preferences, ...(value?.preferences || {}) },
    customCategories: Array.isArray(value?.customCategories) ? value.customCategories : [],
    articles: Array.isArray(value?.articles) ? value.articles.map((article) => ({
      ...article,
      tags: Array.isArray(article.tags) ? article.tags : [],
      annotations: Array.isArray(article.annotations) ? article.annotations : [],
      writingNotes: typeof article.writingNotes === 'string' ? article.writingNotes : '',
      meta: { ...(article.meta || {}), bookChapter: article.meta?.bookChapter || '' }
    })) : [],
    dailyStats: value?.dailyStats && typeof value.dailyStats === 'object' ? value.dailyStats : {}
  };
}

async function initialize() {
  cacheDom();
  bindEvents();
  document.body.classList.add(`platform-${appBridge.platform}`);
  const result = await appBridge.loadStore();
  if (result.success && result.data) store = hydrateStore(result.data);
  else if (!result.success) toast(`读取本地数据失败：${result.error}`, 'error');
  applyTheme();
  updateSettingsControls();
  renderAll();
  refreshAIConfig();
  initializeAutoSync();
}

function cacheDom() {
  [
    'category-list', 'page-kicker', 'page-title', 'page-description', 'search-input', 'status-filter', 'book-filter',
    'sort-select', 'article-list', 'empty-state', 'empty-title', 'empty-description', 'empty-action',
    'result-count', 'result-words', 'count-all', 'count-favorites', 'count-trash', 'today-words',
    'today-progress', 'today-goal-label', 'editor-overlay', 'editor-title-input', 'save-indicator',
    'favorite-button', 'editor-category', 'editor-status-field', 'editor-status', 'editor-tags', 'novel-meta', 'novel-work',
    'novel-kind', 'novel-volume', 'novel-work-options', 'novel-volume-options', 'reading-meta', 'book-title', 'book-title-options', 'book-chapter', 'editor-workspace', 'editor-body',
    'markdown-editor', 'markdown-preview', 'editor-splitter', 'word-count', 'character-count',
    'reading-time', 'last-saved-label', 'category-overlay', 'category-name-input',
    'category-description-input', 'settings-overlay', 'theme-select', 'daily-goal-input',
    'confirm-overlay', 'confirm-icon', 'confirm-title', 'confirm-message', 'confirm-actions', 'toast-region',
    'find-panel', 'find-input', 'replace-input', 'find-result', 'history-overlay', 'history-list',
    'export-overlay', 'export-dialog-title', 'export-description', 'export-select-all-label',
    'export-select-all', 'export-selected-count', 'export-article-list', 'export-format-select',
    'export-format-note', 'export-confirm-button', 'writing-assistant', 'assistant-keyword-input', 'keyword-chips',
    'outline-list', 'annotation-count', 'annotation-selection-hint', 'annotation-input',
    'add-annotation-button', 'annotation-list', 'writing-notes',
    'ai-config-banner', 'ai-config-state', 'ai-review-prompt', 'ai-review-meta', 'ai-review-result',
    'run-ai-review-button', 'copy-ai-review-button', 'deepseek-api-key-input', 'deepseek-api-key-status',
    'save-ai-key-button', 'remove-ai-key-button', 'ai-review-toolbar', 'ai-selected-count',
    'apply-selected-ai-issues-button'
  ].forEach((id) => { dom[id] = byId(id); });
}

function bindEvents() {
  byId('window-minimize').addEventListener('click', () => appBridge.minimize());
  byId('window-maximize').addEventListener('click', () => appBridge.maximizeToggle());
  byId('window-close').addEventListener('click', () => appBridge.closeWindow());
  byId('new-article-button').addEventListener('click', () => openEditor());
  byId('empty-action').addEventListener('click', () => openEditor());
  byId('import-button').addEventListener('click', importArticles);
  byId('export-view-button').addEventListener('click', () => openExportDialog('single'));
  byId('batch-export-button').addEventListener('click', () => openExportDialog('batch'));
  dom['export-select-all'].addEventListener('change', toggleAllExportCandidates);
  dom['export-format-select'].addEventListener('change', updateExportFormatNote);
  dom['export-confirm-button'].addEventListener('click', confirmArticleExport);
  byId('new-category-button').addEventListener('click', () => openOverlay('category-overlay'));
  byId('create-category-confirm').addEventListener('click', createCategory);
  byId('settings-button').addEventListener('click', openSettings);
  byId('use-session-ai-key-button').addEventListener('click', useSessionDeepSeekKey);
  byId('unlock-saved-ai-key-button').addEventListener('click', unlockSavedAIKey);
  byId('backup-button').addEventListener('click', createBackup);
  byId('restore-button').addEventListener('click', restoreBackup);
  byId('open-data-folder-button').addEventListener('click', openDataFolder);
  byId('sync-choose-folder').addEventListener('click', chooseSyncFolder);
  byId('sync-now').addEventListener('click', () => synchronizeWriting(true));
  byId('sync-toggle').addEventListener('click', toggleAutoSync);
  byId('sync-open-folder').addEventListener('click', () => appBridge.openSyncFolder?.());

  dom['search-input'].addEventListener('input', renderArticles);
  dom['status-filter'].addEventListener('change', renderArticles);
  dom['book-filter'].addEventListener('change', renderArticles);
  dom['sort-select'].addEventListener('change', () => { store.preferences.articleSort = dom['sort-select'].value; persistStore(); renderArticles(); });
  document.querySelectorAll('[data-list-mode]').forEach((button) => button.addEventListener('click', () => {
    store.preferences.listMode = button.dataset.listMode;
    document.querySelectorAll('[data-list-mode]').forEach((item) => item.classList.toggle('active', item === button));
    persistStore();
    renderArticles();
  }));

  document.querySelectorAll('.utility-nav [data-view]').forEach((button) => button.addEventListener('click', () => {
    activeView = { type: 'view', id: button.dataset.view };
    renderAll();
  }));

  document.querySelectorAll('[data-close-overlay]').forEach((button) => button.addEventListener('click', () => closeOverlay(button.dataset.closeOverlay)));
  document.querySelectorAll('.overlay').forEach((overlay) => overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) event.preventDefault();
  }));

  byId('editor-close').addEventListener('click', requestCloseEditor);
  byId('editor-maximize').addEventListener('click', toggleEditorMaximize);
  byId('favorite-button').addEventListener('click', () => {
    if (!editorDraft) return;
    editorDraft.favorite = !editorDraft.favorite;
    updateFavoriteButton();
    markEditorDirty();
    toast(editorDraft.favorite ? '已加入收藏' : '已取消收藏');
  });
  byId('manual-save-button').addEventListener('click', async () => {
    if (await commitDraft({ manual: true })) toast('当前内容已保存');
  });
  byId('export-button').addEventListener('click', exportCurrentArticle);
  byId('undo-button').addEventListener('click', undoEditor);
  byId('redo-button').addEventListener('click', redoEditor);
  byId('find-button').addEventListener('click', openFindPanel);
  byId('find-close').addEventListener('click', closeFindPanel);
  byId('find-next').addEventListener('click', () => findText(1));
  byId('find-previous').addEventListener('click', () => findText(-1));
  byId('replace-current').addEventListener('click', replaceCurrentMatch);
  byId('replace-all').addEventListener('click', replaceAllMatches);
  byId('history-button').addEventListener('click', openHistory);
  byId('follow-toggle').addEventListener('click', () => setPreviewFollowing(!previewFollowing, true));
  byId('assistant-toggle').addEventListener('click', () => setAssistantOpen(dom['editor-workspace'].classList.contains('assistant-hidden')));
  byId('assistant-close').addEventListener('click', () => setAssistantOpen(false));
  document.querySelectorAll('[data-assistant-tab]').forEach((button) => button.addEventListener('click', () => setAssistantTab(button.dataset.assistantTab)));
  byId('add-keyword-button').addEventListener('click', addKeywordFromAssistant);
  dom['assistant-keyword-input'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === '，' || event.key === ',') {
      event.preventDefault();
      addKeywordFromAssistant();
    }
  });
  dom['annotation-input'].addEventListener('input', updateAnnotationComposer);
  dom['add-annotation-button'].addEventListener('click', addAnnotation);
  dom['writing-notes'].addEventListener('input', () => {
    if (!editorDraft) return;
    editorDraft.writingNotes = dom['writing-notes'].value;
    markEditorDirty();
  });
  byId('ai-open-settings').addEventListener('click', openSettings);
  byId('save-ai-prompt-button').addEventListener('click', saveAIReviewPrompt);
  byId('reset-ai-prompt-button').addEventListener('click', resetAIReviewPrompt);
  dom['run-ai-review-button'].addEventListener('click', runAIReview);
  dom['copy-ai-review-button'].addEventListener('click', copyAIReview);
  dom['apply-selected-ai-issues-button'].addEventListener('click', () => applyAIReviewIssues(selectedAIReviewIssueIds()));
  dom['save-ai-key-button'].addEventListener('click', saveDeepSeekApiKey);
  dom['remove-ai-key-button'].addEventListener('click', removeDeepSeekApiKey);
  dom['deepseek-api-key-input'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); useSessionDeepSeekKey(); }
  });

  document.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => setEditorLayout(button.dataset.layout)));
  document.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => applyFormat(button.dataset.format)));

  dom['editor-title-input'].addEventListener('input', () => { if (editorDraft) { editorDraft.title = dom['editor-title-input'].value; if (editorDraft.aiReview) updateAIReviewMeta(); markEditorDirty(); } });
  dom['editor-category'].addEventListener('change', () => { if (editorDraft) { editorDraft.category = dom['editor-category'].value; updateCategoryMeta(); if (editorDraft.aiReview) updateAIReviewMeta(); markEditorDirty(); } });
  dom['editor-status'].addEventListener('change', () => { if (editorDraft) { editorDraft.status = dom['editor-status'].value; markEditorDirty(); } });
  dom['editor-tags'].addEventListener('input', () => {
    if (!editorDraft) return;
    editorDraft.tags = parseTags(dom['editor-tags'].value);
    renderKeywords();
    markEditorDirty();
  });
  ['novel-kind', 'novel-work', 'novel-volume', 'book-title', 'book-chapter'].forEach((id) => {
    dom[id].addEventListener('input', updateDraftMeta);
    dom[id].addEventListener('change', updateDraftMeta);
  });

  dom['markdown-editor'].addEventListener('compositionstart', () => { composing = true; });
  dom['markdown-editor'].addEventListener('compositionend', () => {
    composing = false;
    captureUserEditForUndo();
    updateContentFromEditor();
  });
  dom['markdown-editor'].addEventListener('input', () => {
    if (!composing) { captureUserEditForUndo(); updateContentFromEditor(); }
  });
  dom['markdown-editor'].addEventListener('keydown', handleEditorKeydown);
  ['select', 'click', 'keyup'].forEach((eventName) => dom['markdown-editor'].addEventListener(eventName, updateAnnotationComposer));
  dom['find-input'].addEventListener('input', updateFindResult);
  dom['find-input'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); findText(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') closeFindPanel();
  });

  dom['markdown-preview'].addEventListener('scroll', () => {
    if (programmaticPreviewScroll) return;
    const distance = dom['markdown-preview'].scrollHeight - dom['markdown-preview'].scrollTop - dom['markdown-preview'].clientHeight;
    setPreviewFollowing(distance < 36, false);
  }, { passive: true });

  bindSplitter();
  bindAssistantResizer();
  dom['theme-select'].addEventListener('change', () => {
    store.preferences.theme = dom['theme-select'].value;
    applyTheme();
    persistStore();
  });
  dom['daily-goal-input'].addEventListener('change', () => {
    store.preferences.dailyGoal = Math.max(100, Number(dom['daily-goal-input'].value) || 1000);
    renderStats();
    persistStore();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('keydown', handleGlobalKeydown);
}

function renderAll() {
  renderCategories();
  renderHeader();
  renderArticles();
  renderStats();
  updateSettingsControls();
}

function renderCategories() {
  dom['category-list'].replaceChildren();
  for (const category of allCategories()) {
    const button = document.createElement('button');
    button.className = `nav-item ${activeView.type === 'category' && activeView.id === category.id ? 'active' : ''}`;
    const count = activeArticles().filter((article) => article.category === category.id).length;
    const symbol = FIXED_CATEGORIES.some((fixed) => fixed.id === category.id)
      ? `<span class="nav-icon">${escapeHtml(category.icon)}</span>`
      : `<span class="category-color" style="color:${escapeHtml(category.color)};background:${escapeHtml(category.color)}"></span>`;
    button.innerHTML = `${symbol}<span>${escapeHtml(category.name)}</span><b>${count}</b>`;
    button.addEventListener('click', () => {
      activeView = { type: 'category', id: category.id };
      renderAll();
    });
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      if (FIXED_CATEGORIES.some((fixed) => fixed.id === category.id)) return;
      const choice = await confirmDialog({
        title: `管理“${category.name}”`,
        message: '删除分类不会删除其中的文章，文章会移动到“日常随笔”。',
        icon: '⋯',
        actions: [
          { value: 'cancel', label: '取消', style: 'secondary' },
          { value: 'delete', label: '删除分类', style: 'danger' }
        ]
      });
      if (choice === 'delete') deleteCustomCategory(category.id);
    });
    dom['category-list'].appendChild(button);
  }
  document.querySelectorAll('.utility-nav .nav-item').forEach((button) => {
    button.classList.toggle('active', activeView.type === 'view' && activeView.id === button.dataset.view);
  });
}

function renderHeader() {
  const header = getViewHeader();
  dom['page-kicker'].textContent = header.kicker;
  dom['page-title'].textContent = header.title;
  dom['page-description'].textContent = header.description;
  const trash = activeView.type === 'view' && activeView.id === 'trash';
  byId('new-article-button').style.display = trash ? 'none' : '';
  byId('import-button').style.display = trash ? 'none' : '';
  byId('export-view-button').style.display = trash ? 'none' : '';
  byId('batch-export-button').style.display = trash ? 'none' : '';
  const actionLabels = { novel: '新建章节', short: '新建文章', essay: '新建随笔', reading: '新建笔记', inspiration: '记录灵感' };
  const actionLabel = activeView.type === 'category' ? (actionLabels[activeView.id] || '新建内容') : '新建内容';
  byId('new-article-button').innerHTML = `<span>＋</span> ${actionLabel}`;
  byId('empty-action').textContent = actionLabel;
  renderBookFilter();
}

function isReadingCategoryView() {
  return activeView.type === 'category' && activeView.id === 'reading';
}

function isNovelCategoryView() {
  return activeView.type === 'category' && activeView.id === 'novel';
}

function getKnownNovelNames(field, workTitle = null) {
  return [...new Set(activeArticles()
    .filter((article) => article.category === 'novel' &&
      (workTitle === null || String(article.meta?.workTitle || '').trim() === workTitle))
    .map((article) => String(article.meta?.[field] || '').trim())
    .filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

function renderNovelNameOptions() {
  for (const [id, names] of [
    ['novel-work-options', getKnownNovelNames('workTitle')],
    ['novel-volume-options', getKnownNovelNames('volume', dom['novel-work'].value.trim())]
  ]) {
    dom[id].replaceChildren(...names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    }));
  }
}

const bookFilterSelections = { reading: 'all', novel: 'all' };

function getKnownBookTitles() {
  return [...new Set(activeArticles()
    .filter((article) => article.category === 'reading')
    .map((article) => String(article.meta?.bookTitle || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderBookTitleOptions() {
  if (!dom['book-title-options']) return;
  dom['book-title-options'].replaceChildren();
  for (const title of getKnownBookTitles()) {
    const option = document.createElement('option');
    option.value = title;
    dom['book-title-options'].appendChild(option);
  }
}

function renderBookFilter() {
  const readingView = isReadingCategoryView();
  dom['status-filter'].hidden = readingView;
  const novelView = isNovelCategoryView();
  dom['book-filter'].hidden = !readingView && !novelView;
  dom['sort-select'].hidden = novelView;
  if (store.preferences.articleSort) dom['sort-select'].value = store.preferences.articleSort;
  dom['search-input'].placeholder = readingView ? '搜索书名、章节、标题或正文' : novelView ? '搜索书名、卷名、标题或正文' : '搜索标题、正文或标签';
  const previousCategory = dom['book-filter'].dataset.category;
  if (previousCategory) bookFilterSelections[previousCategory] = dom['book-filter'].value || 'all';
  if (!readingView && !novelView) return;

  const category = novelView ? 'novel' : 'reading';
  const field = novelView ? 'workTitle' : 'bookTitle';
  const previousValue = bookFilterSelections[category];
  dom['book-filter'].dataset.category = category;
  const titles = novelView ? getKnownNovelNames('workTitle') : getKnownBookTitles();
  const hasUntitled = activeArticles().some((article) => article.category === category && !String(article.meta?.[field] || '').trim());

  dom['book-filter'].replaceChildren();
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = '全部书名';
  dom['book-filter'].appendChild(allOption);
  for (const title of titles) {
    const option = document.createElement('option');
    option.value = title;
    option.textContent = `《${title}》`;
    dom['book-filter'].appendChild(option);
  }
  if (hasUntitled) {
    const option = document.createElement('option');
    option.value = '__untitled__';
    option.textContent = '未填写书名';
    dom['book-filter'].appendChild(option);
  }
  const availableValues = new Set([...dom['book-filter'].options].map((option) => option.value));
  dom['book-filter'].value = availableValues.has(previousValue) ? previousValue : 'all';
}

function getViewHeader() {
  if (activeView.type === 'category') {
    const category = categoryById(activeView.id);
    return { kicker: '写作分类', title: category.name, description: category.description || '属于你的独立写作空间。' };
  }
  return {
    all: { kicker: 'LIBRARY', title: '全部文章', description: '浏览所有分类中的文字。' },
    recent: { kicker: 'RECENT', title: '最近编辑', description: '继续刚才没有写完的内容。' },
    favorites: { kicker: 'FAVORITES', title: '我的收藏', description: '集中查看最重要的文字。' },
    trash: { kicker: 'TRASH', title: '回收站', description: '删除的内容会保留在这里，直到永久清除。' }
  }[activeView.id];
}

function getVisibleArticles() {
  let articles = activeView.type === 'view' && activeView.id === 'trash' ? trashedArticles() : activeArticles();
  if (activeView.type === 'category') articles = articles.filter((article) => article.category === activeView.id);
  if (activeView.id === 'favorites') articles = articles.filter((article) => article.favorite);
  if (activeView.id === 'recent') articles = articles.filter((article) => Date.now() - new Date(article.updatedAt).getTime() < 30 * 86400000);
  const query = dom['search-input'].value.trim().toLowerCase();
  if (query) {
    articles = articles.filter((article) => [article.title, article.content, ...(article.tags || []), article.meta?.workTitle, article.meta?.volume, article.meta?.bookTitle, article.meta?.bookChapter]
      .filter(Boolean).join(' ').toLowerCase().includes(query));
  }
  if (isReadingCategoryView() || isNovelCategoryView()) {
    const book = dom['book-filter'].value;
    const field = isNovelCategoryView() ? 'workTitle' : 'bookTitle';
    if (book === '__untitled__') articles = articles.filter((article) => !String(article.meta?.[field] || '').trim());
    else if (book && book !== 'all') articles = articles.filter((article) => String(article.meta?.[field] || '').trim() === book);
  }
  if (!isReadingCategoryView()) {
    const status = dom['status-filter'].value;
    if (status !== 'all') articles = articles.filter((article) => article.category !== 'reading' && article.status === status);
  }
  const sort = isNovelCategoryView() ? 'manual' : dom['sort-select'].value;
  return [...articles].sort((a, b) => {
    if (sort === 'manual') return compareArticleOrder(a, b);
    if (sort === 'created-desc') return new Date(b.createdAt) - new Date(a.createdAt);
    if (sort === 'title-asc') return String(a.title).localeCompare(String(b.title), 'zh-CN');
    if (sort === 'words-desc') return (b.wordCount || 0) - (a.wordCount || 0);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}

function renderArticles() {
  const articles = getVisibleArticles();
  dom['article-list'].replaceChildren();
  const novelView = isNovelCategoryView();
  dom['article-list'].classList.toggle('novel-library', novelView);
  dom['article-list'].classList.toggle('rows', !novelView && store.preferences.listMode === 'rows');
  document.querySelectorAll('[data-list-mode]').forEach((button) => button.classList.toggle('active', button.dataset.listMode === store.preferences.listMode));
  if (novelView) renderNovelLibrary(articles);
  else for (const article of articles) dom['article-list'].appendChild(createArticleCard(article));
  dom['empty-state'].classList.toggle('hidden', articles.length > 0 || novelView);
  const trash = activeView.type === 'view' && activeView.id === 'trash';
  dom['empty-title'].textContent = trash ? '回收站是空的' : '还没有内容';
  dom['empty-description'].textContent = trash ? '被删除的文章会暂时保存在这里。' : '写下第一句话，让想法有一个安放的地方。';
  byId('empty-action').style.display = trash ? 'none' : '';
  const totalWords = articles.reduce((total, article) => total + Number(article.wordCount || 0), 0);
  dom['result-count'].textContent = `${articles.length} 篇内容`;
  dom['result-words'].textContent = `共 ${totalWords.toLocaleString('zh-CN')} 字`;
  byId('export-view-button').disabled = articles.length === 0 || trash;
  byId('batch-export-button').disabled = articles.length === 0 || trash;
}

let draggedArticleId = null;
const ARTICLE_DRAG_TYPE = 'application/x-writing-space-article';

function articleOrderValue(article) {
  return typeof article.manualOrder === 'number' && Number.isFinite(article.manualOrder)
    ? article.manualOrder : -(new Date(article.createdAt || article.updatedAt).getTime() || 0);
}
function compareArticleOrder(a, b) {
  return articleOrderValue(a) - articleOrderValue(b) || String(a.id).localeCompare(String(b.id));
}
function clearArticleDropHints() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-zone-active').forEach((node) => {
    node.classList.remove('drop-before', 'drop-after', 'drop-zone-active');
  });
}
function acceptsArticleDrop(target) {
  const article = activeArticles().find((a) => a.id === draggedArticleId);
  if (!article || (activeView.type === 'view' && activeView.id === 'trash')) return false;
  const panel = target.closest('.novel-panel');
  return !panel || (article.category === 'novel' && String(article.meta?.workTitle || '').trim() === panel.dataset.book);
}
function dropAfterCard(event, card) {
  const rect = card.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2;
}
function bindArticleDrag(card, article) {
  card.addEventListener('dragstart', (event) => {
    if (event.target.closest('button')) { event.preventDefault(); return; }
    draggedArticleId = article.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(ARTICLE_DRAG_TYPE, article.id);
    card.classList.add('card-dragging');
  });
  card.addEventListener('dragend', () => {
    draggedArticleId = null;
    card.classList.remove('card-dragging');
    clearArticleDropHints();
  });
  bindArticleDropTarget(card);
}
function bindArticleDropTarget(target) {
  target.addEventListener('dragover', (event) => {
    if (!acceptsArticleDrop(target)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    clearArticleDropHints();
    if (target.matches('.article-card')) {
      if (target.dataset.articleId !== draggedArticleId) target.classList.add(dropAfterCard(event, target) ? 'drop-after' : 'drop-before');
    } else target.classList.add('drop-zone-active');
  });
  target.addEventListener('dragleave', (event) => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('drop-before', 'drop-after', 'drop-zone-active');
  });
  target.addEventListener('drop', async (event) => {
    if (!acceptsArticleDrop(target) || event.dataTransfer.getData(ARTICLE_DRAG_TYPE) !== draggedArticleId) return;
    event.preventDefault(); event.stopPropagation();
    const id = draggedArticleId;
    const anchorId = target.matches('.article-card') ? target.dataset.articleId : null;
    const after = anchorId ? dropAfterCard(event, target) : true;
    const panel = target.closest('.novel-panel');
    clearArticleDropHints(); draggedArticleId = null;
    if (anchorId === id) return;
    await moveArticleCard(id, { anchorId, after, kind: panel?.dataset.kind, book: panel?.dataset.book });
  });
}
async function moveArticleCard(id, { anchorId = null, after = true, kind, book } = {}) {
  const article = activeArticles().find((a) => a.id === id);
  if (!article) return;
  let candidates;
  if (kind) {
    if (article.category !== 'novel' || String(article.meta?.workTitle || '').trim() !== book) return;
    candidates = activeArticles().filter((a) => a.category === 'novel' &&
      String(a.meta?.workTitle || '').trim() === book && novelContentKind(a) === kind && a.id !== id).sort(compareArticleOrder);
  } else candidates = getVisibleArticles().filter((a) => a.id !== id);
  const anchorIndex = anchorId ? candidates.findIndex((a) => a.id === anchorId) : candidates.length;
  if (anchorId && anchorIndex < 0) return;
  candidates.splice(anchorId ? anchorIndex + (after ? 1 : 0) : candidates.length, 0, article);
  if (kind) article.meta = { ...(article.meta || {}), novelKind: kind };
  const now = isoNow();
  for (const [index, item] of candidates.entries()) {
    const order = index * 1024;
    if (item.manualOrder !== order || item.id === id) { item.manualOrder = order; item.updatedAt = now; }
  }
  if (!isNovelCategoryView()) {
    store.preferences.articleSort = 'manual';
    dom['sort-select'].value = 'manual';
  }
  renderAll();
  const saved = await persistStore();
  if (saved) renderAll();
}

function novelContentKind(article) {
  return article.meta?.novelKind === 'material' ? 'material' : 'body';
}

function renderNovelLibrary(articles) {
  const books = new Map();
  for (const article of articles) {
    const title = String(article.meta?.workTitle || '').trim();
    if (!books.has(title)) books.set(title, []);
    books.get(title).push(article);
  }
  // Keep both columns available even when this book has no matching articles.
  if (!books.size) {
    const selected = dom['book-filter'].value;
    books.set(selected && selected !== 'all' && selected !== '__untitled__' ? selected : '', []);
  }
  for (const [title, entries] of books) {
    const group = document.createElement('section');
    group.className = 'novel-book-group';
    const heading = document.createElement('h2');
    heading.className = 'novel-book-title';
    heading.textContent = title ? `《${title}》` : '未填写书名';
    group.appendChild(heading);
    const columns = document.createElement('div');
    columns.className = 'novel-columns';
    for (const [kind, label, hint] of [
      ['body', '正文', '章节、故事与情节'],
      ['material', '素材', '独立大纲、人物设计与世界设定']
    ]) {
      const entriesOfKind = entries.filter((article) => novelContentKind(article) === kind);
      const panel = document.createElement('section');
      panel.className = 'novel-panel';
      panel.dataset.kind = kind;
      panel.dataset.book = title;
      bindArticleDropTarget(panel);
      panel.setAttribute('aria-label', `${title || '未填写书名'} · ${label}`);
      const header = document.createElement('header');
      header.className = 'novel-panel-header';
      header.innerHTML = `<div><h3>${label} <span>${entriesOfKind.length}</span></h3><p>${hint}</p></div>`;
      const add = document.createElement('button');
      add.className = 'button secondary';
      add.textContent = kind === 'body' ? '＋ 新建正文' : '＋ 新建素材';
      add.addEventListener('click', () => openEditor(null, { novelKind: kind, workTitle: title }));
      header.appendChild(add);
      panel.appendChild(header);
      const list = document.createElement('div');
      list.className = `novel-panel-list ${store.preferences.listMode === 'rows' ? 'compact' : ''}`;
      for (const article of entriesOfKind) list.appendChild(createArticleCard(article));
      if (!entriesOfKind.length) {
        const empty = document.createElement('p');
        empty.className = 'novel-panel-empty';
        empty.textContent = kind === 'body' ? '暂无正文，可新建章节开始写作。' : '暂无素材，可记录大纲、人物或设定。';
        list.appendChild(empty);
      }
      panel.appendChild(list);
      columns.appendChild(panel);
    }
    group.appendChild(columns);
    dom['article-list'].appendChild(group);
  }
}

function createArticleCard(article) {
  const category = categoryById(article.category);
  const card = document.createElement('article');
  card.className = `article-card ${article.category === 'reading' ? 'reading-card' : ''}`;
  card.tabIndex = 0;
  card.dataset.articleId = article.id;
  card.draggable = !article.deletedAt;
  if (!article.deletedAt) bindArticleDrag(card, article);
  const preview = stripMarkdown(article.content).slice(0, 150) || '还没有正文内容';
  const tags = (article.tags || []).slice(0, 3).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('');
  const readingMeta = article.category === 'reading'
    ? [article.meta?.bookTitle ? `《${article.meta.bookTitle}》` : '未填写书名', article.meta?.bookChapter].filter(Boolean).map(escapeHtml).join(' · ')
    : '';
  const statusBadge = article.category === 'reading' ? '' : `<span class="status-badge">${escapeHtml(STATUS_LABELS[article.status] || '草稿')}</span>`;
  card.innerHTML = `
    <div class="card-top">
      <span class="type-badge" style="color:${escapeHtml(category.color)};background:${escapeHtml(category.color)}18">${escapeHtml(article.category === 'novel' ? (novelContentKind(article) === 'material' ? '小说素材' : '小说正文') : category.name)}</span>
      ${statusBadge}
      <div class="card-actions">
        ${article.deletedAt ? '' : `<button class="card-favorite ${article.favorite ? 'is-favorite' : ''}" title="${article.favorite ? '取消收藏' : '收藏文章'}" aria-label="${article.favorite ? '取消收藏' : '收藏文章'}" aria-pressed="${Boolean(article.favorite)}">${article.favorite ? '★' : '☆'}</button>`}
        <button class="card-menu" title="更多操作" aria-label="更多操作"><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><circle cx="4" cy="9" r="1.5"/><circle cx="9" cy="9" r="1.5"/><circle cx="14" cy="9" r="1.5"/></svg></button>
      </div>
    </div>
    <h3>${article.favorite ? '<span class="favorite-mark">★</span> ' : ''}${escapeHtml(article.title || '未命名文章')}</h3>
    <p>${escapeHtml(preview)}</p>
    ${readingMeta ? `<div class="reading-book-meta">${readingMeta}</div>` : ''}
    <div class="card-tags">${tags}</div>
    <div class="card-footer"><span>${Number(article.wordCount || 0).toLocaleString('zh-CN')} 字</span><span>${relativeTime(article.updatedAt)}</span></div>`;
  const open = () => {
    if (article.deletedAt) showTrashActions(article);
    else openEditor(article.id);
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => { if (event.target === card && event.key === 'Enter') open(); });
  card.querySelector('.card-favorite')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const current = store.articles.find((a) => a.id === article.id && !a.deletedAt);
    if (!current) return;
    current.favorite = !current.favorite;
    current.updatedAt = isoNow();
    renderAll();
    const saved = await persistStore();
    if (saved) { renderAll(); toast(current.favorite ? '已加入收藏' : '已取消收藏'); }
  });
  card.querySelector('.card-menu').addEventListener('click', (event) => {
    event.stopPropagation();
    article.deletedAt ? showTrashActions(article) : showArticleActions(article);
  });
  return card;
}

async function showArticleActions(article) {
  const action = await confirmDialog({
    title: article.title || '未命名文章', message: '请选择要进行的操作。', icon: '•••',
    actions: [
      { value: 'cancel', label: '取消', style: 'secondary' },
      { value: 'export', label: '导出', style: 'secondary' },
      { value: 'duplicate', label: '创建副本', style: 'secondary' },
      { value: 'delete', label: '移入回收站', style: 'danger' },
      { value: 'edit', label: '继续写作', style: 'primary' }
    ]
  });
  if (action === 'edit') openEditor(article.id);
  if (action === 'export') openExportDialog('single', [article]);
  if (action === 'duplicate') duplicateArticle(article);
  if (action === 'delete') moveToTrash(article.id);
}

async function showTrashActions(article) {
  const action = await confirmDialog({
    title: article.title || '未命名文章', message: '可以恢复文章，或将其永久删除。永久删除后无法找回。', icon: '♲',
    actions: [
      { value: 'cancel', label: '取消', style: 'secondary' },
      { value: 'delete', label: '永久删除', style: 'danger' },
      { value: 'restore', label: '恢复文章', style: 'primary' }
    ]
  });
  if (action === 'restore') {
    article.deletedAt = null; article.updatedAt = isoNow(); await persistStore(); renderAll(); toast('文章已恢复');
  }
  if (action === 'delete') {
    const confirm = await confirmDialog({ title: '永久删除？', message: '此操作无法撤销，文章及其历史版本都会被清除。', actions: [{ value: 'cancel', label: '取消', style: 'secondary' }, { value: 'yes', label: '永久删除', style: 'danger' }] });
    if (confirm === 'yes') { store.articles = store.articles.filter((item) => item.id !== article.id); await persistStore(); renderAll(); toast('文章已永久删除'); }
  }
}

function duplicateArticle(article) {
  const copy = deepClone(article);
  copy.id = uid();
  copy.title = `${article.title || '未命名文章'} - 副本`;
  copy.createdAt = copy.updatedAt = isoNow();
  copy.favorite = false;
  copy.deletedAt = null;
  store.articles.push(copy);
  persistStore(); renderAll(); toast('已创建文章副本');
}

async function moveToTrash(id) {
  const article = store.articles.find((item) => item.id === id);
  if (!article) return;
  article.deletedAt = isoNow(); article.updatedAt = isoNow();
  await persistStore(); renderAll(); toast('文章已移入回收站');
}

function renderStats() {
  const articles = activeArticles();
  dom['count-all'].textContent = articles.length;
  dom['count-favorites'].textContent = articles.filter((article) => article.favorite).length;
  dom['count-trash'].textContent = trashedArticles().length;
  const todayWords = Number(store.dailyStats[todayKey()] || 0);
  const goal = Number(store.preferences.dailyGoal || 1000);
  dom['today-words'].textContent = todayWords.toLocaleString('zh-CN');
  dom['today-progress'].style.width = `${Math.min(100, todayWords / goal * 100)}%`;
  dom['today-goal-label'].textContent = `目标 ${goal.toLocaleString('zh-CN')} 字`;
}

function createBlankArticle(options = {}) {
  const category = activeView.type === 'category' ? activeView.id : 'essay';
  const now = isoNow();
  const meta = { workTitle: '', volume: '', bookTitle: '', bookChapter: '' };
  if (category === 'novel') meta.novelKind = options.novelKind === 'material' ? 'material' : 'body';
  if ((category === 'reading' || category === 'novel') && dom['book-filter']) {
    const selectedBook = dom['book-filter'].value;
    if (selectedBook && selectedBook !== 'all' && selectedBook !== '__untitled__') {
      meta[category === 'novel' ? 'workTitle' : 'bookTitle'] = selectedBook;
    }
  }
  if (category === 'novel' && options.workTitle !== undefined) meta.workTitle = options.workTitle;
  return {
    id: uid(), category, title: '', content: '', tags: [], status: 'draft', favorite: false,
    createdAt: now, updatedAt: now, deletedAt: null, wordCount: 0, lastCountedWords: 0,
    meta,
    annotations: [],
    writingNotes: '',
    versions: []
  };
}

function openEditor(id = null, options = {}) {
  const existing = id ? store.articles.find((article) => article.id === id && !article.deletedAt) : null;
  editorDraft = deepClone(existing || createBlankArticle(options));
  editingId = editorDraft.id;
  editorSyncBasis = getArticleSyncBasis(editingId);
  editorSnapshot = JSON.stringify(editorDraft);
  editorDirty = false;
  clearTimeout(saveTimer);
  populateEditor();
  openOverlay('editor-overlay');
  requestAnimationFrame(() => { applyAssistantWidth(); dom['editor-title-input'].focus(); });
}

function populateEditor() {
  dom['editor-title-input'].value = editorDraft.title || '';
  dom['editor-category'].replaceChildren();
  for (const category of allCategories()) {
    const option = document.createElement('option'); option.value = category.id; option.textContent = category.name; dom['editor-category'].appendChild(option);
  }
  dom['editor-category'].value = editorDraft.category;
  dom['editor-status'].value = editorDraft.status || 'draft';
  dom['editor-tags'].value = (editorDraft.tags || []).join(', ');
  dom['novel-kind'].value = novelContentKind(editorDraft);
  dom['novel-work'].value = editorDraft.meta?.workTitle || '';
  dom['novel-volume'].value = editorDraft.meta?.volume || '';
  renderBookTitleOptions();
  renderNovelNameOptions();
  dom['book-title'].value = editorDraft.meta?.bookTitle || '';
  dom['book-chapter'].value = editorDraft.meta?.bookChapter || '';
  dom['markdown-editor'].value = editorDraft.content || '';
  dom['writing-notes'].value = editorDraft.writingNotes || '';
  dom['ai-review-prompt'].value = store.preferences.aiReviewPrompt || DEFAULT_AI_REVIEW_PROMPT;
  dom['annotation-input'].value = '';
  dom['assistant-keyword-input'].value = '';
  lastEditorValue = dom['markdown-editor'].value;
  undoStack = [];
  redoStack = [];
  updateUndoButtons();
  updateCategoryMeta(); updateFavoriteButton(); updatePreview(); updateEditorStats();
  renderKeywords(); renderOutline(); renderAnnotations(); renderAIReview(); updateAnnotationComposer();
  setEditorLayout(store.preferences.editorLayout || 'split', false);
  setAssistantOpen(store.preferences.assistantOpen !== false, false);
  setAssistantTab(store.preferences.assistantTab || 'outline', false);
  dom['editor-body'].style.setProperty('--editor-width', `${store.preferences.editorWidth || 50}%`);
  setPreviewFollowing(true, false);
  closeFindPanel();
  setSaveIndicator('saved');
}

function updateCategoryMeta() {
  const category = dom['editor-category'].value;
  dom['novel-meta'].classList.toggle('show', category === 'novel');
  dom['reading-meta'].classList.toggle('show', category === 'reading');
  dom['editor-status-field'].hidden = category === 'reading';
}

function updateDraftMeta() {
  if (!editorDraft) return;
  editorDraft.meta = {
    ...(editorDraft.meta || {}),
    novelKind: dom['novel-kind'].value,
    workTitle: dom['novel-work'].value,
    volume: dom['novel-volume'].value,
    bookTitle: dom['book-title'].value,
    bookChapter: dom['book-chapter'].value
  };
  renderNovelNameOptions();
  if (editorDraft.aiReview) updateAIReviewMeta();
  markEditorDirty();
}

function updateFavoriteButton() {
  byId('favorite-button').textContent = editorDraft?.favorite ? '★' : '☆';
  byId('favorite-button').classList.toggle('favorite-mark', Boolean(editorDraft?.favorite));
}

function updateContentFromEditor() {
  if (!editorDraft) return;
  editorDraft.content = dom['markdown-editor'].value;
  lastEditorValue = dom['markdown-editor'].value;
  updatePreview(); updateEditorStats(); renderOutline(); renderAnnotations(); updateAnnotationComposer();
  if (editorDraft.aiReview) updateAIReviewMeta();
  markEditorDirty();
}

function updateEditorStats() {
  const content = editorDraft?.content || '';
  const words = countWords(content);
  dom['word-count'].textContent = `${words.toLocaleString('zh-CN')} 字`;
  dom['character-count'].textContent = `${content.length.toLocaleString('zh-CN')} 字符`;
  dom['reading-time'].textContent = `约 ${Math.max(1, Math.ceil(words / 350))} 分钟阅读`;
}

function markEditorDirty() {
  if (!editorDraft) return;
  editorDirty = JSON.stringify(editorDraft) !== editorSnapshot;
  if (!editorDirty) return;
  setSaveIndicator('saving', '等待自动保存');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => commitDraft({ manual: false }), 850);
}

async function commitDraft({ manual = false } = {}) {
  if (!editorDraft) return true;
  clearTimeout(saveTimer);
  editorDraft.title = dom['editor-title-input'].value.trim();
  editorDraft.content = dom['markdown-editor'].value;
  const old = store.articles.find((article) => article.id === editorDraft.id);
  const oldCount = Number(old?.lastCountedWords || 0);
  const newCount = countWords(editorDraft.content);
  editorDraft.wordCount = newCount;
  editorDraft.updatedAt = isoNow();
  editorDraft.lastCountedWords = newCount;
  if (old && old.content !== editorDraft.content) {
    const versions = [...(old.versions || [])];
    const lastVersion = versions[versions.length - 1];
    const oldAlreadyCaptured = lastVersion && lastVersion.content === old.content && lastVersion.title === old.title;
    const oldEnough = !lastVersion || Date.now() - new Date(lastVersion.savedAt).getTime() >= 5 * 60 * 1000;
    if (!oldAlreadyCaptured && (manual || oldEnough || versions.length === 0)) {
      versions.push({ savedAt: isoNow(), title: old.title, content: old.content });
    }
    editorDraft.versions = versions.slice(-20);
  }
  store.dailyStats[todayKey()] = Number(store.dailyStats[todayKey()] || 0) + Math.max(0, newCount - oldCount);
  if (!store.syncMetadata) store.syncMetadata = { heads: {}, hashes: {} };
  const syncKey = `article:${editorDraft.id}`;
  if (editorSyncBasis) {
    store.syncMetadata.heads[syncKey] = deepClone(editorSyncBasis.heads);
    if (editorSyncBasis.hash) store.syncMetadata.hashes[syncKey] = editorSyncBasis.hash;
    else delete store.syncMetadata.hashes[syncKey];
  }
  const savedDraft = deepClone(editorDraft);
  const index = store.articles.findIndex((article) => article.id === editorDraft.id);
  if (index >= 0) store.articles[index] = deepClone(editorDraft);
  else store.articles.push(deepClone(editorDraft));
  setSaveIndicator('saving', '正在保存');
  const success = await persistStore();
  if (success) {
    const savedArticle = store.articles.find((a) => a.id === savedDraft.id && a.content === savedDraft.content)
      || store.articles.find((a) => a.syncConflictOf === savedDraft.id && a.content === savedDraft.content && a.updatedAt === savedDraft.updatedAt);
    if (savedArticle && savedArticle.id !== savedDraft.id && editorDraft) {
      editingId = editorDraft.id = savedArticle.id;
      editorDraft.title = savedArticle.title;
      savedDraft.id = savedArticle.id;
      savedDraft.title = savedArticle.title;
      dom['editor-title-input'].value = savedArticle.title;
    }
    editorSyncBasis = getArticleSyncBasis(editorDraft?.id || savedDraft.id);
    editorSnapshot = JSON.stringify(savedDraft);
    editorDirty = Boolean(editorDraft && JSON.stringify(editorDraft) !== editorSnapshot);
    setSaveIndicator(editorDirty ? 'saving' : 'saved');
    dom['last-saved-label'].textContent = `已于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 保存`;
    renderAll();
  } else {
    editorDirty = true;
    setSaveIndicator('error', '保存失败');
  }
  return success;
}

function setSaveIndicator(status, label) {
  dom['save-indicator'].className = `save-indicator ${status === 'saved' ? '' : status}`;
  dom['save-indicator'].querySelector('span').textContent = label || (status === 'saved' ? '已保存' : status === 'saving' ? '正在保存' : '保存失败');
}

async function requestCloseEditor() {
  if (!editorDraft) return closeEditor();
  clearTimeout(saveTimer);
  if (editorDirty) {
    const action = await confirmDialog({
      title: '关闭写作窗口？', message: '检测到尚未写入磁盘的更改。你可以先保存，也可以放弃这次更改。', icon: '✎',
      actions: [
        { value: 'cancel', label: '继续写作', style: 'secondary' },
        { value: 'discard', label: '放弃更改', style: 'danger' },
        { value: 'save', label: '保存并关闭', style: 'primary' }
      ]
    });
    if (action === 'cancel' || !action) return;
    if (action === 'save' && !(await commitDraft({ manual: true }))) return;
  }
  closeEditor();
}

function closeEditor() {
  clearTimeout(saveTimer);
  closeOverlay('editor-overlay');
  editingId = null; editorDraft = null; editorDirty = false; editorSnapshot = '';
  document.querySelector('.editor-dialog').classList.remove('maximized');
  closeFindPanel();
}

function parseTags(value) {
  return [...new Set(String(value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

function setAssistantOpen(open, save = true) {
  dom['editor-workspace'].classList.toggle('assistant-hidden', !open);
  const toggle = byId('assistant-toggle');
  toggle.classList.toggle('active', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? '写作辅助' : '打开辅助';
  store.preferences.assistantOpen = open;
  byId('assistant-resizer').setAttribute('aria-hidden', String(!open));
  applyAssistantWidth();
  if (save) persistStore();
}

function setAssistantTab(tab, save = true) {
  const valid = ['outline', 'annotations', 'notes', 'ai'].includes(tab) ? tab : 'outline';
  document.querySelectorAll('[data-assistant-tab]').forEach((button) => {
    const active = button.dataset.assistantTab === valid;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-assistant-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.assistantPanel === valid));
  dom['writing-assistant'].classList.toggle('ai-mode', valid === 'ai');
  store.preferences.assistantTab = valid;
  applyAssistantWidth();
  if (valid === 'annotations') { renderAnnotations(); updateAnnotationComposer(); }
  if (valid === 'ai') { renderAIReview(); refreshAIConfig(); }
  if (save) persistStore();
}

function articleSourceFingerprint(article) {
  const source = JSON.stringify({
    title: article?.title || '',
    category: article?.category || '',
    content: article?.content || '',
    meta: article?.meta || {}
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function refreshAIConfig() {
  const result = await appBridge.getAIConfig();
  aiConfigured = Boolean(result?.success && result.configured);
  dom['ai-config-banner'].classList.toggle('configured', aiConfigured);
  dom['ai-config-banner'].classList.toggle('error', !result?.success);
  dom['ai-config-state'].textContent = result?.success
    ? (aiConfigured ? `DeepSeek ${result.maskedKey || '已配置'}` : 'DeepSeek 尚未配置')
    : `配置读取失败：${result?.error || '未知错误'}`;
  dom['deepseek-api-key-status'].className = result?.success ? (aiConfigured ? 'success' : '') : 'error';
  dom['deepseek-api-key-status'].textContent = result?.success
    ? (aiConfigured ? `${result.maskedKey || '密钥已配置'}，${result.mode === 'session' ? '本次运行可用，退出后清除，无需钥匙串' : '本次运行已解锁'}` : (result.savedEncrypted ? '已保存的密钥尚未解锁。可重新输入 API Key 并点击“本次使用”，无需钥匙串密码。' : '请输入 API Key，然后选择“本次使用”'))
    : (result?.error || '无法读取配置');
  dom['remove-ai-key-button'].hidden = !aiConfigured && !result?.savedEncrypted;
  byId('unlock-saved-ai-key-button').hidden = !result?.savedEncrypted || aiConfigured;
  dom['deepseek-api-key-input'].placeholder = aiConfigured ? '输入新密钥可用于本次运行' : '输入 sk- 开头的 API Key';
  return aiConfigured;
}

async function useSessionDeepSeekKey() {
  if (!appBridge.useSessionAIApiKey) return toast('请在桌面版中使用', 'error');
  const value = dom['deepseek-api-key-input'].value.trim();
  if (!value) return toast('请输入 DeepSeek API Key', 'error');
  const result = await appBridge.useSessionAIApiKey(value);
  if (!result.success) return toast(result.error || '启用失败', 'error');
  dom['deepseek-api-key-input'].value = '';
  await refreshAIConfig();
  toast('AI 校验已启用，本次运行无需钥匙串密码');
}

async function unlockSavedAIKey() {
  const result = await appBridge.unlockSavedAIApiKey();
  if (!result.success) return toast(`无法解锁：${result.error}。可改用“本次使用”。`, 'error');
  await refreshAIConfig();
  toast('已解锁本次运行的 AI 密钥');
}

async function saveDeepSeekApiKey() {
  const value = dom['deepseek-api-key-input'].value.trim();
  if (!value) return toast('请输入 DeepSeek API Key', 'error');
  dom['save-ai-key-button'].disabled = true;
  dom['deepseek-api-key-status'].className = '';
  dom['deepseek-api-key-status'].textContent = '正在安全保存…';
  const result = await appBridge.saveAIApiKey(value);
  dom['save-ai-key-button'].disabled = false;
  if (!result?.success) {
    dom['deepseek-api-key-status'].className = 'error';
    dom['deepseek-api-key-status'].textContent = result?.error || '保存失败';
    return toast(`API Key 保存失败：${result?.error || '未知错误'}`, 'error');
  }
  dom['deepseek-api-key-input'].value = '';
  await refreshAIConfig();
  toast('DeepSeek API Key 已安全保存');
}

async function removeDeepSeekApiKey() {
  const action = await confirmDialog({
    title: '移除 DeepSeek API Key？',
    message: '移除后将无法使用 AI 校验，之后可以重新配置。',
    icon: 'AI',
    actions: [
      { value: 'cancel', label: '取消', style: 'secondary' },
      { value: 'remove', label: '确认移除', style: 'danger' }
    ]
  });
  if (action !== 'remove') return;
  const result = await appBridge.removeAIApiKey();
  if (!result?.success) return toast(`移除失败：${result?.error || '未知错误'}`, 'error');
  dom['deepseek-api-key-input'].value = '';
  await refreshAIConfig();
  toast('DeepSeek API Key 已移除');
}

async function saveAIReviewPrompt(showToast = true) {
  const prompt = dom['ai-review-prompt'].value.trim();
  if (!prompt) {
    if (showToast) toast('校验提示词不能为空', 'error');
    return false;
  }
  store.preferences.aiReviewPrompt = prompt;
  const success = await persistStore();
  if (showToast) toast(success ? '校验提示词已保存' : '提示词保存失败', success ? 'info' : 'error');
  return success;
}

async function resetAIReviewPrompt() {
  dom['ai-review-prompt'].value = DEFAULT_AI_REVIEW_PROMPT;
  store.preferences.aiReviewPrompt = DEFAULT_AI_REVIEW_PROMPT;
  await persistStore();
  toast('已恢复默认校验提示词');
}

async function runAIReview() {
  if (!editorDraft || aiReviewRunning) return;
  if (!aiConfigured && !(await refreshAIConfig())) {
    openSettings();
    return toast('请先配置 DeepSeek API Key', 'error');
  }
  const prompt = dom['ai-review-prompt'].value.trim();
  if (!prompt) return toast('校验提示词不能为空', 'error');
  if (!String(editorDraft.content || '').trim()) return toast('正文为空，暂时无法校验', 'error');
  await saveAIReviewPrompt(false);

  const draftId = editorDraft.id;
  const sourceFingerprint = articleSourceFingerprint(editorDraft);
  aiReviewRunning = true;
  dom['run-ai-review-button'].disabled = true;
  dom['run-ai-review-button'].classList.add('loading');
  dom['run-ai-review-button'].textContent = '正在校验，请稍候…';
  dom['ai-review-meta'].textContent = '正在检查错别字、语句和段落结构…';

  const category = categoryById(editorDraft.category);
  const result = await appBridge.reviewArticle({
    prompt,
    title: editorDraft.title || dom['editor-title-input'].value || '未命名文章',
    category: category.name,
    content: editorDraft.content || '',
    metadata: {
      keywords: editorDraft.tags || [],
      workTitle: editorDraft.meta?.workTitle || '',
      volume: editorDraft.meta?.volume || '',
      bookTitle: editorDraft.meta?.bookTitle || '',
      bookChapter: editorDraft.meta?.bookChapter || ''
    }
  });

  aiReviewRunning = false;
  dom['run-ai-review-button'].disabled = false;
  dom['run-ai-review-button'].classList.remove('loading');
  dom['run-ai-review-button'].textContent = '重新校验当前文章';
  if (!result?.success) {
    dom['ai-review-meta'].textContent = result?.error || 'AI 校验失败';
    return toast(`AI 校验失败：${result?.error || '未知错误'}`, 'error');
  }
  if (!editorDraft || editorDraft.id !== draftId) return toast('文章已关闭，本次校验结果未写入文章', 'error');

  editorDraft.aiReview = {
    result: result.review,
    appliedIssueIds: [],
    createdAt: isoNow(),
    model: result.model || 'deepseek-flash',
    usage: result.usage || null,
    finishReason: result.finishReason || '',
    sourceFingerprint,
    prompt
  };
  markEditorDirty();
  renderAIReview();
  document.querySelector('.ai-prompt-box').open = false;
  requestAnimationFrame(() => dom['ai-review-result'].scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  await commitDraft();
  toast(result.finishReason === 'length'
    ? 'AI 校验完成，但结果可能因长度限制被截断'
    : (result.retried ? 'AI 校验完成，程序已自动修正返回格式' : 'AI 校验完成'));
}

function renderAIReview() {
  const review = editorDraft?.aiReview;
  if (!review?.result && !review?.report) {
    dom['ai-review-result'].innerHTML = '<div class="assistant-empty">校验结果会显示在这里。建议先保存当前文章，再开始检查。</div>';
    dom['ai-review-meta'].textContent = '';
    dom['ai-review-toolbar'].hidden = true;
    dom['copy-ai-review-button'].hidden = true;
    dom['run-ai-review-button'].textContent = '开始校验当前文章';
    return;
  }
  if (review.result) renderStructuredAIReview(review);
  else {
    dom['ai-review-result'].innerHTML = markdownToHtml(review.report);
    dom['ai-review-toolbar'].hidden = true;
  }
  updateAIReviewMeta();
  dom['copy-ai-review-button'].hidden = false;
  dom['run-ai-review-button'].textContent = '重新校验当前文章';
}

function appendAIReviewSection(parent, title, values, className = '') {
  const items = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
  if (!items.length) return;
  const section = document.createElement('section');
  section.className = `ai-review-section ${className}`.trim();
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.appendChild(heading);
  if (items.length === 1 && !Array.isArray(values)) {
    const paragraph = document.createElement('p');
    paragraph.textContent = items[0];
    section.appendChild(paragraph);
  } else {
    const list = document.createElement('ul');
    for (const value of items) {
      const item = document.createElement('li');
      item.textContent = value;
      list.appendChild(item);
    }
    section.appendChild(list);
  }
  parent.appendChild(section);
}

function renderStructuredAIReview(review) {
  const result = review.result || {};
  const issues = Array.isArray(result.issues) ? result.issues : [];
  const applied = new Set(review.appliedIssueIds || []);
  const stale = review.sourceFingerprint !== articleSourceFingerprint(editorDraft);
  dom['ai-review-result'].replaceChildren();
  appendAIReviewSection(dom['ai-review-result'], '总体判断', result.summary || '校验已完成。');

  const grouped = new Map();
  for (const issue of issues) {
    const category = AI_ISSUE_CATEGORY_LABELS[issue.category] ? issue.category : 'wording';
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(issue);
  }

  for (const category of Object.keys(AI_ISSUE_CATEGORY_LABELS)) {
    const categoryIssues = grouped.get(category) || [];
    if (!categoryIssues.length) continue;
    const group = document.createElement('section');
    group.className = 'ai-issue-group';
    const header = document.createElement('header');
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = AI_ISSUE_CATEGORY_LABELS[category];
    const count = document.createElement('span');
    count.textContent = `${categoryIssues.length} 项`;
    heading.append(title, count);
    header.appendChild(heading);
    const applicable = categoryIssues.filter((issue) => issue.autoApplicable && !applied.has(issue.id));
    if (applicable.length) {
      const applyCategory = document.createElement('button');
      applyCategory.type = 'button';
      applyCategory.className = 'button secondary compact ai-apply-category';
      applyCategory.textContent = `应用此类 ${applicable.length} 项`;
      applyCategory.disabled = stale;
      applyCategory.addEventListener('click', () => applyAIReviewIssues(applicable.map((issue) => issue.id)));
      header.appendChild(applyCategory);
    }
    group.appendChild(header);

    for (const issue of categoryIssues) {
      const card = document.createElement('article');
      card.className = `ai-issue-card ${applied.has(issue.id) ? 'applied' : ''}`;
      const cardHeader = document.createElement('div');
      if (issue.autoApplicable) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.aiIssueId = issue.id;
        checkbox.checked = !applied.has(issue.id);
        checkbox.disabled = applied.has(issue.id) || stale;
        checkbox.setAttribute('aria-label', `选择${AI_ISSUE_CATEGORY_LABELS[category]}修改`);
        checkbox.addEventListener('change', updateAIReviewSelectionState);
        cardHeader.appendChild(checkbox);
      }
      const confidence = document.createElement('span');
      confidence.className = `ai-confidence ${issue.confidence || 'medium'}`;
      confidence.textContent = applied.has(issue.id) ? '已应用' : (issue.autoApplicable ? AI_CONFIDENCE_LABELS[issue.confidence] || '可应用' : '仅建议');
      cardHeader.appendChild(confidence);
      card.appendChild(cardHeader);

      if (issue.original) {
        const comparison = document.createElement('div');
        comparison.className = 'ai-issue-comparison';
        const original = document.createElement('div');
        const originalLabel = document.createElement('b'); originalLabel.textContent = '原文';
        const originalText = document.createElement('code'); originalText.textContent = issue.original;
        original.append(originalLabel, originalText);
        comparison.appendChild(original);
        if (issue.replacement || issue.autoApplicable) {
          const replacement = document.createElement('div');
          const replacementLabel = document.createElement('b'); replacementLabel.textContent = '建议';
          const replacementText = document.createElement('code'); replacementText.textContent = issue.replacement || '（删除此处）';
          replacement.append(replacementLabel, replacementText);
          comparison.appendChild(replacement);
        }
        card.appendChild(comparison);
      }
      if (issue.reason) {
        const reason = document.createElement('p');
        reason.textContent = issue.reason;
        card.appendChild(reason);
      }
      group.appendChild(card);
    }
    dom['ai-review-result'].appendChild(group);
  }

  if (!issues.length) appendAIReviewSection(dom['ai-review-result'], '检查结果', '未发现需要明确修改的问题。');
  appendAIReviewSection(dom['ai-review-result'], '段落与结构建议', result.paragraphAdvice || []);
  appendAIReviewSection(dom['ai-review-result'], '情节链', result.plotAnalysis?.chain || [], 'plot-section');
  appendAIReviewSection(dom['ai-review-result'], '情节风险', result.plotAnalysis?.risks || [], 'plot-section');
  appendAIReviewSection(dom['ai-review-result'], '修改优先级', result.priorities || []);
  dom['ai-review-toolbar'].hidden = !issues.some((issue) => issue.autoApplicable && !applied.has(issue.id));
  updateAIReviewSelectionState();
}

function selectedAIReviewIssueIds() {
  return [...dom['ai-review-result'].querySelectorAll('input[data-ai-issue-id]:checked')].map((input) => input.dataset.aiIssueId);
}

function updateAIReviewSelectionState() {
  const count = selectedAIReviewIssueIds().length;
  const stale = Boolean(editorDraft?.aiReview && editorDraft.aiReview.sourceFingerprint !== articleSourceFingerprint(editorDraft));
  dom['ai-selected-count'].textContent = stale ? '正文已变化，请重新校验' : `已选择 ${count} 项`;
  dom['apply-selected-ai-issues-button'].textContent = count ? `应用已选（${count}）` : '应用已选修改';
  dom['apply-selected-ai-issues-button'].disabled = count === 0 || stale;
}

function locateAIReviewIssue(content, issue) {
  const original = String(issue.original || '');
  if (!original) return null;
  const positions = [];
  let from = 0;
  while (from <= content.length - original.length) {
    const index = content.indexOf(original, from);
    if (index < 0) break;
    positions.push(index);
    from = index + Math.max(1, original.length);
  }
  if (positions.length === 1) return { start: positions[0], end: positions[0] + original.length };
  if (!positions.length) return null;
  const before = String(issue.contextBefore || '');
  const after = String(issue.contextAfter || '');
  const scored = positions.map((start) => ({
    start,
    score: (before && content.slice(Math.max(0, start - before.length), start) === before ? 2 : 0)
      + (after && content.slice(start + original.length, start + original.length + after.length) === after ? 2 : 0)
  })).sort((a, b) => b.score - a.score);
  if (!scored[0].score || (scored[1] && scored[1].score === scored[0].score)) return null;
  return { start: scored[0].start, end: scored[0].start + original.length };
}

async function applyAIReviewIssues(issueIds) {
  const review = editorDraft?.aiReview;
  if (!review?.result || !Array.isArray(issueIds) || !issueIds.length) return;
  if (review.sourceFingerprint !== articleSourceFingerprint(editorDraft)) {
    return toast('正文已在校验后发生变化，请重新校验后再应用修改', 'error');
  }
  const applied = new Set(review.appliedIssueIds || []);
  const requested = new Set(issueIds);
  const issues = (review.result.issues || []).filter((issue) => requested.has(issue.id) && issue.autoApplicable && !applied.has(issue.id));
  const source = dom['markdown-editor'].value;
  const located = [];
  let skipped = 0;
  for (const issue of issues) {
    const range = locateAIReviewIssue(source, issue);
    if (!range) { skipped += 1; continue; }
    located.push({ ...range, issue });
  }
  located.sort((a, b) => a.start - b.start);
  const safe = [];
  for (const item of located) {
    if (safe.length && item.start < safe[safe.length - 1].end) { skipped += 1; continue; }
    safe.push(item);
  }
  if (!safe.length) return toast('所选建议无法在当前正文中准确定位，请重新校验', 'error');

  recordUndoState();
  let next = source;
  for (const item of [...safe].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, item.start)}${item.issue.replacement}${next.slice(item.end)}`;
    applied.add(item.issue.id);
  }
  dom['markdown-editor'].value = next;
  updateContentFromEditor();
  review.appliedIssueIds = [...applied];
  review.sourceFingerprint = articleSourceFingerprint(editorDraft);
  markEditorDirty();
  renderAIReview();
  await commitDraft();
  toast(`已应用 ${safe.length} 项修改${skipped ? `，${skipped} 项因无法准确定位而跳过` : ''}；可使用撤销恢复`);
}

function updateAIReviewMeta() {
  const review = editorDraft?.aiReview;
  if (!review?.result && !review?.report) return;
  const tokens = Number(review.usage?.total_tokens || 0);
  const stale = review.sourceFingerprint !== articleSourceFingerprint(editorDraft);
  const time = new Date(review.createdAt || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  dom['ai-review-meta'].textContent = `${time} · ${review.model || 'DeepSeek'}${tokens ? ` · ${tokens.toLocaleString('zh-CN')} tokens` : ''}${stale ? ' · 正文已修改，建议重新校验' : ''}`;
  if (review.result) updateAIReviewSelectionState();
}

async function copyAIReview() {
  const review = editorDraft?.aiReview;
  if (!review?.result && !review?.report) return;
  const report = review.report || formatStructuredAIReviewText(review.result);
  try {
    await navigator.clipboard.writeText(report);
    toast('校验结果已复制');
  } catch {
    toast('无法复制校验结果', 'error');
  }
}

function formatStructuredAIReviewText(result) {
  const lines = ['AI 校验结果', '', result?.summary || ''];
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  for (const category of Object.keys(AI_ISSUE_CATEGORY_LABELS)) {
    const categoryIssues = issues.filter((issue) => issue.category === category);
    if (!categoryIssues.length) continue;
    lines.push('', `【${AI_ISSUE_CATEGORY_LABELS[category]}】`);
    categoryIssues.forEach((issue, index) => {
      lines.push(`${index + 1}. 原文：${issue.original || '—'}`);
      if (issue.replacement || issue.autoApplicable) lines.push(`   建议：${issue.replacement || '删除此处'}`);
      if (issue.reason) lines.push(`   理由：${issue.reason}`);
    });
  }
  if (result?.paragraphAdvice?.length) lines.push('', '【段落与结构建议】', ...result.paragraphAdvice.map((item) => `- ${item}`));
  if (result?.plotAnalysis?.chain?.length) lines.push('', '【情节链】', ...result.plotAnalysis.chain.map((item) => `- ${item}`));
  if (result?.plotAnalysis?.risks?.length) lines.push('', '【情节风险】', ...result.plotAnalysis.risks.map((item) => `- ${item}`));
  if (result?.priorities?.length) lines.push('', '【修改优先级】', ...result.priorities.map((item) => `- ${item}`));
  return lines.filter((line, index) => line || index > 0).join('\n').trim();
}

function addKeywordFromAssistant() {
  if (!editorDraft) return;
  const additions = parseTags(dom['assistant-keyword-input'].value);
  if (!additions.length) return;
  const next = [...new Set([...(editorDraft.tags || []), ...additions])].slice(0, 12);
  if (next.length === (editorDraft.tags || []).length) toast('关键词已经存在');
  editorDraft.tags = next;
  dom['editor-tags'].value = next.join(', ');
  dom['assistant-keyword-input'].value = '';
  renderKeywords();
  markEditorDirty();
}

function removeKeyword(keyword) {
  if (!editorDraft) return;
  editorDraft.tags = (editorDraft.tags || []).filter((item) => item !== keyword);
  dom['editor-tags'].value = editorDraft.tags.join(', ');
  renderKeywords();
  markEditorDirty();
}

function renderKeywords() {
  dom['keyword-chips'].replaceChildren();
  const keywords = editorDraft?.tags || [];
  if (!keywords.length) {
    const empty = document.createElement('span');
    empty.className = 'keyword-empty';
    empty.textContent = '还没有关键词';
    dom['keyword-chips'].appendChild(empty);
    return;
  }
  for (const keyword of keywords) {
    const chip = document.createElement('span');
    chip.className = 'keyword-chip';
    const label = document.createElement('span');
    label.textContent = keyword;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `删除关键词“${keyword}”`;
    remove.addEventListener('click', () => removeKeyword(keyword));
    chip.append(label, remove);
    dom['keyword-chips'].appendChild(chip);
  }
}

function getOutlineItems(content = editorDraft?.content || '') {
  const items = [];
  let offset = 0;
  for (const line of String(content).split('\n')) {
    const match = line.match(/^(#{1,2})[ \t]+(.+?)\s*#*\s*$/);
    if (match) {
      items.push({ level: match[1].length, title: stripMarkdown(match[2]) || match[2].trim(), offset });
    }
    offset += line.length + 1;
  }
  return items;
}

function renderOutline() {
  dom['outline-list'].replaceChildren();
  const items = getOutlineItems();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'assistant-empty';
    empty.textContent = '正文中还没有一级或二级标题。可使用工具栏的 H1、H2 快速建立结构。';
    dom['outline-list'].appendChild(empty);
    return;
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `outline-item level-${item.level}`;
    const level = document.createElement('span');
    level.className = 'outline-level';
    level.textContent = `H${item.level}`;
    const title = document.createElement('span');
    title.className = 'outline-text';
    title.textContent = item.title;
    button.append(level, title);
    button.addEventListener('click', () => jumpToEditorPosition(item.offset));
    dom['outline-list'].appendChild(button);
  }
}

function jumpToEditorPosition(start, end = start) {
  if (dom['editor-body'].classList.contains('layout-preview')) setEditorLayout('split');
  const textarea = dom['markdown-editor'];
  const safeStart = Math.max(0, Math.min(Number(start) || 0, textarea.value.length));
  const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, textarea.value.length));
  textarea.focus();
  textarea.setSelectionRange(safeStart, safeEnd);
  const lineNumber = textarea.value.slice(0, safeStart).split('\n').length - 1;
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 30;
  textarea.scrollTop = Math.max(0, lineNumber * lineHeight - textarea.clientHeight * .28);
  updateAnnotationComposer();
}

function currentAnnotationSelection() {
  if (!editorDraft) return null;
  const textarea = dom['markdown-editor'];
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (end <= start) return null;
  const text = textarea.value.slice(start, end).trim();
  return text ? { start, end, text } : null;
}

function updateAnnotationComposer() {
  const selection = currentAnnotationSelection();
  const noteReady = Boolean(dom['annotation-input'].value.trim());
  dom['add-annotation-button'].disabled = !selection || !noteReady;
  dom['annotation-selection-hint'].textContent = selection
    ? `已选择：“${selection.text.replace(/\s+/g, ' ').slice(0, 70)}${selection.text.length > 70 ? '…' : ''}”`
    : '请先在左侧正文中选择一段文字。';
}

function addAnnotation() {
  if (!editorDraft) return;
  const selection = currentAnnotationSelection();
  const note = dom['annotation-input'].value.trim();
  if (!selection) return toast('请先在正文中选择要批注的文字', 'error');
  if (!note) return toast('请输入批注内容', 'error');
  editorDraft.annotations = [...(editorDraft.annotations || []), {
    id: uid(),
    start: selection.start,
    end: selection.end,
    excerpt: selection.text.slice(0, 500),
    note,
    createdAt: isoNow()
  }];
  dom['annotation-input'].value = '';
  renderAnnotations();
  updateAnnotationComposer();
  markEditorDirty();
  toast('批注已添加');
}

function resolveAnnotationRange(annotation) {
  const content = editorDraft?.content || '';
  const excerpt = String(annotation.excerpt || '');
  if (!excerpt) return { start: annotation.start || 0, end: annotation.end || annotation.start || 0, found: false };
  let best = -1;
  let from = 0;
  let distance = Infinity;
  while (from <= content.length - excerpt.length) {
    const index = content.indexOf(excerpt, from);
    if (index < 0) break;
    const currentDistance = Math.abs(index - Number(annotation.start || 0));
    if (currentDistance < distance) { best = index; distance = currentDistance; }
    from = index + Math.max(1, excerpt.length);
  }
  return best >= 0
    ? { start: best, end: best + excerpt.length, found: true }
    : { start: Math.min(Number(annotation.start || 0), content.length), end: Math.min(Number(annotation.end || 0), content.length), found: false };
}

function renderAnnotations() {
  dom['annotation-list'].replaceChildren();
  const annotations = editorDraft?.annotations || [];
  dom['annotation-count'].textContent = annotations.length;
  if (!annotations.length) {
    const empty = document.createElement('div');
    empty.className = 'assistant-empty';
    empty.textContent = '选择正文中的文字并写下批注，之后可从这里快速回到原文。';
    dom['annotation-list'].appendChild(empty);
    return;
  }
  for (const annotation of annotations) {
    const range = resolveAnnotationRange(annotation);
    const card = document.createElement('article');
    card.className = 'annotation-card';
    const quote = document.createElement('blockquote');
    const excerpt = String(annotation.excerpt || '').replace(/\s+/g, ' ');
    quote.textContent = `${range.found ? '' : '原文可能已修改 · '}${excerpt.slice(0, 100)}${excerpt.length > 100 ? '…' : ''}`;
    const note = document.createElement('p');
    note.textContent = annotation.note || '';
    const footer = document.createElement('footer');
    const time = document.createElement('span');
    time.textContent = new Date(annotation.createdAt || Date.now()).toLocaleDateString('zh-CN');
    const actions = document.createElement('div');
    const jump = document.createElement('button');
    jump.type = 'button'; jump.textContent = '定位';
    jump.addEventListener('click', () => jumpToEditorPosition(range.start, range.end));
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'annotation-delete'; remove.textContent = '删除';
    remove.addEventListener('click', () => {
      editorDraft.annotations = (editorDraft.annotations || []).filter((item) => item.id !== annotation.id);
      renderAnnotations(); markEditorDirty(); toast('批注已删除');
    });
    actions.append(jump, remove); footer.append(time, actions); card.append(quote, note, footer);
    dom['annotation-list'].appendChild(card);
  }
}

function renderInline(text) {
  let output = text;
  output = output.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^)]+)\)/g, '<img src="$2" alt="$1">');
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  output = output.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  output = output.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  output = output.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  return output;
}

function markdownToHtml(markdown) {
  const escaped = escapeHtml(markdown).replace(/\r\n/g, '\n');
  const codeBlocks = [];
  const prepared = escaped.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, language, code) => {
    const token = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code data-language="${language.trim()}">${code.replace(/\n$/, '')}</code></pre>`);
    return `\n${token}\n`;
  });
  const lines = prepared.split('\n');
  const html = [];
  let paragraph = [];
  let listType = null;
  const flushParagraph = () => {
    if (paragraph.length) { html.push(`<p>${renderInline(paragraph.join('<br>'))}</p>`); paragraph = []; }
  };
  const closeList = () => { if (listType) { html.push(`</${listType.tag}>`); listType = null; } };
  const openList = (tag, className = '') => {
    const same = listType && listType.tag === tag && listType.className === className;
    if (same) return;
    closeList();
    listType = { tag, className };
    html.push(`<${tag}${className ? ` class="${className}"` : ''}>`);
  };
  const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const codeToken = trimmed.match(/^@@CODEBLOCK(\d+)@@$/);
    if (codeToken) { flushParagraph(); closeList(); html.push(codeBlocks[Number(codeToken[1])]); continue; }
    if (!trimmed) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`); continue; }
    if (/^([-*_]){3,}$/.test(trimmed.replace(/\s/g, ''))) { flushParagraph(); closeList(); html.push('<hr>'); continue; }
    const nextLine = lines[index + 1] || '';
    const isTableHeader = line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine);
    if (isTableHeader) {
      flushParagraph(); closeList();
      const headers = tableCells(line);
      const alignments = tableCells(nextLine).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push('<table><thead><tr>');
      headers.forEach((cell, cellIndex) => html.push(`<th style="text-align:${alignments[cellIndex] || 'left'}">${renderInline(cell)}</th>`));
      html.push('</tr></thead><tbody>');
      rows.forEach((row) => {
        html.push('<tr>');
        headers.forEach((_header, cellIndex) => html.push(`<td style="text-align:${alignments[cellIndex] || 'left'}">${renderInline(row[cellIndex] || '')}</td>`));
        html.push('</tr>');
      });
      html.push('</tbody></table>');
      continue;
    }
    const quote = line.match(/^(?:>|&gt;)\s?(.*)$/);
    if (quote) { flushParagraph(); closeList(); html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`); continue; }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (task || unordered || ordered) {
      flushParagraph();
      if (task) {
        openList('ul', 'task-list');
        html.push(`<li><input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}>${renderInline(task[2])}</li>`);
      } else {
        openList(unordered ? 'ul' : 'ol');
        html.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      }
      continue;
    }
    closeList(); paragraph.push(line);
  }
  flushParagraph(); closeList();
  return html.join('\n');
}

function updatePreview() {
  const content = editorDraft?.content || '';
  dom['markdown-preview'].innerHTML = content.trim() ? markdownToHtml(content) : '<p class="preview-placeholder">右侧会实时显示 Markdown 排版效果。</p>';
  if (previewFollowing) {
    programmaticPreviewScroll = true;
    requestAnimationFrame(() => {
      dom['markdown-preview'].scrollTop = dom['markdown-preview'].scrollHeight;
      setTimeout(() => { programmaticPreviewScroll = false; }, 60);
    });
  }
}

function setPreviewFollowing(value, announce) {
  previewFollowing = value;
  const button = byId('follow-toggle');
  button.classList.toggle('active', value);
  button.textContent = value ? '自动跟随' : '恢复跟随';
  if (value) {
    programmaticPreviewScroll = true;
    dom['markdown-preview'].scrollTop = dom['markdown-preview'].scrollHeight;
    setTimeout(() => { programmaticPreviewScroll = false; }, 60);
  }
  if (announce) toast(value ? '预览将自动显示最新内容' : '已暂停预览自动跟随');
}

function toggleEditorMaximize() {
  const dialog = document.querySelector('.editor-dialog');
  const maximized = dialog.classList.toggle('maximized');
  const button = byId('editor-maximize');
  button.textContent = maximized ? '❐' : '⛶';
  button.title = maximized ? '恢复窗口' : '最大化';
  toast(maximized ? '已进入沉浸写作视图' : '已恢复弹窗大小');
}

function recordUndoState() {
  const current = dom['markdown-editor'].value;
  if (undoStack[undoStack.length - 1] !== current) undoStack.push(current);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function captureUserEditForUndo() {
  const current = dom['markdown-editor'].value;
  if (current === lastEditorValue) return;
  if (undoStack[undoStack.length - 1] !== lastEditorValue) undoStack.push(lastEditorValue);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function undoEditor() {
  if (!undoStack.length) return toast('没有可以撤销的操作');
  const textarea = dom['markdown-editor'];
  const previous = undoStack.pop();
  redoStack.push(textarea.value);
  textarea.value = previous;
  updateContentFromEditor();
  updateUndoButtons();
  textarea.focus();
}

function redoEditor() {
  if (!redoStack.length) return toast('没有可以重做的操作');
  const textarea = dom['markdown-editor'];
  const next = redoStack.pop();
  if (undoStack[undoStack.length - 1] !== textarea.value) undoStack.push(textarea.value);
  textarea.value = next;
  updateContentFromEditor();
  updateUndoButtons();
  textarea.focus();
}

function updateUndoButtons() {
  const undo = byId('undo-button');
  const redo = byId('redo-button');
  if (undo) undo.disabled = undoStack.length === 0;
  if (redo) redo.disabled = redoStack.length === 0;
}

function openFindPanel() {
  dom['find-panel'].classList.add('show');
  dom['find-panel'].setAttribute('aria-hidden', 'false');
  dom['find-input'].focus();
  dom['find-input'].select();
  updateFindResult();
}

function closeFindPanel() {
  if (!dom['find-panel']) return;
  dom['find-panel'].classList.remove('show');
  dom['find-panel'].setAttribute('aria-hidden', 'true');
}

function getMatchPositions(query) {
  if (!query) return [];
  const text = dom['markdown-editor'].value.toLocaleLowerCase('zh-CN');
  const needle = query.toLocaleLowerCase('zh-CN');
  const positions = [];
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    positions.push(index);
    offset = index + Math.max(needle.length, 1);
  }
  return positions;
}

function updateFindResult(activeIndex = null) {
  const query = dom['find-input'].value;
  const positions = getMatchPositions(query);
  if (!query) dom['find-result'].textContent = '输入要查找的文字';
  else if (!positions.length) dom['find-result'].textContent = '没有找到匹配内容';
  else if (activeIndex === null) dom['find-result'].textContent = `共 ${positions.length} 处匹配`;
  else dom['find-result'].textContent = `第 ${activeIndex + 1} 处，共 ${positions.length} 处`;
  return positions;
}

function findText(direction = 1) {
  const query = dom['find-input'].value;
  const positions = getMatchPositions(query);
  if (!query || !positions.length) { updateFindResult(); return false; }
  const textarea = dom['markdown-editor'];
  let index;
  if (direction > 0) {
    index = positions.findIndex((position) => position >= textarea.selectionEnd);
    if (index < 0) index = 0;
  } else {
    index = positions.length - 1;
    for (let i = positions.length - 1; i >= 0; i -= 1) {
      if (positions[i] < textarea.selectionStart) { index = i; break; }
    }
  }
  textarea.focus();
  textarea.setSelectionRange(positions[index], positions[index] + query.length);
  updateFindResult(index);
  return true;
}

function replaceCurrentMatch() {
  const textarea = dom['markdown-editor'];
  const query = dom['find-input'].value;
  if (!query) return;
  const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
  if (selected.toLocaleLowerCase('zh-CN') !== query.toLocaleLowerCase('zh-CN') && !findText(1)) return;
  recordUndoState();
  textarea.setRangeText(dom['replace-input'].value, textarea.selectionStart, textarea.selectionEnd, 'end');
  updateContentFromEditor();
  findText(1);
}

function replaceAllMatches() {
  const query = dom['find-input'].value;
  const positions = getMatchPositions(query);
  if (!query || !positions.length) return updateFindResult();
  const replacement = dom['replace-input'].value;
  recordUndoState();
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  dom['markdown-editor'].value = dom['markdown-editor'].value.replace(expression, replacement);
  updateContentFromEditor();
  updateFindResult();
  toast(`已替换 ${positions.length} 处内容`);
}

function openHistory() {
  renderHistory();
  openOverlay('history-overlay');
}

function renderHistory() {
  dom['history-list'].replaceChildren();
  const versions = [...(editorDraft?.versions || [])].reverse();
  if (!versions.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '还没有历史版本。继续写作并保存后，这里会保留较早的内容。';
    dom['history-list'].appendChild(empty);
    return;
  }
  for (const version of versions) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const summary = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = version.title || '未命名文章';
    const meta = document.createElement('p');
    meta.textContent = `${new Date(version.savedAt).toLocaleString('zh-CN')} · ${countWords(version.content).toLocaleString('zh-CN')} 字 · ${stripMarkdown(version.content).slice(0, 45) || '空白版本'}`;
    summary.append(title, meta);
    const restore = document.createElement('button');
    restore.className = 'button secondary compact';
    restore.textContent = '恢复此版本';
    restore.addEventListener('click', () => restoreVersion(version));
    item.append(summary, restore);
    dom['history-list'].appendChild(item);
  }
}

async function restoreVersion(version) {
  const choice = await confirmDialog({
    title: '恢复这个历史版本？',
    message: '当前编辑内容不会立即删除；保存后它也会进入历史记录。',
    icon: '◷',
    actions: [
      { value: 'cancel', label: '取消', style: 'secondary' },
      { value: 'restore', label: '恢复版本', style: 'primary' }
    ]
  });
  if (choice !== 'restore' || !editorDraft) return;
  recordUndoState();
  editorDraft.title = version.title || editorDraft.title;
  editorDraft.content = version.content || '';
  dom['editor-title-input'].value = editorDraft.title;
  dom['markdown-editor'].value = editorDraft.content;
  updatePreview(); updateEditorStats(); markEditorDirty();
  closeOverlay('history-overlay');
  toast('历史版本已载入，保存后生效');
}

function applyFormat(type) {
  const textarea = dom['markdown-editor'];
  textarea.focus();
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  recordUndoState();
  let before = '', after = '', replacement = selected;
  if (type === 'heading1') { before = '# '; replacement = selected || '一级标题'; }
  if (type === 'heading2') { before = '## '; replacement = selected || '二级标题'; }
  if (type === 'heading3') { before = '### '; replacement = selected || '三级标题'; }
  if (type === 'bold') { before = '**'; after = '**'; replacement = selected || '粗体文字'; }
  if (type === 'italic') { before = '*'; after = '*'; replacement = selected || '斜体文字'; }
  if (type === 'strike') { before = '~~'; after = '~~'; replacement = selected || '删除文字'; }
  if (type === 'highlight') { before = '=='; after = '=='; replacement = selected || '重点内容'; }
  if (type === 'quote') { replacement = (selected || '引用内容').split('\n').map((line) => `> ${line}`).join('\n'); }
  if (type === 'unordered') { replacement = (selected || '列表项').split('\n').map((line) => `- ${line}`).join('\n'); }
  if (type === 'ordered') { replacement = (selected || '列表项').split('\n').map((line, index) => `${index + 1}. ${line}`).join('\n'); }
  if (type === 'task') { replacement = (selected || '待办事项').split('\n').map((line) => `- [ ] ${line}`).join('\n'); }
  if (type === 'link') { before = '['; after = '](https://)'; replacement = selected || '链接文字'; }
  if (type === 'image') { before = '!['; after = '](https://)'; replacement = selected || '图片说明'; }
  if (type === 'table') {
    before = `${start > 0 && textarea.value[start - 1] !== '\n' ? '\n' : ''}`;
    replacement = '| 项目 | 内容 |\n| --- | --- |\n| 示例 | 在这里填写 |';
  }
  if (type === 'code') { before = '`'; after = '`'; replacement = selected || '代码'; }
  if (type === 'codeblock') { before = '```\n'; after = '\n```'; replacement = selected || '代码'; }
  if (type === 'divider') { before = `${start > 0 ? '\n' : ''}---\n`; replacement = ''; }
  textarea.setRangeText(`${before}${replacement}${after}`, start, end, 'end');
  updateContentFromEditor();
}

function handleEditorKeydown(event) {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoEditor();
    else undoEditor();
    return;
  }
  if (modifier && !event.altKey && ['b', 'i', 'k'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    applyFormat({ b: 'bold', i: 'italic', k: 'link' }[event.key.toLowerCase()]);
    return;
  }
  if (modifier && event.altKey && ['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    applyFormat(`heading${event.key}`);
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !modifier) {
    const textarea = event.target;
    const caret = textarea.selectionStart;
    if (caret === textarea.selectionEnd) {
      const lineStart = textarea.value.lastIndexOf('\n', caret - 1) + 1;
      const lineBeforeCaret = textarea.value.slice(lineStart, caret);
      const continuation = lineBeforeCaret.match(/^(\s*)(?:(\d+)([.)])|([-*+])\s+\[([ xX])\]|([-*+])|(>))\s+(.*)$/);
      if (continuation) {
        event.preventDefault();
        recordUndoState();
        const indent = continuation[1] || '';
        const body = continuation[8] || '';
        let prefix = '';
        if (continuation[2]) prefix = `${Number(continuation[2]) + 1}${continuation[3]} `;
        else if (continuation[4]) prefix = `${continuation[4]} [ ] `;
        else if (continuation[6]) prefix = `${continuation[6]} `;
        else if (continuation[7]) prefix = '> ';
        if (!body.trim()) textarea.setRangeText('', lineStart, caret, 'end');
        else textarea.setRangeText(`\n${indent}${prefix}`, caret, caret, 'end');
        updateContentFromEditor();
        return;
      }
    }
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    recordUndoState();
    const textarea = event.target;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (textarea.value.slice(start, end).includes('\n')) {
      const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
      const block = textarea.value.slice(lineStart, end);
      const transformed = event.shiftKey
        ? block.split('\n').map((line) => line.replace(/^ {1,2}/, '')).join('\n')
        : block.split('\n').map((line) => `  ${line}`).join('\n');
      textarea.setRangeText(transformed, lineStart, end, 'select');
    } else if (event.shiftKey) {
      const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
      const removable = textarea.value.slice(lineStart, start).match(/^ {1,2}/)?.[0].length || 0;
      if (removable) textarea.setRangeText('', lineStart, lineStart + removable, 'end');
    } else {
      textarea.setRangeText('  ', start, end, 'end');
    }
    updateContentFromEditor();
  }
}

function setEditorLayout(layout, save = true) {
  const valid = ['editor', 'split', 'preview'].includes(layout) ? layout : 'split';
  dom['editor-body'].classList.remove('layout-editor', 'layout-split', 'layout-preview');
  dom['editor-body'].classList.add(`layout-${valid}`);
  document.querySelectorAll('[data-layout]').forEach((button) => button.classList.toggle('active', button.dataset.layout === valid));
  store.preferences.editorLayout = valid;
  applyAssistantWidth();
  if (save) persistStore();
}

function bindSplitter() {
  dom['editor-splitter'].addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const body = dom['editor-body'];
    const move = (moveEvent) => {
      const rect = body.getBoundingClientRect();
      const percent = Math.max(25, Math.min(75, (moveEvent.clientX - rect.left) / rect.width * 100));
      body.style.setProperty('--editor-width', `${percent}%`);
      store.preferences.editorWidth = Math.round(percent * 10) / 10;
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); persistStore(); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

async function importArticles() {
  if (appBridge.isPreview) return toast('文件导入请在桌面版中使用');
  const result = await appBridge.importText();
  if (!result.success) return toast(`导入失败：${result.error}`, 'error');
  if (result.canceled) return;
  const category = activeView.type === 'category' ? activeView.id : 'essay';
  for (const file of result.files) {
    const article = createBlankArticle();
    article.category = category; article.title = file.name || '导入文章'; article.content = file.content;
    article.wordCount = article.lastCountedWords = countWords(file.content);
    store.articles.push(article);
  }
  await persistStore(); renderAll();
  const converted = result.files.filter((file) => file.converted).length;
  const warningCount = result.files.reduce((total, file) => total + (file.warnings?.length || 0), 0);
  const detail = converted ? `，其中 ${converted} 篇已转换为 Markdown` : '';
  toast(`已导入 ${result.files.length} 篇文章${detail}${warningCount ? `（${warningCount} 条格式提示）` : ''}`);
}

function openExportDialog(mode, articles = null) {
  if (appBridge.isPreview) return toast('文件导出请在桌面版中使用');
  exportMode = mode === 'batch' ? 'batch' : 'single';
  exportCandidates = (articles || getVisibleArticles()).filter((article) => !article.deletedAt);
  if (!exportCandidates.length) return toast('当前没有可以导出的文章', 'error');

  dom['export-dialog-title'].textContent = exportMode === 'batch' ? '批量导出文章' : '导出文章';
  dom['export-description'].textContent = exportMode === 'batch'
    ? '勾选要导出的文章。程序会在你选择的位置新建一个导出文件夹。'
    : '选择一篇文章，并指定导出格式。';
  dom['export-select-all-label'].hidden = exportMode !== 'batch';
  dom['export-article-list'].replaceChildren();

  exportCandidates.forEach((article, index) => {
    const category = categoryById(article.category);
    const label = document.createElement('label');
    label.className = 'export-article-option';
    const input = document.createElement('input');
    input.type = exportMode === 'batch' ? 'checkbox' : 'radio';
    input.name = 'export-article-selection';
    input.value = article.id;
    input.checked = exportMode === 'batch' || index === 0;
    input.addEventListener('change', updateExportSelection);
    const details = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = article.title || '未命名文章';
    const meta = document.createElement('small');
    meta.textContent = article.category === 'reading'
      ? [category.name, article.meta?.bookTitle ? `《${article.meta.bookTitle}》` : '未填写书名', article.meta?.bookChapter].filter(Boolean).join(' · ')
      : `${category.name} · ${STATUS_LABELS[article.status] || '草稿'}`;
    details.append(title, meta);
    const words = document.createElement('span');
    words.textContent = `${Number(article.wordCount || 0).toLocaleString('zh-CN')} 字`;
    label.append(input, details, words);
    dom['export-article-list'].appendChild(label);
  });

  dom['export-format-select'].value = 'md';
  updateExportFormatNote();
  updateExportSelection();
  openOverlay('export-overlay');
}

function updateExportFormatNote() {
  const descriptions = {
    md: '保留原始 Markdown，适合继续编辑和迁移。',
    docx: '生成可继续编辑的 Word 文档，保留标题、列表、表格和常见文字样式。',
    pdf: '生成适合阅读、打印和分享的 A4 版式 PDF。',
    txt: '移除 Markdown 标记，仅保留纯文本内容。',
    html: '生成带完整排版样式的网页文件。'
  };
  dom['export-format-note'].textContent = descriptions[dom['export-format-select'].value] || '';
}

function selectedExportArticles() {
  const selectedIds = new Set([...dom['export-article-list'].querySelectorAll('input:checked')].map((input) => input.value));
  return exportCandidates.filter((article) => selectedIds.has(article.id));
}

function updateExportSelection() {
  const count = selectedExportArticles().length;
  dom['export-selected-count'].textContent = `已选择 ${count} 篇`;
  dom['export-confirm-button'].disabled = count === 0;
  dom['export-confirm-button'].textContent = exportMode === 'batch' ? `导出 ${count} 篇文章` : '导出所选文章';
  if (exportMode === 'batch') {
    dom['export-select-all'].checked = count === exportCandidates.length;
    dom['export-select-all'].indeterminate = count > 0 && count < exportCandidates.length;
  }
}

function toggleAllExportCandidates() {
  if (exportMode !== 'batch') return;
  dom['export-article-list'].querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = dom['export-select-all'].checked;
  });
  updateExportSelection();
}

function markdownToPlainText(value) {
  return String(value || '')
    .replace(/```(?:[^\n]*)\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[x\]\s+/gim, '☑ ')
    .replace(/^\s*[-*+]\s+\[ \]\s+/gm, '☐ ')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~`=]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function createExportDocument(article, format) {
  const title = article.title || '未命名文章';
  const source = article.content || '';
  const keywords = article.tags || [];
  if (format === 'txt') return { fileName: title, content: markdownToPlainText(source) };
  if (format === 'docx') return { fileName: title, title, source, keywords, content: '' };
  if (format === 'html' || format === 'pdf') {
    const keywordLine = keywords.length ? `<p class="document-keywords">关键词：${keywords.map(escapeHtml).join('、')}</p>` : '';
    const content = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>@page{size:A4;margin:18mm 19mm 20mm}*{box-sizing:border-box}html{background:#fff}body{max-width:780px;margin:0 auto;padding:${format === 'pdf' ? '0' : '54px 28px 70px'};font:16px/1.9 Georgia,"Songti SC","Microsoft YaHei",serif;color:#232821;overflow-wrap:anywhere}body>h1:first-child{margin:0 0 10px;font:700 30px/1.35 Inter,"PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:-.025em;color:#111}.document-keywords{margin:0 0 30px;color:#6f776f;font:12px/1.6 Inter,"PingFang SC",sans-serif}h1,h2,h3,h4,h5,h6{break-after:avoid-page;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#111}h1{margin:30px 0 16px;font-size:25px}h2{margin:26px 0 13px;font-size:21px}h3{margin:22px 0 11px;font-size:18px}p{margin:0 0 14px}blockquote{margin:18px 0;padding:5px 0 5px 16px;border-left:3px solid #2f7457;color:#566058}pre{padding:15px 17px;background:#f2f3f1;overflow:auto;border-radius:8px;break-inside:avoid}code{font-family:Consolas,monospace;background:#f2f3f1;padding:2px 4px;border-radius:4px}pre code{padding:0;background:transparent}img{max-width:100%;break-inside:avoid}mark{padding:1px 3px;background:#ffe7a8}table{width:100%;margin:19px 0;border-collapse:collapse;font:13px/1.55 Inter,"PingFang SC",sans-serif;break-inside:auto}tr{break-inside:avoid}th,td{padding:9px 10px;border:1px solid #d9ddd9;text-align:left}th{background:#e8f0eb;color:#183d2e}.task-list{padding-left:0;list-style:none}.task-list input{margin-right:8px}a{color:#2f7457;text-decoration:none}hr{margin:26px 0;border:0;border-top:1px solid #d9ddd9}</style></head><body><h1>${escapeHtml(title)}</h1>${keywordLine}${markdownToHtml(source)}</body></html>`;
    return { fileName: title, title, source, keywords, content };
  }
  return { fileName: title, title, source, keywords, content: source };
}

function exportFormatDetails(format) {
  if (format === 'txt') return { extension: 'txt', filterName: '纯文本' };
  if (format === 'html') return { extension: 'html', filterName: '网页' };
  if (format === 'docx') return { extension: 'docx', filterName: 'Word 文档' };
  if (format === 'pdf') return { extension: 'pdf', filterName: 'PDF 文档' };
  return { extension: 'md', filterName: 'Markdown' };
}

async function confirmArticleExport() {
  const articles = selectedExportArticles();
  if (!articles.length) return;
  const format = dom['export-format-select'].value;
  const details = exportFormatDetails(format);
  const items = articles.map((article) => createExportDocument(article, format));
  dom['export-confirm-button'].disabled = true;
  dom['export-confirm-button'].textContent = '正在导出…';

  const result = exportMode === 'batch'
    ? await appBridge.exportArticles({ ...details, items })
    : await appBridge.exportText({ ...details, ...items[0] });

  if (!result.success) {
    toast(`导出失败：${result.error}`, 'error');
    updateExportSelection();
    return;
  }
  if (result.canceled) {
    updateExportSelection();
    return;
  }
  closeOverlay('export-overlay');
  toast(exportMode === 'batch' ? `已批量导出 ${result.count || items.length} 篇文章` : '文章导出完成');
}

async function exportCurrentArticle() {
  if (!editorDraft) return;
  openExportDialog('single', [editorDraft]);
}

function createCategory() {
  const name = dom['category-name-input'].value.trim();
  if (!name) return toast('请输入分类名称', 'error');
  if (allCategories().some((category) => category.name === name)) return toast('已经存在同名分类', 'error');
  const colors = ['#ef6c78', '#7b71e8', '#2ba5a0', '#b779d0', '#5287c7'];
  const category = { id: `custom-${uid()}`, name, description: dom['category-description-input'].value.trim(), color: colors[store.customCategories.length % colors.length], icon: '•' };
  store.customCategories.push(category);
  activeView = { type: 'category', id: category.id };
  dom['category-name-input'].value = ''; dom['category-description-input'].value = '';
  closeOverlay('category-overlay'); persistStore(); renderAll();
}

function deleteCustomCategory(id) {
  store.customCategories = store.customCategories.filter((category) => category.id !== id);
  store.articles.forEach((article) => { if (article.category === id) article.category = 'essay'; });
  activeView = { type: 'category', id: 'essay' };
  persistStore(); renderAll(); toast('分类已删除，原文章已移入日常随笔');
}

function openSettings() {
  updateSettingsControls();
  dom['deepseek-api-key-input'].value = '';
  refreshAIConfig();
  refreshSyncStatus();
  openOverlay('settings-overlay');
}
function updateSettingsControls() {
  if (!dom['theme-select']) return;
  dom['theme-select'].value = store.preferences.theme || 'system';
  dom['daily-goal-input'].value = store.preferences.dailyGoal || 1000;
}

function applyTheme() {
  const preference = store.preferences.theme || 'system';
  if (preference === 'eye') {
    document.documentElement.dataset.theme = 'eye';
    return;
  }
  const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

async function openDataFolder() {
  if (appBridge.isPreview) return toast('本地数据目录请在桌面版中打开');
  const result = await appBridge.openDataFolder();
  if (result?.success) toast('已打开本地数据目录');
  else toast(`无法打开数据目录：${result?.error || '未知错误'}`, 'error');
}

async function createBackup() {
  if (appBridge.isPreview) return toast('数据备份请在桌面版中使用');
  const result = await appBridge.createBackup(store);
  if (!result.success) toast(`备份失败：${result.error}`, 'error');
  else if (!result.canceled) toast('写作数据备份完成');
}

async function restoreBackup() {
  if (appBridge.isPreview) return toast('恢复备份请在桌面版中使用');
  const result = await appBridge.readBackup();
  if (!result.success) return toast(`无法读取备份：${result.error}`, 'error');
  if (result.canceled) return;
  const action = await confirmDialog({
    title: '恢复这份备份？', message: '当前本地数据将被备份中的内容替换。若自动同步已启用，这次恢复也会同步到其他设备。建议先导出一次当前数据。',
    actions: [{ value: 'cancel', label: '取消', style: 'secondary' }, { value: 'restore', label: '确认恢复', style: 'danger' }]
  });
  if (action !== 'restore') return;
  const syncMetadata = deepClone(store.syncMetadata || { heads: {}, hashes: {} });
  store = hydrateStore(result.data);
  store.syncMetadata = syncMetadata;
  const success = await persistStore();
  if (success) { closeOverlay('settings-overlay'); applyTheme(); renderAll(); toast('备份恢复完成'); }
}

function openOverlay(id) {
  const overlay = byId(id); if (!overlay) return;
  overlay.classList.add('show'); overlay.setAttribute('aria-hidden', 'false');
}

function closeOverlay(id) {
  const overlay = byId(id); if (!overlay) return;
  overlay.classList.remove('show'); overlay.setAttribute('aria-hidden', 'true');
}

function confirmDialog({ title, message, icon = '!', actions = [] }) {
  if (confirmResolver) confirmResolver('cancel');
  dom['confirm-title'].textContent = title;
  dom['confirm-message'].textContent = message;
  dom['confirm-icon'].textContent = icon;
  dom['confirm-actions'].replaceChildren();
  return new Promise((resolve) => {
    confirmResolver = resolve;
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = `button ${action.style || 'secondary'}`;
      button.textContent = action.label;
      button.addEventListener('click', () => {
        closeOverlay('confirm-overlay'); confirmResolver = null; resolve(action.value);
      }, { once: true });
      dom['confirm-actions'].appendChild(button);
    }
    openOverlay('confirm-overlay');
  });
}

function toast(message, type = '') {
  const item = document.createElement('div'); item.className = `toast ${type}`; item.textContent = message;
  dom['toast-region'].appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

function persistStore() {
  store.updatedAt = isoNow();
  const snapshot = deepClone(store);
  let outcome = true;
  saveQueue = saveQueue.then(async () => {
    const result = await appBridge.saveStore(snapshot);
    outcome = Boolean(result.success);
    if (!result.success) toast(`保存失败：${result.error}`, 'error');
    else if (result.data) {
      store = reconcileStore(store, hydrateStore(result.data), snapshot);
      scheduleAutoSync();
    }
    return result;
  });
  return saveQueue.then(() => outcome).catch((error) => { toast(`保存失败：${error.message}`, 'error'); return false; });
}

function handleGlobalKeydown(event) {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'k' && !dom['editor-overlay'].classList.contains('show')) {
    event.preventDefault(); dom['search-input'].focus(); dom['search-input'].select();
  }
  if (modifier && event.key.toLowerCase() === 's' && dom['editor-overlay'].classList.contains('show')) {
    event.preventDefault(); commitDraft({ manual: true });
  }
  if (modifier && event.key.toLowerCase() === 'f' && dom['editor-overlay'].classList.contains('show')) {
    event.preventDefault(); openFindPanel();
  }
  if (modifier && event.key.toLowerCase() === 'n' && !dom['editor-overlay'].classList.contains('show')) {
    event.preventDefault(); openEditor();
  }
  if (event.key === 'Escape') {
    if (dom['confirm-overlay'].classList.contains('show')) return;
    if (dom['find-panel'].classList.contains('show')) closeFindPanel();
    else if (dom['history-overlay'].classList.contains('show')) closeOverlay('history-overlay');
    else if (dom['category-overlay'].classList.contains('show')) closeOverlay('category-overlay');
    else if (dom['settings-overlay'].classList.contains('show')) closeOverlay('settings-overlay');
    else if (dom['editor-overlay'].classList.contains('show')) requestCloseEditor();
  }
}

window.addEventListener('error', (event) => {
  console.error(event.error || event.message);
  if (dom['toast-region']) toast(`操作没有完成：${event.message}`, 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
  if (dom['toast-region']) toast(`操作没有完成：${event.reason?.message || event.reason || '未知错误'}`, 'error');
});

initialize();


function getArticleSyncBasis(id) {
  const key = `article:${id}`;
  return { heads: deepClone(store.syncMetadata?.heads?.[key] || []), hash: store.syncMetadata?.hashes?.[key] || null };
}

// Apply acknowledged changes while retaining edits queued after the request.
// Their original causal basis remains intact so concurrent remote edits create
// a conflict copy instead of being silently treated as overwritten revisions.
function reconcileStore(current, incoming, sent) {
  const result = hydrateStore(incoming);
  result.preferences = deepClone(current.preferences);
  result.syncMetadata ||= { heads: {}, hashes: {} };
  for (const [kind, field] of [['article', 'articles'], ['category', 'customCategories']]) {
    const baseline = new Map((sent[field] || []).map((item) => [item.id, item]));
    const desired = new Map((current[field] || []).map((item) => [item.id, item]));
    const merged = new Map((result[field] || []).map((item) => [item.id, item]));
    for (const id of new Set([...baseline.keys(), ...desired.keys()])) {
      if (JSON.stringify(baseline.get(id)) === JSON.stringify(desired.get(id))) continue;
      if (desired.has(id)) merged.set(id, deepClone(desired.get(id))); else merged.delete(id);
      const key = `${kind}:${id}`;
      if (current.syncMetadata?.heads?.[key]) result.syncMetadata.heads[key] = deepClone(current.syncMetadata.heads[key]);
      else delete result.syncMetadata.heads[key];
      if (current.syncMetadata?.hashes?.[key]) result.syncMetadata.hashes[key] = current.syncMetadata.hashes[key];
      else delete result.syncMetadata.hashes[key];
    }
    result[field] = [...merged.values()];
  }
  for (const date of new Set([...Object.keys(current.dailyStats || {}), ...Object.keys(sent.dailyStats || {})])) {
    if (current.dailyStats[date] === sent.dailyStats[date]) continue;
    result.dailyStats[date] = current.dailyStats[date];
    const key = `stat:${date}`;
    if (current.syncMetadata?.heads?.[key]) result.syncMetadata.heads[key] = deepClone(current.syncMetadata.heads[key]);
    else delete result.syncMetadata.heads[key];
    if (current.syncMetadata?.hashes?.[key]) result.syncMetadata.hashes[key] = current.syncMetadata.hashes[key];
    else delete result.syncMetadata.hashes[key];
  }
  return result;
}

function showSyncStatus(status) {
  syncStatus = status;
  const label = byId('sync-status');
  if (!label) return;
  if (!status) { label.textContent = '同步设置暂时不可用'; return; }
  const messages = {
    disabled: status.folder ? '自动同步已暂停，本地仍可正常写作' : '尚未启用',
    waiting: '已启用，等待同步', syncing: '正在同步…',
    ready: status.lastSyncAt ? `已与同步文件夹合并 · ${new Date(status.lastSyncAt).toLocaleTimeString('zh-CN')}` : '已就绪',
    warning: '部分文件暂未读取，将自动重试', error: '同步暂时失败，本地写作不受影响'
  };
  label.textContent = messages[status.phase] || '等待同步';
  if (status.conflicts) label.textContent += ` · 已保留 ${status.conflicts} 个冲突版本`;
  if (status.error) label.textContent += `。${status.error}`;
  byId('sync-folder-path').textContent = status.folder || '';
  byId('sync-now').disabled = !status.enabled || syncBusy;
  byId('sync-toggle').hidden = !status.folder;
  byId('sync-toggle').textContent = status.enabled ? '暂停同步' : '恢复同步';
  byId('sync-open-folder').hidden = !status.folder;
}
async function refreshSyncStatus() {
  if (!appBridge.getSyncStatus) {
    byId('sync-status').textContent = '自动同步请在桌面版中使用';
    byId('sync-choose-folder').disabled = true;
    return;
  }
  const result = await appBridge.getSyncStatus();
  if (result.success) showSyncStatus(result.status);
  else byId('sync-status').textContent = `同步配置错误：${result.error}`;
}
async function chooseSyncFolder() {
  if (!appBridge.chooseSyncFolder) return;
  const result = await appBridge.chooseSyncFolder();
  if (!result.success) return toast(`无法启用同步：${result.error}`, 'error');
  if (result.canceled) return;
  showSyncStatus(result.status);
  await synchronizeWriting(true);
}
async function toggleAutoSync() {
  const result = await appBridge.setSyncEnabled(!syncStatus?.enabled);
  if (!result.success) return toast(result.error, 'error');
  showSyncStatus(result.status);
  if (result.status.enabled) await synchronizeWriting(true);
}
function scheduleAutoSync() {
  if (!syncStatus?.enabled) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => synchronizeWriting(), 1200);
}
async function initializeAutoSync() {
  await refreshSyncStatus();
  if (!appBridge.runSync) return;
  setInterval(() => synchronizeWriting(), 15000);
  window.addEventListener('focus', () => synchronizeWriting());
  window.addEventListener('online', () => synchronizeWriting());
  await synchronizeWriting();
}
async function synchronizeWriting(manual = false) {
  if (!appBridge.runSync || !syncStatus?.enabled || syncBusy || composing) return;
  syncBusy = true;
  const beforeConflicts = syncStatus.conflicts || 0;
  try {
    if (editorDirty && !(await commitDraft())) return;
    await saveQueue;
    // Flush changes queued during an outstanding save before exchanging files.
    if (editorDirty) { scheduleAutoSync(); return; }
    const sent = deepClone(store);
    showSyncStatus({ ...syncStatus, phase: 'syncing' });
    const result = await appBridge.runSync();
    if (!result.success) throw new Error(result.error);
    if (result.data) {
      store = reconcileStore(store, hydrateStore(result.data), sent);
      if (editorDraft && !editorDirty) {
        const updated = store.articles.find((a) => a.id === editingId);
        if (updated && !updated.deletedAt && JSON.stringify(updated) !== JSON.stringify(editorDraft)) {
          const position = dom['markdown-editor'].selectionStart;
          editorDraft = deepClone(updated);
          editorSnapshot = JSON.stringify(editorDraft);
          populateEditor();
          dom['markdown-editor'].setSelectionRange(position, position);
          toast('当前文章已收到另一台设备的更新');
        } else if (!updated || updated.deletedAt) {
          closeEditor();
          toast('当前文章已在另一台设备移入回收站或删除');
        }
        if (editingId) editorSyncBasis = getArticleSyncBasis(editingId);
      }
      renderAll();
    }
    showSyncStatus(result.status);
    if (result.status.conflicts > beforeConflicts) toast('发现同时修改的内容，已保留同步冲突副本');
    else if (manual && result.status.phase === 'ready') toast('已与同步文件夹合并，跨设备传输由网盘完成');
  } catch (error) {
    showSyncStatus({ ...syncStatus, phase: 'error', error: error.message });
    if (manual) toast(`同步失败：${error.message}`, 'error');
  } finally {
    syncBusy = false;
    if (syncStatus) showSyncStatus(syncStatus);
  }
}


function assistantWidthBounds() {
  const width = dom['editor-workspace'].getBoundingClientRect().width || window.innerWidth;
  const overlay = window.innerWidth <= 860;
  const writingMinimum = dom['editor-body'].classList.contains('layout-split') ? 540 : 320;
  return { min: 260, max: Math.max(260, Math.min(720, overlay ? width - 40 : width - writingMinimum - 8)) };
}
function applyAssistantWidth(requested = null) {
  if (!dom['editor-workspace']) return;
  const bounds = assistantWidthBounds();
  const saved = Number(store.preferences.assistantWidth);
  const normal = store.preferences.assistantTab === 'ai' ? 410 : 310;
  const preferred = requested ?? (Number.isFinite(saved) && saved > 0 ? saved : normal);
  const width = Math.round(Math.max(bounds.min, Math.min(bounds.max, preferred)));
  dom['editor-workspace'].style.setProperty('--assistant-width', `${width}px`);
  const handle = byId('assistant-resizer');
  handle.setAttribute('aria-valuemin', String(bounds.min));
  handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
  handle.setAttribute('aria-valuenow', String(width));
  handle.setAttribute('aria-valuetext', `${width} 像素`);
  return width;
}
function bindAssistantResizer() {
  const handle = byId('assistant-resizer');
  let dragging = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || dragging) return;
    event.preventDefault();
    dragging = { id: event.pointerId, x: event.clientX, width: dom['writing-assistant'].getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-assistant');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    store.preferences.assistantWidth = applyAssistantWidth(dragging.width + dragging.x - event.clientX);
  });
  const finish = (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    dragging = null;
    document.body.classList.remove('resizing-assistant');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    persistStore();
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('dblclick', () => {
    store.preferences.assistantWidth = null;
    applyAssistantWidth();
    persistStore();
  });
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const bounds = assistantWidthBounds();
    const current = dom['writing-assistant'].getBoundingClientRect().width;
    const next = event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : current + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 10);
    store.preferences.assistantWidth = applyAssistantWidth(next);
    persistStore();
  });
  window.addEventListener('resize', () => applyAssistantWidth());
}
