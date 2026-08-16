/**
 * IndexedDB スキーマと入出力（仕様書 セクション10）
 *
 * DB名: voxelyard-db / バージョン: 1
 *  - worlds      (keyPath: worldId, index: updatedAt)
 *  - worldVoxels (keyPath: worldId)  … voxelData は ArrayBuffer をそのまま保存
 *  - settings    (keyPath: key)
 *
 * voxelData をバイナリのまま扱うことで、シリアライズなしに 256KB 固定サイズで
 * 一瞬で保存できる。
 */

import { CELL_COUNT } from '../core/coords.ts';
import { BLOCK_INDEX_BY_ID, currentBlockIdMap } from '../core/blocks.ts';
import {
  BIT_DEPENDENT,
  BIT_STATE,
  MASK_BLOCK_ID,
  MASK_ROTATION,
} from '../core/voxelData.ts';

const DB_NAME = 'voxelyard-db';
const DB_VERSION = 1;

export const STORE_WORLDS = 'worlds';
export const STORE_VOXELS = 'worldVoxels';
export const STORE_SETTINGS = 'settings';

export type PlayerState = {
  positionWorld: { x: number; y: number; z: number };
  rotationY: number;
};

export type WorldMeta = {
  worldId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  playerState: PlayerState;
};

export type WorldVoxelRecord = {
  worldId: string;
  voxelData: ArrayBuffer;
  blockIdMap: Record<string, string>;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_WORLDS)) {
        const store = db.createObjectStore(STORE_WORLDS, { keyPath: 'worldId' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE_VOXELS)) {
        db.createObjectStore(STORE_VOXELS, { keyPath: 'worldId' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'));
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB のトランザクションに失敗しました'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB のトランザクションが中断されました'));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB の要求に失敗しました'));
  });
}

// ---------------------------------------------------------------- worlds

/** 最終更新日時の降順でワールド一覧を返す */
export async function listWorlds(): Promise<WorldMeta[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_WORLDS, 'readonly');
  const all = await reqResult<WorldMeta[]>(tx.objectStore(STORE_WORLDS).getAll());
  await txDone(tx);
  return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export async function getWorld(worldId: string): Promise<WorldMeta | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_WORLDS, 'readonly');
  const rec = await reqResult<WorldMeta | undefined>(tx.objectStore(STORE_WORLDS).get(worldId));
  await txDone(tx);
  return rec;
}

export async function putWorldMeta(meta: WorldMeta): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_WORLDS, 'readwrite');
  tx.objectStore(STORE_WORLDS).put(meta);
  await txDone(tx);
}

/** メタ情報と voxel バイナリをまとめて保存する */
export async function saveWorld(meta: WorldMeta, voxelBuffer: ArrayBuffer): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_WORLDS, STORE_VOXELS], 'readwrite');
  tx.objectStore(STORE_WORLDS).put(meta);
  const record: WorldVoxelRecord = {
    worldId: meta.worldId,
    voxelData: voxelBuffer,
    blockIdMap: currentBlockIdMap(),
  };
  tx.objectStore(STORE_VOXELS).put(record);
  await txDone(tx);
}

export async function deleteWorld(worldId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_WORLDS, STORE_VOXELS], 'readwrite');
  tx.objectStore(STORE_WORLDS).delete(worldId);
  tx.objectStore(STORE_VOXELS).delete(worldId);
  await txDone(tx);
}

/**
 * voxel バイナリを読み込む。
 * 保存時の blockIdMap が現行定義と異なる場合はインデックスを変換する。
 */
export async function loadVoxelBuffer(worldId: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_VOXELS, 'readonly');
  const rec = await reqResult<WorldVoxelRecord | undefined>(
    tx.objectStore(STORE_VOXELS).get(worldId),
  );
  await txDone(tx);
  if (!rec) return null;
  if (rec.voxelData.byteLength !== CELL_COUNT * 2) return null;
  return remapBlockIndices(rec.voxelData, rec.blockIdMap);
}

/**
 * 保存時のインデックス → 現行のインデックスへ変換する。
 * 現行定義に存在しない blockId のセルは空にする。
 */
function remapBlockIndices(buffer: ArrayBuffer, storedMap: Record<string, string>): ArrayBuffer {
  const current = currentBlockIdMap();
  let identical = true;
  for (const key of new Set([...Object.keys(storedMap), ...Object.keys(current)])) {
    if (storedMap[key] !== current[key]) {
      identical = false;
      break;
    }
  }
  if (identical) return buffer;

  // 旧インデックス → 新インデックス
  const lookup = new Int16Array(MASK_BLOCK_ID + 1).fill(-1);
  lookup[0] = 0;
  for (const [oldIndexStr, blockId] of Object.entries(storedMap)) {
    const oldIndex = Number(oldIndexStr);
    if (!Number.isInteger(oldIndex) || oldIndex < 0 || oldIndex > MASK_BLOCK_ID) continue;
    lookup[oldIndex] = BLOCK_INDEX_BY_ID.get(blockId) ?? 0;
  }

  const cells = new Uint16Array(buffer);
  for (let i = 0; i < cells.length; i++) {
    const raw = cells[i];
    if (raw === 0) continue;
    const oldIndex = raw & MASK_BLOCK_ID;
    const mapped = lookup[oldIndex];
    if (mapped <= 0) {
      cells[i] = 0;
      continue;
    }
    cells[i] = mapped | (raw & (MASK_ROTATION | BIT_STATE | BIT_DEPENDENT));
  }
  return buffer;
}

// ---------------------------------------------------------------- settings

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const rec = await reqResult<{ key: string; value: T } | undefined>(
    tx.objectStore(STORE_SETTINGS).get(key),
  );
  await txDone(tx);
  return rec ? rec.value : fallback;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SETTINGS, 'readwrite');
  tx.objectStore(STORE_SETTINGS).put({ key, value });
  await txDone(tx);
}

// ---------------------------------------------------------------- ユーティリティ

export function newWorldId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // 古い WebKit 向けのフォールバック
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
