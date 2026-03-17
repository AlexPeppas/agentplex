import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = join(__dirname, '..', 'assets');
const svg = join(assets, 'logo.svg');

// PNG 512x512
await sharp(svg, { density: 400 })
  .resize(512, 512)
  .png()
  .toFile(join(assets, 'logo.png'));
console.log('logo.png created');

// Multi-size ICO (16, 32, 48, 64, 128, 256)
const sizes = [16, 32, 48, 64, 128, 256];
const pngBuffers = [];
for (const size of sizes) {
  const buf = await sharp(svg, { density: 400 })
    .resize(size, size)
    .png()
    .toBuffer();
  pngBuffers.push({ size, buf });
}

const headerSize = 6;
const entrySize = 16;
const numImages = pngBuffers.length;
const dirSize = headerSize + entrySize * numImages;

const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(numImages, 4);

let offset = dirSize;
const entries = [];
for (const { size, buf } of pngBuffers) {
  const entry = Buffer.alloc(entrySize);
  entry.writeUInt8(size < 256 ? size : 0, 0);
  entry.writeUInt8(size < 256 ? size : 0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(buf.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += buf.length;
}

const ico = Buffer.concat([header, ...entries, ...pngBuffers.map(p => p.buf)]);
writeFileSync(join(assets, 'logo.ico'), ico);
console.log('logo.ico created (' + sizes.join(', ') + 'px)');
