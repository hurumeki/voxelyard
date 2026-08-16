/**
 * ゲーム本体。描画・入力・物理・保存を束ねる。
 *
 * 描画ループは requestAnimationFrame、物理は固定タイムステップ（Player 側）で
 * 分離してある（仕様書 セクション4）。
 */

import { Vector3, WebGPURenderer } from 'three/webgpu';
import type { DataArrayTexture } from 'three/webgpu';

import { GRID_X, GRID_Z } from '../core/coords.ts';
import type { CellPos } from '../core/coords.ts';
import { World } from './world.ts';
import { raycastWorld } from './raycast.ts';
import { CameraController } from './cameraController.ts';
import { Player } from '../physics/player.ts';
import { WorldRenderer } from '../render/worldRenderer.ts';
import { GhostPreview } from '../render/ghost.ts';
import { PlayerModel } from '../render/playerModel.ts';
import { TouchControls } from '../input/touchControls.ts';
import { Hud } from '../ui/hud.ts';
import type { Mode } from '../ui/hud.ts';
import { AudioManager } from '../audio/audio.ts';
import { toast } from '../ui/dom.ts';
import type { WorldMeta } from '../storage/db.ts';
import { saveWorld } from '../storage/db.ts';

/** リーチ：プレイヤー中心から半径5セル（5m） */
export const REACH = 5.0;
/** オートセーブ間隔 */
const AUTOSAVE_INTERVAL_MS = 30_000;
/** 連続操作で保存が乱発しないようにするデバウンス */
const SAVE_DEBOUNCE_MS = 1200;

export type GameOptions = {
  container: HTMLElement;
  hud: Hud;
  texture: DataArrayTexture;
  audio: AudioManager;
  pixelRatio: number;
  showFps: boolean;
  /** WebGL2 バックエンドを強制する（開発時の動作確認用） */
  forceWebGL?: boolean;
};

export class Game {
  readonly renderer: WebGPURenderer;
  readonly worldRenderer: WorldRenderer;
  readonly camera: CameraController;
  readonly player = new Player();

  private world: World;
  private meta: WorldMeta;

  private readonly ghost: GhostPreview;
  private readonly playerModel = new PlayerModel();
  private readonly touch: TouchControls;
  private readonly hud: Hud;
  private readonly audio: AudioManager;

  private mode: Mode = 'normal';
  private selectedIndex = -1;
  private placeRotation = 0;
  /** 着座中の椅子のセル */
  private seatCell: CellPos | null = null;

  private jumpQueued = false;
  private aimX: number | null = null;
  private aimY: number | null = null;

  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private showFps: boolean;

  private lastSaveAt = 0;
  private saveTimer: number | undefined;
  private savingPromise: Promise<void> | null = null;

  private readonly tmpVec = new Vector3();

  private constructor(
    renderer: WebGPURenderer,
    private readonly options: GameOptions,
    world: World,
    meta: WorldMeta,
  ) {
    this.renderer = renderer;
    this.world = world;
    this.meta = meta;
    this.hud = options.hud;
    this.audio = options.audio;
    this.showFps = options.showFps;

    this.worldRenderer = new WorldRenderer(options.texture);
    this.ghost = new GhostPreview(this.worldRenderer);
    this.worldRenderer.add(this.ghost.root);
    this.worldRenderer.add(this.playerModel.root);

    const rect = options.container.getBoundingClientRect();
    this.camera = new CameraController(Math.max(rect.width, 1) / Math.max(rect.height, 1));

    this.touch = new TouchControls(options.container, this.hud.stickRoot, {
      onLook: (dx, dy) => {
        // 指の動きとカメラの回る向きを一致させる
        this.camera.rotate(dx * 0.006, -dy * 0.005);
      },
      onZoom: (factor) => this.camera.zoom(factor),
      onTap: (x, y) => void this.handleTap(x, y),
      onAim: (x, y) => {
        this.aimX = x;
        this.aimY = y;
      },
    });

    this.hud.setMode('normal');
    this.hud.setFpsVisible(this.showFps);

    this.applyWorld(world, meta);
  }

