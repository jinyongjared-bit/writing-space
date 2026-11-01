'use strict';

const fs = require('fs');
const path = require('path');

async function writePdfFromHtml({ BrowserWindow, html, outputPath, temporaryDirectory }) {
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const temporaryHtml = path.join(temporaryDirectory, `.pdf-export-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.html`);
  const exportWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  try {
    fs.writeFileSync(temporaryHtml, String(html || ''), 'utf8');
    await exportWindow.loadFile(temporaryHtml);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const pdf = await exportWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.55, left: 0.58, right: 0.58 }
    });
    fs.writeFileSync(outputPath, pdf);
    return { bytes: pdf.length };
  } finally {
    if (!exportWindow.isDestroyed()) exportWindow.destroy();
    if (fs.existsSync(temporaryHtml)) fs.unlinkSync(temporaryHtml);
  }
}

module.exports = { writePdfFromHtml };
