/**
 * テクスチャ管理（仕様書 セクション3・8）
 *
 * Greedy Meshing で結合した大きな面にタイル状の繰り返しを掛けるため、
 * テクスチャアトラスではなく DataArrayTexture（texture_2d_array）を使う。
 * アトラスだと UV が 0〜1 を超えたときに隣のタイルへはみ出して破綻する。
 *
 * 生成部は TextureSource インターフェースの背後に隠してあるので、
 * 後から PNG 画像ベースの実装へ差し替えられる。
 */

import {
  DataArrayTexture,
  NearestFilter,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three/webgpu';
import type { TextureName } from '../core/blocks.ts';
import { mulberry32 } from '../core/rng.ts';

/** レイヤーの並び。ここでの順序がシェーダーに渡すレイヤーインデックスになる */
export const TEXTURE_LAYERS: readonly TextureName[] = [
  'wood',
  'stone',
  'soil',
  'grass_top',
  'grass_side',
  'plank',
  'glass',
];

const LAYER_INDEX = new Map<TextureName, number>(TEXTURE_LAYERS.map((n, i) => [n, i]));

export function textureLayerIndex(name: TextureName): number {
  return LAYER_INDEX.get(name) ?? 0;
}

/** テクスチャ供給インターフェース。PNG 差し替え時はこれを実装したものを渡す */
export interface TextureSource {
  /** 1辺のピクセル数（16 または 32 を想定） */
  readonly size: number;
  /** RGBA8 の Uint8Array（size * size * 4）を返す */
  generate(name: TextureName): Uint8Array;
}

const TEX_SIZE = 16;

type RGB = readonly [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function shade(color: RGB, amount: number): RGB {
  return [clamp255(color[0] + amount), clamp255(color[1] + amount), clamp255(color[2] + amount)];
}

/**
 * Canvas API 相当の手続き的生成。実際には Canvas を経由せず
 * 直接ピクセルバッファへ書き込む（オフスクリーン Canvas より軽く、結果も決定的）。
 */
export class ProceduralTextureSource implements TextureSource {
  readonly size = TEX_SIZE;

  generate(name: TextureName): Uint8Array {
    switch (name) {
      case 'wood':
        return this.wood(0xa1b2c3, [200, 168, 124]);
      case 'plank':
        return this.plank(0x51a2b3, [186, 150, 104]);
      case 'stone':
        return this.stone(0xbeef01, [150, 150, 144]);
      case 'soil':
        return this.soil(0x1337c0, [112, 82, 55]);
      case 'grass_top':
        return this.grassTop(0x5eed01, [95, 155, 69]);
      case 'grass_side':
        return this.grassSide(0x5eed02, [95, 155, 69], [112, 82, 55]);
      case 'glass':
        return this.glass(0xa5c8ff);
    }
  }

  private buffer(): Uint8Array {
    return new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  }

  private put(buf: Uint8Array, x: number, y: number, c: RGB, a = 255): void {
    const o = (y * TEX_SIZE + x) * 4;
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
    buf[o + 3] = a;
  }

  /** 木目：ベース色＋縦方向の濃淡ストライプ＋軽いノイズ */
  private wood(seed: number, base: RGB): Uint8Array {
    const rnd = mulberry32(seed);
    const buf = this.buffer();
    const stripe = new Array<number>(TEX_SIZE);
    for (let x = 0; x < TEX_SIZE; x++) {
      stripe[x] = Math.round((rnd() - 0.5) * 26) + (x % 4 === 0 ? -14 : 0);
    }
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const noise = (rnd() - 0.5) * 10;
        this.put(buf, x, y, shade(base, stripe[x] + noise));
      }
    }
    return buf;
  }

  /** 板材：木目より明るく、横方向の板の継ぎ目を入れる */
  private plank(seed: number, base: RGB): Uint8Array {
    const rnd = mulberry32(seed);
    const buf = this.buffer();
    for (let y = 0; y < TEX_SIZE; y++) {
      const seam = y % 8 === 0 ? -34 : 0;
      for (let x = 0; x < TEX_SIZE; x++) {
        const grain = ((x * 7 + y * 3) % 5) - 2;
        const noise = (rnd() - 0.5) * 12;
        this.put(buf, x, y, shade(base, seam + grain * 3 + noise));
      }
    }
    return buf;
  }

  /** 石目：ベース色＋ランダムな明暗パッチ */
  private stone(seed: number, base: RGB): Uint8Array {
    const rnd = mulberry32(seed);
    const buf = this.buffer();
    const patch = new Int8Array(TEX_SIZE * TEX_SIZE);
    for (let i = 0; i < 14; i++) {
      const px = Math.floor(rnd() * TEX_SIZE);
      const py = Math.floor(rnd() * TEX_SIZE);
      const r = 1 + Math.floor(rnd() * 3);
      const amt = Math.round((rnd() - 0.5) * 44);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const x = (px + dx + TEX_SIZE) % TEX_SIZE;
          const y = (py + dy + TEX_SIZE) % TEX_SIZE;
          patch[y * TEX_SIZE + x] = amt;
        }
      }
    }
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const noise = (rnd() - 0.5) * 14;
        this.put(buf, x, y, shade(base, patch[y * TEX_SIZE + x] + noise));
      }
    }
    return buf;
  }

  /** 土：茶系ベース＋粒状ノイズ */
  private soil(seed: number, base: RGB): Uint8Array {
    const rnd = mulberry32(seed);
    const buf = this.buffer();
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const grain = rnd() < 0.16 ? -26 : 0;
        const noise = (rnd() - 0.5) * 22;
        this.put(buf, x, y, shade(base, grain + noise));
      }
    }
    return buf;
  }

  /** 草（上面）：緑一色＋ノイズ */
  private grassTop(seed: number, base: RGB): Uint8Array {
    const rnd = mulberry32(seed);
    const buf = this.buffer();
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const noise = (rnd() - 0.5) * 26;
        this.put(buf, x, y, shade(base, noise));
      }
    }
    return buf;
  }

  /** 草（側面）：上部が緑、下部が土色。境界はギザギザにする */
  private grassSide(seed: number, green: RGB, dirt: RGB): Uint8Array {
    const rnd = mulberry32(seed);
    const buf = this.buffer();
    const edge = new Array<number>(TEX_SIZE);
    for (let x = 0; x < TEX_SIZE; x++) {
      edge[x] = 4 + Math.floor(rnd() * 3);
    }
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const noise = (rnd() - 0.5) * 20;
        // DataArrayTexture は行 0 が v=0（下端）に対応し、側面の UV は v が
        // ワールドの +Y に増える向きにしてあるので、緑は行の後半（上端側）に置く。
        const isGrass = y >= TEX_SIZE - edge[x];
        this.put(buf, x, y, shade(isGrass ? green : dirt, noise));
      }
    }
    return buf;
  }

  /** ガラス：ほぼ透明。窓の面材に使う */
  private glass(seed: number): Uint8Array {
    const rnd = mulberry32(seed);
    const buf = this.buffer();
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const noise = (rnd() - 0.5) * 12;
        this.put(buf, x, y, shade([206, 232, 244], noise), 64);
      }
    }
    return buf;
  }
}

/**
 * すべてのレイヤーをまとめた DataArrayTexture を生成する。
 * UV の繰り返しが必要なので RepeatWrapping、ピクセルアート風なので NearestFilter。
 */
export function buildBlockTextureArray(source: TextureSource): DataArrayTexture {
  const size = source.size;
  const depth = TEXTURE_LAYERS.length;
  const data = new Uint8Array(size * size * 4 * depth);
  TEXTURE_LAYERS.forEach((name, layer) => {
    const layerData = source.generate(name);
    if (layerData.length !== size * size * 4) {
      throw new Error(`テクスチャ ${name} のサイズが不正です`);
    }
    data.set(layerData, layer * size * size * 4);
  });

  const tex = new DataArrayTexture(data, size, size, depth);
  tex.format = RGBAFormat;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  // 配列テクスチャのミップマップ生成はバックエンド差が出やすいので使わない。
  // ピクセルアート風の見た目とも相性がよい。
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
