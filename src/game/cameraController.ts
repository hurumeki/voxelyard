/**
 * 三人称の軌道カメラ（仕様書 セクション5）
 *
 * - プレイヤーを注視点とする
 * - ズーム距離 1.5m 〜 6m
 * - 垂直角度 -10° 〜 80°
 * - めり込み対策：注視点からカメラ位置へレイを飛ばし、
 *   間に障害物があれば衝突点の手前まで引き寄せる。離れたら滑らかに戻す。
 */

import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { Player } from '../physics/player.ts';
import type { World } from './world.ts';
import { raycastWorld } from './raycast.ts';

export const MIN_DISTANCE = 1.5;
export const MAX_DISTANCE = 6.0;
const MIN_PITCH = (-10 * Math.PI) / 180;
const MAX_PITCH = (80 * Math.PI) / 180;
/** カメラが壁にめり込まないようにする余裕 */
const COLLISION_MARGIN = 0.25;

export class CameraController {
  readonly camera: PerspectiveCamera;

  /** 水平角。0 のときプレイヤーの背後（-Z 方向）から見る */
  yaw = 0;
  /** 仰角 */
  pitch = (20 * Math.PI) / 180;
  /** ユーザーが指定した距離 */
  desiredDistance = 4.0;

  /** 実際に使っている距離（障害物で縮む） */
  private currentDistance = 4.0;

  private readonly target = new Vector3();
  private readonly offset = new Vector3();

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(70, aspect, 0.05, 400);
  }

  rotate(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + deltaPitch));
  }

  zoom(factor: number): void {
    this.desiredDistance = Math.min(
      MAX_DISTANCE,
      Math.max(MIN_DISTANCE, this.desiredDistance * factor),
    );
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 移動入力をワールド方向へ変換するための水平角 */
  get movementYaw(): number {
    return this.yaw;
  }

  update(world: World, player: Player, dt: number): void {
    this.target.set(player.x, player.eyeY(), player.z);

    const cosPitch = Math.cos(this.pitch);
    // yaw = 0 でプレイヤーの背後（+Z 側）にカメラが来る
    const dirX = Math.sin(this.yaw) * cosPitch;
    const dirY = Math.sin(this.pitch);
    const dirZ = Math.cos(this.yaw) * cosPitch;

    let allowed = this.desiredDistance;
    const hit = raycastWorld(
      world,
      { x: this.target.x, y: this.target.y, z: this.target.z },
      { x: dirX, y: dirY, z: dirZ },
      this.desiredDistance + COLLISION_MARGIN,
    );
    if (hit) {
      allowed = Math.max(MIN_DISTANCE * 0.4, hit.distance - COLLISION_MARGIN);
    }

    if (allowed < this.currentDistance) {
      // 障害物にぶつかったら即座に引き寄せる（めり込みを見せない）
      this.currentDistance = allowed;
    } else {
      // 離れたら滑らかに元の距離へ戻す
      const speed = 1 - Math.exp(-8 * dt);
      this.currentDistance += (allowed - this.currentDistance) * speed;
    }

    this.offset.set(dirX, dirY, dirZ).multiplyScalar(this.currentDistance);
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);
  }

  /**
   * 画面上の正規化デバイス座標（-1〜1）からワールドへのレイを作る。
   */
  rayFromNdc(ndcX: number, ndcY: number): { origin: Vector3; direction: Vector3 } {
    const origin = this.camera.position.clone();
    const direction = new Vector3(ndcX, ndcY, 0.5)
      .unproject(this.camera)
      .sub(origin)
      .normalize();
    return { origin, direction };
  }
}
