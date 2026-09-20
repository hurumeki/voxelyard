/**
 * 着色を頂点属性／インスタンス属性へ渡すための値づくり。
 *
 * シェーダー（materials.ts の TINT_ATTRIBUTE）は vec4 を受け取る。
 *   xyz = パレット色（リニア RGB）
 *   w   = 適用量（0 = 素の色、1 = 着色）
 *
 * 色番号は高々十数種類なので、変換結果は使い回す。
 */

import { TINT_NONE, blockColorByIndex, tintLinearRgb } from '../core/blockColors.ts';

export { TINT_NONE };

/** 着色なし。xyz は使われないので白を入れておく */
const NONE: readonly [number, number, number, number] = [1, 1, 1, 0];

const cache = new Map<number, readonly [number, number, number, number]>();

/** 色番号 → 属性値（vec4） */
export function tintAttributeValue(tint: number): readonly [number, number, number, number] {
  // 未知の色番号（将来のパレットで保存されたデータなど）は素の色として扱う
  if (blockColorByIndex(tint) === undefined) return NONE;
  const cached = cache.get(tint);
  if (cached) return cached;
  const [r, g, b] = tintLinearRgb(tint);
  const value = [r, g, b, 1] as const;
  cache.set(tint, value);
  return value;
}
