import sharp from 'sharp';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

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

// macOS .icns — requires iconutil (ships with macOS)
if (process.platform === 'darwin') {
  const iconsetDir = join(assets, 'logo.iconset');
  mkdirSync(iconsetDir, { recursive: true });

  const icnsSizes = [16, 32, 64, 128, 256, 512];
  for (const size of icnsSizes) {
    await sharp(svg, { density: 400 })
      .resize(size, size)
      .png()
      .toFile(join(iconsetDir, `icon_${size}x${size}.png`));
    // @2x variants (up to 256 -> 512@2x)
    if (size <= 256) {
      await sharp(svg, { density: 400 })
        .resize(size * 2, size * 2)
        .png()
        .toFile(join(iconsetDir, `icon_${size}x${size}@2x.png`));
    }
  }

  const icnsPath = join(assets, 'logo.icns');
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath]);
  rmSync(iconsetDir, { recursive: true });
  console.log('logo.icns created');
}
