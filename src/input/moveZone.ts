/**
 * 移動スティックを起動できる領域（仕様書 セクション5）
 *
 * 移動エリアを画面左半分にすると、中央付近のブロックを狙ったタップまで
 * 移動操作として奪われてしまう。そのため親指の届く左下の隅だけに限定する。
 * DOM に依存しないよう矩形は引数で受け取る。
 */

/** 移動エリアの割合（画面左下から見た横幅・高さ） */
export const MOVE_ZONE_RATIO = 1 / 3;

export type SurfaceRect = { left: number; top: number; width: number; height: number };

/** 指定座標（clientX/clientY）が移動エリア内か */
export function isInMoveZone(clientX: number, clientY: number, rect: SurfaceRect): boolean {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return x < rect.width * MOVE_ZONE_RATIO && y > rect.height * (1 - MOVE_ZONE_RATIO);
}
