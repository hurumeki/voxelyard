/**
 * 設置できない理由をユーザーへ伝えるための変換（仕様書 セクション7）。
 *
 * world.canPlace() は失敗理由を返しているので、それを文言とゴーストの色に落とす。
 * Three.js には依存させない（テストから直接読めるようにするため）。
 */

import type { PlaceFailure } from './world.ts';

/** 設置できる */
export const GHOST_COLOR_OK = 0xa8f08a;
/** プレイヤー自身が邪魔をしている（体をどければ置ける） */
export const GHOST_COLOR_BLOCKED_BY_PLAYER = 0xf0a83c;
/** それ以外の理由で置けない */
export const GHOST_COLOR_INVALID = 0xf05a5a;

const MESSAGES: Record<PlaceFailure, string> = {
  'player-overlap': '自分が邪魔で置けません',
  'no-support': '地面か他のブロックに接していないと置けません',
  occupied: 'すでにブロックがあります',
  'out-of-bounds': 'ワールドの外には置けません',
  'out-of-reach': '届きません',
  'unknown-block': 'このブロックは置けません',
};

/** 失敗理由に対応する日本語の説明 */
export function placeFailMessage(reason: PlaceFailure): string {
  return MESSAGES[reason];
}

/**
 * ゴーストの色。理由が null なら設置可能。
 * 「自分が邪魔」だけは別色にする（体をどければ置けるので、他の失敗とは対処が違う）。
 */
export function ghostColorFor(reason: PlaceFailure | null): number {
  if (reason === null) return GHOST_COLOR_OK;
  if (reason === 'player-overlap') return GHOST_COLOR_BLOCKED_BY_PLAYER;
  return GHOST_COLOR_INVALID;
}
