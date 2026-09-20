/**
 * JSON エクスポート／インポート（仕様書 セクション10）
 *
 * 実行時は密なバイナリ、入出力は疎な配列。
 * マルチセル占有ブロックは基準セルのみを1エントリとして出力し、
 * occupies に全占有セルを列挙する。
 */

import { GRID_X, GRID_Y, GRID_Z, degreesToRotationIndex, rotationIndexToDegrees } from '../core/coords.ts';
import type { CellPos } from '../core/coords.ts';
import { blockDefById, blockDefByIndex, blockIndexOf } from '../core/blocks.ts';
import { TINT_NONE, blockColorIdOf, blockColorIndexOf } from '../core/blockColors.ts';
import { World } from '../game/world.ts';
import type { WorldMeta } from './db.ts';

/**
 * 書き出しフォーマットの版。
 * v2 でブロックの色（color）を追加した。色は省略可能なので v1 も読み込める。
 */
export const FORMAT_VERSION = 2;
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1, 2];

export type ExportedBlock = {
  x: number;
  y: number;
  z: number;
  blockId: string;
  rotationY: number;
  /** 着色。素の色のブロックでは省略する */
  color?: string;
  state?: { open: boolean };
  occupies?: Array<{ x: number; y: number; z: number }>;
};

export type ExportedWorld = {
  formatVersion: number;
  app: string;
  world: { name: string; createdAt: string; updatedAt: string };
  gridSize: { width: number; depth: number; height: number };
  blocks: ExportedBlock[];
};

// ---------------------------------------------------------------- エクスポート

export function buildExport(world: World, meta: WorldMeta): ExportedWorld {
  const blocks: ExportedBlock[] = [];

  world.voxels.forEachFilled((x, y, z) => {
    // 従属セルは基準セル側の occupies で表現するので出力しない
    if (world.voxels.isDependent(x, y, z)) return;
    const def = blockDefByIndex(world.voxels.getBlockId(x, y, z));
    if (!def) return;
    const rot = world.voxels.getRotation(x, y, z);

    const entry: ExportedBlock = {
      x,
      y,
      z,
      blockId: def.blockId,
      rotationY: rotationIndexToDegrees(rot),
    };
    const colorId = blockColorIdOf(world.voxels.getTint(x, y, z));
    if (colorId) entry.color = colorId;
    if (def.usesState) {
      entry.state = { open: world.voxels.getState(x, y, z) };
    }
    if (def.cellCount > 1) {
      entry.occupies = world
        .occupiedCells(def, { x, y, z }, rot)
        .map((c) => ({ x: c.x, y: c.y, z: c.z }));
    }
    blocks.push(entry);
  });

  return {
    formatVersion: FORMAT_VERSION,
    app: 'VoxelYard',
    world: { name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt },
    gridSize: { width: GRID_X, depth: GRID_Z, height: GRID_Y },
    blocks,
  };
}

/** ファイル名に使えない文字（/ \\ : * ? " < > | と制御文字）を _ に置換する */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const replaced = name.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  return replaced.length > 0 ? replaced.slice(0, 60) : 'world';
}

export function exportFilename(worldName: string, at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `_${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${sanitizeFilename(worldName)}_${stamp}.json`;
}

/** Blob を生成して <a download> でダウンロードする（iPad では共有シート経由） */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Safari がダウンロードを開始する前に revoke すると失敗するため少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- インポート

export type ImportResult = {
  world: World;
  worldName: string;
  placed: number;
  skipped: number;
  /** 代表的なスキップ理由（先頭のいくつか） */
  messages: string[];
};

export class ImportError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * JSON をバリデーションしつつ新しい World を組み立てる。
 * 不正なブロックはスキップし、件数を返す（読み込み全体は失敗させない）。
 */
