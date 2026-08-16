/**
 * ホットバー／インベントリ用のブロックアイコン。
 * テクスチャ生成と同じ TextureSource から作るので、見た目がゲーム内と一致する。
 */

import type { TextureName } from '../core/blocks.ts';
import { BLOCK_DEFS } from '../core/blocks.ts';
import type { TextureSource } from '../render/textures.ts';

const cache = new Map<TextureName, string>();

function dataUrlFor(source: TextureSource, name: TextureName): string {
  const cached = cache.get(name);
  if (cached) return cached;

  const size = source.size;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const rgba = source.generate(name);
  const image = ctx.createImageData(size, size);
  // テクスチャは行0が下端なので、アイコンでは上下を反転して表示する
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    image.data.set(rgba.subarray(src, src + size * 4), y * size * 4);
  }
  ctx.putImageData(image, 0, 0);
  const url = canvas.toDataURL('image/png');
  cache.set(name, url);
  return url;
}

/** ブロックの代表面（側面）のアイコン URL */
export function blockIconUrl(source: TextureSource, blockId: string): string {
  const def = BLOCK_DEFS.find((d) => d.blockId === blockId);
  if (!def) return '';
  // 草ブロックは上面のほうが見分けやすい
  const name = def.blockId === 'grass_natural' ? def.tex.top : def.tex.side;
  return dataUrlFor(source, name);
}
