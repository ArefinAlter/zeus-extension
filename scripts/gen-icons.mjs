// Generates the placeholder toolbar icons (a bolt on a rounded square) as PNG files in icons/,
// with no dependency beyond node:zlib. Chrome needs PNG; the matching SVG source is icons/zeus.svg.
//
//   node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
const SIZES = [16, 32, 48, 128];

const BACKGROUND = [0x1b, 0x2a, 0x5e];
const BOLT = [0xff, 0xd2, 0x3f];
/** The bolt in unit coordinates; the same points appear in icons/zeus.svg. */
const POLYGON = [
  [0.6, 0.08],
  [0.26, 0.54],
  [0.46, 0.54],
  [0.38, 0.92],
  [0.76, 0.4],
  [0.55, 0.4],
  [0.68, 0.08],
];
const RADIUS = 0.22;

/** @param {number} x @param {number} y */
function insideRoundedSquare(x, y) {
  const dx = Math.max(RADIUS - x, x - (1 - RADIUS), 0);
  const dy = Math.max(RADIUS - y, y - (1 - RADIUS), 0);
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

/** @param {number} x @param {number} y */
function insideBolt(x, y) {
  let inside = false;
  for (let i = 0, j = POLYGON.length - 1; i < POLYGON.length; j = i++) {
    const [xi = 0, yi = 0] = POLYGON[i] ?? [];
    const [xj = 0, yj = 0] = POLYGON[j] ?? [];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** @param {number} size */
function render(size) {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let bolt = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (insideRoundedSquare(x, y)) {
            bg++;
            if (insideBolt(x, y)) bolt++;
          }
        }
      }
      const total = samples * samples;
      const alpha = bg / total;
      const boltShare = bg === 0 ? 0 : bolt / bg;
      const o = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[o + c] = Math.round(
          (BACKGROUND[c] ?? 0) * (1 - boltShare) + (BOLT[c] ?? 0) * boltShare,
        );
      }
      pixels[o + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {number} size @param {Buffer} rgba */
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  writeFileSync(join(outDir, `icon-${size}.png`), png(size, render(size)));
  console.log(`wrote icons/icon-${size}.png`);
}
const points = POLYGON.map(
  ([x = 0, y = 0]) => `${(x * 128).toFixed(1)},${(y * 128).toFixed(1)}`,
).join(' ');
writeFileSync(
  join(outDir, 'zeus.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">\n  <rect width="128" height="128" rx="${(RADIUS * 128).toFixed(1)}" fill="#1b2a5e"/>\n  <polygon points="${points}" fill="#ffd23f"/>\n</svg>\n`,
);
console.log('wrote icons/zeus.svg');
