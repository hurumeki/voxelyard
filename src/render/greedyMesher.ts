/**
 * Greedy Meshing（仕様書 セクション3）
 *
 * - 不透明な立方体ブロックのみを対象とする（半ブロック・階段・窓・家具は対象外）
 * - 他のブロックに接している面は生成しない
 * - 面の向きに応じた明度を頂点カラーへ直接書き込む（カスタムシェーダーを書かないため）
 *
 * 面ごとのテクスチャは DataArrayTexture のレイヤー番号として頂点属性 texLayer に載せる。
 */

import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import { CHUNK_SIZE, GRID_Y } from '../core/coords.ts';
import { blockDefByIndex, isOpaqueFullCube } from '../core/blocks.ts';
import type { VoxelData } from '../core/voxelData.ts';
import { TEX_LAYER_ATTRIBUTE } from './materials.ts';
import { textureLayerIndex } from './textures.ts';

/** 面の向きごとの明度（仕様書の推奨値） */
export const FACE_BRIGHTNESS = {
  top: 1.0,
  sideX: 0.8,
  sideZ: 0.65,
  bottom: 0.5,
} as const;

type FaceDir = {
  /** 法線の軸 0=X, 1=Y, 2=Z */
  readonly axis: 0 | 1 | 2;
  /** 法線の向き */
  readonly sign: 1 | -1;
  readonly normal: readonly [number, number, number];
  readonly brightness: number;
  /** 'top' | 'bottom' | 'side' のどのテクスチャを使うか */
  readonly texSlot: 'top' | 'bottom' | 'side';
};

const FACE_DIRS: readonly FaceDir[] = [
  { axis: 0, sign: 1, normal: [1, 0, 0], brightness: FACE_BRIGHTNESS.sideX, texSlot: 'side' },
  { axis: 0, sign: -1, normal: [-1, 0, 0], brightness: FACE_BRIGHTNESS.sideX, texSlot: 'side' },
  { axis: 1, sign: 1, normal: [0, 1, 0], brightness: FACE_BRIGHTNESS.top, texSlot: 'top' },
  { axis: 1, sign: -1, normal: [0, -1, 0], brightness: FACE_BRIGHTNESS.bottom, texSlot: 'bottom' },
  { axis: 2, sign: 1, normal: [0, 0, 1], brightness: FACE_BRIGHTNESS.sideZ, texSlot: 'side' },
  { axis: 2, sign: -1, normal: [0, 0, -1], brightness: FACE_BRIGHTNESS.sideZ, texSlot: 'side' },
];

/** ブロックインデックス → 面スロット → テクスチャレイヤー番号のキャッシュ */
const layerCache = new Map<number, { top: number; bottom: number; side: number }>();

function layersFor(blockIndex: number): { top: number; bottom: number; side: number } {
  let entry = layerCache.get(blockIndex);
  if (!entry) {
    const def = blockDefByIndex(blockIndex);
    entry = def
      ? {
          top: textureLayerIndex(def.tex.top),
          bottom: textureLayerIndex(def.tex.bottom),
          side: textureLayerIndex(def.tex.side),
        }
      : { top: 0, bottom: 0, side: 0 };
    layerCache.set(blockIndex, entry);
  }
  return entry;
}

/** Greedy Meshing の対象となるブロックか */
function greedyBlockIndexAt(voxels: VoxelData, x: number, y: number, z: number): number {
  const idx = voxels.getBlockId(x, y, z);
  if (idx === 0) return 0;
  const def = blockDefByIndex(idx);
  return def && def.render === 'greedy' ? idx : 0;
}

/**
 * 面が隠れているか。
 * 隣が不透明な立方体、または地面（Y=-1）なら描画しない。
 */
function faceHidden(voxels: VoxelData, nx: number, ny: number, nz: number): boolean {
  if (ny < 0) return true; // 地面。底面は常に隠れる
  if (ny >= GRID_Y) return false;
  return isOpaqueFullCube(blockDefByIndex(voxels.getBlockId(nx, ny, nz)));
}

type MeshBuffers = {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  layers: number[];
  indices: number[];
};

/**
 * 指定チャンクの Greedy メッシュを生成する。
 * 何も面がなければ null を返す。
 */
export function buildChunkGeometry(
  voxels: VoxelData,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
): BufferGeometry | null {
  const base = [chunkX * CHUNK_SIZE, chunkY * CHUNK_SIZE, chunkZ * CHUNK_SIZE] as const;
  const buf: MeshBuffers = {
    positions: [],
    normals: [],
    uvs: [],
    colors: [],
    layers: [],
    indices: [],
  };

  // mask はチャンク断面（CHUNK_SIZE × CHUNK_SIZE）分
  const mask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);

  for (const dir of FACE_DIRS) {
    const axis = dir.axis;
    const a1 = ((axis + 1) % 3) as 0 | 1 | 2;
    const a2 = ((axis + 2) % 3) as 0 | 1 | 2;

    for (let slice = 0; slice < CHUNK_SIZE; slice++) {
      mask.fill(0);
      let hasAny = false;

      const cell: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < CHUNK_SIZE; i++) {
        for (let j = 0; j < CHUNK_SIZE; j++) {
          cell[axis] = base[axis] + slice;
          cell[a1] = base[a1] + i;
          cell[a2] = base[a2] + j;

          const blockIndex = greedyBlockIndexAt(voxels, cell[0], cell[1], cell[2]);
          if (blockIndex === 0) continue;

          const nx = cell[0] + dir.normal[0];
          const ny = cell[1] + dir.normal[1];
          const nz = cell[2] + dir.normal[2];
          if (faceHidden(voxels, nx, ny, nz)) continue;

          mask[i * CHUNK_SIZE + j] = blockIndex;
          hasAny = true;
        }
      }

      if (!hasAny) continue;
      emitMergedQuads(buf, mask, dir, a1, a2, base, slice);
    }
  }

  if (buf.indices.length === 0) return null;
  return toGeometry(buf);
}

