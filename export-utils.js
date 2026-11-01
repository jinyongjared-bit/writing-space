'use strict';

const fs = require('fs');
const path = require('path');

function safeExportName(value) {
  let name = String(value || '未命名文章')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  if (!name) name = '未命名文章';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  return name;
}

function uniqueDirectoryPath(parentDirectory, baseName) {
  let candidate = path.join(parentDirectory, baseName);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parentDirectory, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function writeBatchExport(parentDirectory, extension, items, date = new Date()) {
  const plan = createBatchExportPlan(parentDirectory, extension, items, date);
  for (const entry of plan.entries) fs.writeFileSync(entry.filePath, String(entry.item.content || ''), 'utf8');
  return plan.targetDirectory;
}

function createBatchExportPlan(parentDirectory, extension, items, date = new Date()) {
  const dateLabel = date.toISOString().slice(0, 10);
  const targetDirectory = uniqueDirectoryPath(parentDirectory, `写作空间导出-${dateLabel}`);
  fs.mkdirSync(targetDirectory, { recursive: false });
  const usedNames = new Map();
  const entries = items.map((item) => {
    const fileName = safeExportName(item.fileName);
    const key = fileName.toLocaleLowerCase('zh-CN');
    const count = (usedNames.get(key) || 0) + 1;
    usedNames.set(key, count);
    const suffix = count === 1 ? '' : ` (${count})`;
    return { item, filePath: path.join(targetDirectory, `${fileName}${suffix}.${extension}`) };
  });
  return { targetDirectory, entries };
}

module.exports = { createBatchExportPlan, safeExportName, uniqueDirectoryPath, writeBatchExport };
