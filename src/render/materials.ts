/**
 * マテリアル生成（仕様書 セクション3）
 *
 * 面ごとの明度差は Greedy Meshing / ジオメトリ生成時に頂点カラーへ焼き込んであるので、
 * ここでは「配列テクスチャをレイヤー指定でサンプリングして頂点カラーを掛ける」だけを行う。
 *
 * 配列テクスチャのレイヤーを頂点属性で切り替える処理だけは固定機能では表現できないため
 * NodeMaterial（TSL）を使う。TSL は WebGPU / WebGL2 のどちらのバックエンドでも
 * 同一コードで動作するので、生の GLSL を書く場合のような分岐は発生しない。
 */

import { DoubleSide, MeshLambertNodeMaterial } from 'three/webgpu';
import type { DataArrayTexture } from 'three/webgpu';
import { attribute, luminance, mix, texture, uv, vec3, vec4 } from 'three/tsl';
import { LUMA, TINT_REFERENCE_LUMINANCE } from '../core/blockColors.ts';

/** ジオメトリに持たせる、面ごとのテクスチャレイヤー番号の属性名 */
export const TEX_LAYER_ATTRIBUTE = 'texLayer';

/**
 * ブロックの着色を渡す属性名。
 * xyz = パレット色（リニア RGB）、w = 適用量（0 = 素の色、1 = 着色）。
 *
 * Greedy メッシュ・地面は頂点ごと、特殊形状ブロックは InstancedBufferAttribute として
 * インスタンスごとに与える（three はどちらも同じ属性名で扱える）。
 */
export const TINT_ATTRIBUTE = 'blockTint';

function arrayTextureColorNode(tex: DataArrayTexture) {
  // 1つの面（四角形）の4頂点はすべて同じレイヤー番号を持つため、
  // 補間しても値は変化しない。念のため round してから整数化する。
  const layer = attribute<'float'>(TEX_LAYER_ATTRIBUTE, 'float').round().toInt();
  const sampled = texture(tex, uv()).depth(layer);
  const vertexTint = attribute<'vec3'>('color', 'vec3');

  // 着色：テクスチャの模様（明暗）を残したまま色相だけを差し替える。
  // 輝度を基準輝度で割ってからパレット色へ掛けるので、
  // 平均的な明るさのテクセルがちょうどパレット色になる。
  const paint = attribute<'vec4'>(TINT_ATTRIBUTE, 'vec4');
  const shade = luminance(sampled.rgb, vec3(LUMA[0], LUMA[1], LUMA[2])).div(
    TINT_REFERENCE_LUMINANCE,
  );
  const painted = paint.xyz.mul(shade).clamp(0, 1);
  // w = 0 のセルは元の色をそのまま使う（旧データ・素材そのままのブロック）
  const base = mix(sampled.rgb, painted, paint.w);

  return vec4(base.mul(vertexTint), sampled.a);
}

/** 不透明ブロック用（Greedy メッシュ・特殊形状インスタンス共通） */
export function createOpaqueBlockMaterial(tex: DataArrayTexture): MeshLambertNodeMaterial {
  const mat = new MeshLambertNodeMaterial();
  mat.colorNode = arrayTextureColorNode(tex);
  mat.transparent = false;
  return mat;
}

/**
 * 透過ブロック（窓のガラス面）用。
 * 不透明パスの後に描画されるよう transparent を立てる。
 * ガラスは薄い板なので裏側からも見えるよう DoubleSide。
 */
export function createTransparentBlockMaterial(tex: DataArrayTexture): MeshLambertNodeMaterial {
  const mat = new MeshLambertNodeMaterial();
  mat.colorNode = arrayTextureColorNode(tex);
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = DoubleSide;
  return mat;
}
