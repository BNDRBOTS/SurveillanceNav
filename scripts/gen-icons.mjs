/**
 * Generates PWA PNG icons (192, 512, maskable-512) without dependencies:
 * rasterizes the lens mark onto an RGBA buffer and writes valid PNGs
 * (zlib deflate via node:zlib + hand-computed CRC32).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = ~0;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function writePng(file, size, draw) {
  const px = Buffer.alloc(size * size * 4);
  draw(px, size);
  // filter byte 0 per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(outDir, file), png);
  console.log(`icons: ${file} (${png.length} bytes)`);
}

const BG = [4, 4, 7, 255];
const GOLD = [233, 196, 106, 255];

function drawLens(px, size, { pad = 0 } = {}) {
  const set = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const cx = size / 2;
  const cy = size / 2;
  const usable = size / 2 - pad;
  const rOuter = usable * 0.62;
  const ring = usable * 0.085;
  const rInner = usable * 0.27;
  const tick = usable * 0.075;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      set(x, y, BG);
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - rOuter) <= ring) set(x, y, GOLD);
      if (d <= rInner) set(x, y, GOLD);
      // crosshair ticks
      const along = (v, c) => Math.abs(v - c) <= tick;
      const inTickRange = d >= rOuter + ring * 1.6 && d <= usable * 0.97;
      if (inTickRange && (along(x, cx) || along(y, cy))) set(x, y, GOLD);
    }
  }
}

writePng('icon-192.png', 192, (px, s) => drawLens(px, s));
writePng('icon-512.png', 512, (px, s) => drawLens(px, s));
// maskable: 20% safe-zone padding
writePng('icon-maskable-512.png', 512, (px, s) => drawLens(px, s, { pad: s * 0.12 }));
