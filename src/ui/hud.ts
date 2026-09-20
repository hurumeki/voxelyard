/**
 * ゲーム画面の HUD（仕様書 セクション5・8）
 *
 * ┌─────────────────────────────────────────────┐
 * │ [モード表示]                    [設定] [保存] │
 * │           （3Dビューポート）                  │
 * │                              [⟲][⟳] ← 回転  │
 * │                                  [ジャンプ]  │
 * │ ○ 仮想スティック          [ホットバー 1〜8]  │
 * └─────────────────────────────────────────────┘
 */

import { BLOCK_DEFS, blockDefById } from '../core/blocks.ts';
import type { TextureSource } from '../render/textures.ts';
import { blockIconUrl } from './blockIcons.ts';
import { asUiControl, el } from './dom.ts';

export type Mode = 'normal' | 'place' | 'break' | 'action';

export const HOTBAR_SIZE = 8;

/** ホットバーの既定構成（仕様書 セクション10 の settings 例と同じ） */
export const DEFAULT_HOTBAR: string[] = [
  'wood_natural',
  'stone_natural',
  'wood_stair',
  'wood_half',
  'chair_wood',
  'table_wood',
  'door_wood',
  'window_wood',
];

const MODE_LABEL: Record<Mode, string> = {
  normal: '通常モード',
  place: '設置モード',
  break: '破壊モード',
  action: 'アクションモード',
};

export type HudCallbacks = {
  onJump(): void;
  onRotate(delta: number): void;
  onSelectSlot(index: number): void;
  onSelectTool(tool: 'break' | 'action'): void;
  onOpenSettings(): void;
  onOpenInventory(): void;
  onSave(): void;
  onExitToWorldList(): void;
};

export class Hud {
  readonly root: HTMLElement;
  readonly stickRoot: HTMLElement;

  private readonly modeBadge: HTMLElement;
  private readonly fpsMeter: HTMLElement;
  private readonly rotateRow: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly breakSlot: HTMLElement;
  private readonly actionSlot: HTMLElement;

  private hotbar: string[] = [...DEFAULT_HOTBAR];
  private mode: Mode = 'normal';
  private selectedIndex = -1;

