/**
 * プレイヤーの移動・衝突判定（仕様書 セクション4）
 *
 * - 物理演算は固定タイムステップ（60Hz）のアキュムレータ方式。描画ループとは分離する。
 * - 1フレームあたりの最大サブステップは5回で打ち切る（デススパイラル防止）。
 * - 落下の終端速度は「1ステップの移動量が 0.25ユニット（= 0.125m）以内」に収まる値。
 * - 衝突は軸ごとのスイープ判定で行い、床のすり抜け（トンネリング）を防ぐ。
 */

import type { AABB, World } from '../game/world.ts';
import { aabbOverlap } from '../game/world.ts';
import { GRID_X, GRID_Z } from '../core/coords.ts';

/** 当たり判定の寸法（仕様書：幅1 × 奥行1 × 高さ3.5ユニット） */
export const PLAYER_WIDTH = 0.5; // 1ユニット
export const PLAYER_HEIGHT = 1.75; // 3.5ユニット
export const PLAYER_HALF_W = PLAYER_WIDTH / 2;

/** 自動で登れる段差（半ブロック = 1ユニット） */
export const STEP_HEIGHT = 0.5;

export const WALK_SPEED = 4.0; // m/s
export const GRAVITY = 22.0; // m/s^2
/** 終端速度。60Hz の1ステップで 7.5/60 = 0.125m = 0.25ユニット */
export const TERMINAL_VELOCITY = 7.5;
/** ジャンプ初速。到達高 7.0^2 / (2*22) ≈ 1.11m > 1m（通常ブロック1段） */
export const JUMP_VELOCITY = 7.0;

export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 5;

const EPS = 1e-4;

/** スイープ判定の結果 */
type SweepResult = {
  /** 実際に動かせる距離 */
  move: number;
  /** 何かに当たって移動が制限されたか */
  blocked: boolean;
};

export type MoveInput = {
  /** カメラ基準の移動方向。長さ 0〜1 */
  forward: number;
  strafe: number;
  jumpQueued: boolean;
};

export class Player {
  /** ワールド座標。足元（AABB の底面）の中心 */
  x = 32.5;
  y = 0;
  z = 32.5;

  velocityY = 0;
  /** 向き（ラジアン、Y軸まわり）。移動方向に追従する */
  yaw = 0;

  onGround = false;
  /** 着座中か。着座中は物理を止める（保存対象外） */
  seated = false;
  /** 直近フレームの水平移動速度（アニメーション用） */
  horizontalSpeed = 0;

  private accumulator = 0;
  private readonly scratchBoxes: AABB[] = [];

  reset(x: number, y: number, z: number, yaw: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
    this.velocityY = 0;
    this.onGround = false;
    this.seated = false;
    this.accumulator = 0;
  }

  /** バックグラウンド復帰時に必ず呼ぶ（仕様書 4章・11章） */
  resetAccumulator(): void {
    this.accumulator = 0;
  }

  box(): AABB {
    return {
      minX: this.x - PLAYER_HALF_W,
      maxX: this.x + PLAYER_HALF_W,
      minY: this.y,
      maxY: this.y + PLAYER_HEIGHT,
      minZ: this.z - PLAYER_HALF_W,
      maxZ: this.z + PLAYER_HALF_W,
    };
  }

  /** カメラの注視点（頭のあたり） */
  eyeY(): number {
    return this.y + PLAYER_HEIGHT * 0.85;
  }

