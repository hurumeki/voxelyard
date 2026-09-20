/**
 * ワールドの論理層。
 * voxel データの上に「設置条件」「マルチセル占有」「当たり判定形状」といった
 * ゲームルールを載せる。描画とは分離しており、ここは Three.js に依存しない。
 */

import {
  CHUNKS_X,
  CHUNKS_Z,
  CHUNK_SIZE,
  GRID_X,
  GRID_Y,
  GRID_Z,
  NEIGHBOR_DIRS,
  cellIndex,
  inBounds,
  indexToCell,
  isGround,
  rotationForward,
} from '../core/coords.ts';
import type { CellPos } from '../core/coords.ts';
import {
  blockDefByIndex,
  blockIndexOf,
  localCollisionBoxes,
} from '../core/blocks.ts';
import type { BlockDef } from '../core/blocks.ts';
import { VoxelData } from '../core/voxelData.ts';
import { TINT_NONE, normalizeTint } from '../core/blockColors.ts';

/** ワールド座標の軸平行境界ボックス（メートル） */
export type AABB = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

export type PlaceFailure =
  | 'occupied'
  | 'out-of-bounds'
  | 'no-support'
  | 'player-overlap'
  | 'out-of-reach'
  | 'unknown-block';

export type PlaceCheck = { ok: true } | { ok: false; reason: PlaceFailure };

/** チャンク番号 */
export function chunkIndexOfCell(x: number, y: number, z: number): number {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  return cx + cz * CHUNKS_X + cy * CHUNKS_X * CHUNKS_Z;
}

/** 中心原点のローカル座標を rotationY（0-3）に従って回転させる */
function rotateLocal(x: number, z: number, rot: number): [number, number] {
  switch (rot & 3) {
    case 0:
      return [x, z];
    case 1:
      return [z, -x];
    case 2:
      return [-x, -z];
    default:
      return [-z, x];
  }
}

export class World {
  readonly voxels: VoxelData;

  /** メッシュ再構築が必要なチャンク */
  private readonly dirtyChunks = new Set<number>();
  /** Greedy 対象外（instanced / transparent）のブロックが置かれているセル */
  private readonly specialCells = new Set<number>();
  /** 特殊形状ブロックの構成が変わるたびに増える版番号（インスタンス再構築の判定用） */
  private specialVersion = 0;
  /** 前回保存以降に変更があったか */
  private dirty = false;

  constructor(buffer?: ArrayBufferLike, tintBuffer?: ArrayBufferLike) {
    this.voxels = new VoxelData(buffer, tintBuffer);
    this.voxels.setChangeListener((x, y, z) => this.onCellChanged(x, y, z));
    this.rebuildSpecialIndex();
    this.markAllChunksDirty();
  }

  // ---------------------------------------------------------------- 変更通知

