/**
 * 設置ゴーストプレビュー（仕様書 セクション7）
 *
 * - 設置候補セルに半透明のプレビューブロックを常時表示
 * - 選択中のブロック形状・回転を反映
 * - 設置可能：白〜緑系／設置不可：赤
 * - ゴースト自体はレイキャストの対象外（自前の voxel レイキャストなので自然に除外される）
 */

import { Group, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import type { BufferGeometry } from 'three/webgpu';
import { buildUnitCubeGeometry } from './blockGeometries.ts';
import type { WorldRenderer } from './worldRenderer.ts';

const DEG90 = Math.PI / 2;

export class GhostPreview {
  readonly root = new Group();

  private readonly material = new MeshBasicNodeMaterial();
  private readonly cubeGeometry: BufferGeometry;
  private mesh: Mesh | null = null;
  private currentGeometry: BufferGeometry | null = null;

  constructor(private readonly renderer: WorldRenderer) {
    this.cubeGeometry = buildUnitCubeGeometry();
    this.material.transparent = true;
    this.material.opacity = 0.42;
    this.material.depthWrite = false;
    this.root.renderOrder = 3;
    this.root.visible = false;
  }

  hide(): void {
    this.root.visible = false;
  }

  /**
   * @param valid 設置可能なら true（緑系）、不可なら false（赤）
   */
  show(
    blockId: string,
    cellX: number,
    cellY: number,
    cellZ: number,
    rotation: number,
    valid: boolean,
  ): void {
    const set = this.renderer.geometrySetOf(blockId);
    const geometry = set?.solid ?? this.cubeGeometry;

    if (geometry !== this.currentGeometry) {
      if (this.mesh) this.root.remove(this.mesh);
      this.mesh = new Mesh(geometry, this.material);
      this.currentGeometry = geometry;
      this.root.add(this.mesh);
    }

    this.material.color.setHex(valid ? 0xa8f08a : 0xf05a5a);
    this.root.position.set(cellX + 0.5, cellY + 0.5, cellZ + 0.5);
    this.root.rotation.y = rotation * DEG90;
    this.root.visible = true;
  }

  dispose(): void {
    this.material.dispose();
    this.cubeGeometry.dispose();
  }
}