  /**
   * 可変デルタを受け取り、固定タイムステップで物理を進める。
   *
   * 戻り値は実行したサブステップ数。0 のときは入力が一切消費されていないので、
   * 呼び出し側はジャンプなどの単発入力を次フレームへ持ち越すこと
   * （120Hz 表示だと 1/60 秒に満たないフレームが頻繁に発生する）。
   *
   * @param dt 実時間の経過秒数
   * @param cameraYaw カメラの水平角。移動入力をワールド方向へ変換するのに使う
   */
  update(world: World, dt: number, input: MoveInput, cameraYaw: number): number {
    if (this.seated) {
      this.accumulator = 0;
      this.horizontalSpeed = 0;
      return 0;
    }

    this.accumulator += dt;
    let steps = 0;
    let moved = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.accumulator -= FIXED_DT;
      steps++;
      moved += this.step(world, input, cameraYaw);
      // ジャンプは1フレームにつき1回だけ消費する
      input = { ...input, jumpQueued: false };
    }
    if (steps >= MAX_SUBSTEPS) {
      // 打ち切った分は捨てる（溜め込むとデススパイラルになる）
      this.accumulator = 0;
    }
    this.horizontalSpeed = steps > 0 ? moved / (steps * FIXED_DT) : 0;
    return steps;
  }

  /** 1固定ステップ分の更新。戻り値は水平移動距離 */
  private step(world: World, input: MoveInput, cameraYaw: number): number {
    // --- 入力からワールド方向の速度を作る -------------------------------
    const mag = Math.hypot(input.forward, input.strafe);
    let vx = 0;
    let vz = 0;
    if (mag > 0.001) {
      const clamped = Math.min(mag, 1);
      // カメラの向き基準：forward は画面奥方向
      const sin = Math.sin(cameraYaw);
      const cos = Math.cos(cameraYaw);
      const fx = -sin * (input.forward / mag);
      const fz = -cos * (input.forward / mag);
      const sx = cos * (input.strafe / mag);
      const sz = -sin * (input.strafe / mag);
      const dx = fx + sx;
      const dz = fz + sz;
      const len = Math.hypot(dx, dz) || 1;
      vx = (dx / len) * WALK_SPEED * clamped;
      vz = (dz / len) * WALK_SPEED * clamped;
      this.yaw = Math.atan2(-vx, -vz);
    }

    // --- ジャンプ・重力 -------------------------------------------------
    if (input.jumpQueued && this.onGround) {
      this.velocityY = JUMP_VELOCITY;
      this.onGround = false;
    }
    this.velocityY -= GRAVITY * FIXED_DT;
    if (this.velocityY < -TERMINAL_VELOCITY) this.velocityY = -TERMINAL_VELOCITY;

    // --- 垂直移動 -------------------------------------------------------
    const dy = this.velocityY * FIXED_DT;
    const vertical = this.sweep(world, 1, dy);
    this.y += vertical.move;
    if (vertical.blocked) {
      if (dy < 0) this.onGround = true;
      this.velocityY = 0;
    } else if (dy < 0) {
      this.onGround = false;
    }

    // --- 水平移動（段差吸収つき） ---------------------------------------
    const beforeX = this.x;
    const beforeZ = this.z;
    this.moveHorizontal(world, 0, vx * FIXED_DT);
    this.moveHorizontal(world, 2, vz * FIXED_DT);
    this.clampToWorld();

    return Math.hypot(this.x - beforeX, this.z - beforeZ);
  }

  /**
   * 水平方向へ移動する。ブロックに阻まれた場合、段差が STEP_HEIGHT 以内なら
   * 自動的に登る（半ブロック・階段の1段ぶん）。
   */
  private moveHorizontal(world: World, axis: 0 | 2, delta: number): void {
    if (delta === 0) return;
    const direct = this.sweep(world, axis, delta);
    if (!direct.blocked) {
      this.applyAxis(axis, direct.move);
      return;
    }

    // 阻まれた。段差吸収を試す
    const savedY = this.y;
    const savedX = this.x;
    const savedZ = this.z;

    const up = this.sweep(world, 1, STEP_HEIGHT);
    if (up.move < EPS) {
      this.applyAxis(axis, direct.move);
      return;
    }
    this.y += up.move;
    const stepped = this.sweep(world, axis, delta);
    if (!stepped.blocked) {
      this.applyAxis(axis, stepped.move);
      // 登った分のうち不要な高さを戻す
      const down = this.sweep(world, 1, -up.move);
      this.y += down.move;
      if (down.blocked) this.onGround = true;
      return;
    }

    // 登っても通れないので元に戻す
    this.y = savedY;
    this.x = savedX;
    this.z = savedZ;
    this.applyAxis(axis, direct.move);
  }

  private applyAxis(axis: 0 | 1 | 2, delta: number): void {
    if (axis === 0) this.x += delta;
    else if (axis === 1) this.y += delta;
    else this.z += delta;
  }

  /**
   * 指定軸方向へ delta だけ動かせる距離を返す（スイープ判定）。
   * 途中のブロックを飛び越えないよう、掃過範囲全体を対象にする。
   *
   * blocked は「何かに当たって移動が制限されたか」。
   * 単純に move !== delta で判定すると、めり込み防止の微小マージンのせいで
   * 衝突していなくても常に true になってしまうので、明示的に返す。
   */
  private sweep(world: World, axis: 0 | 1 | 2, delta: number): SweepResult {
    if (delta === 0) return { move: 0, blocked: false };
    const box = this.box();
    const swept: AABB = { ...box };
    if (axis === 0) {
      if (delta > 0) swept.maxX += delta;
      else swept.minX += delta;
    } else if (axis === 1) {
      if (delta > 0) swept.maxY += delta;
      else swept.minY += delta;
    } else {
      if (delta > 0) swept.maxZ += delta;
      else swept.minZ += delta;
    }

    const boxes = world.collectSolidBoxes(swept, this.scratchBoxes);
    let allowed = delta;
    let blocked = false;

    const limit = (value: number): void => {
      if (delta > 0 ? value < allowed : value > allowed) {
        allowed = value;
        blocked = true;
      }
    };

    for (const b of boxes) {
      // 他の2軸で重なっていなければ衝突しない
      if (axis === 0) {
        if (!(box.minY < b.maxY - EPS && box.maxY > b.minY + EPS)) continue;
        if (!(box.minZ < b.maxZ - EPS && box.maxZ > b.minZ + EPS)) continue;
        if (delta > 0) {
          if (b.minX >= box.maxX - EPS) limit(b.minX - box.maxX);
        } else {
          if (b.maxX <= box.minX + EPS) limit(b.maxX - box.minX);
        }
      } else if (axis === 1) {
        if (!(box.minX < b.maxX - EPS && box.maxX > b.minX + EPS)) continue;
        if (!(box.minZ < b.maxZ - EPS && box.maxZ > b.minZ + EPS)) continue;
        if (delta > 0) {
          if (b.minY >= box.maxY - EPS) limit(b.minY - box.maxY);
        } else {
          if (b.maxY <= box.minY + EPS) limit(b.maxY - box.minY);
        }
      } else {
        if (!(box.minX < b.maxX - EPS && box.maxX > b.minX + EPS)) continue;
        if (!(box.minY < b.maxY - EPS && box.maxY > b.minY + EPS)) continue;
        if (delta > 0) {
          if (b.minZ >= box.maxZ - EPS) limit(b.minZ - box.maxZ);
        } else {
          if (b.maxZ <= box.minZ + EPS) limit(b.maxZ - box.minZ);
        }
      }
    }

    if (blocked) {
      // 数値誤差でめり込まないよう、わずかに手前で止める
      allowed = allowed > 0 ? Math.max(0, allowed - EPS) : Math.min(0, allowed + EPS);
    }
    return { move: allowed, blocked };
  }

  /** 建築可能領域の内側に収める（壁の当たり判定の保険） */
  private clampToWorld(): void {
    const lo = PLAYER_HALF_W;
    this.x = Math.min(Math.max(this.x, lo), GRID_X - lo);
    this.z = Math.min(Math.max(this.z, lo), GRID_Z - lo);
  }

  /** 現在位置でブロックと重なっていないか（設置直後の押し出し確認用） */
  isStuck(world: World): boolean {
    const box = this.box();
    const boxes = world.collectSolidBoxes(box, this.scratchBoxes);
    return boxes.some((b) => aabbOverlap(b, box));
  }
}
