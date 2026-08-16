/**
 * タッチ操作（仕様書 セクション5）
 *
 * | エリア        | ジェスチャー          | 動作                         |
 * |---------------|-----------------------|------------------------------|
 * | 画面左半分    | タップ開始位置にスティック生成＋ドラッグ | 移動（アナログ360°） |
 * | 画面右半分    | スワイプ              | カメラ視点回転               |
 * | 画面右半分    | ピンチ                | ズームイン／アウト           |
 * | 画面右半分    | タップ（移動10px未満）| ブロック操作                 |
 *
 * ジャンプは専用ボタンに分離してあるので、右半分のタップは常にブロック操作。
 */

/** タップと判定する移動量の上限（px） */
const TAP_MOVE_THRESHOLD = 10;
/** タップと判定する時間の上限（ms） */
const TAP_TIME_THRESHOLD = 400;
/** 仮想スティックの最大振れ幅（px） */
const STICK_RADIUS = 56;

export type TouchCallbacks = {
  onLook(deltaX: number, deltaY: number): void;
  onZoom(factor: number): void;
  onTap(clientX: number, clientY: number): void;
  onAim(clientX: number, clientY: number): void;
};

type LeftPointer = {
  id: number;
  originX: number;
  originY: number;
};

type RightPointer = {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  moved: number;
};

export class TouchControls {
  /** 移動入力（-1〜1）。forward は画面奥方向 */
  forward = 0;
  strafe = 0;

  private left: LeftPointer | null = null;
  private readonly right = new Map<number, RightPointer>();
  private pinchStartDistance = 0;
  private pinchLastDistance = 0;

  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;

  constructor(
    private readonly surface: HTMLElement,
    stickRoot: HTMLElement,
    private readonly callbacks: TouchCallbacks,
  ) {
    this.stickBase = stickRoot;
    const knob = stickRoot.querySelector<HTMLElement>('.stick-knob');
    if (!knob) throw new Error('仮想スティックのノブ要素が見つかりません');
    this.stickKnob = knob;

    surface.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    surface.addEventListener('pointermove', this.onPointerMove, { passive: false });
    surface.addEventListener('pointerup', this.onPointerUp, { passive: false });
    surface.addEventListener('pointercancel', this.onPointerUp, { passive: false });
    // iOS のダブルタップズーム・長押しメニューを抑制
    surface.addEventListener('gesturestart', preventDefault as EventListener, { passive: false });
    surface.addEventListener('contextmenu', preventDefault as EventListener);
  }

  dispose(): void {
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.surface.removeEventListener('pointermove', this.onPointerMove);
    this.surface.removeEventListener('pointerup', this.onPointerUp);
    this.surface.removeEventListener('pointercancel', this.onPointerUp);
  }

  /** 入力状態をすべてリセットする（バックグラウンド復帰時など） */
  reset(): void {
    this.left = null;
    this.right.clear();
    this.forward = 0;
    this.strafe = 0;
    this.pinchStartDistance = 0;
    this.hideStick();
  }

  private isLeftHalf(clientX: number): boolean {
    const rect = this.surface.getBoundingClientRect();
    return clientX - rect.left < rect.width / 2;
  }

  private onPointerDown = (ev: PointerEvent): void => {
    // UI 部品の上から始まった操作はここでは扱わない
    if ((ev.target as HTMLElement)?.closest('[data-ui-control]')) return;
    ev.preventDefault();
    this.surface.setPointerCapture?.(ev.pointerId);

    if (this.isLeftHalf(ev.clientX) && !this.left) {
      this.left = { id: ev.pointerId, originX: ev.clientX, originY: ev.clientY };
      this.showStick(ev.clientX, ev.clientY);
      this.updateStick(ev.clientX, ev.clientY);
      return;
    }

    this.right.set(ev.pointerId, {
      id: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastY: ev.clientY,
      startTime: performance.now(),
      moved: 0,
    });
    if (this.right.size === 2) {
      this.pinchStartDistance = this.pinchDistance();
      this.pinchLastDistance = this.pinchStartDistance;
    }
    if (this.right.size === 1) {
      this.callbacks.onAim(ev.clientX, ev.clientY);
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.left && ev.pointerId === this.left.id) {
      ev.preventDefault();
      this.updateStick(ev.clientX, ev.clientY);
      return;
    }

    const p = this.right.get(ev.pointerId);
    if (!p) return;
    ev.preventDefault();

    const dx = ev.clientX - p.lastX;
    const dy = ev.clientY - p.lastY;
    p.moved += Math.hypot(dx, dy);
    p.lastX = ev.clientX;
    p.lastY = ev.clientY;

    if (this.right.size >= 2) {
      const d = this.pinchDistance();
      if (this.pinchLastDistance > 0 && d > 0) {
        // 指を広げる = ズームイン = カメラ距離を縮める
        this.callbacks.onZoom(this.pinchLastDistance / d);
      }
      this.pinchLastDistance = d;
      return;
    }

    this.callbacks.onLook(dx, dy);
    this.callbacks.onAim(ev.clientX, ev.clientY);
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.left && ev.pointerId === this.left.id) {
      this.left = null;
      this.forward = 0;
      this.strafe = 0;
      this.hideStick();
      return;
    }

    const p = this.right.get(ev.pointerId);
    if (!p) return;
    this.right.delete(ev.pointerId);

    const elapsed = performance.now() - p.startTime;
    const isTap =
      p.moved < TAP_MOVE_THRESHOLD &&
      elapsed < TAP_TIME_THRESHOLD &&
      this.pinchStartDistance === 0;
    if (isTap) this.callbacks.onTap(p.startX, p.startY);

    if (this.right.size < 2) {
      this.pinchStartDistance = 0;
      this.pinchLastDistance = 0;
    }
  };

  private pinchDistance(): number {
    const pts = [...this.right.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].lastX - pts[1].lastX, pts[0].lastY - pts[1].lastY);
  }

  // ---------------------------------------------------------------- スティック

  private showStick(x: number, y: number): void {
    this.stickBase.style.display = 'block';
    this.stickBase.style.left = `${x}px`;
    this.stickBase.style.top = `${y}px`;
  }

  private hideStick(): void {
    this.stickBase.style.display = 'none';
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
  }

  private updateStick(x: number, y: number): void {
    if (!this.left) return;
    let dx = x - this.left.originX;
    let dy = y - this.left.originY;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS;
      dy = (dy / len) * STICK_RADIUS;
    }
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    // 画面上方向 = 前進
    this.strafe = dx / STICK_RADIUS;
    this.forward = -dy / STICK_RADIUS;
  }
}

function preventDefault(ev: Event): void {
  ev.preventDefault();
}
