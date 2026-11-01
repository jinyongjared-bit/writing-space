'use strict';

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const assets = path.join(projectRoot, 'assets');

function buildIco(images, sizes) {
  const directorySize = 6 + sizes.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = directorySize;
  sizes.forEach((size, index) => {
    const png = images[size];
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...sizes.map((size) => images[size])]);
}

function icnsChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

function buildIcns(images) {
  const chunks = [
    icnsChunk('icp4', images[16]),
    icnsChunk('icp5', images[32]),
    icnsChunk('icp6', images[64]),
    icnsChunk('ic07', images[128]),
    icnsChunk('ic08', images[256]),
    icnsChunk('ic09', images[512]),
    icnsChunk('ic10', images[1024])
  ];
  const size = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(size, 4);
  return Buffer.concat([header, ...chunks]);
}

app.whenReady().then(async () => {
  const sourcePath = path.join(assets, 'icon-source.png');
  const source = nativeImage.createFromPath(sourcePath);
  if (source.isEmpty()) throw new Error('无法读取应用图标源文件 assets/icon-source.png');
  const sourceSize = source.getSize();
  if (sourceSize.width !== sourceSize.height || sourceSize.width < 1024) {
    throw new Error(`应用图标源文件必须是至少 1024×1024 的正方形，当前为 ${sourceSize.width}×${sourceSize.height}`);
  }
  const images = {};
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    images[size] = source.resize({ width: size, height: size, quality: 'best' }).toPNG();
  }
  fs.copyFileSync(sourcePath, path.join(assets, 'icon.png'));
  fs.writeFileSync(path.join(assets, 'icon-512.png'), images[512]);
  fs.writeFileSync(path.join(assets, 'icon-256.png'), images[256]);
  fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(images, [16, 24, 32, 48, 64, 128, 256]));
  fs.writeFileSync(path.join(assets, 'icon.icns'), buildIcns(images));
  app.quit();
}).catch((error) => {
  console.error(error.stack || error.message);
  app.exit(1);
});
