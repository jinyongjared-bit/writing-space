'use strict';

const fs = require('fs');
const mammoth = require('mammoth');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} = require('docx');

function cleanMarkdown(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html) {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**'
  });
  service.use(gfm);
  service.addRule('preserveHighlight', {
    filter: ['mark'],
    replacement: (content) => `==${content}==`
  });
  const tables = [];
  const prepared = String(html || '').replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) => {
      return [...rowMatch[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cellMatch) => {
        return service.turndown(cellMatch[1]).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
      });
    }).filter((row) => row.length);
    if (!rows.length) return '';
    const columnCount = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => Array.from({ length: columnCount }, (_value, index) => row[index] || ''));
    const markdown = [
      `| ${normalized[0].join(' | ')} |`,
      `| ${normalized[0].map(() => '---').join(' | ')} |`,
      ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`)
    ].join('\n');
    const token = `WRITINGSPACETABLETOKEN${tables.length}`;
    tables.push(markdown);
    return `<p>${token}</p>`;
  });
  let markdown = service.turndown(prepared);
  tables.forEach((table, index) => { markdown = markdown.replace(`WRITINGSPACETABLETOKEN${index}`, table); });
  return cleanMarkdown(markdown);
}

async function importWordAsMarkdown(filePath) {
  const result = await mammoth.convertToHtml({ path: filePath }, {
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Subtitle'] => p:fresh",
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh"
    ],
    includeDefaultStyleMap: true
  });
  return {
    content: htmlToMarkdown(result.value),
    warnings: result.messages.map((message) => message.message).filter(Boolean)
  };
}

function median(numbers) {
  const values = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return 12;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function joinPdfFragments(items) {
  let output = '';
  for (const item of items) {
    const text = String(item.str || '');
    if (!text) continue;
    if (!output) { output = text; continue; }
    const left = output.at(-1);
    const right = text[0];
    const noSpace = /[\u3400-\u9fff，。！？；：、“”‘’（）【】]/.test(left) || /[\u3400-\u9fff，。！？；：、“”‘’（）【】]/.test(right);
    output += noSpace ? text : ` ${text}`;
  }
  return output.replace(/\s+([,.;:!?，。！？；：])/g, '$1').trim();
}

function pageTextToMarkdown(textContent) {
  const groups = [];
  for (const item of textContent.items || []) {
    if (!item.str?.trim()) continue;
    const x = Number(item.transform?.[4] || 0);
    const y = Number(item.transform?.[5] || 0);
    const size = Math.max(Math.abs(Number(item.transform?.[0] || 0)), Math.abs(Number(item.transform?.[3] || 0)), Number(item.height || 0));
    let line = groups.find((entry) => Math.abs(entry.y - y) <= Math.max(2.5, size * .22));
    if (!line) { line = { y, size: 0, items: [] }; groups.push(line); }
    line.size = Math.max(line.size, size);
    line.items.push({ x, str: item.str });
  }
  groups.sort((a, b) => b.y - a.y);
  const bodySize = median(groups.map((line) => line.size).filter((size) => size > 0));
  const output = [];
  let previousY = null;
  for (const line of groups) {
    line.items.sort((a, b) => a.x - b.x);
    const text = joinPdfFragments(line.items);
    if (!text || /^\d+$/.test(text) && text.length <= 3) continue;
    const ratio = line.size / Math.max(bodySize, 1);
    let rendered = text;
    if (ratio >= 1.65 && text.length <= 80) rendered = `# ${text}`;
    else if (ratio >= 1.28 && text.length <= 100) rendered = `## ${text}`;
    const gap = previousY === null ? 0 : previousY - line.y;
    if (output.length && (gap > bodySize * 1.7 || rendered.startsWith('#'))) output.push('');
    output.push(rendered);
    previousY = line.y;
  }
  return cleanMarkdown(output.join('\n'));
}

async function importPdfAsMarkdown(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const markdown = pageTextToMarkdown(textContent);
    if (markdown) pages.push(markdown);
  }
  await pdf.destroy();
  if (!pages.length) throw new Error('没有识别到可复制的文字；扫描版 PDF 暂不支持 OCR');
  return { content: pages.join('\n\n---\n\n'), warnings: [] };
}

