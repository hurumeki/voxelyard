/**
 * アイコンと無音プレースホルダー音源を生成する。
 *
 *   node scripts/gen-assets.mjs
 *
 * アイコン：等角投影の積み木キューブを重ねたミニマルなロゴ。
 *   背景 ダークグリーン #1b1f16 / キューブ ナチュラルウッド #C8A87C 系。
 * 音源：無音の WAV。後から同名ファイルを差し替えるだけで有効になる。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = join(root, 'public', 'icons');
const soundDir = join(root, 'public', 'assets', 'sounds');

// ---------------------------------------------------------------- PNG 出力

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA の Uint8Array を PNG バッファへ */
function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- アイコン描画

const BG = [0x1b, 0x1f, 0x16];
const TOP = [0xdc, 0xbd, 0x92];
const LEFT = [0xc8, 0xa8, 0x7c];
const RIGHT = [0x9d, 0x81, 0x5c];

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }

  fill(color) {
    for (let i = 0; i < this.size * this.size; i++) {
      this.data[i * 4] = color[0];
      this.data[i * 4 + 1] = color[1];
      this.data[i * 4 + 2] = color[2];
      this.data[i * 4 + 3] = 255;
    }
  }

  /** 凸多角形を塗る。4xスーパーサンプリングでエッジを滑らかにする */
  polygon(points, color) {
    const s = this.size;
    const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
    const maxY = Math.min(s - 1, Math.ceil(Math.max(...points.map((p) => p[1]))));
    const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p[0]))));
    const maxX = Math.min(s - 1, Math.ceil(Math.max(...points.map((p) => p[0]))));
    const sub = [0.25, 0.75];

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let hits = 0;
        for (const oy of sub) {
          for (const ox of sub) {
            if (inside(points, x + ox, y + oy)) hits++;
          }
        }
        if (hits === 0) continue;
        const a = hits / 4;
        const o = (y * s + x) * 4;
        for (let c = 0; c < 3; c++) {
          this.data[o + c] = Math.round(this.data[o + c] * (1 - a) + color[c] * a);
        }
        this.data[o + 3] = 255;
      }
    }
  }
}

function inside(points, px, py) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

/** 等角投影のキューブ1個を描く。(cx, cy) は上面の頂点 */
function drawCube(canvas, cx, cy, w, h) {
  const top = [
    [cx, cy],
    [cx + w, cy + h],
    [cx, cy + h * 2],
    [cx - w, cy + h],
  ];
  const left = [
    [cx - w, cy + h],
    [cx, cy + h * 2],
    [cx, cy + h * 2 + w * 1.15],
    [cx - w, cy + h + w * 1.15],
  ];
  const right = [
    [cx, cy + h * 2],
    [cx + w, cy + h],
    [cx + w, cy + h + w * 1.15],
    [cx, cy + h * 2 + w * 1.15],
  ];
  canvas.polygon(top, TOP);
  canvas.polygon(left, LEFT);
  canvas.polygon(right, RIGHT);
}

/**
 * @param size 出力サイズ
 * @param scale ロゴの占有率。maskable は安全領域に収めるため小さくする
 */
function renderIcon(size, scale) {
  const canvas = new Canvas(size);
  canvas.fill(BG);

  const u = size * scale * 0.16; // キューブ半幅
  const h = u * 0.5;
  const cx = size / 2;
  const cy = size / 2 - u * 1.1;

  // 下段2個 → 上段1個の積み木
  drawCube(canvas, cx - u, cy + h * 2, u, h);
  drawCube(canvas, cx + u, cy + h * 2, u, h);
  drawCube(canvas, cx, cy - h * 0.3, u, h);

  return encodePng(canvas.data, size);
}

// ---------------------------------------------------------------- 無音 WAV

function silentWav(seconds, sampleRate = 22050) {
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2; // 16bit モノラル
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt チャンクサイズ
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // モノラル
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // バイト/秒
  buf.writeUInt16LE(2, 32); // ブロックアライン
  buf.writeUInt16LE(16, 34); // ビット深度
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

// ---------------------------------------------------------------- 実行

mkdirSync(iconDir, { recursive: true });
mkdirSync(soundDir, { recursive: true });

writeFileSync(join(iconDir, 'icon-180.png'), renderIcon(180, 1));
writeFileSync(join(iconDir, 'icon-192.png'), renderIcon(192, 1));
writeFileSync(join(iconDir, 'icon-512.png'), renderIcon(512, 1));
// maskable は外周20%が切り取られ得るので中央に寄せる
writeFileSync(join(iconDir, 'icon-512-maskable.png'), renderIcon(512, 0.72));

writeFileSync(join(soundDir, 'place.wav'), silentWav(0.2));
writeFileSync(join(soundDir, 'break.wav'), silentWav(0.25));
writeFileSync(join(soundDir, 'bgm.wav'), silentWav(4));

console.log('アイコンと音源のプレースホルダーを生成しました。');
