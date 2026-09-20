/**
 * ブロックの色（着色パレット）
 *
 * ブロックの「素材」（木・石・板など）と「色」を分離して持つ。
 * 色は voxel の 16bit とは別の Uint8Array（1セル1バイト）に格納する。
 * 0 は「素の色（着色なし）」で、1 以降がこの配列のパレット番号に対応する。
 *
 * ⚠️ 既存の要素を並べ替えたり削除したりしてはならない（保存済みワールドの
 * 色番号がずれるため）。追加は必ず末尾に行うこと。
 *
 * 着色はテクスチャの明暗（木目・石目）を残したまま色相だけを置き換える。
 *   着色後 = clamp(パレット色 × (テクスチャの輝度 / 基準輝度), 0, 1)
 * これをシェーダー（materials.ts）とアイコン生成（ui/blockIcons.ts）の
 * 両方で使うため、計算はこのモジュールに集約する。
 */

/** 着色なしを表すパレット番号 */
export const TINT_NONE = 0;

export type BlockColor = {
  /** 保存フォーマット（JSON）で使う識別子 */
  readonly id: string;
  readonly name: string;
  /** UI のスウォッチ用（CSS 色） */
  readonly css: string;
  /** sRGB 0〜1 */
  readonly srgb: readonly [number, number, number];
};

function color(id: string, name: string, css: string): BlockColor {
  const hex = css.replace('#', '');
  const srgb = [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ] as const;
  return { id, name, css, srgb };
}

/** パレット本体。配列インデックス + 1 が保存される色番号になる（0 は着色なし） */
export const BLOCK_COLORS: readonly BlockColor[] = [
  color('white', 'しろ', '#ece9e1'),
  color('gray', 'はいいろ', '#9b9e96'),
  color('black', 'くろずみ', '#4a4c4f'),
  color('red', 'あか', '#c8503c'),
  color('orange', 'だいだい', '#dd8b39'),
  color('yellow', 'きいろ', '#e3c54a'),
  color('lime', 'きみどり', '#9ac44d'),
  color('green', 'みどり', '#4e9a54'),
  color('sky', 'そらいろ', '#62aede'),
  color('blue', 'あお', '#3f6fc0'),
  color('purple', 'むらさき', '#8b5cb0'),
  color('pink', 'ももいろ', '#d97ba6'),
];

/** 色番号の上限（Uint8Array に収まること） */
export const MAX_TINT_INDEX = BLOCK_COLORS.length;

const INDEX_BY_ID: ReadonlyMap<string, number> = new Map(
  BLOCK_COLORS.map((c, i) => [c.id, i + 1] as const),
);

/** 色番号 → 定義。0（着色なし）と範囲外は undefined */
export function blockColorByIndex(index: number): BlockColor | undefined {
  return index >= 1 && index <= BLOCK_COLORS.length ? BLOCK_COLORS[index - 1] : undefined;
}

/** 色 id → 色番号。未知の id は 0（着色なし） */
export function blockColorIndexOf(id: string): number {
  return INDEX_BY_ID.get(id) ?? TINT_NONE;
}

/** 色番号 → 色 id。着色なしは null */
export function blockColorIdOf(index: number): string | null {
  return blockColorByIndex(index)?.id ?? null;
}

/** 保存されている色番号として妥当か（未知の番号は着色なしへ丸める） */
export function normalizeTint(index: number): number {
  return Number.isInteger(index) && index >= 1 && index <= BLOCK_COLORS.length ? index : TINT_NONE;
}

/** 現行パレットの colorMap（保存時にワールドへ埋め込む） */
export function currentColorMap(): Record<string, string> {
  const map: Record<string, string> = {};
  BLOCK_COLORS.forEach((c, i) => {
    map[String(i + 1)] = c.id;
  });
  return map;
}

// ---------------------------------------------------------------- 色の計算

/**
 * 着色の基準輝度（リニア空間）。
 * テクスチャの輝度がこの値のとき、着色結果がパレット色そのものになる。
 * 手続き的テクスチャ（木・板・石）の平均輝度に合わせてある。
 */
export const TINT_REFERENCE_LUMINANCE = 0.35;

/** 輝度の係数（three.js の luminance() と同じ Rec.709） */
export const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** パレット色をリニア RGB で返す。着色なしは白（描画側で使わない） */
export function tintLinearRgb(index: number): [number, number, number] {
  const c = blockColorByIndex(index);
  if (!c) return [1, 1, 1];
  return [srgbToLinear(c.srgb[0]), srgbToLinear(c.srgb[1]), srgbToLinear(c.srgb[2])];
}

/**
 * リニア RGB のテクセルへ着色を適用する（シェーダーと同じ式）。
 * アイコン生成のプレビューでも同じ見た目になるよう、ここを唯一の実装とする。
 */
export function applyTintLinear(
  texel: readonly [number, number, number],
  tintIndex: number,
): [number, number, number] {
  if (tintIndex === TINT_NONE) return [texel[0], texel[1], texel[2]];
  const tint = tintLinearRgb(tintIndex);
  const lum = texel[0] * LUMA[0] + texel[1] * LUMA[1] + texel[2] * LUMA[2];
  const scale = lum / TINT_REFERENCE_LUMINANCE;
  return [
    Math.min(1, tint[0] * scale),
    Math.min(1, tint[1] * scale),
    Math.min(1, tint[2] * scale),
  ];
}

/** sRGB 0〜255 のピクセルへ着色を適用する（アイコン生成用） */
export function applyTintSrgb255(
  r: number,
  g: number,
  b: number,
  tintIndex: number,
): [number, number, number] {
  if (tintIndex === TINT_NONE) return [r, g, b];
  const linear = applyTintLinear(
    [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)],
    tintIndex,
  );
  return [
    Math.round(linearToSrgb(linear[0]) * 255),
    Math.round(linearToSrgb(linear[1]) * 255),
    Math.round(linearToSrgb(linear[2]) * 255),
  ];
}