function inlineChildren(text) {
  const value = String(text || '');
  const expression = /(!?\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|~~[^~]+~~|==[^=]+==|`[^`]+`|(?<!\*)\*[^*]+\*(?!\*))/g;
  const children = [];
  let cursor = 0;
  let match;
  while ((match = expression.exec(value))) {
    if (match.index > cursor) children.push(new TextRun(value.slice(cursor, match.index)));
    const token = match[0];
    const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (image) children.push(new TextRun({ text: `[图片：${image[1] || '未命名'}]`, italics: true, color: '66736C' }));
    else if (link) children.push(new ExternalHyperlink({ link: link[2], children: [new TextRun({ text: link[1], style: 'Hyperlink' })] }));
    else if (token.startsWith('**')) children.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    else if (token.startsWith('~~')) children.push(new TextRun({ text: token.slice(2, -2), strike: true }));
    else if (token.startsWith('==')) children.push(new TextRun({ text: token.slice(2, -2), highlight: 'yellow' }));
    else if (token.startsWith('`')) children.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'EEF0ED' } }));
    else children.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    cursor = expression.lastIndex;
  }
  if (cursor < value.length) children.push(new TextRun(value.slice(cursor)));
  return children.length ? children : [new TextRun('')];
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function markdownBlocks(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const children = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) { code.push(lines[index]); index += 1; }
      children.push(new Paragraph({
        children: [new TextRun({ text: `${language ? `${language}\n` : ''}${code.join('\n')}`, font: 'Consolas', size: 19 })],
        spacing: { before: 140, after: 180 },
        indent: { left: 260, right: 260 },
        shading: { type: ShadingType.CLEAR, fill: 'F2F3F1' }
      }));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
      children.push(new Paragraph({ heading: levels[heading[1].length - 1], children: inlineChildren(heading[2]) }));
      continue;
    }
    const next = lines[index + 1] || '';
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(tableCells(lines[index])); index += 1; }
      index -= 1;
      const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
      const makeRow = (cells, header = false) => new TableRow({
        children: headers.map((_item, cellIndex) => new TableCell({
          margins: { top: 110, bottom: 110, left: 130, right: 130 },
          shading: header ? { type: ShadingType.CLEAR, fill: 'E8F0EB' } : undefined,
          borders: { top: border, bottom: border, left: border, right: border },
          children: [new Paragraph({ children: inlineChildren(cells[cellIndex] || ''), alignment: AlignmentType.LEFT })]
        }))
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [makeRow(headers, true), ...rows.map((row) => makeRow(row))]
      }));
      children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      continue;
    }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      children.push(new Paragraph({ children: [new TextRun(`${task[1].toLowerCase() === 'x' ? '☑' : '☐'} `), ...inlineChildren(task[2])], indent: { left: 360 }, spacing: { after: 70 } }));
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) { children.push(new Paragraph({ children: inlineChildren(unordered[1]), bullet: { level: 0 } })); continue; }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) { children.push(new Paragraph({ children: inlineChildren(ordered[1]), numbering: { reference: 'numbered-list', level: 0 } })); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      children.push(new Paragraph({
        children: inlineChildren(quote[1]),
        italics: true,
        indent: { left: 360 },
        borders: { left: { style: BorderStyle.SINGLE, size: 14, color: '2F7457', space: 10 } },
        spacing: { before: 100, after: 100 }
      }));
      continue;
    }
    if (/^([-*_]){3,}$/.test(trimmed.replace(/\s/g, ''))) {
      children.push(new Paragraph({ text: '', borders: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C9CEC9' } }, spacing: { before: 120, after: 180 } }));
      continue;
    }
    children.push(new Paragraph({ children: inlineChildren(line), spacing: { after: 150 }, keepLines: true }));
  }
  return children;
}

async function exportMarkdownAsWord({ title, source, keywords = [] }) {
  const titleParagraph = new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: String(title || '未命名文章'), bold: true, color: '000000' })],
    spacing: { after: keywords.length ? 100 : 320 }
  });
  const children = [titleParagraph];
  if (keywords.length) {
    children.push(new Paragraph({
      children: [new TextRun({ text: `关键词：${keywords.join('、')}`, color: '66736C', size: 19 })],
      spacing: { after: 300 }
    }));
  }
  children.push(...markdownBlocks(source));
  const document = new Document({
    creator: '写作空间',
    title: String(title || '未命名文章'),
    description: '由写作空间导出',
    styles: {
      default: {
        document: { run: { font: 'Microsoft YaHei', size: 22, color: '20241F' }, paragraph: { spacing: { line: 360 } } },
        title: { run: { font: 'Microsoft YaHei', size: 38, bold: true, color: '000000' }, paragraph: { spacing: { after: 320 } } },
        heading1: { run: { font: 'Microsoft YaHei', size: 31, bold: true, color: '000000' }, paragraph: { spacing: { before: 320, after: 150 }, keepNext: true } },
        heading2: { run: { font: 'Microsoft YaHei', size: 27, bold: true, color: '000000' }, paragraph: { spacing: { before: 270, after: 130 }, keepNext: true } },
        heading3: { run: { font: 'Microsoft YaHei', size: 24, bold: true, color: '000000' }, paragraph: { spacing: { before: 220, after: 110 }, keepNext: true } }
      }
    },
    numbering: {
      config: [{
        reference: 'numbered-list',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 520, hanging: 260 } } } }]
      }]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1134, right: 1276, bottom: 1134, left: 1276 }
        }
      },
      children
    }]
  });
  return Packer.toBuffer(document);
}

module.exports = { exportMarkdownAsWord, htmlToMarkdown, importPdfAsMarkdown, importWordAsMarkdown };
