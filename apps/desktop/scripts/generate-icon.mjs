// Generates apps/desktop/resources/icon.png, a simple app icon for the
// desktop shell: a DeepSeek-blue rounded square with a white diagonal stripe.
//
// Run from the repository root: node apps/desktop/scripts/generate-icon.mjs

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'resources', 'icon.png');
const SIZE = 256;
const CORNER = 48;
const STRIPE_MIN = 64;
const STRIPE_MAX = 100;
const BLUE = [77, 107, 254, 255]; // #4D6BFE
const WHITE = [255, 255, 255, 255];

function inRoundedRect(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const half = SIZE / 2 - CORNER;
  const ax = Math.abs(x - cx) - half;
  const ay = Math.abs(y - cy) - half;
  if (ax <= 0 && ay <= 0) return true;
  if (ax > 0 && ay > 0) return ax * ax + ay * ay <= CORNER * CORNER;
  return ax <= CORNER && ay <= CORNER;
}

function pixel(x, y) {
  if (!inRoundedRect(x, y)) return [0, 0, 0, 0];
  const band = x - y;
  if (band >= STRIPE_MIN && band <= STRIPE_MAX) return WHITE;
  return BLUE;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const raw = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    const offset = (y * SIZE + x) * 4;
    raw[offset] = r;
    raw[offset + 1] = g;
    raw[offset + 2] = b;
    raw[offset + 3] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// compression, filter, interlace default to 0

let scanlines = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  scanlines[y * (SIZE * 4 + 1)] = 0; // filter: none
  raw.copy(scanlines, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes)`);