export function importWorld(json: unknown): ImportResult {
  if (!isObject(json)) throw new ImportError('JSON の形式が不正です。');

  if (typeof json.formatVersion !== 'number' || !SUPPORTED_FORMAT_VERSIONS.includes(json.formatVersion)) {
    throw new ImportError(
      `対応していないフォーマットです（formatVersion: ${String(json.formatVersion)}` +
        `／対応: ${SUPPORTED_FORMAT_VERSIONS.join(', ')}）。`,
    );
  }

  const grid = json.gridSize;
  if (
    !isObject(grid) ||
    grid.width !== GRID_X ||
    grid.depth !== GRID_Z ||
    grid.height !== GRID_Y
  ) {
    throw new ImportError(
      `グリッドサイズが現行仕様と一致しません（必要: ${GRID_X}×${GRID_Z}×${GRID_Y}）。`,
    );
  }

  if (!Array.isArray(json.blocks)) throw new ImportError('blocks 配列がありません。');

  const worldInfo = isObject(json.world) ? json.world : {};
  const worldName = typeof worldInfo.name === 'string' && worldInfo.name.trim()
    ? worldInfo.name.trim()
    : 'インポートしたワールド';

  const world = new World();
  const claimed = new Set<string>();
  const messages: string[] = [];
  let placed = 0;
  let skipped = 0;

  const fail = (msg: string): void => {
    skipped++;
    if (messages.length < 5) messages.push(msg);
  };

  const key = (c: { x: number; y: number; z: number }): string => `${c.x},${c.y},${c.z}`;
  const inGrid = (c: { x: number; y: number; z: number }): boolean =>
    c.x >= 0 && c.x < GRID_X && c.y >= 0 && c.y < GRID_Y && c.z >= 0 && c.z < GRID_Z;

  for (const raw of json.blocks) {
    if (!isObject(raw)) {
      fail('ブロックの形式が不正です。');
      continue;
    }
    const { x, y, z } = raw;
    if (!isInt(x) || !isInt(y) || !isInt(z) || !inGrid({ x, y, z })) {
      fail(`座標が範囲外です: (${String(x)}, ${String(y)}, ${String(z)})`);
      continue;
    }
    if (typeof raw.blockId !== 'string') {
      fail('blockId がありません。');
      continue;
    }
    const def = blockDefById(raw.blockId);
    if (!def) {
      fail(`未知のブロックです: ${raw.blockId}`);
      continue;
    }
    const rotDeg = raw.rotationY ?? 0;
    if (typeof rotDeg !== 'number') {
      fail(`rotationY が不正です: ${String(rotDeg)}`);
      continue;
    }
    const rot = degreesToRotationIndex(rotDeg);
    if (rot === null) {
      fail(`rotationY は 0/90/180/270 のいずれかである必要があります: ${rotDeg}`);
      continue;
    }

    const expected = world.occupiedCells(def, { x, y, z }, rot);

    // occupies が与えられている場合は形状定義・回転と矛盾しないか検証する
    if (raw.occupies !== undefined) {
      if (!Array.isArray(raw.occupies) || raw.occupies.length !== expected.length) {
        fail(`occupies の内容が ${raw.blockId} の形状と矛盾しています: (${x}, ${y}, ${z})`);
        continue;
      }
      const given = new Set(
        raw.occupies
          .filter(isObject)
          .filter((c) => isInt(c.x) && isInt(c.y) && isInt(c.z))
          .map((c) => `${c.x as number},${c.y as number},${c.z as number}`),
      );
      if (given.size !== expected.length || !expected.every((c) => given.has(key(c)))) {
        fail(`occupies の内容が ${raw.blockId} の形状と矛盾しています: (${x}, ${y}, ${z})`);
        continue;
      }
    }

    // 範囲外・重複のチェック
    if (!expected.every(inGrid)) {
      fail(`占有セルが範囲外です: ${raw.blockId} (${x}, ${y}, ${z})`);
      continue;
    }
    if (expected.some((c) => claimed.has(key(c)))) {
      fail(`同一セルが重複しています: (${x}, ${y}, ${z})`);
      continue;
    }

    // 未知の色は素の色として読み込む（読み込み全体は失敗させない）
    let tint = TINT_NONE;
    if (raw.color !== undefined) {
      if (typeof raw.color !== 'string') {
        fail(`color が不正です: ${String(raw.color)}`);
        continue;
      }
      tint = blockColorIndexOf(raw.color);
      if (tint === TINT_NONE) {
        if (messages.length < 5) messages.push(`未知の色です（素の色にしました）: ${raw.color}`);
      }
    }

    const blockIndex = blockIndexOf(def.blockId);
    const open = isObject(raw.state) && raw.state.open === true;
    expected.forEach((c: CellPos, i: number) => {
      claimed.add(key(c));
      world.voxels.setBlock(c.x, c.y, c.z, blockIndex, rot, def.usesState && open, i > 0, tint);
    });
    placed++;
  }

  world.markAllChunksDirty();
  return { world, worldName, placed, skipped, messages };
}
