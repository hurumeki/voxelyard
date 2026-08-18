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
import { attribute, texture, uv, vec4 } from 'three/tsl';

/** ジオメトリに持たせる、面ごとのテクスチャレイヤー番号の属性名 */
export const TEX_LAYER_ATTRIBUTE = 'texLayer';

function arrayTextureColorNode(tex: DataArrayTexture) {
  // 1つの面（四角形）の4頂点はすべて同じレイヤー番号を持つため、
  // 補間しても値は変化しない。念のため round してから整数化する。
  const layer = attribute<'float'>(TEX_LAYER_ATTRIBUTE, 'float').round().toInt();
  const sampled = texture(tex, uv()).depth(layer);
  const vertexTint = attribute<'vec3'>('color', 'vec3');
  return vec4(sampled.rgb.mul(vertexTint), sampled.a);
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
