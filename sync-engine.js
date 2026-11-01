'use strict';

// Each device owns one snapshot. Vector clocks retain concurrent revisions,
// including deletions; a delayed cloud file can never resurrect an older edit.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const LIMIT = 100 * 1024 * 1024;
const FORMAT = 'writing-space-sync-v1';
const clone = (value) => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
function writeAtomic(file, contents) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function covers(a, b) { return Object.entries(b).every(([id, n]) => (a[id] || 0) >= n); }
function mergeClock(versions) {
  const result = {};
  for (const version of versions) for (const [id, n] of Object.entries(version.clock)) result[id] = Math.max(result[id] || 0, n);
  return result;
}
function joinVersions(first, second) {
  const unique = new Map();
  for (const version of [...first, ...second]) {
    const key = canonical(version.clock);
    if (unique.has(key) && hash(unique.get(key).value) !== hash(version.value)) throw new Error('同步文件包含相同版本号的不同内容');
    unique.set(key, version);
  }
  const values = [...unique.values()];
  return values.filter((candidate) => !values.some((other) => other !== candidate && covers(other.clock, candidate.clock)))
    .sort((a, b) => hash(a).localeCompare(hash(b)));
}
function flatten(store) {
  const records = new Map();
  for (const [kind, list] of [['article', store.articles], ['category', store.customCategories]]) {
    for (const value of list || []) {
      if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 256) throw new Error('文章或分类缺少有效编号');
      const key = `${kind}:${value.id}`;
      if (records.has(key)) throw new Error('存在重复的文章或分类编号');
      records.set(key, value);
    }
  }
  for (const [date, words] of Object.entries(store.dailyStats || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(date)) records.set(`stat:${date}`, Number(words) || 0);
  return records;
}
function validateRecords(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records) || Object.keys(records).length > 100000) throw new Error('同步记录格式无效');
  for (const [key, versions] of Object.entries(records)) {
    if (!/^(article|category|stat):.{1,256}$/.test(key) || !Array.isArray(versions) || !versions.length || versions.length > 1000) throw new Error('同步记录格式无效');
    for (const version of versions) {
      if (!version || !version.clock || typeof version.clock !== 'object' || Array.isArray(version.clock) || !Object.keys(version.clock).length) throw new Error('同步版本信息无效');
      for (const [id, n] of Object.entries(version.clock)) if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(n) || n < 1) throw new Error('同步版本号无效');
      if (!Object.hasOwn(version, 'value')) throw new Error('同步内容缺失');
      if (key.startsWith('stat:')) {
        if (version.value !== null && (!Number.isFinite(version.value) || version.value < 0)) throw new Error('写作统计无效');
      } else if (version.value !== null && (typeof version.value !== 'object' || Array.isArray(version.value) || version.value.id !== key.slice(key.indexOf(':') + 1))) throw new Error('同步文章编号不匹配');
    }
  }
}

