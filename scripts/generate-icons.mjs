import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = join(__dirname, '..', 'assets');
const svg = join(assets, 'logo.svg');

// PNG 512x512
await sharp(svg, { density: 300 })
  .resize(512, 512)
  .png()
  .toFile(join(assets, 'logo.png'));
console.log('logo.png created');

// ICO 256x256 (single PNG-in-ICO)
const buf = await sharp(svg, { density: 300 })
  .resize(256, 256)
  .png()
  .toBuffer();

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);
entry.writeUInt8(0, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(buf.length, 8);
entry.writeUInt32LE(22, 12);

writeFileSync(join(assets, 'logo.ico'), Buffer.concat([header, entry, buf]));
console.log('logo.ico created');
