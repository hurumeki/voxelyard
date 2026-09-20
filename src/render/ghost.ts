/**
 * 設置ゴーストプレビュー（仕様書 セクション7）
 *
 * - 設置候補セルに半透明のプレビューブロックを常時表示
 * - 選択中のブロック形状・回転を反映
 * - 設置可能：緑／プレイヤーが邪魔：橙／それ以外の理由で不可：赤
 * - 半透明の本体はプレイヤーの体やブロックに隠れて見えなくなるので、
 *   深度テストを切った輪郭線を重ねて「どのセルを狙っているか」を常に見せる
 * - ゴースト自体はレイキャストの対象外（自前の voxel レイキャストなので自然に除外される）
 */

import {
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { BufferGeometry } from 'three/webgpu';
import { buildUnitCubeGeometry } from './blockGeometries.ts';
import { ghostColorFor } from '../game/placeFeedback.ts';
import type { PlaceFailure } from '../game/world.ts';
import type { WorldRenderer } from './worldRenderer.ts';

const DEG90 = Math.PI / 2;

export class GhostPreview {
  readonly root = new Group();

  private readonly material = new MeshBasicNodeMaterial();
  private readonly outlineMaterial = new LineBasicMaterial();
  private readonly cubeGeometry: BufferGeometry;
  private mesh: Mesh | null = null;
  private outline: LineSegments | null = null;
  private currentGeometry: BufferGeometry | null = null;

  constructor(private readonly renderer: WorldRenderer) {
    this.cubeGeometry = buildUnitCubeGeometry();
    this.material.transparent = true;
    this.material.opacity = 0.42;
    this.material.depthWrite = false;
    // 何かの裏に回っても候補セルが見えるように、輪郭だけは常に手前へ描く
    this.outlineMaterial.depthTest = false;
    this.outlineMaterial.transparent = true;
    this.outlineMaterial.opacity = 0.9;
    this.root.renderOrder = 3;
    this.root.visible = false;
  }

  hide(): void {
    this.root.visible = false;
  }

  /**
   * @param reason 設置できない理由。null なら設置可能
   */
  show(
    blockId: string,
    cellX: number,
    cellY: number,
    cellZ: number,
    rotation: number,
    reason: PlaceFailure | null,
  ): void {
    const set = this.renderer.geometrySetOf(blockId);
    const geometry = set?.solid ?? this.cubeGeometry;

    if (geometry !== this.currentGeometry) {
      this.rebuild(geometry);
      this.currentGeometry = geometry;
    }

    const color = ghostColorFor(reason);
    this.material.color.setHex(color);
    this.outlineMaterial.color.setHex(color);
    this.root.position.set(cellX + 0.5, cellY + 0.5, cellZ + 0.5);
    this.root.rotation.y = rotation * DEG90;
    this.root.visible = true;
  }

  /** 形状が変わったときに本体と輪郭を作り直す */
  private rebuild(geometry: BufferGeometry): void {
    if (this.mesh) this.root.remove(this.mesh);
    if (this.outline) {
      this.root.remove(this.outline);
      // 輪郭のジオメトリはここで生成したものなので破棄する
      // （本体のジオメトリは WorldRenderer と共有なので触らない）
      this.outline.geometry.dispose();
    }

    this.mesh = new Mesh(geometry, this.material);
    this.root.add(this.mesh);

    this.outline = new LineSegments(new EdgesGeometry(geometry), this.outlineMaterial);
    this.outline.renderOrder = 4;
    this.root.add(this.outline);
  }

  dispose(): void {
    this.outline?.geometry.dispose();
    this.material.dispose();
    this.outlineMaterial.dispose();
    this.cubeGeometry.dispose();
  }
}