  /**
   * WebGPURenderer は非同期初期化が必須。init() を待たずに描画すると失敗する。
   */
  static async create(options: GameOptions, world: World, meta: WorldMeta): Promise<Game> {
    const renderer = new WebGPURenderer({ antialias: false, forceWebGL: options.forceWebGL });
    await renderer.init();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.pixelRatio));
    const rect = options.container.getBoundingClientRect();
    renderer.setSize(Math.max(rect.width, 1), Math.max(rect.height, 1), false);
    options.container.appendChild(renderer.domElement);
    return new Game(renderer, options, world, meta);
  }

  // ---------------------------------------------------------------- ワールド

  /** ワールドを差し替える（一覧から別のワールドを開いたとき） */
  applyWorld(world: World, meta: WorldMeta): void {
    this.world = world;
    this.meta = meta;
    this.worldRenderer.clearWorldMeshes();
    this.worldRenderer.rebuildAll(world);

    const p = meta.playerState.positionWorld;
    this.player.reset(p.x, p.y, p.z, (meta.playerState.rotationY * Math.PI) / 180);
    // 着座状態は保存対象外。必ず立った状態から開始する
    this.player.seated = false;
    this.seatCell = null;
    this.camera.yaw = (meta.playerState.rotationY * Math.PI) / 180;
    this.world.clearDirty();
    this.lastSaveAt = performance.now();
  }

  currentMeta(): WorldMeta {
    return this.meta;
  }

  currentWorld(): World {
    return this.world;
  }

  setMetaName(name: string): void {
    this.meta = { ...this.meta, name };
    this.world.markDirty();
  }

  // ---------------------------------------------------------------- ループ

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.player.resetAccumulator();
    const loop = (now: number): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  private frame(now: number): void {
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // タブ復帰直後などの巨大な dt は切り詰める
    const dt = Math.min(rawDt, 0.25);

    this.updateFps(rawDt);

    // 移動入力があれば着座を解除する
    if (this.player.seated && (this.touch.forward !== 0 || this.touch.strafe !== 0)) {
      this.standUp();
    }

    this.player.update(
      this.world,
      dt,
      {
        forward: this.touch.forward,
        strafe: this.touch.strafe,
        jumpQueued: this.jumpQueued,
      },
      this.camera.movementYaw,
    );
    this.jumpQueued = false;

    this.camera.update(this.world, this.player, dt);
    this.playerModel.update(
      this.player.x,
      this.player.y,
      this.player.z,
      this.player.yaw,
      this.player.horizontalSpeed,
      this.player.seated,
      dt,
    );

    this.worldRenderer.update(this.world);
    this.updateGhost();

    // init() 済みなので同期版の render() でよい
    this.renderer.render(this.worldRenderer.scene, this.camera.camera);

    this.maybeAutoSave(now);
  }

  private updateFps(rawDt: number): void {
    if (!this.showFps) return;
    this.fpsAccum += rawDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      const fps = this.fpsFrames / this.fpsAccum;
      const pending = this.worldRenderer.pendingChunkCount();
      this.hud.setFps(fps, pending > 0 ? `  chunk:${pending}` : '');
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }

  resize(): void {
    const rect = this.options.container.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    this.renderer.setSize(w, h, false);
    this.camera.setAspect(w / h);
  }

  setPixelRatio(ratio: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratio));
    this.resize();
  }

  setShowFps(show: boolean): void {
    this.showFps = show;
    this.hud.setFpsVisible(show);
  }

  // ---------------------------------------------------------------- モード

  setMode(mode: Mode): void {
    this.mode = mode;
    this.hud.setMode(mode);
    if (mode !== 'place') this.ghost.hide();
  }

  getMode(): Mode {
    return this.mode;
  }

  selectSlot(index: number): void {
    const blockId = this.hud.blockIdAt(index);
    if (!blockId) return;
    if (this.mode === 'place' && this.selectedIndex === index) {
      // 同じアイコンを再タップしたら通常モードへ戻る
      this.selectedIndex = -1;
      this.hud.setSelectedIndex(-1);
      this.setMode('normal');
      return;
    }
    this.selectedIndex = index;
    this.hud.setSelectedIndex(index);
    // ブロックを切り替えても回転角はリセットしない
    this.setMode('place');
  }

  selectTool(tool: 'break' | 'action'): void {
    this.setMode(this.mode === tool ? 'normal' : tool);
  }

  rotatePlacement(delta: number): void {
    this.placeRotation = (this.placeRotation + delta + 4) % 4;
  }

  queueJump(): void {
    if (this.player.seated) this.standUp();
    this.jumpQueued = true;
  }

  private selectedBlockId(): string | null {
    return this.selectedIndex >= 0 ? this.hud.blockIdAt(this.selectedIndex) : null;
  }

  // ---------------------------------------------------------------- 操作

  private ndcFromClient(clientX: number, clientY: number): [number, number] {
    const rect = this.options.container.getBoundingClientRect();
    return [
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ];
  }

  private pick(clientX: number, clientY: number) {
    const [nx, ny] = this.ndcFromClient(clientX, clientY);
    const ray = this.camera.rayFromNdc(nx, ny);
    // カメラからブロックまでの距離は、プレイヤーからのリーチより長くなり得るので
    // カメラ距離ぶんの余裕を加えて飛ばし、リーチ判定は別途行う。
    const maxDistance = REACH + this.camera.camera.position.distanceTo(
      this.tmpVec.set(this.player.x, this.player.eyeY(), this.player.z),
    );
    return raycastWorld(
      this.world,
      { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z },
      { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z },
      maxDistance,
    );
  }

  /** プレイヤー中心からセル中心までの距離がリーチ内か */
  private withinReach(cell: CellPos): boolean {
    const cx = cell.x + 0.5;
    const cy = cell.y + 0.5;
    const cz = cell.z + 0.5;
    const px = this.player.x;
    const py = this.player.y + 0.875; // 当たり判定の中心高さ
    const pz = this.player.z;
    return Math.hypot(cx - px, cy - py, cz - pz) <= REACH;
  }

  private async handleTap(clientX: number, clientY: number): Promise<void> {
    await this.audio.unlock();
    this.aimX = clientX;
    this.aimY = clientY;

    if (this.mode === 'normal') return;
    // 着座中はブロック操作を行えない
    if (this.player.seated && this.mode !== 'action') return;

    const hit = this.pick(clientX, clientY);
    if (!hit) return;

    if (this.mode === 'place') {
      const blockId = this.selectedBlockId();
      if (!blockId) return;
      const target: CellPos = {
        x: hit.cell.x + hit.normal[0],
        y: hit.cell.y + hit.normal[1],
        z: hit.cell.z + hit.normal[2],
      };
      if (!this.withinReach(target)) return;
      const check = this.world.canPlace(blockId, target, this.placeRotation, this.player.box());
      if (!check.ok) return;
      this.world.place(blockId, target, this.placeRotation);
      this.audio.playEffect('place');
      this.scheduleSave();
      return;
    }

    if (this.mode === 'break') {
      if (hit.isGround) return; // 地面は破壊不可
      if (!this.withinReach(hit.cell)) return;
      if (this.world.remove(hit.cell)) {
        this.audio.playEffect('break');
        this.scheduleSave();
      }
      return;
    }

    // アクションモード
    if (hit.isGround) return;
    if (!this.withinReach(hit.cell)) return;
    const def = this.world.defAt(hit.cell);
    if (!def?.action) return;
    if (def.action === 'door') {
      if (this.world.toggleDoor(hit.cell)) this.scheduleSave();
      return;
    }
    if (def.action === 'sit') {
      if (this.player.seated) this.standUp();
      else this.sitOn(hit.cell);
    }
  }

  private sitOn(cell: CellPos): void {
    const rot = this.world.voxels.getRotation(cell.x, cell.y, cell.z);
    this.player.seated = true;
    this.player.velocityY = 0;
    this.player.x = cell.x + 0.5;
    this.player.z = cell.z + 0.5;
    this.player.y = cell.y + 0.5; // 座面の高さ
    this.player.yaw = rot * (Math.PI / 2);
    this.seatCell = cell;
  }

  private standUp(): void {
    if (!this.player.seated) return;
    this.player.seated = false;
    if (this.seatCell) this.player.y = this.seatCell.y + 0.5;
    this.seatCell = null;
    this.player.resetAccumulator();
  }

  // ---------------------------------------------------------------- ゴースト

  private updateGhost(): void {
    if (this.mode !== 'place') {
      this.ghost.hide();
      return;
    }
    const blockId = this.selectedBlockId();
    if (!blockId) {
      this.ghost.hide();
      return;
    }

    // 直近に触れた位置、なければ画面中央を狙う
    const rect = this.options.container.getBoundingClientRect();
    const cx = this.aimX ?? rect.left + rect.width / 2;
    const cy = this.aimY ?? rect.top + rect.height / 2;

    const hit = this.pick(cx, cy);
    if (!hit) {
      this.ghost.hide();
      return;
    }
    const target: CellPos = {
      x: hit.cell.x + hit.normal[0],
      y: hit.cell.y + hit.normal[1],
      z: hit.cell.z + hit.normal[2],
    };
    const check = this.world.canPlace(blockId, target, this.placeRotation, this.player.box());
    const valid = check.ok && this.withinReach(target);
    this.ghost.show(blockId, target.x, target.y, target.z, this.placeRotation, valid);
  }

  // ---------------------------------------------------------------- 保存

  /** デバウンス付きの保存予約。ダーティでなければ何もしない */
  scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), SAVE_DEBOUNCE_MS);
  }

  private maybeAutoSave(now: number): void {
    if (now - this.lastSaveAt < AUTOSAVE_INTERVAL_MS) return;
    this.lastSaveAt = now;
    if (!this.world.isDirty()) return;
    void this.save();
  }

  /** 実際に保存する。ダーティフラグが立っていなければスキップ */
  async save(force = false): Promise<void> {
    if (!force && !this.world.isDirty()) return;
    if (this.savingPromise) return this.savingPromise;

    window.clearTimeout(this.saveTimer);
    this.world.clearDirty();
    this.lastSaveAt = performance.now();

    const meta: WorldMeta = {
      ...this.meta,
      updatedAt: new Date().toISOString(),
      playerState: {
        positionWorld: { x: this.player.x, y: this.player.y, z: this.player.z },
        rotationY: (this.camera.yaw * 180) / Math.PI,
      },
    };
    this.meta = meta;

    this.savingPromise = saveWorld(meta, this.world.voxels.cloneBuffer())
      .catch((err: unknown) => {
        this.world.markDirty();
        console.error('ワールドの保存に失敗しました', err);
        toast('保存に失敗しました。空き容量を確認してください。');
      })
      .finally(() => {
        this.savingPromise = null;
      });
    return this.savingPromise;
  }

  // ---------------------------------------------------------------- 後始末

  /** バックグラウンドへ回るとき */
  onHidden(): void {
    this.stop();
    this.touch.reset();
    this.audio.suspend();
    void this.save();
  }

  /** 復帰時。アキュムレータを必ずリセットする */
  onVisible(): void {
    this.player.resetAccumulator();
    this.audio.resume();
    this.resize();
    this.start();
  }

  dispose(): void {
    this.stop();
    this.touch.dispose();
    this.ghost.dispose();
    this.playerModel.dispose();
    this.worldRenderer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** スポーン地点（グリッド中央の地面上） */
  static defaultSpawn(): { x: number; y: number; z: number } {
    return { x: GRID_X / 2 + 0.5, y: 0, z: GRID_Z / 2 + 0.5 };
  }
}
