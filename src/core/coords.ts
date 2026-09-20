/**
 * 単位系・座標系の定義（仕様書 セクション1）
 *
 * - 1ユニット = ブロック1辺の半分 = 0.5m
 * - 1セル     = 2×2×2ユニット = 1m立方
 * - セル座標  : 整数。ブロックの位置、データ構造のインデックス
 * - ワールド座標: 浮動小数点（メートル）。プレイヤー・カメラ・レイキャスト
 *
 * 変数名と型で必ず区別すること。
 */

/** 1ユニット（ブロック1辺の半分）のメートル数 */
export const UNIT = 0.5;
/** 1セルのメートル数 */
export const CELL = 1.0;

/** 建築可能領域のセル数 */
export const GRID_X = 64;
export const GRID_Y = 32;
export const GRID_Z = 64;

export const CELL_COUNT = GRID_X * GRID_Y * GRID_Z; // 131,072

/** チャンクサイズ（セル）。実機計測でチューニングする（仕様書 3章） */
export const CHUNK_SIZE = 16;
export const CHUNKS_X = GRID_X / CHUNK_SIZE; // 4
export const CHUNKS_Y = GRID_Y / CHUNK_SIZE; // 2
export const CHUNKS_Z = GRID_Z / CHUNK_SIZE; // 4
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 32

/** 整数のセル座標 */
export type CellPos = { readonly x: number; readonly y: number; readonly z: number };
/** 浮動小数点のワールド座標（メートル） */
export type WorldPos = { readonly x: number; readonly y: number; readonly z: number };

/**
 * voxel 配列のインデックス計算。
 * この順序で固定すること（保存フォーマットが依存する）。
 */
export function cellIndex(x: number, y: number, z: number): number {
  return x + z * GRID_X + y * GRID_X * GRID_Z;
}

/** インデックスからセル座標へ逆変換 */
export function indexToCell(index: number): CellPos {
  const x = index % GRID_X;
  const z = Math.floor(index / GRID_X) % GRID_Z;
  const y = Math.floor(index / (GRID_X * GRID_Z));
  return { x, y, z };
}

/** 建築可能領域内か */
export function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < GRID_X && y >= 0 && y < GRID_Y && z >= 0 && z < GRID_Z;
}

/** セル座標 → そのセルの最小角のワールド座標 */
export function cellToWorld(c: CellPos): WorldPos {
  return { x: c.x * CELL, y: c.y * CELL, z: c.z * CELL };
}

/** セル座標 → セル中心のワールド座標 */
export function cellCenterToWorld(c: CellPos): WorldPos {
  return { x: (c.x + 0.5) * CELL, y: (c.y + 0.5) * CELL, z: (c.z + 0.5) * CELL };
}

/** ワールド座標 → セル座標 */
export function worldToCell(w: WorldPos): CellPos {
  return { x: Math.floor(w.x / CELL), y: Math.floor(w.y / CELL), z: Math.floor(w.z / CELL) };
}

/**
 * 地面か（Y=-1 相当。地面は voxel 配列に含めない）。
 * 建築可能領域の水平範囲すべてに地面が存在する。
 */
export function isGround(x: number, y: number, z: number): boolean {
  return y === -1 && x >= 0 && x < GRID_X && z >= 0 && z < GRID_Z;
}

/**
 * 外周の壁か（建築可能領域の外側1セル分、高さ GRID_Y）。
 * 壁は支持ブロックとして扱わない（仕様書 6章）。
 */
export function isWall(x: number, y: number, z: number): boolean {
  if (y < 0 || y >= GRID_Y) return false;
  const outsideX = x === -1 || x === GRID_X;
  const outsideZ = z === -1 || z === GRID_Z;
  const withinX = x >= -1 && x <= GRID_X;
  const withinZ = z >= -1 && z <= GRID_Z;
  return withinX && withinZ && (outsideX || outsideZ);
}

/** 6近傍の方向ベクトル（+X, -X, +Y, -Y, +Z, -Z の順） */
export const NEIGHBOR_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * 水平方向 (dx, dz) を向くための yaw。
 * 0 のとき -Z（奥）を向く。プレイヤー・特殊ブロックの正面の取り方と揃えてある
 * （rotationForward の 0 と同じ向き）。
 */
export function yawTowards(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** 角度を -π 〜 π に正規化する */
export function normalizeAngle(angle: number): number {
  const TAU = Math.PI * 2;
  let r = (angle + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

/**
 * current から target へ最短回りで t（0〜1）だけ近づけた角度。
 * 差を正規化してから補間するので、+179° → -179° で長い方へ回らない。
 */
export function approachAngle(current: number, target: number, t: number): number {
  return current + normalizeAngle(target - current) * t;
}

/** rotationY のインデックス(0-3) → 度 */
export function rotationIndexToDegrees(idx: number): 0 | 90 | 180 | 270 {
  return ([0, 90, 180, 270] as const)[idx & 3];
}

/** 度 → rotationY のインデックス(0-3)。0/90/180/270 以外は null */
export function degreesToRotationIndex(deg: number): number | null {
  switch (deg) {
    case 0:
      return 0;
    case 90:
      return 1;
    case 180:
      return 2;
    case 270:
      return 3;
    default:
      return null;
  }
}

/**
 * rotationY インデックスに対応する水平方向ベクトル。
 * 0 = -Z（奥）を「正面」とし、Y軸まわりに反時計回り（Three.js の回転方向）で 90° ずつ。
 */
export function rotationForward(rot: number): readonly [number, number] {
  switch (rot & 3) {
    case 0:
      return [0, -1];
    case 1:
      return [-1, 0];
    case 2:
      return [0, 1];
    default:
      return [1, 0];
  }
}