  constructor(
    private readonly textureSource: TextureSource,
    private readonly callbacks: HudCallbacks,
  ) {
    this.modeBadge = el('div', { className: 'mode-badge', text: MODE_LABEL.normal });
    this.fpsMeter = el('div', { attrs: { id: 'fps-meter' }, className: 'hidden', text: '-- fps' });

    const topLeft = el('div', {
      className: 'hud-top-left',
      children: [this.modeBadge, this.fpsMeter],
    });

    const backBtn = asUiControl(el('button', { className: 'hud-icon-btn', text: '一覧' }));
    backBtn.addEventListener('click', () => this.callbacks.onExitToWorldList());
    const invBtn = asUiControl(el('button', { className: 'hud-icon-btn', text: '道具' }));
    invBtn.addEventListener('click', () => this.callbacks.onOpenInventory());
    const setBtn = asUiControl(el('button', { className: 'hud-icon-btn', text: '設定' }));
    setBtn.addEventListener('click', () => this.callbacks.onOpenSettings());
    const saveBtn = asUiControl(el('button', { className: 'hud-icon-btn', text: '保存' }));
    saveBtn.addEventListener('click', () => this.callbacks.onSave());

    const topRight = el('div', {
      className: 'hud-top-right',
      children: [backBtn, invBtn, setBtn, saveBtn],
    });

    // 回転ボタン（設置モード時のみ表示）
    const rotLeft = asUiControl(el('button', { className: 'round-btn', text: '⟲' }));
    rotLeft.addEventListener('click', () => this.callbacks.onRotate(-1));
    const rotRight = asUiControl(el('button', { className: 'round-btn', text: '⟳' }));
    rotRight.addEventListener('click', () => this.callbacks.onRotate(1));
    this.rotateRow = el('div', { className: 'rotate-row hidden', children: [rotLeft, rotRight] });

    const jump = asUiControl(
      el('button', { className: 'round-btn', text: 'ジャンプ', attrs: { id: 'btn-jump' } }),
    );
    jump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.callbacks.onJump();
    });

    const bottomRight = el('div', {
      className: 'hud-bottom-right',
      children: [this.rotateRow, jump],
    });

    // ホットバー：8スロット＋破壊／アクションの専用アイコン
    const hotbarRow = el('div', { attrs: { id: 'hotbar' } });
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = asUiControl(el('button', { className: 'slot' }));
      slot.addEventListener('click', () => this.callbacks.onSelectSlot(i));
      this.slots.push(slot);
      hotbarRow.appendChild(slot);
    }
    this.breakSlot = asUiControl(el('button', { className: 'slot' }));
    this.breakSlot.appendChild(el('div', { className: 'slot-swatch', text: '🔨' }));
    this.breakSlot.appendChild(el('div', { text: '破壊' }));
    this.breakSlot.addEventListener('click', () => this.callbacks.onSelectTool('break'));
    this.actionSlot = asUiControl(el('button', { className: 'slot' }));
    this.actionSlot.appendChild(el('div', { className: 'slot-swatch', text: '✋' }));
    this.actionSlot.appendChild(el('div', { text: '操作' }));
    this.actionSlot.addEventListener('click', () => this.callbacks.onSelectTool('action'));
    hotbarRow.appendChild(this.breakSlot);
    hotbarRow.appendChild(this.actionSlot);

    this.stickRoot = el('div', {
      attrs: { id: 'stick' },
      children: [el('div', { className: 'stick-knob' })],
    });

    // 指を離しているあいだは画面中央を狙っていることを示す（設置モード時のみ表示）
    this.crosshair = el('div', { attrs: { id: 'crosshair' }, className: 'hidden' });

    this.root = el('div', {
      attrs: { id: 'hud' },
      children: [topLeft, topRight, bottomRight, hotbarRow, this.stickRoot, this.crosshair],
    });

    this.renderHotbar();
  }

  // ---------------------------------------------------------------- 状態反映

  setMode(mode: Mode): void {
    this.mode = mode;
    this.modeBadge.textContent = MODE_LABEL[mode];
    this.rotateRow.classList.toggle('hidden', mode !== 'place');
    this.crosshair.classList.toggle('hidden', mode !== 'place');
    this.updateSelection();
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = index;
    this.updateSelection();
  }

  private updateSelection(): void {
    this.slots.forEach((slot, i) => {
      slot.classList.toggle('selected', this.mode === 'place' && i === this.selectedIndex);
    });
    this.breakSlot.classList.toggle('selected', this.mode === 'break');
    this.actionSlot.classList.toggle('selected', this.mode === 'action');
  }

  setHotbar(config: string[]): void {
    this.hotbar = [...config];
    while (this.hotbar.length < HOTBAR_SIZE) this.hotbar.push('');
    this.hotbar.length = HOTBAR_SIZE;
    this.renderHotbar();
  }

  getHotbar(): string[] {
    return [...this.hotbar];
  }

  blockIdAt(index: number): string | null {
    const id = this.hotbar[index];
    return id && blockDefById(id) ? id : null;
  }

  private renderHotbar(): void {
    this.slots.forEach((slot, i) => {
      slot.replaceChildren();
      const blockId = this.hotbar[i];
      const def = blockId ? blockDefById(blockId) : undefined;
      if (!def) {
        slot.appendChild(el('div', { className: 'slot-swatch' }));
        slot.appendChild(el('div', { text: '—' }));
        return;
      }
      const img = el('img', {
        className: 'slot-swatch',
        attrs: { src: blockIconUrl(this.textureSource, def.blockId), alt: def.name },
      });
      slot.appendChild(img);
      slot.appendChild(el('div', { text: def.name }));
    });
    this.updateSelection();
  }

  setFpsVisible(visible: boolean): void {
    this.fpsMeter.classList.toggle('hidden', !visible);
  }

  setFps(fps: number, extra = ''): void {
    this.fpsMeter.textContent = `${fps.toFixed(0)} fps${extra}`;
  }

  /** インベントリ編集画面の中身を組み立てる */
  buildInventoryEditor(onChange: (config: string[]) => void): HTMLElement {
    let picked: string | null = null;

    const editorSlots: HTMLElement[] = [];
    const editorRow = el('div', { className: 'hotbar-editor' });

    const refresh = (): void => {
      editorSlots.forEach((slot, i) => {
        slot.replaceChildren();
        const def = blockDefById(this.hotbar[i] ?? '');
        if (def) {
          slot.appendChild(
            el('img', {
              className: 'slot-swatch',
              attrs: { src: blockIconUrl(this.textureSource, def.blockId), alt: def.name },
            }),
          );
          slot.appendChild(el('div', { text: def.name }));
        } else {
          slot.appendChild(el('div', { className: 'slot-swatch' }));
          slot.appendChild(el('div', { text: '空き' }));
        }
      });
    };

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = el('button', { className: 'slot' });
      const assign = (): void => {
        if (picked === null) return;
        this.hotbar[i] = picked;
        this.renderHotbar();
        refresh();
        onChange(this.getHotbar());
      };
      slot.addEventListener('click', assign);
      // ドラッグ＆ドロップでも配置できる
      slot.addEventListener('dragover', (e) => {
        e.preventDefault();
        slot.classList.add('drop-target');
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('drop-target'));
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        slot.classList.remove('drop-target');
        const id = e.dataTransfer?.getData('text/plain');
        if (id && blockDefById(id)) {
          this.hotbar[i] = id;
          this.renderHotbar();
          refresh();
          onChange(this.getHotbar());
        }
      });
      editorSlots.push(slot);
      editorRow.appendChild(slot);
    }
    refresh();

    const grid = el('div', { className: 'inventory-grid' });
    const items: HTMLElement[] = [];
    for (const def of BLOCK_DEFS) {
      const item = el('button', {
        className: 'inv-item',
        attrs: { draggable: 'true' },
        children: [
          el('img', {
            className: 'slot-swatch',
            attrs: { src: blockIconUrl(this.textureSource, def.blockId), alt: def.name },
          }),
          el('div', { text: def.name }),
        ],
      });
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', def.blockId);
      });
      item.addEventListener('click', () => {
        picked = picked === def.blockId ? null : def.blockId;
        items.forEach((n) => n.classList.remove('picked'));
        if (picked) item.classList.add('picked');
      });
      items.push(item);
      grid.appendChild(item);
    }

    return el('div', {
      className: 'modal-body',
      children: [
        el('div', {
          className: 'hint',
          text: 'ブロックを選んでからホットバーのスロットをタップすると配置できます（ドラッグ＆ドロップも可）。',
        }),
        editorRow,
        grid,
      ],
    });
  }
}