/** mask 上の同一ブロックの矩形を貪欲に結合して四角形を出力する */
function emitMergedQuads(
  buf: MeshBuffers,
  mask: Int32Array,
  dir: FaceDir,
  a1: 0 | 1 | 2,
  a2: 0 | 1 | 2,
  base: readonly [number, number, number],
  slice: number,
): void {
  const axis = dir.axis;
  const layers = { top: 0, bottom: 0, side: 0 };

  for (let i = 0; i < CHUNK_SIZE; i++) {
    for (let j = 0; j < CHUNK_SIZE; ) {
      const blockIndex = mask[i * CHUNK_SIZE + j];
      if (blockIndex === 0) {
        j++;
        continue;
      }

      // j 方向（a2軸）に伸ばす
      let h = 1;
      while (j + h < CHUNK_SIZE && mask[i * CHUNK_SIZE + j + h] === blockIndex) h++;

      // i 方向（a1軸）に伸ばす
      let w = 1;
      outer: while (i + w < CHUNK_SIZE) {
        for (let k = 0; k < h; k++) {
          if (mask[(i + w) * CHUNK_SIZE + j + k] !== blockIndex) break outer;
        }
        w++;
      }

      // 使った領域をクリア
      for (let di = 0; di < w; di++) {
        for (let dj = 0; dj < h; dj++) {
          mask[(i + di) * CHUNK_SIZE + j + dj] = 0;
        }
      }

      const l = layersFor(blockIndex);
      layers.top = l.top;
      layers.bottom = l.bottom;
      layers.side = l.side;
      const texLayer = layers[dir.texSlot];

      pushQuad(buf, dir, a1, a2, base, slice, i, j, w, h, texLayer, axis);

      j += h;
    }
  }
}

function pushQuad(
  buf: MeshBuffers,
  dir: FaceDir,
  a1: 0 | 1 | 2,
  a2: 0 | 1 | 2,
  base: readonly [number, number, number],
  slice: number,
  i: number,
  j: number,
  w: number,
  h: number,
  texLayer: number,
  axis: 0 | 1 | 2,
): void {
  // 面の位置。+方向の面はセルの上端、-方向の面はセルの下端
  const level = base[axis] + slice + (dir.sign === 1 ? 1 : 0);

  const corner = (di: number, dj: number): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0];
    p[axis] = level;
    p[a1] = base[a1] + i + di;
    p[a2] = base[a2] + j + dj;
    return p;
  };

  const c00 = corner(0, 0);
  const c10 = corner(w, 0);
  const c11 = corner(w, h);
  const c01 = corner(0, h);

  // a1軸 × a2軸 = +axis 方向になるので、
  // 正の面は c00→c10→c11→c01、負の面はその逆順で法線が合う。
  const quad = dir.sign === 1 ? [c00, c10, c11, c01] : [c00, c01, c11, c10];

  // UV: 側面（法線がX軸）のみ v を a1(=Y) に、それ以外は v を a2 に対応させて
  // テクスチャが上下反転しないようにする。
  const uvFor = (di: number, dj: number): [number, number] =>
    axis === 0 ? [dj, di] : [di, dj];
  const uvRaw: Array<[number, number]> = [uvFor(0, 0), uvFor(w, 0), uvFor(w, h), uvFor(0, h)];
  const uvQuad = dir.sign === 1 ? uvRaw : [uvRaw[0], uvRaw[3], uvRaw[2], uvRaw[1]];

  const startVertex = buf.positions.length / 3;
  const b = dir.brightness;
  for (let v = 0; v < 4; v++) {
    const p = quad[v];
    buf.positions.push(p[0], p[1], p[2]);
    buf.normals.push(dir.normal[0], dir.normal[1], dir.normal[2]);
    buf.uvs.push(uvQuad[v][0], uvQuad[v][1]);
    buf.colors.push(b, b, b);
    buf.layers.push(texLayer);
  }
  buf.indices.push(
    startVertex,
    startVertex + 1,
    startVertex + 2,
    startVertex,
    startVertex + 2,
    startVertex + 3,
  );
}

function toGeometry(buf: MeshBuffers): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(buf.positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(buf.normals), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(buf.uvs), 2));
  geo.setAttribute('color', new BufferAttribute(new Float32Array(buf.colors), 3));
  geo.setAttribute(TEX_LAYER_ATTRIBUTE, new BufferAttribute(new Float32Array(buf.layers), 1));
  geo.setIndex(new BufferAttribute(new Uint32Array(buf.indices), 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
