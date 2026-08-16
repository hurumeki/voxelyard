/**
 * ブロック操作用のレイキャスト（仕様書 セクション7）
 *
 * タップ座標からカメラ方向にレイを飛ばし、最初にヒットしたブロック（または地面）の
 * セルと面の法線を返す。その法線側の隣接セルが設置候補になる。
 *
 * セル単位の DDA（Amanatides & Woo）で走査し、各セルでは実際の形状ボックスと
 * 交差判定するので、階段や半ブロックの見た目どおりの位置に当たる。
 */

import { GRID_X, GRID_Y, GRID_Z } from '../core/coords.ts';
import type { CellPos, WorldPos } from '../core/coords.ts';
import type { AABB, World } from './world.ts';

export type RayHit = {
  /** ヒットしたセル。地面の場合は y = -1 */
  readonly cell: CellPos;
  /** 面の法線 */
  readonly normal: readonly [number, number, number];
  readonly distance: number;
  readonly point: WorldPos;
  readonly isGround: boolean;
};

type BoxHit = { t: number; normal: [number, number, number] } | null;

/** レイと AABB の交差。入射時刻と入射面の法線を返す */
function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: AABB,
  maxT: number,
): BoxHit {
  let tMin = 0;
  let tMax = maxT;
  let axis = -1;
  let sign = 1;

  const check = (o: number, d: number, lo: number, hi: number, a: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = a;
      sign = s;
    }
    if (t2 < tMax) tMax = t2;
    return tMin <= tMax;
  };

  if (!check(ox, dx, b.minX, b.maxX, 0)) return null;
  if (!check(oy, dy, b.minY, b.maxY, 1)) return null;
  if (!check(oz, dz, b.minZ, b.maxZ, 2)) return null;
  if (axis < 0) return null;

  const normal: [number, number, number] = [0, 0, 0];
  normal[axis] = sign;
  return { t: tMin, normal };
}

/**
 * ワールドへレイを飛ばす。
 * @param maxDistance レイの最大長（メートル）
 */
export function raycastWorld(
  world: World,
  origin: WorldPos,
  dir: WorldPos,
  maxDistance: number,
): RayHit | null {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-9) return null;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;

  let best: RayHit | null = null;

  // --- 地面（Y=0 の平面） -------------------------------------------------
  if (dy < -1e-9 && origin.y > 0) {
    const t = -origin.y / dy;
    if (t <= maxDistance) {
      const gx = origin.x + dx * t;
      const gz = origin.z + dz * t;
      if (gx >= 0 && gx < GRID_X && gz >= 0 && gz < GRID_Z) {
        best = {
          cell: { x: Math.floor(gx), y: -1, z: Math.floor(gz) },
          normal: [0, 1, 0],
          distance: t,
          point: { x: gx, y: 0, z: gz },
          isGround: true,
        };
      }
    }
  }

  // --- ブロック（セル DDA） -----------------------------------------------
  const limit = best ? Math.min(maxDistance, best.distance) : maxDistance;

  let cx = Math.floor(origin.x);
  let cy = Math.floor(origin.y);
  let cz = Math.floor(origin.z);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = Math.abs(dy) < 1e-9 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(1 / dz);

  const boundary = (o: number, c: number, step: number): number =>
    step > 0 ? c + 1 - o : o - c;

  let tMaxX = tDeltaX === Infinity ? Infinity : boundary(origin.x, cx, stepX) * tDeltaX;
  let tMaxY = tDeltaY === Infinity ? Infinity : boundary(origin.y, cy, stepY) * tDeltaY;
  let tMaxZ = tDeltaZ === Infinity ? Infinity : boundary(origin.z, cz, stepZ) * tDeltaZ;

  let travelled = 0;
  // セルを跨ぐ回数の上限（無限ループ防止）
  const maxSteps = Math.ceil(maxDistance) * 3 + 8;

  for (let i = 0; i < maxSteps && travelled <= limit; i++) {
    if (cx >= 0 && cx < GRID_X && cy >= 0 && cy < GRID_Y && cz >= 0 && cz < GRID_Z) {
      if (world.voxels.getBlockId(cx, cy, cz) !== 0) {
        let cellBest: BoxHit = null;
        for (const b of world.cellPickBoxes(cx, cy, cz)) {
          const hit = rayBox(origin.x, origin.y, origin.z, dx, dy, dz, b, limit);
          if (hit && (!cellBest || hit.t < cellBest.t)) cellBest = hit;
        }
        if (cellBest) {
          return {
            cell: { x: cx, y: cy, z: cz },
            normal: cellBest.normal,
            distance: cellBest.t,
            point: {
              x: origin.x + dx * cellBest.t,
              y: origin.y + dy * cellBest.t,
              z: origin.z + dz * cellBest.t,
            },
            isGround: false,
          };
        }
      }
    }

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      travelled = tMaxX;
      cx += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxZ) {
      travelled = tMaxY;
      cy += stepY;
      tMaxY += tDeltaY;
    } else {
      travelled = tMaxZ;
      cz += stepZ;
      tMaxZ += tDeltaZ;
    }

    // 領域から完全に離れたら打ち切る
    if (cy < -2 || cy > GRID_Y + 2) break;
  }

  return best;
}
