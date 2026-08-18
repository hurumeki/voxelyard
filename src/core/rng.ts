/**
 * シード固定の擬似乱数生成器（mulberry32）。
 *
 * テクスチャの手続き的生成に Math.random() を使うと起動のたびに模様が変わってしまうため、
 * 見た目の再現性が必要な箇所では必ずこちらを使うこと（仕様書 セクション8）。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
