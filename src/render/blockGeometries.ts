/**
 * 特殊形状ブロックのジオメトリ生成（仕様書 セクション3・8）
 *
 * Greedy Meshing の対象外となる形状（半ブロック・階段・椅子・テーブル・ドア・窓）を
 * 直方体の組み合わせとして組み立てる。InstancedMesh で共有するため、
 * 座標は「セル中心を原点とするローカル空間（1セル = 1.0）」で生成する。
 *
 * 明度差は Greedy メッシュと同じ値を頂点カラーへ焼き込むので、
 * 通常ブロックと並べても違和感が出ない。
 */

import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import type { BlockDef, TextureName } from '../core/blocks.ts';
import { FACE_BRIGHTNESS } from './greedyMesher.ts';
import { TEX_LAYER_ATTRIBUTE } from './materials.ts';
import { textureLayerIndex } from './textures.ts';

type Vec3 = readonly [number, number, number];

type FaceLayers = { top: number; bottom: number; side: number };

class GeometryBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private layers: number[] = [];
  private indices: number[] = [];

  /** 直方体を1つ追加する。min/max はセル中心を原点とするローカル座標 */
  box(min: Vec3, max: Vec3, faceLayers: FaceLayers, tint = 1): void {
    for (let axis = 0 as 0 | 1 | 2; axis <= 2; axis = (axis + 1) as 0 | 1 | 2) {
      for (const sign of [1, -1] as const) {
        this.face(min, max, axis, sign, faceLayers, tint);
      }
    }
  }

  private face(min: Vec3, max: Vec3, axis: 0 | 1 | 2, sign: 1 | -1, fl: FaceLayers, tint: number): void {
    const a1 = ((axis + 1) % 3) as 0 | 1 | 2;
    const a2 = ((axis + 2) % 3) as 0 | 1 | 2;
    const level = sign === 1 ? max[axis] : min[axis];

    const corner = (h1: 0 | 1, h2: 0 | 1): Vec3 => {
      const p: [number, number, number] = [0, 0, 0];
      p[axis] = level;
      p[a1] = h1 === 0 ? min[a1] : max[a1];
      p[a2] = h2 === 0 ? min[a2] : max[a2];
      return p;
    };

    const c00 = corner(0, 0);
    const c10 = corner(1, 0);
    const c11 = corner(1, 1);
    const c01 = corner(0, 1);
    const quad = sign === 1 ? [c00, c10, c11, c01] : [c00, c01, c11, c10];

    const brightness =
      axis === 1
        ? sign === 1
          ? FACE_BRIGHTNESS.top
          : FACE_BRIGHTNESS.bottom
        : axis === 0
          ? FACE_BRIGHTNESS.sideX
          : FACE_BRIGHTNESS.sideZ;
    const b = brightness * tint;

    const texLayer = axis === 1 ? (sign === 1 ? fl.top : fl.bottom) : fl.side;

    const normal: [number, number, number] = [0, 0, 0];
    normal[axis] = sign;

    // UV は Greedy メッシュと同じ対応（法線がX軸なら u=Z, v=Y など）。
    // ローカル座標に +0.5 して 0 起点にすると、隣接ブロックとタイルが揃う。
    const uvOf = (p: Vec3): [number, number] =>
      axis === 0 ? [p[a2] + 0.5, p[a1] + 0.5] : [p[a1] + 0.5, p[a2] + 0.5];

    const start = this.positions.length / 3;
    for (const p of quad) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      const [u, v] = uvOf(p);
      this.uvs.push(u, v);
      this.colors.push(b, b, b);
      this.layers.push(texLayer);
    }
    this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geo.setAttribute(TEX_LAYER_ATTRIBUTE, new BufferAttribute(new Float32Array(this.layers), 1));
    geo.setIndex(new BufferAttribute(new Uint16Array(this.indices), 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

function faceLayersOf(def: BlockDef): FaceLayers {
  return {
    top: textureLayerIndex(def.tex.top),
    bottom: textureLayerIndex(def.tex.bottom),
    side: textureLayerIndex(def.tex.side),
  };
}

function uniformLayers(name: TextureName): FaceLayers {
  const l = textureLayerIndex(name);
  return { top: l, bottom: l, side: l };
}

/**
 * ブロック1種類分の描画ジオメトリ。
 * ドアのように状態で形が変わるものは open 側も持つ。
 * 窓のように透過部分を持つものは glass を別ジオメトリとして持つ。
 */
export type BlockGeometrySet = {
  readonly solid: BufferGeometry;
  readonly solidOpen?: BufferGeometry;
  readonly glass?: BufferGeometry;
};

/** 半ブロック：セル下半分（水平回転のみのため常に下半分） */
function buildHalf(def: BlockDef): BlockGeometrySet {
  const g = new GeometryBuilder();
  g.box([-0.5, -0.5, -0.5], [0.5, 0, 0.5], faceLayersOf(def));
  return { solid: g.build() };
}

/**
 * 階段：rotationY=0 のとき正面は -Z。
 * 奥（-Z 側）が高さ2ユニット、手前（+Z 側）が高さ1ユニットの L字。
 */
function buildStair(def: BlockDef): BlockGeometrySet {
  const fl = faceLayersOf(def);
  const g = new GeometryBuilder();
  g.box([-0.5, -0.5, -0.5], [0.5, 0.5, 0], fl); // 奥側：全高
  g.box([-0.5, -0.5, 0], [0.5, 0, 0.5], fl); // 手前側：半分
  return { solid: g.build() };
}

/** 椅子：脚4本＋座面＋背もたれ。rotationY=0 のとき正面（座る向き）は -Z */
function buildChair(def: BlockDef): BlockGeometrySet {
  const fl = faceLayersOf(def);
  const g = new GeometryBuilder();
  const legTop = -0.12;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * 0.29;
      const cz = sz * 0.29;
      g.box([cx - 0.06, -0.5, cz - 0.06], [cx + 0.06, legTop, cz + 0.06], fl, 0.92);
    }
  }
  g.box([-0.36, legTop, -0.36], [0.36, 0, 0.36], fl); // 座面
  g.box([-0.36, 0, 0.24], [0.36, 0.46, 0.36], fl, 0.96); // 背もたれ（+Z 側）
  return { solid: g.build() };
}

