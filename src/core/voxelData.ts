/**
 * 実行時 voxel データ構造（仕様書 セクション2）
 *
 * 64 × 32 × 64 = 131,072 セル × 2バイト = 256KB の密な Uint16Array。
 * 隣接判定が O(1) で行えること、IndexedDB へ ArrayBuffer をそのまま保存できることが狙い。
 *
 * 16ビットのビット割り当て:
 *   bits 0-9   (10bit) : blockId のインデックス（0 = 空、最大1023種類）
 *   bits 10-11 (2bit)  : rotationY（0=0°, 1=90°, 2=180°, 3=270°）
 *   bit  12    (1bit)  : state フラグ（ドアの開閉など）
 *   bit  13    (1bit)  : マルチセル占有ブロックの「従属セル」マーカー
 *   bits 14-15 (2bit)  : 予備
 *
 * ビット演算がコード全体に散らばらないよう、アクセスは必ずこのモジュールのヘルパーを通すこと。
 */

import { CELL_COUNT, GRID_X, GRID_Y, GRID_Z, cellIndex, inBounds } from './coords.ts';

export const MASK_BLOCK_ID = 0x03ff; // bits 0-9
export const SHIFT_ROTATION = 10;
export const MASK_ROTATION = 0x0c00; // bits 10-11
export const BIT_STATE = 1 << 12;
export const BIT_DEPENDENT = 1 << 13;

/** 1セル分の 16bit 値から blockId インデックスを取り出す */
export function getBlockIdFromRaw(raw: number): number {
  return raw & MASK_BLOCK_ID;
}
/** 1セル分の 16bit 値から rotationY インデックス（0-3）を取り出す */
export function getRotationFromRaw(raw: number): number {
  return (raw & MASK_ROTATION) >>> SHIFT_ROTATION;
}
export function getStateFromRaw(raw: number): boolean {
  return (raw & BIT_STATE) !== 0;
}
export function isDependentFromRaw(raw: number): boolean {
  return (raw & BIT_DEPENDENT) !== 0;
}

/** 各フィールドから 16bit 値を組み立てる */
export function packCell(
  blockIndex: number,
  rotation: number,
  state: boolean,
  dependent: boolean,
): number {
  return (
    (blockIndex & MASK_BLOCK_ID) |
    ((rotation & 3) << SHIFT_ROTATION) |
    (state ? BIT_STATE : 0) |
    (dependent ? BIT_DEPENDENT : 0)
  );
}

/**
 * voxel 配列のラッパ。
 * ブロックの意味的な操作（マルチセル占有・設置条件など）は上位の World が担当し、
 * ここは純粋なストレージとダーティ通知のみを扱う。
 */
export class VoxelData {
  readonly cells: Uint16Array;

  /** 変更されたセルを通知するコールバック（チャンク再構築のトリガ） */
  private onCellChanged: ((x: number, y: number, z: number) => void) | null = null;

  constructor(buffer?: ArrayBufferLike) {
    if (buffer) {
      if (buffer.byteLength !== CELL_COUNT * 2) {
        throw new Error(
          `voxelData のサイズが不正です: ${buffer.byteLength} bytes (期待値 ${CELL_COUNT * 2})`,
        );
      }
      this.cells = new Uint16Array(buffer);
    } else {
      this.cells = new Uint16Array(CELL_COUNT);
    }
  }

  setChangeListener(fn: ((x: number, y: number, z: number) => void) | null): void {
    this.onCellChanged = fn;
  }

  /** 範囲外は 0（空）を返す */
  getRaw(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0;
    return this.cells[cellIndex(x, y, z)];
  }

  getBlockId(x: number, y: number, z: number): number {
    return getBlockIdFromRaw(this.getRaw(x, y, z));
  }

  getRotation(x: number, y: number, z: number): number {
    return getRotationFromRaw(this.getRaw(x, y, z));
  }

  getState(x: number, y: number, z: number): boolean {
    return getStateFromRaw(this.getRaw(x, y, z));
  }

  isDependent(x: number, y: number, z: number): boolean {
    return isDependentFromRaw(this.getRaw(x, y, z));
  }

  isEmpty(x: number, y: number, z: number): boolean {
    return this.getBlockId(x, y, z) === 0;
  }

  /** 生の 16bit 値を書き込む */
  setRaw(x: number, y: number, z: number, raw: number): void {
    if (!inBounds(x, y, z)) return;
    const i = cellIndex(x, y, z);
    if (this.cells[i] === raw) return;
    this.cells[i] = raw;
    this.onCellChanged?.(x, y, z);
  }

  setBlock(
    x: number,
    y: number,
    z: number,
    blockIndex: number,
    rotation = 0,
    state = false,
    dependent = false,
  ): void {
    this.setRaw(x, y, z, packCell(blockIndex, rotation, state, dependent));
  }

  clearCell(x: number, y: number, z: number): void {
    this.setRaw(x, y, z, 0);
  }

  setState(x: number, y: number, z: number, state: boolean): void {
    const raw = this.getRaw(x, y, z);
    if (raw === 0) return;
    this.setRaw(x, y, z, state ? raw | BIT_STATE : raw & ~BIT_STATE);
  }

  /** すべてのセルを空にする */
  clearAll(): void {
    this.cells.fill(0);
  }

  /** 設置済みセルを走査する（空セルはスキップ） */
  forEachFilled(fn: (x: number, y: number, z: number, raw: number) => void): void {
    const cells = this.cells;
    for (let y = 0; y < GRID_Y; y++) {
      const yBase = y * GRID_X * GRID_Z;
      for (let z = 0; z < GRID_Z; z++) {
        const zBase = yBase + z * GRID_X;
        for (let x = 0; x < GRID_X; x++) {
          const raw = cells[zBase + x];
          if (raw !== 0) fn(x, y, z, raw);
        }
      }
    }
  }

  /** 保存用に ArrayBuffer のコピーを返す */
  cloneBuffer(): ArrayBuffer {
    return this.cells.slice().buffer as ArrayBuffer;
  }
}
