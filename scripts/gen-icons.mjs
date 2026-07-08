// Erzeugt einfache PNG-App-Icons (rote Kachel mit Kreis) ohne externe Abhängigkeiten.
// Aufruf: node scripts/gen-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'frontend', 'icons');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size * 0.52, r = size * (maskable ? 0.30 : 0.34);
  const corner = maskable ? 0 : size * 0.19; // maskable = volle Fläche
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // abgerundete Ecken (nur nicht-maskable)
      let inside = true;
      if (corner > 0) {
        const dx = Math.max(corner - x, x - (size - corner), 0);
        const dy = Math.max(corner - y, y - (size - corner), 0);
        if (dx * dx + dy * dy > corner * corner) inside = false;
      }
      let R = 0xb9, G = 0x1c, B = 0x1c, A = inside ? 255 : 0;
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) { R = 0x7f; G = 0x1d; B = 0x1d; }        // dunkler Kreis
      if (d < r * 0.5) { R = 0xfe; G = 0xf3; B = 0xc7; }   // heller Kern
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = A;
    }
  }
  // Scanlines mit Filter-Byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makePng(192, false));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makePng(512, false));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), makePng(512, true));
console.log('Icons erzeugt in', outDir);
