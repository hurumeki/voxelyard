/**
 * エントリポイント。
 * 起動チェック → ワールド一覧 → ゲーム画面 の流れと、
 * iOS / PWA 特有の対応（セクション11）をここで束ねる。
 */

import './style.css';

import { World } from './game/world.ts';
import { Game } from './game/game.ts';
import { AudioManager } from './audio/audio.ts';
import { ProceduralTextureSource, buildBlockTextureArray } from './render/textures.ts';
import { DEFAULT_HOTBAR, Hud } from './ui/hud.ts';
import {
  confirmDialog,
  el,
  formatDateTime,
  promptDialog,
  requireEl,
  toast,
} from './ui/dom.ts';
import {
  deleteWorld,
  getSetting,
  getWorld,
  listWorlds,
  loadVoxelBuffer,
  newWorldId,
  putWorldMeta,
  saveWorld,
  setSetting,
} from './storage/db.ts';
import type { WorldMeta } from './storage/db.ts';
import { buildExport, downloadJson, exportFilename, ImportError, importWorld } from './storage/worldIO.ts';
import { registerServiceWorker } from './pwa.ts';

type Settings = {
  hotbarConfig: string[];
  audioEnabled: boolean;
  showFps: boolean;
  pixelRatio: number;
};

const app = requireEl('#app');

const bootMessage = el('div', { attrs: { id: 'boot-message' }, text: '起動しています…' });
/** 読み込み失敗時にワールド一覧へ戻るためのボタン。通常は隠しておく */
const bootBackButton = el('button', {
  className: 'btn hidden',
  text: 'ワールド一覧へ戻る',
});
const bootScreen = el('div', {
  className: 'screen',
  attrs: { id: 'screen-boot' },
  children: [
    el('div', { attrs: { id: 'boot-title' }, text: 'VoxelYard' }),
    bootMessage,
    bootBackButton,
  ],
});

/** 読み込み中の表示（復帰ボタンは隠す） */
function showBootProgress(message: string): void {
  bootMessage.textContent = message;
  bootBackButton.classList.add('hidden');
  showScreen('boot');
}

/** 失敗の表示（復帰ボタンを出して行き止まりにしない） */
function showBootError(message: string, allowBack: boolean): void {
  bootMessage.textContent = message;
  bootBackButton.classList.toggle('hidden', !allowBack);
  showScreen('boot');
}

const worldsScreen = el('div', {
  className: 'screen hidden',
  attrs: { id: 'screen-worlds' },
});

const viewport = el('div', { attrs: { id: 'viewport' } });
const gameScreen = el('div', {
  className: 'screen hidden',
  attrs: { id: 'screen-game' },
  children: [viewport],
});

app.append(bootScreen, worldsScreen, gameScreen);

function showScreen(which: 'boot' | 'worlds' | 'game'): void {
  bootScreen.classList.toggle('hidden', which !== 'boot');
  worldsScreen.classList.toggle('hidden', which !== 'worlds');
  gameScreen.classList.toggle('hidden', which !== 'game');
}

// ---------------------------------------------------------------- 起動チェック

/**
 * 開発時にデスクトップの Chrome / Firefox で動作確認するための逃げ道。
 * `?webgl=1` を付けると WebGPU チェックを飛ばして WebGL2 バックエンドで起動する。
 * 実機（iPadOS 26 の Safari）では常に WebGPU を使う。
 */
const forceWebGL = new URLSearchParams(location.search).has('webgl');