  private onCellChanged(x: number, y: number, z: number): void {
    this.dirty = true;
    this.markChunkDirtyAt(x, y, z);
    // チャンク境界に接するブロックを変更した場合は隣接チャンクも再構築する
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!inBounds(nx, ny, nz)) continue;
      if (chunkIndexOfCell(nx, ny, nz) !== chunkIndexOfCell(x, y, z)) {
        this.dirtyChunks.add(chunkIndexOfCell(nx, ny, nz));
      }
    }

    // 特殊形状セルの索引を更新
    const idx = cellIndex(x, y, z);
    const def = blockDefByIndex(this.voxels.getBlockId(x, y, z));
    const wasSpecial = this.specialCells.delete(idx);
    const isSpecial = def !== undefined && def.render !== 'greedy';
    if (isSpecial) this.specialCells.add(idx);
    // インスタンス群の作り直しが必要になった場合のみ版番号を進める
    if (wasSpecial || isSpecial) this.specialVersion++;
  }

  getSpecialVersion(): number {
    return this.specialVersion;
  }

  private markChunkDirtyAt(x: number, y: number, z: number): void {
    this.dirtyChunks.add(chunkIndexOfCell(x, y, z));
  }

  markAllChunksDirty(): void {
    for (let i = 0; i < CHUNKS_X * CHUNKS_Z * (GRID_Y / CHUNK_SIZE); i++) {
      this.dirtyChunks.add(i);
    }
  }

  takeDirtyChunks(): number[] {
    const out = [...this.dirtyChunks];
    this.dirtyChunks.clear();
    return out;
  }

  peekDirtyChunkCount(): number {
    return this.dirtyChunks.size;
  }

  /** 特殊形状ブロックのセル索引を作り直す（ロード直後など） */
  private rebuildSpecialIndex(): void {
    this.specialCells.clear();
    this.voxels.forEachFilled((x, y, z, raw) => {
      const def = blockDefByIndex(raw & 0x03ff);
      if (def && def.render !== 'greedy') this.specialCells.add(cellIndex(x, y, z));
    });
  }

  specialCellIndices(): ReadonlySet<number> {
    return this.specialCells;
  }

  isDirty(): boolean {
    return this.dirty;
  }
  clearDirty(): void {
    this.dirty = false;
  }
  markDirty(): void {
    this.dirty = true;
  }

  // ---------------------------------------------------------------- 占有セル

  /**
   * 基準セルにそのブロックを置いたとき占有するセル一覧。
   * テーブルのみ2セル（基準セル＋回転方向に隣接する1セル）。
   */
  occupiedCells(def: BlockDef, base: CellPos, rotation: number): CellPos[] {
    if (def.cellCount === 1) return [base];
    const [fx, fz] = rotationForward(rotation);
    return [base, { x: base.x + fx, y: base.y, z: base.z + fz }];
  }

  /**
   * 従属セルから基準セルを逆引きする。
   * 隣接セルを走査し、同一 blockId かつ従属マーカーが立っていないセルのうち、
   * その回転方向の占有セルがこのセルを含むものを探す。
   */
  findBaseCell(cell: CellPos): CellPos | null {
    const raw = this.voxels.getRaw(cell.x, cell.y, cell.z);
    if (raw === 0) return null;
    if (!this.voxels.isDependent(cell.x, cell.y, cell.z)) return cell;

    const blockIndex = this.voxels.getBlockId(cell.x, cell.y, cell.z);
    const def = blockDefByIndex(blockIndex);
    if (!def) return null;

    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const nz = cell.z + dz;
      if (!inBounds(nx, ny, nz)) continue;
      if (this.voxels.getBlockId(nx, ny, nz) !== blockIndex) continue;
      if (this.voxels.isDependent(nx, ny, nz)) continue;
      const rot = this.voxels.getRotation(nx, ny, nz);
      const occ = this.occupiedCells(def, { x: nx, y: ny, z: nz }, rot);
      if (occ.some((c) => c.x === cell.x && c.y === cell.y && c.z === cell.z)) {
        return { x: nx, y: ny, z: nz };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 設置判定

  /**
   * 設置可能か判定する（仕様書 セクション7）。
   * リーチ判定は呼び出し側で行い、ここには playerBox のみ渡す。
   */
  canPlace(
    blockId: string,
    base: CellPos,
    rotation: number,
    playerBox: AABB | null,
  ): PlaceCheck {
    const blockIndex = blockIndexOf(blockId);
    const def = blockDefByIndex(blockIndex);
    if (!def) return { ok: false, reason: 'unknown-block' };

    const cells = this.occupiedCells(def, base, rotation);

    for (const c of cells) {
      if (!inBounds(c.x, c.y, c.z)) return { ok: false, reason: 'out-of-bounds' };
      if (!this.voxels.isEmpty(c.x, c.y, c.z)) return { ok: false, reason: 'occupied' };
    }

    // 隣接条件：占有セルのいずれかが、地面または既存ブロックに接していればよい
    // （外周の壁は支持とみなさない）
    let supported = false;
    for (const c of cells) {
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        const nz = c.z + dz;
        if (isGround(nx, ny, nz)) {
          supported = true;
          break;
        }
        if (!inBounds(nx, ny, nz)) continue; // 壁・領域外は支持にならない
        // 自分自身が占有する予定のセルは支持に数えない
        if (cells.some((o) => o.x === nx && o.y === ny && o.z === nz)) continue;
        if (!this.voxels.isEmpty(nx, ny, nz)) {
          supported = true;
          break;
        }
      }
      if (supported) break;
    }
    if (!supported) return { ok: false, reason: 'no-support' };

    if (playerBox) {
      for (const c of cells) {
        for (const box of this.cellCollisionBoxes(c.x, c.y, c.z, blockIndex, rotation, false)) {
          if (aabbOverlap(box, playerBox)) return { ok: false, reason: 'player-overlap' };
        }
      }
    }

    return { ok: true };
  }

  /**
   * 設置する。canPlace が通っている前提。
   * tint は色番号（0 = 素の色）。マルチセル占有ブロックは全セルへ同じ色を入れる。
   */
  place(blockId: string, base: CellPos, rotation: number, tint: number = TINT_NONE): boolean {
    const blockIndex = blockIndexOf(blockId);
    const def = blockDefByIndex(blockIndex);
    if (!def) return false;
    const color = normalizeTint(tint);
    const cells = this.occupiedCells(def, base, rotation);
    cells.forEach((c, i) => {
      this.voxels.setBlock(c.x, c.y, c.z, blockIndex, rotation, false, i > 0, color);
    });
    return true;
  }

  /**
   * 設置済みブロックの色を変える。
   * どのセルをタップしてもブロック全体（マルチセル占有なら全セル）に適用する。
   * 空セル・既に同じ色だった場合は false（無駄な保存・再構築を避ける）。
   */
  paint(cell: CellPos, tint: number): boolean {
    const baseCell = this.findBaseCell(cell);
    if (!baseCell) return false;
    const def = blockDefByIndex(this.voxels.getBlockId(baseCell.x, baseCell.y, baseCell.z));
    if (!def) return false;
    const color = normalizeTint(tint);
    const rot = this.voxels.getRotation(baseCell.x, baseCell.y, baseCell.z);
    const cells = this.occupiedCells(def, baseCell, rot);
    if (cells.every((c) => this.voxels.getTint(c.x, c.y, c.z) === color)) return false;
    for (const c of cells) {
      this.voxels.setTint(c.x, c.y, c.z, color);
    }
    return true;
  }

  /** セルの色番号（0 = 素の色） */
  tintAt(cell: CellPos): number {
    const baseCell = this.findBaseCell(cell);
    if (!baseCell) return TINT_NONE;
    return this.voxels.getTint(baseCell.x, baseCell.y, baseCell.z);
  }

  /**
   * 破壊する。マルチセル占有ブロックはどのセルをタップしても全セルが消える。
   * 破壊できた場合は true。
   */
  remove(cell: CellPos): boolean {
    const baseCell = this.findBaseCell(cell);
    if (!baseCell) return false;
    const blockIndex = this.voxels.getBlockId(baseCell.x, baseCell.y, baseCell.z);
    const def = blockDefByIndex(blockIndex);
    if (!def) return false;
    const rot = this.voxels.getRotation(baseCell.x, baseCell.y, baseCell.z);
    for (const c of this.occupiedCells(def, baseCell, rot)) {
      this.voxels.clearCell(c.x, c.y, c.z);
    }
    return true;
  }

  // ---------------------------------------------------------------- 当たり判定

  /**
   * セルの当たり判定ボックス（ワールド座標）を返す。
   * blockIndex / rotation を明示的に渡せるのは、まだ設置していないブロックの
   * 事前判定（canPlace のプレイヤー重なりチェック）に使うため。
   */
  cellCollisionBoxes(
    x: number,
    y: number,
    z: number,
    blockIndexOverride?: number,
    rotationOverride?: number,
    stateOverride?: boolean,
  ): AABB[] {
    const blockIndex = blockIndexOverride ?? this.voxels.getBlockId(x, y, z);
    if (blockIndex === 0) return [];
    const def = blockDefByIndex(blockIndex);
    if (!def) return [];
    const rot = rotationOverride ?? this.voxels.getRotation(x, y, z);
    const open = stateOverride ?? this.voxels.getState(x, y, z);

    const boxes = localCollisionBoxes(def, open);
    const out: AABB[] = [];
    for (const b of boxes) {
      // ローカル 0..1 → セル中心原点へ
      const lx0 = b.min[0] - 0.5;
      const lz0 = b.min[2] - 0.5;
      const lx1 = b.max[0] - 0.5;
      const lz1 = b.max[2] - 0.5;
      const [ax, az] = rotateLocal(lx0, lz0, rot);
      const [bx, bz] = rotateLocal(lx1, lz1, rot);
      const minX = Math.min(ax, bx) + x + 0.5;
      const maxX = Math.max(ax, bx) + x + 0.5;
      const minZ = Math.min(az, bz) + z + 0.5;
      const maxZ = Math.max(az, bz) + z + 0.5;
      out.push({
        minX,
        maxX,
        minY: y + b.min[1],
        maxY: y + b.max[1],
        minZ,
        maxZ,
      });
    }
    return out;
  }

  /**
   * レイキャスト（ブロックのタップ判定）用のボックス。
   * 開いているドアも掴めるよう、state に関わらず閉じた形状で判定する。
   */
  cellPickBoxes(x: number, y: number, z: number): AABB[] {
    return this.cellCollisionBoxes(x, y, z, undefined, undefined, false);
  }

  /**
   * 指定範囲と重なる固体ボックスをすべて集める。
   * 地面（y<0）と外周の壁も含む。
   */
  collectSolidBoxes(range: AABB, out: AABB[] = []): AABB[] {
    out.length = 0;

    // 地面
    if (range.minY < 0) {
      out.push({
        minX: -1000,
        maxX: 1000,
        minY: -100,
        maxY: 0,
        minZ: -1000,
        maxZ: 1000,
      });
    }

    // 外周の壁（建築可能領域の外側1セル、高さは無限扱いで領域外への脱出を防ぐ）
    if (range.minX < 0) {
      out.push({ minX: -1, maxX: 0, minY: -100, maxY: 1000, minZ: -1000, maxZ: 1000 });
    }
    if (range.maxX > GRID_X) {
      out.push({ minX: GRID_X, maxX: GRID_X + 1, minY: -100, maxY: 1000, minZ: -1000, maxZ: 1000 });
    }
    if (range.minZ < 0) {
      out.push({ minX: -1000, maxX: 1000, minY: -100, maxY: 1000, minZ: -1, maxZ: 0 });
    }
    if (range.maxZ > GRID_Z) {
      out.push({ minX: -1000, maxX: 1000, minY: -100, maxY: 1000, minZ: GRID_Z, maxZ: GRID_Z + 1 });
    }

    const x0 = Math.max(0, Math.floor(range.minX));
    const x1 = Math.min(GRID_X - 1, Math.floor(range.maxX));
    const y0 = Math.max(0, Math.floor(range.minY));
    const y1 = Math.min(GRID_Y - 1, Math.floor(range.maxY));
    const z0 = Math.max(0, Math.floor(range.minZ));
    const z1 = Math.min(GRID_Z - 1, Math.floor(range.maxZ));

    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (this.voxels.getBlockId(x, y, z) === 0) continue;
          for (const box of this.cellCollisionBoxes(x, y, z)) {
            if (aabbOverlap(box, range)) out.push(box);
          }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- アクション

  /** ドアの開閉をトグルする */
  toggleDoor(cell: CellPos): boolean {
    const def = blockDefByIndex(this.voxels.getBlockId(cell.x, cell.y, cell.z));
    if (!def || def.action !== 'door') return false;
    this.voxels.setState(cell.x, cell.y, cell.z, !this.voxels.getState(cell.x, cell.y, cell.z));
    return true;
  }

  /** セルのブロック定義 */
  defAt(cell: CellPos): BlockDef | undefined {
    return blockDefByIndex(this.voxels.getBlockId(cell.x, cell.y, cell.z));
  }

  /** セル索引 → セル座標 */
  static cellOfIndex(index: number): CellPos {
    return indexToCell(index);
  }
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ
  );
}
