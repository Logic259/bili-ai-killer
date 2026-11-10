import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(__dirname, '../extension/icons');

// CRC32 table for standard PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const b = c1 / c2;
  return Math.hypot(px - (ax + b * vx), py - (ay + b * vy));
}

/**
 * Renders a crisp anti-aliased shield + crossed-out cyber whale/bot badge icon.
 */
function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = 1.25 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Normalized coordinates in [-1, 1]
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = ((y + 0.5) / size) * 2 - 1;

      // Rounded squircle background
      const rCorner = 0.42;
      const qx = Math.max(Math.abs(nx) - (0.90 - rCorner), 0);
      const qy = Math.max(Math.abs(ny) - (0.90 - rCorner), 0);
      const bgDist = Math.hypot(qx, qy) - rCorner;
      const bgAlpha = 1 - smoothstep(-aa, aa, bgDist);

      if (bgAlpha <= 0.001) continue;

      // Deep slate-blue to Bilibili cyan-pink subtle gradient background
      const gradT = (nx * 0.4 + ny * 0.6 + 1) * 0.5;
      let r = Math.round(18 + gradT * 16);
      let g = Math.round(25 + gradT * 24);
      let b = Math.round(44 + gradT * 42);

      // Shield silhouette in center
      const sy = ny + 0.04;
      const shieldHalfW = sy < 0.05
        ? 0.56 - Math.max(0, -sy - 0.45) * 0.2
        : Math.max(0, 0.56 * (1 - Math.pow((sy - 0.05) / 0.68, 1.45)));
      const inShieldVert = sy >= -0.60 && sy <= 0.70;
      const shieldEdge = inShieldVert ? (Math.abs(nx) - shieldHalfW) : 1;
      const topBottomEdge = Math.max(-0.60 - sy, sy - 0.70);
      const sDist = Math.max(shieldEdge, topBottomEdge);

      // Shield border glow (cyan #00AEEC)
      const shieldStroke = 1 - smoothstep(0.035 - aa, 0.035 + aa, Math.abs(sDist));
      const shieldFill = 1 - smoothstep(-aa, aa, sDist);

      if (shieldFill > 0) {
        r = Math.round(r * (1 - shieldFill * 0.55) + 0 * (shieldFill * 0.55));
        g = Math.round(g * (1 - shieldFill * 0.55) + 174 * (shieldFill * 0.55));
        b = Math.round(b * (1 - shieldFill * 0.55) + 236 * (shieldFill * 0.55));
      }
      if (shieldStroke > 0) {
        r = Math.round(r * (1 - shieldStroke) + 56 * shieldStroke);
        g = Math.round(g * (1 - shieldStroke) + 209 * shieldStroke);
        b = Math.round(b * (1 - shieldStroke) + 255 * shieldStroke);
      }

      // Stylized "AI" / Fish-eye core dot + slash ("ban" strike-through in #FB7299 coral-red)
      const ringDist = Math.abs(Math.hypot(nx, ny + 0.02) - 0.27);
      const ringAlpha = 1 - smoothstep(0.055 - aa, 0.055 + aa, ringDist);
      if (ringAlpha > 0) {
        r = Math.round(r * (1 - ringAlpha) + 255 * ringAlpha);
        g = Math.round(g * (1 - ringAlpha) + 255 * ringAlpha);
        b = Math.round(b * (1 - ringAlpha) + 255 * ringAlpha);
      }

      const slashDist = distToSegment(nx, ny, -0.36, -0.34, 0.36, 0.38);
      const slashAlpha = 1 - smoothstep(0.085 - aa, 0.085 + aa, slashDist);
      if (slashAlpha > 0) {
        r = Math.round(r * (1 - slashAlpha) + 251 * slashAlpha);
        g = Math.round(g * (1 - slashAlpha) + 114 * slashAlpha);
        b = Math.round(b * (1 - slashAlpha) + 153 * slashAlpha);
      }

      const idx = (y * size + x) * 4;
      buf[idx] = clamp(r, 0, 255);
      buf[idx + 1] = clamp(g, 0, 255);
      buf[idx + 2] = clamp(b, 0, 255);
      buf[idx + 3] = Math.round(clamp(bgAlpha, 0, 1) * 255);
    }
  }

  return encodePNG(size, size, buf);
}

fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, renderIcon(size));
  console.log(`Generated ${outPath}`);
}