class SyncEngine {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.settingsPath = path.join(directory, 'sync-settings.json');
    this.statePath = path.join(directory, 'sync-state.json');
    this.settings = fs.existsSync(this.settingsPath) ? JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) : { deviceId: crypto.randomUUID(), deviceName: os.hostname(), enabled: false, folder: '' };
    if (!/^[a-f0-9-]{36}$/.test(this.settings.deviceId || '')) throw new Error('本机同步配置损坏，请恢复配置备份');
    this.state = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : { records: {}, sequence: 0 };
    if (Object.keys(this.state.records || {}).length) validateRecords(this.state.records);
    this.state.sequence = Object.values(this.state.records).flat().reduce((n, v) => Math.max(n, v.clock[this.settings.deviceId] || 0), Number(this.state.sequence) || 0);
    this.status = { phase: this.settings.enabled ? 'waiting' : 'disabled', lastSyncAt: null, error: '', conflicts: 0 };
    this.remoteCache = new Map();
    this.saveSettings();
  }
  saveSettings() { writeAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2)); }
  saveState() { writeAtomic(this.statePath, JSON.stringify(this.state)); }
  configure(folder) {
    if (!path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) throw new Error('请选择已存在的网盘同步文件夹');
    const resolved = fs.realpathSync(folder);
    const local = fs.realpathSync(this.directory);
    if (resolved === local || resolved.startsWith(`${local}${path.sep}`) || local.startsWith(`${resolved}${path.sep}`)) throw new Error('不能把本地数据目录作为同步文件夹');
    this.settings.folder = resolved;
    this.settings.enabled = true;
    this.saveSettings();
    this.remoteCache.clear();
    this.status = { ...this.status, phase: 'waiting', error: '', lastSyncAt: null };
  }
  pause() { this.settings.enabled = false; this.saveSettings(); this.status.phase = 'disabled'; }
  resume() { if (!this.settings.folder) throw new Error('请先选择同步文件夹'); this.settings.enabled = true; this.saveSettings(); this.status.phase = 'waiting'; }
  getStatus() { return { ...this.status, enabled: this.settings.enabled, folder: this.settings.folder, deviceName: this.settings.deviceName }; }
  captureLocal(store) {
    const desired = flatten(store);
    const metadata = store.syncMetadata || { hashes: {}, heads: {} };
    const hashes = metadata.hashes || {};
    const keys = new Set([...desired.keys(), ...Object.keys(hashes)]);
    for (const key of keys) {
      const value = desired.has(key) ? desired.get(key) : null;
      if (hashes[key] === hash(value)) continue;
      // Unknown rows in a newer shared snapshot are not deletions in an older UI.
      if (!desired.has(key) && !Object.hasOwn(hashes, key)) continue;
      const current = this.state.records[key] || [];
      if (current.length === 1 && hash(current[0].value) === hash(value)) continue;
      const parents = metadata.heads?.[key] || [];
      const clock = mergeClock(parents.map((clock) => ({ clock })));
      this.state.sequence += 1;
      clock[this.settings.deviceId] = this.state.sequence;
      const version = { clock, value: clone(value), author: this.settings.deviceName, at: new Date().toISOString() };
      this.state.records[key] = joinVersions(current, [version]);
    }
    this.preserveConflicts();
    this.saveState();
    return this.materialize(store);
  }
  preserveConflicts() {
    let conflicts = 0;
    for (const [key, versions] of Object.entries(this.state.records)) {
      if (versions.length < 2 || key.startsWith('stat:')) continue;
      const sorted = [...versions].sort((a, b) => String(b.at).localeCompare(String(a.at)) || hash(b).localeCompare(hash(a)));
      const seen = new Set();
      const unique = sorted.filter((v) => { const key = hash(v.value); if (seen.has(key)) return false; seen.add(key); return true; });
      if (unique.length < 2) continue;
      conflicts += unique.length - 1;
      // Timestamp affects only which revision is displayed as the primary.
      // Causal dominance, never the wall clock, decides whether an edit survives.
      unique.sort((a, b) => String(b.at).localeCompare(String(a.at)) || hash(b).localeCompare(hash(a)));
      for (const version of unique.slice(1)) {
        if (version.value === null) continue;
        const original = version.value;
        const id = `sync-conflict-${hash({ key, clock: version.clock }).slice(0, 32)}`;
        const copyKey = `${key.split(':')[0]}:${id}`;
        if (Object.hasOwn(this.state.records, copyKey)) continue;
        const value = { ...clone(original), id, syncConflictOf: original.id };
        if (key.startsWith('article:')) value.title = `${original.title || '未命名文章'}（同步冲突副本）`;
        else value.name = `${original.name || '分类'}（同步冲突副本）`;
        this.state.records[copyKey] = [{ ...clone(version), value }];
      }
    }
    this.status.conflicts = conflicts;
  }
  materialize(local) {
    const output = { ...clone(local), articles: [], customCategories: [], dailyStats: {}, syncMetadata: { hashes: {}, heads: {} } };
    for (const [key, versions] of Object.entries(this.state.records)) {
      const sorted = [...versions].sort((a, b) => String(b.at).localeCompare(String(a.at)) || hash(b).localeCompare(hash(a)));
      const value = key.startsWith('stat:') ? Math.max(0, ...sorted.map((v) => Number(v.value) || 0)) : sorted[0].value;
      output.syncMetadata.hashes[key] = hash(value);
      output.syncMetadata.heads[key] = versions.map((version) => clone(version.clock));
      if (value === null) continue;
      if (key.startsWith('article:')) output.articles.push(clone(value));
      else if (key.startsWith('category:')) output.customCategories.push(clone(value));
      else output.dailyStats[key.slice(5)] = value;
    }
    const categories = new Set(['novel', 'short', 'essay', 'reading', 'inspiration', ...output.customCategories.map((category) => category.id)]);
    // Deleted categories never hide their articles. Keep the original record
    // intact so a category arriving later restores the correct association.
    for (const article of output.articles) if (!categories.has(article.category)) {
      article.category = 'essay';
      output.syncMetadata.hashes[`article:${article.id}`] = hash(article);
    }
    return output;
  }
  synchronize(local) {
    if (!this.settings.enabled) return { data: local, status: this.getStatus() };
    this.status.phase = 'syncing';
    this.status.error = '';
    try {
      const folder = this.settings.folder;
      // A missing drive is an offline state. Do not create a replacement folder.
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('同步文件夹暂时不可用，本地写作仍可保存');
      const devices = path.join(folder, 'writing-space-sync-v1', 'devices');
      fs.mkdirSync(devices, { recursive: true });
      const issues = [];
      for (const name of fs.readdirSync(devices).sort()) {
        if (!name.endsWith('.json.gz')) continue;
        const file = path.join(devices, name);
        try {
          const stat = fs.statSync(file);
          const signature = `${stat.size}:${stat.mtimeMs}`;
          if (this.remoteCache.get(file) === signature) continue;
          if (stat.size > LIMIT) throw new Error('同步文件过大');
          const bytes = zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: LIMIT });
          const payload = JSON.parse(bytes.toString('utf8'));
          if (payload.format !== FORMAT || !/^[a-f0-9-]{36}$/.test(payload.deviceId || '')) throw new Error('同步文件格式不受支持');
          validateRecords(payload.records);
          // Validate and merge into a candidate before accepting any rows.
          const candidate = { ...this.state.records };
          for (const [key, versions] of Object.entries(payload.records)) candidate[key] = joinVersions(candidate[key] || [], versions);
          this.state.records = candidate;
          this.state.sequence = Object.values(candidate).flat().reduce((n, v) => Math.max(n, v.clock[this.settings.deviceId] || 0), this.state.sequence);
          this.remoteCache.set(file, signature);
        } catch (error) { issues.push(`${name}：${error.message}`); }
      }
      this.preserveConflicts();
      this.saveState();
      const payload = { format: FORMAT, deviceId: this.settings.deviceId, deviceName: this.settings.deviceName, records: this.state.records };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized) > LIMIT) throw new Error('同步数据超过 100MB，请先导出备份并精简文章历史');
      const destination = path.join(devices, `${this.settings.deviceId}.json.gz`);
      const compressed = zlib.gzipSync(serialized);
      const digest = hash(payload);
      if (digest !== this.publishedHash || !fs.existsSync(destination)) {
        writeAtomic(destination, compressed);
        this.publishedHash = digest;
        const stat = fs.statSync(destination);
        this.remoteCache.set(destination, `${stat.size}:${stat.mtimeMs}`);
      }
      this.status.phase = issues.length ? 'warning' : 'ready';
      this.status.error = issues.length ? `部分同步文件暂未读取，将自动重试。${issues[0]}` : '';
      this.status.lastSyncAt = new Date().toISOString();
      return { data: this.materialize(local), status: this.getStatus() };
    } catch (error) {
      this.status.phase = 'error';
      this.status.error = error.message;
      return { data: this.materialize(local), status: this.getStatus() };
    }
  }
}

module.exports = { SyncEngine, joinVersions, hash, flatten, writeAtomic };