async function main(): Promise<void> {
  // WebGPU 対応チェック（iPadOS 26 以降が必要）
  if (!('gpu' in navigator) && !forceWebGL) {
    showBootError(
      'この端末では動作しません。\n\nVoxelYard は WebGPU を使用します。iPadOS 26 以降にアップデートしてから、もう一度お試しください。',
      false,
    );
    return;
  }

  // ストレージの永続化を要求（IndexedDB が自動削除されないように）
  let persisted = false;
  try {
    persisted = (await navigator.storage?.persist?.()) ?? false;
  } catch {
    persisted = false;
  }

  const settings = await loadSettings();
  const textureSource = new ProceduralTextureSource();
  const texture = buildBlockTextureArray(textureSource);
  const audio = new AudioManager();
  audio.setEnabled(settings.audioEnabled);

  const state = {
    settings,
    persisted,
    game: null as Game | null,
    currentWorldId: null as string | null,
  };

  const hud = new Hud(textureSource, {
    onJump: () => state.game?.queueJump(),
    onRotate: (d) => state.game?.rotatePlacement(d),
    onSelectSlot: (i) => state.game?.selectSlot(i),
    onSelectTool: (t) => state.game?.selectTool(t),
    onOpenSettings: () => openSettings(),
    onOpenInventory: () => openInventory(),
    onSave: () => {
      void state.game?.save(true).then(() => toast('保存しました'));
    },
    onExitToWorldList: () => void exitToWorldList(),
  });
  hud.setHotbar(settings.hotbarConfig);
  gameScreen.appendChild(hud.root);

  // 最初のタップで AudioContext をアンロックする（iOS 対策）
  const unlockOnce = (): void => {
    void audio.unlock();
    window.removeEventListener('pointerdown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce, { once: true });

  // ------------------------------------------------------------ ワールド一覧

  const worldListNode = el('div', { className: 'world-list' });

  buildWorldsScreen();
  buildOrientationOverlay();
  bootBackButton.addEventListener('click', () => void exitToWorldList());

  function buildWorldsScreen(): void {
    const title = el('h1', { text: 'VoxelYard' });
    const createBtn = el('button', { className: 'btn btn-primary', text: '新規作成' });
    createBtn.addEventListener('click', () => void createWorldFlow());

    const importInput = el('input', {
      className: 'hidden',
      attrs: { type: 'file', accept: 'application/json' },
    });
    importInput.addEventListener('change', () => void handleImport(importInput));
    const importBtn = el('button', { className: 'btn', text: 'JSON読込' });
    importBtn.addEventListener('click', () => importInput.click());

    const settingsBtn = el('button', { className: 'btn', text: '設定' });
    settingsBtn.addEventListener('click', () => openSettings());

    worldsScreen.append(
      el('div', {
        className: 'worlds-header',
        children: [title, el('div', { className: 'modal-actions', children: [importBtn, settingsBtn, createBtn] })],
      }),
      worldListNode,
      importInput,
    );
  }

  async function refreshWorldList(): Promise<void> {
    const worlds = await listWorlds();
    worldListNode.replaceChildren();
    if (worlds.length === 0) {
      worldListNode.appendChild(
        el('div', { className: 'empty-note', text: 'ワールドがありません。「新規作成」から始めてください。' }),
      );
      return;
    }
    for (const meta of worlds) {
      worldListNode.appendChild(buildWorldRow(meta));
    }
  }

  function buildWorldRow(meta: WorldMeta): HTMLElement {
    const open = el('button', {
      className: 'world-row-main',
      children: [
        el('div', { className: 'world-row-name', text: meta.name }),
        el('div', { className: 'world-row-date', text: `更新 ${formatDateTime(meta.updatedAt)}` }),
      ],
    });
    open.addEventListener('click', () => void openWorld(meta.worldId));

    const rename = el('button', { className: 'btn btn-small', text: '名前' });
    rename.addEventListener('click', async () => {
      const name = await promptDialog('ワールド名の変更', meta.name);
      if (!name) return;
      await putWorldMeta({ ...meta, name, updatedAt: new Date().toISOString() });
      if (state.game && state.currentWorldId === meta.worldId) state.game.setMetaName(name);
      await refreshWorldList();
    });

    const exportBtn = el('button', { className: 'btn btn-small', text: '書出' });
    exportBtn.addEventListener('click', () => void exportWorld(meta));

    const del = el('button', { className: 'btn btn-small btn-danger', text: '削除' });
    del.addEventListener('click', async () => {
      const ok = await confirmDialog(
        'ワールドの削除',
        `「${meta.name}」を削除します。この操作は取り消せません。`,
        '削除する',
      );
      if (!ok) return;
      await deleteWorld(meta.worldId);
      if (state.currentWorldId === meta.worldId) state.currentWorldId = null;
      await refreshWorldList();
    });

    return el('div', { className: 'world-row', children: [open, rename, exportBtn, del] });
  }

  async function createWorldFlow(): Promise<void> {
    const name = await promptDialog('新しいワールド', `ワールド ${new Date().getHours()}時`);
    if (!name) return;
    const meta = await createWorld(name, new World());
    await refreshWorldList();
    await openWorld(meta.worldId);
  }

  async function createWorld(name: string, world: World): Promise<WorldMeta> {
    const now = new Date().toISOString();
    const spawn = Game.defaultSpawn();
    const meta: WorldMeta = {
      worldId: newWorldId(),
      name,
      createdAt: now,
      updatedAt: now,
      playerState: { positionWorld: spawn, rotationY: 0 },
    };
    await saveWorld(meta, world.voxels.cloneBuffer());
    return meta;
  }

  // ------------------------------------------------------------ ゲーム開始

  /**
   * ワールドを開く。
   * Game.create() は WebGPURenderer と TouchControls を作るので、
   * 二重に走ると同じビューポートに描画コンテキストが2つできてしまう。
   * 読み込み中は再入を弾く。
   */
  let openingWorld = false;

  async function openWorld(worldId: string): Promise<void> {
    if (openingWorld) return;
    openingWorld = true;
    // 読み込み中は前のワールドのループを止めておく
    state.game?.stop();
    showBootProgress('ワールドを読み込んでいます…');

    try {
      const meta = await getWorld(worldId);
      if (!meta) {
        toast('ワールドが見つかりませんでした。');
        await refreshWorldList();
        showScreen('worlds');
        return;
      }

      const buffer = await loadVoxelBuffer(worldId);
      const world = new World(buffer ?? undefined);

      if (!state.game) {
        state.game = await Game.create(
          {
            container: viewport,
            hud,
            texture,
            audio,
            pixelRatio: state.settings.pixelRatio,
            showFps: state.settings.showFps,
            forceWebGL,
          },
          world,
          meta,
        );
      } else {
        state.game.applyWorld(world, meta);
      }

      state.currentWorldId = worldId;
      await setSetting('lastOpenedWorldId', worldId);

      showScreen('game');
      state.game.resize();
      state.game.setMode('normal');
      state.game.start();
      updateOrientationOverlay();
    } catch (err) {
      console.error(err);
      // 3D初期化とデータ読み込みのどちらで失敗したかで案内を変える
      const message = state.game
        ? `ワールドの読み込みに失敗しました。\n\n${err instanceof Error ? err.message : String(err)}`
        : '3D描画の初期化に失敗しました。\n\niPadOS 26 以降であること、Safari の WebGPU が有効であることを確認してください。';
      await refreshWorldList().catch(() => undefined);
      showBootError(message, true);
    } finally {
      openingWorld = false;
    }
  }

  async function exitToWorldList(): Promise<void> {
    if (state.game) {
      state.game.stop();
      // ワールド一覧へ戻るときは必ず保存する
      await state.game.save(true);
    }
    await refreshWorldList();
    showScreen('worlds');
  }

  // ------------------------------------------------------------ 入出力

  async function exportWorld(meta: WorldMeta): Promise<void> {
    const buffer = await loadVoxelBuffer(meta.worldId);
    const world = new World(buffer ?? undefined);
    downloadJson(buildExport(world, meta), exportFilename(meta.name));
  }

  async function handleImport(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = importWorld(parsed);
      // 読み込み結果は必ず新規ワールドとして作成する
      const meta = await createWorld(result.worldName, result.world);
      await refreshWorldList();
      const detail = result.skipped > 0 ? `\n${result.messages.join('\n')}` : '';
      toast(
        `${result.placed} 個のブロックを読み込みました。` +
          (result.skipped > 0 ? `\n${result.skipped} 個をスキップしました。${detail}` : ''),
        result.skipped > 0 ? 6000 : 2600,
      );
      await openWorld(meta.worldId);
    } catch (err) {
      console.error(err);
      const message = err instanceof ImportError ? err.message : 'JSON の解析に失敗しました。';
      toast(message, 5000);
    }
  }

  // ------------------------------------------------------------ 設定・インベントリ

  function openInventory(): void {
    const backdrop = el('div', { className: 'modal-backdrop' });
    const close = el('button', { className: 'btn btn-primary', text: '閉じる' });
    const body = hud.buildInventoryEditor((config) => {
      state.settings.hotbarConfig = config;
      void setSetting('hotbarConfig', config);
    });
    const modal = el('div', {
      className: 'modal',
      children: [
        el('h2', { text: 'インベントリ／ホットバー編集' }),
        body,
        el('div', { className: 'modal-actions', children: [close] }),
      ],
    });
    backdrop.appendChild(modal);
    app.appendChild(backdrop);
    close.addEventListener('click', () => backdrop.remove());
  }

  function openSettings(): void {
    const backdrop = el('div', { className: 'modal-backdrop' });

    const audioRow = settingSwitch(
      'サウンド',
      'BGM と効果音の再生',
      state.settings.audioEnabled,
      (on) => {
        state.settings.audioEnabled = on;
        audio.setEnabled(on);
        void setSetting('audioEnabled', on);
      },
    );

    const fpsRow = settingSwitch('FPS表示', '画面左上にフレームレートを表示', state.settings.showFps, (on) => {
      state.settings.showFps = on;
      state.game?.setShowFps(on);
      void setSetting('showFps', on);
    });

    const ratioRow = el('div', { className: 'setting-row' });
    const ratioButtons = el('div', { className: 'modal-actions' });
    for (const value of [1.0, 1.25, 1.5]) {
      const b = el('button', {
        className: `btn btn-small${state.settings.pixelRatio === value ? ' btn-primary' : ''}`,
        text: value.toFixed(2),
      });
      b.addEventListener('click', () => {
        state.settings.pixelRatio = value;
        state.game?.setPixelRatio(value);
        void setSetting('pixelRatio', value);
        [...ratioButtons.children].forEach((n, i) => {
          n.className = `btn btn-small${[1.0, 1.25, 1.5][i] === value ? ' btn-primary' : ''}`;
        });
      });
      ratioButtons.appendChild(b);
    }
    ratioRow.append(
      el('div', {
        children: [
          el('div', { className: 'label', text: '描画解像度' }),
          el('div', {
            className: 'desc',
            text: '1.00 が最も軽い。余裕があれば上げてよい（最も効果の大きい設定）',
          }),
        ],
      }),
      ratioButtons,
    );

    const storageRow = el('div', {
      className: 'setting-row',
      children: [
        el('div', {
          children: [
            el('div', { className: 'label', text: 'ストレージの永続化' }),
            el('div', {
              className: 'desc',
              text: state.persisted
                ? '許可されています。データは自動削除されません。'
                : '未許可です。空き容量が減ると削除される可能性があります。',
            }),
          ],
        }),
      ],
    });

    const close = el('button', { className: 'btn btn-primary', text: '閉じる' });
    const modal = el('div', {
      className: 'modal',
      children: [
        el('h2', { text: '設定' }),
        el('div', {
          className: 'modal-body',
          children: [audioRow, fpsRow, ratioRow, storageRow],
        }),
        el('div', { className: 'modal-actions', children: [close] }),
      ],
    });
    backdrop.appendChild(modal);
    app.appendChild(backdrop);
    close.addEventListener('click', () => backdrop.remove());
  }

  // ------------------------------------------------------------ iOS 対応

  function buildOrientationOverlay(): void {
    const overlay = el('div', {
      attrs: { id: 'orientation-overlay' },
      className: 'hidden',
      children: [
        el('div', { className: 'icon', text: '📱↻' }),
        el('div', { text: '横向きにしてください' }),
        el('div', { className: 'hint', text: 'VoxelYard は横画面専用です。' }),
      ],
    });
    app.appendChild(overlay);
  }

  function updateOrientationOverlay(): void {
    const overlay = document.getElementById('orientation-overlay');
    if (!overlay) return;
    const portrait = window.innerHeight > window.innerWidth;
    const onGameScreen = !gameScreen.classList.contains('hidden');
    const show = portrait && onGameScreen;
    overlay.classList.toggle('hidden', !show);
    // 縦画面のあいだはゲーム描画を一時停止する
    if (show) state.game?.stop();
    else if (onGameScreen && state.game && !state.game.isRunning()) state.game.start();
  }

  window.addEventListener('resize', () => {
    state.game?.resize();
    updateOrientationOverlay();
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      state.game?.resize();
      updateOrientationOverlay();
    }, 150);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.game?.onHidden();
    } else if (!gameScreen.classList.contains('hidden')) {
      state.game?.onVisible();
      updateOrientationOverlay();
    }
  });

  // 保険：ページ離脱時にも保存を試みる
  window.addEventListener('pagehide', () => {
    void state.game?.save();
  });

  // ------------------------------------------------------------ 初回起動

  const worlds = await listWorlds();
  if (worlds.length === 0) {
    // 初回起動時はデフォルトワールドを自動生成して即座に遊べるようにする
    const meta = await createWorld('マイワールド1', new World());
    await refreshWorldList();
    await openWorld(meta.worldId);
    return;
  }

  await refreshWorldList();
  const last = await getSetting<string | null>('lastOpenedWorldId', null);
  if (last && worlds.some((w) => w.worldId === last)) {
    await openWorld(last);
  } else {
    showScreen('worlds');
  }
}

// ---------------------------------------------------------------- 補助

function settingSwitch(
  label: string,
  description: string,
  initial: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const sw = el('button', { className: `switch${initial ? ' on' : ''}` });
  let value = initial;
  sw.addEventListener('click', () => {
    value = !value;
    sw.classList.toggle('on', value);
    onChange(value);
  });
  return el('div', {
    className: 'setting-row',
    children: [
      el('div', {
        children: [
          el('div', { className: 'label', text: label }),
          el('div', { className: 'desc', text: description }),
        ],
      }),
      sw,
    ],
  });
}

async function loadSettings(): Promise<Settings> {
  const [hotbarConfig, audioEnabled, showFps, pixelRatio] = await Promise.all([
    getSetting<string[]>('hotbarConfig', [...DEFAULT_HOTBAR]),
    getSetting<boolean>('audioEnabled', true),
    getSetting<boolean>('showFps', false),
    getSetting<number>('pixelRatio', 1.0),
  ]);
  return { hotbarConfig, audioEnabled, showFps, pixelRatio };
}

registerServiceWorker();

void main().catch((err: unknown) => {
  console.error(err);
  showBootError(
    `起動に失敗しました。\n\n${err instanceof Error ? err.message : String(err)}`,
    false,
  );
});
