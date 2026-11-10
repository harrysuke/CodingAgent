/**
 * Generates the Tauri icon set (PNG / ICO / ICNS) with no external deps.
 *
 * The Windows .ico uses classic 32-bit BITMAPINFOHEADER (DIB) entries rather
 * than PNG-compressed entries: rc.exe, which tauri-winres invokes to build the
 * executable's resources, rejects PNG entries with RC2176 "old DIB".
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apps/desktop/src-tauri/icons');
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** RGBA raster, top-down, size*size*4 bytes. */
function raster(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const thickness = Math.max(1.4, size * 0.052);
  const lines = [
    [0.40, 0.27, 0.22, 0.50, 0.40, 0.73],
    [0.60, 0.27, 0.78, 0.50, 0.60, 0.73],
    [0.57, 0.20, 0.43, 0.80],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const cx = Math.min(Math.max(u * size, radius), size - radius);
      const cy = Math.min(Math.max(v * size, radius), size - radius);
      const inside = Math.hypot(u * size - cx, v * size - cy) <= radius;
      const i = (y * size + x) * 4;
      if (!inside) { pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0; continue; }
      let isGlyph = false;
      for (const l of lines) {
        if (l.length === 6) {
          if (distToSegment(u, v, l[0], l[1], l[2], l[3]) < thickness / size ||
              distToSegment(u, v, l[2], l[3], l[4], l[5]) < thickness / size) { isGlyph = true; break; }
        } else if (distToSegment(u, v, l[0], l[1], l[2], l[3]) < thickness / size) { isGlyph = true; break; }
      }
      const [r, g, b] = isGlyph ? [255, 255, 255] : [79, 70, 229];
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function png(size, pixels) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ICO image payload: BITMAPINFOHEADER + bottom-up BGRA XOR bitmap + 1bpp AND
 * mask. biHeight is doubled because the mask follows the colour bitmap.
 */
function dib(size, pixels) {
  const xorSize = size * size * 4;
  const andStride = Math.ceil(size / 32) * 4; // 1bpp rows padded to 4 bytes
  const andSize = andStride * size;
  const out = Buffer.alloc(40 + xorSize + andSize);
  out.writeUInt32LE(40, 0);          // biSize = sizeof(BITMAPINFOHEADER)
  out.writeInt32LE(size, 4);         // biWidth
  out.writeInt32LE(size * 2, 8);     // biHeight = XOR + AND
  out.writeUInt16LE(1, 12);          // biPlanes
  out.writeUInt16LE(32, 14);         // biBitCount (BGRA)
  out.writeUInt32LE(0, 16);          // biCompression = BI_RGB
  out.writeUInt32LE(xorSize + andSize, 20);
  // biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant stay 0.
  let off = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      out[off++] = pixels[s + 2]; // B
      out[off++] = pixels[s + 1]; // G
      out[off++] = pixels[s];     // R
      out[off++] = pixels[s + 3]; // A
    }
  }
  // AND mask is all zero (fully opaque); alpha lives in the BGRA channel.
  return out;
}

const sizes = [16, 32, 48, 64, 128, 256, 512];
const images = new Map(sizes.map(s => [s, { pixels: raster(s) }]));
for (const entry of images.values()) entry.png = null;
for (const size of sizes) images.get(size).png = png(size, images.get(size).pixels);

for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]]) {
  fs.writeFileSync(path.join(outDir, name), images.get(size).png);
}

// ICO: classic DIB entries (rc.exe compatible), one per size.
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoImages = icoSizes.map(size => dib(size, images.get(size).pixels));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const directory = [];
const blobs = [];
for (let i = 0; i < icoSizes.length; i++) {
  const size = icoSizes[i];
  const data = icoImages[i];
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;  // 0 encodes 256
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0; entry[3] = 0;          // palette count, reserved
  entry.writeUInt16LE(1, 4);           // planes
  entry.writeUInt16LE(32, 6);          // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  directory.push(entry);
  blobs.push(data);
}
// All 16-byte directory entries must come first, then all image blobs.
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...directory, ...blobs]));

// ICNS: ic07 (128), ic08 (256), ic09 (512) PNG chunks.
const icnsChunks = [['ic07', 128], ['ic08', 256], ['ic09', 512]].map(([type, size]) => {
  const data = images.get(size).png;
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii'); head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(icnsChunks);
const icnsHead = Buffer.alloc(8);
icnsHead.write('icns', 0, 'ascii'); icnsHead.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(path.join(outDir, 'icon.icns'), Buffer.concat([icnsHead, body]));

console.log(`[icons] Wrote ${sizes.length} PNG sizes + DIB icon.ico + icon.icns to ${outDir}`);