/**
 * テーブル：4×2×2ユニット（横方向に2セル分）。
 * 基準セル中心を原点とし、rotationY=0 のとき従属セルは -Z 側にある。
 */
function buildTable(def: BlockDef): BlockGeometrySet {
  const fl = faceLayersOf(def);
  const g = new GeometryBuilder();
  const zMin = -1.5; // 従属セルの端
  const zMax = 0.5;
  g.box([-0.46, 0.34, zMin + 0.04], [0.46, 0.5, zMax - 0.04], fl); // 天板
  const legs: Array<[number, number]> = [
    [-0.34, zMin + 0.16],
    [0.34, zMin + 0.16],
    [-0.34, zMax - 0.16],
    [0.34, zMax - 0.16],
  ];
  for (const [lx, lz] of legs) {
    g.box([lx - 0.07, -0.5, lz - 0.07], [lx + 0.07, 0.34, lz + 0.07], fl, 0.92);
  }
  return { solid: g.build() };
}

/**
 * ドア：rotationY=0 のとき -Z 側の面を塞ぐ板。
 * 開いた状態は蝶番（-X 側）を軸に90°開いた形を別ジオメトリで持つ。
 */
function buildDoor(def: BlockDef): BlockGeometrySet {
  const fl = faceLayersOf(def);
  const closed = new GeometryBuilder();
  closed.box([-0.5, -0.5, -0.5], [0.5, 0.5, -0.35], fl);

  const open = new GeometryBuilder();
  open.box([-0.5, -0.5, -0.5], [-0.35, 0.5, 0.5], fl);

  return { solid: closed.build(), solidOpen: open.build() };
}

/** 窓：枠（不透明）＋ガラス（透過）。rotationY=0 のとき板面は Z軸に垂直 */
function buildWindow(def: BlockDef): BlockGeometrySet {
  const fl = faceLayersOf(def);
  const frame = new GeometryBuilder();
  const zA = -0.09;
  const zB = 0.09;
  const t = 0.14; // 枠の幅
  frame.box([-0.5, 0.5 - t, zA], [0.5, 0.5, zB], fl); // 上
  frame.box([-0.5, -0.5, zA], [0.5, -0.5 + t, zB], fl); // 下
  frame.box([-0.5, -0.5 + t, zA], [-0.5 + t, 0.5 - t, zB], fl); // 左
  frame.box([0.5 - t, -0.5 + t, zA], [0.5, 0.5 - t, zB], fl); // 右
  // 中央の桟
  frame.box([-0.04, -0.5 + t, zA + 0.02], [0.04, 0.5 - t, zB - 0.02], fl, 0.95);

  const glass = new GeometryBuilder();
  glass.box([-0.5 + t, -0.5 + t, -0.02], [0.5 - t, 0.5 - t, 0.02], uniformLayers('glass'), 1);

  return { solid: frame.build(), glass: glass.build() };
}

/** 特殊形状ブロックのジオメトリを生成する。cube（Greedy対象）は null */
export function buildBlockGeometrySet(def: BlockDef): BlockGeometrySet | null {
  switch (def.shape) {
    case 'half':
      return buildHalf(def);
    case 'stair':
      return buildStair(def);
    case 'chair':
      return buildChair(def);
    case 'table':
      return buildTable(def);
    case 'door':
      return buildDoor(def);
    case 'window':
      return buildWindow(def);
    case 'cube':
      return null;
  }
}

/** ゴーストプレビュー用の単純な立方体（1セル） */
export function buildUnitCubeGeometry(): BufferGeometry {
  const g = new GeometryBuilder();
  g.box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], uniformLayers('wood'));
  return g.build();
}
