/**
 * 論理層（voxel データ・設置ルール・JSON 入出力・物理）の検証。
 *   node --experimental-strip-types --test tests/logic.test.ts
 * DOM に依存しないモジュールのみを対象とする。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { World } from '../src/game/world.ts';
import { Player } from '../src/physics/player.ts';
import { raycastWorld } from '../src/game/raycast.ts';
import { buildExport, exportFilename, importWorld, sanitizeFilename } from '../src/storage/worldIO.ts';
import {
  CELL_COUNT,
  approachAngle,
  cellIndex,
  indexToCell,
  normalizeAngle,
  yawTowards,
} from '../src/core/coords.ts';
import {
  GHOST_COLOR_BLOCKED_BY_PLAYER,
  GHOST_COLOR_INVALID,
  GHOST_COLOR_OK,
  ghostColorFor,
  placeFailMessage,
} from '../src/game/placeFeedback.ts';
import type { PlaceFailure } from '../src/game/world.ts';
import type { WorldMeta } from '../src/storage/db.ts';

const META: WorldMeta = {
  worldId: 'test',
  name: 'テスト/ワールド:1',
  createdAt: '2026-08-16T12:00:00.000Z',
  updatedAt: '2026-08-16T12:34:00.000Z',
  playerState: { positionWorld: { x: 32.5, y: 0, z: 32.5 }, rotationY: 0 },
};

test('セル座標とインデックスが往復する', () => {
  for (const [x, y, z] of [[0, 0, 0], [63, 31, 63], [10, 3, 20], [1, 0, 63]]) {
    const i = cellIndex(x, y, z);
    assert.ok(i >= 0 && i < CELL_COUNT);
    assert.deepEqual(indexToCell(i), { x, y, z });
  }
});

test('地面の上には置けるが、空中には置けない', () => {
  const w = new World();
  assert.deepEqual(w.canPlace('wood_natural', { x: 10, y: 0, z: 10 }, 0, null), { ok: true });
  assert.deepEqual(w.canPlace('wood_natural', { x: 10, y: 5, z: 10 }, 0, null), {
    ok: false,
    reason: 'no-support',
  });
});

test('外周の壁は支持ブロックにならない', () => {
  const w = new World();
  // x=0 の列は壁に接しているが、y=3 は地面にも既存ブロックにも接していない
  assert.deepEqual(w.canPlace('wood_natural', { x: 0, y: 3, z: 10 }, 0, null), {
    ok: false,
    reason: 'no-support',
  });
});

test('同じセルには重ねて置けない', () => {
  const w = new World();
  w.place('wood_natural', { x: 5, y: 0, z: 5 }, 0);
  assert.deepEqual(w.canPlace('stone_natural', { x: 5, y: 0, z: 5 }, 0, null), {
    ok: false,
    reason: 'occupied',
  });
});

test('テーブルは2セルを占有し、どちらをタップしてもまとめて消える', () => {
  const w = new World();
  // rotationY=0 の従属セルは -Z 側
  assert.deepEqual(w.canPlace('table_wood', { x: 20, y: 0, z: 20 }, 0, null), { ok: true });
  w.place('table_wood', { x: 20, y: 0, z: 20 }, 0);

  assert.ok(!w.voxels.isEmpty(20, 0, 20));
  assert.ok(!w.voxels.isEmpty(20, 0, 19));
  assert.equal(w.voxels.isDependent(20, 0, 20), false);
  assert.equal(w.voxels.isDependent(20, 0, 19), true);

  // 従属セル側をタップしても基準セルを逆引きして両方消える
  assert.equal(w.remove({ x: 20, y: 0, z: 19 }), true);
  assert.ok(w.voxels.isEmpty(20, 0, 20));
  assert.ok(w.voxels.isEmpty(20, 0, 19));
});

test('テーブルは領域からはみ出す向きでは置けない', () => {
  const w = new World();
  // z=0 で rotationY=0（-Z 方向）は領域外へはみ出す
  assert.deepEqual(w.canPlace('table_wood', { x: 20, y: 0, z: 0 }, 0, null), {
    ok: false,
    reason: 'out-of-bounds',
  });
  // 反対向き（+Z）なら置ける
  assert.deepEqual(w.canPlace('table_wood', { x: 20, y: 0, z: 0 }, 2, null), { ok: true });
});

test('プレイヤーと重なるセルには置けない', () => {
  const w = new World();
  const p = new Player();
  p.reset(10.5, 0, 10.5, 0);
  assert.deepEqual(w.canPlace('wood_natural', { x: 10, y: 0, z: 10 }, 0, p.box()), {
    ok: false,
    reason: 'player-overlap',
  });
});

test('ドアの state は開閉でトグルする', () => {
  const w = new World();
  w.place('door_wood', { x: 8, y: 0, z: 8 }, 0);
  assert.equal(w.voxels.getState(8, 0, 8), false);
  assert.equal(w.toggleDoor({ x: 8, y: 0, z: 8 }), true);
  assert.equal(w.voxels.getState(8, 0, 8), true);
  // 開いたドアは当たり判定を持たない
  assert.equal(w.cellCollisionBoxes(8, 0, 8).length, 0);
});

test('階段は手前1ユニット・奥2ユニットの2段構成になる', () => {
  const w = new World();
  w.place('wood_stair', { x: 30, y: 0, z: 30 }, 0);
  const boxes = w.cellCollisionBoxes(30, 0, 30);
  assert.equal(boxes.length, 2);
  const tall = boxes.find((b) => b.maxY === 1);
  const low = boxes.find((b) => b.maxY === 0.5);
  assert.ok(tall && low);
  // rotationY=0 の正面は -Z なので、奥（-Z 側）が高い
  assert.equal(tall.minZ, 30);
  assert.equal(tall.maxZ, 30.5);
  assert.equal(low.minZ, 30.5);
});

test('階段は回転すると当たり判定も回る', () => {
  const w = new World();
  w.place('wood_stair', { x: 30, y: 0, z: 30 }, 1); // 90°
  const boxes = w.cellCollisionBoxes(30, 0, 30);
  const tall = boxes.find((b) => b.maxY === 1)!;
  // 90° 回転で高い側は -X 方向へ移る
  assert.equal(tall.minX, 30);
  assert.equal(tall.maxX, 30.5);
});

test('プレイヤーは地面に着地し、落下し続けない', () => {
  const w = new World();
  const p = new Player();
  p.reset(32.5, 5, 32.5, 0);
  for (let i = 0; i < 200; i++) {
    p.update(w, 1 / 60, { forward: 0, strafe: 0, jumpQueued: false }, 0);
  }
  assert.ok(Math.abs(p.y) < 0.01, `y=${p.y}`);
  assert.equal(p.onGround, true);
});

test('半ブロックの段差はジャンプなしで登れる', () => {
  const w = new World();
  for (let x = 16; x <= 21; x++) {
    for (let z = 30; z <= 34; z++) w.place('wood_half', { x, y: 0, z }, 0);
  }
  const p = new Player();
  p.reset(21.9, 0, 32.5, 0);
  for (let i = 0; i < 60; i++) {
    // cameraYaw = π/2 のとき forward は -X 方向
    p.update(w, 1 / 60, { forward: 1, strafe: 0, jumpQueued: false }, Math.PI / 2);
  }
  assert.ok(p.y >= 0.49, `半ブロックの上に登れていない y=${p.y}`);
  assert.ok(p.x < 20, `前進できていない x=${p.x}`);
});

test('階段は2段階で歩いて登れる', () => {
  const w = new World();
  // rotationY=0 の階段は高い側が -Z。手前（+Z）から進入して登る。
  // 階段の先には通常ブロック1段の床を用意する。
  for (let x = 30; x <= 34; x++) {
    w.place('wood_stair', { x, y: 0, z: 20 }, 0);
    for (let z = 16; z <= 19; z++) w.place('wood_natural', { x, y: 0, z }, 0);
  }
  const p = new Player();
  p.reset(32.5, 0, 21.5, 0);
  for (let i = 0; i < 45; i++) {
    // cameraYaw = 0 のとき forward は -Z 方向
    p.update(w, 1 / 60, { forward: 1, strafe: 0, jumpQueued: false }, 0);
  }
  assert.ok(p.y >= 0.99, `階段を登れていない y=${p.y}`);
  assert.ok(p.z < 20, `階段の先へ進めていない z=${p.z}`);
});

test('通常ブロック1段の壁は歩くだけでは登れない', () => {
  const w = new World();
  for (let z = 30; z <= 34; z++) w.place('wood_natural', { x: 20, y: 0, z }, 0);
  const p = new Player();
  p.reset(21.5, 0, 32.5, 0);
  for (let i = 0; i < 120; i++) {
    p.update(w, 1 / 60, { forward: 1, strafe: 0, jumpQueued: false }, Math.PI / 2);
  }
  assert.ok(p.y < 0.1, `登れてしまっている y=${p.y}`);
  assert.ok(p.x > 21.2, `壁を通り抜けている x=${p.x}`);
});

test('高速落下でも床をすり抜けない', () => {
  const w = new World();
  w.place('wood_natural', { x: 40, y: 10, z: 40 }, 0);
  // 支持を無視して直接置く（テスト用）
  const p = new Player();
  p.reset(40.5, 25, 40.5, 0);
  for (let i = 0; i < 600; i++) {
    p.update(w, 1 / 60, { forward: 0, strafe: 0, jumpQueued: false }, 0);
  }
  // ブロックの上（y=11）か地面（y=0）のどちらかで止まっていること
  assert.ok(Math.abs(p.y - 11) < 0.01 || Math.abs(p.y) < 0.01, `y=${p.y}`);
  assert.equal(p.onGround, true);
});

test('レイキャストは地面とブロックの面を正しく返す', () => {
  const w = new World();
  w.place('wood_natural', { x: 10, y: 0, z: 10 }, 0);

  // 真上から地面へ
  const ground = raycastWorld(w, { x: 20.5, y: 10, z: 20.5 }, { x: 0, y: -1, z: 0 }, 20);
  assert.ok(ground);
  assert.equal(ground.isGround, true);
  assert.deepEqual(ground.cell, { x: 20, y: -1, z: 20 });
  assert.deepEqual([...ground.normal], [0, 1, 0]);

  // 真上からブロックの上面へ
  const top = raycastWorld(w, { x: 10.5, y: 10, z: 10.5 }, { x: 0, y: -1, z: 0 }, 20);
  assert.ok(top);
  assert.equal(top.isGround, false);
  assert.deepEqual(top.cell, { x: 10, y: 0, z: 10 });
  assert.deepEqual([...top.normal], [0, 1, 0]);

  // 横からブロックの側面へ
  const side = raycastWorld(w, { x: 15, y: 0.5, z: 10.5 }, { x: -1, y: 0, z: 0 }, 20);
  assert.ok(side);
  assert.deepEqual(side.cell, { x: 10, y: 0, z: 10 });
  assert.deepEqual([...side.normal], [1, 0, 0]);
});

test('JSON は疎な配列で書き出され、従属セルは occupies に集約される', () => {
  const w = new World();
  w.place('wood_natural', { x: 10, y: 3, z: 20 }, 0);
  w.place('door_wood', { x: 15, y: 0, z: 22 }, 1);
  w.place('table_wood', { x: 11, y: 0, z: 20 }, 2);

  const json = buildExport(w, META);
  assert.equal(json.formatVersion, 1);
  assert.equal(json.app, 'VoxelYard');
  assert.deepEqual(json.gridSize, { width: 64, depth: 64, height: 32 });
  // テーブルは1エントリのみ（従属セルは出力しない）
  assert.equal(json.blocks.length, 3);

  const table = json.blocks.find((b) => b.blockId === 'table_wood')!;
  assert.equal(table.occupies?.length, 2);
  assert.deepEqual(table.occupies, [
    { x: 11, y: 0, z: 20 },
    { x: 11, y: 0, z: 21 },
  ]);

  const door = json.blocks.find((b) => b.blockId === 'door_wood')!;
  assert.equal(door.rotationY, 90);
  assert.deepEqual(door.state, { open: false });
});

test('JSON は往復しても内容が保たれる', () => {
  const w = new World();
  w.place('wood_natural', { x: 10, y: 3, z: 20 }, 0);
  w.place('table_wood', { x: 11, y: 0, z: 20 }, 2);
  w.place('door_wood', { x: 15, y: 0, z: 22 }, 1);
  w.toggleDoor({ x: 15, y: 0, z: 22 });

  const json = JSON.parse(JSON.stringify(buildExport(w, META)));
  const result = importWorld(json);
  assert.equal(result.skipped, 0);
  assert.equal(result.placed, 3);
  assert.deepEqual(
    Array.from(result.world.voxels.cells),
    Array.from(w.voxels.cells),
  );
});

test('不正なブロックはスキップされ、読み込み全体は失敗しない', () => {
  const json = {
    formatVersion: 1,
    app: 'VoxelYard',
    world: { name: 'x', createdAt: '', updatedAt: '' },
    gridSize: { width: 64, depth: 64, height: 32 },
    blocks: [
      { x: 1, y: 0, z: 1, blockId: 'wood_natural', rotationY: 0 },
      { x: 999, y: 0, z: 1, blockId: 'wood_natural', rotationY: 0 }, // 範囲外
      { x: 2, y: 0, z: 1, blockId: 'unknown_block', rotationY: 0 }, // 未知
      { x: 3, y: 0, z: 1, blockId: 'wood_natural', rotationY: 45 }, // 不正な回転
      { x: 1, y: 0, z: 1, blockId: 'stone_natural', rotationY: 0 }, // 重複
      {
        x: 5,
        y: 0,
        z: 5,
        blockId: 'table_wood',
        rotationY: 0,
        occupies: [{ x: 5, y: 0, z: 5 }, { x: 6, y: 0, z: 5 }], // 回転と矛盾
      },
    ],
  };
  const result = importWorld(json);
  assert.equal(result.placed, 1);
  assert.equal(result.skipped, 5);
});

test('gridSize や formatVersion が違えば読み込みを拒否する', () => {
  assert.throws(() => importWorld({ formatVersion: 2, gridSize: {}, blocks: [] }));
  assert.throws(() =>
    importWorld({ formatVersion: 1, gridSize: { width: 32, depth: 32, height: 16 }, blocks: [] }),
  );
});

test('ファイル名がサニタイズされる', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFilename(''), 'world');
  const name = exportFilename('テスト:ワールド', new Date(2026, 7, 16, 12, 34));
  assert.equal(name, 'テスト_ワールド_20260816_1234.json');
});

test('通常ブロック1段はジャンプで登れる', () => {
  const w = new World();
  for (let x = 28; x <= 34; x++) {
    for (let z = 16; z <= 19; z++) w.place('wood_natural', { x, y: 0, z }, 0);
  }
  const p = new Player();
  p.reset(31.5, 0, 20.5, 0);
  // 地面に着くまで待ってからジャンプしつつ前進する
  for (let i = 0; i < 10; i++) {
    p.update(w, 1 / 60, { forward: 0, strafe: 0, jumpQueued: false }, 0);
  }
  assert.equal(p.onGround, true);
  for (let i = 0; i < 60; i++) {
    p.update(w, 1 / 60, { forward: 1, strafe: 0, jumpQueued: i === 0 }, 0);
  }
  assert.ok(Math.abs(p.y - 1) < 0.01, `1段登れていない y=${p.y}`);
});

test('2段の段差はジャンプでも登れない', () => {
  const w = new World();
  for (let x = 28; x <= 34; x++) {
    for (let z = 16; z <= 19; z++) {
      w.place('wood_natural', { x, y: 0, z }, 0);
      w.place('wood_natural', { x, y: 1, z }, 0);
    }
  }
  const p = new Player();
  p.reset(31.5, 0, 20.5, 0);
  for (let i = 0; i < 10; i++) {
    p.update(w, 1 / 60, { forward: 0, strafe: 0, jumpQueued: false }, 0);
  }
  for (let i = 0; i < 60; i++) {
    p.update(w, 1 / 60, { forward: 1, strafe: 0, jumpQueued: i === 0 }, 0);
  }
  assert.ok(p.y < 0.1, `登れてしまっている y=${p.y}`);
});

test('ドアが開いている間は通行できる', () => {
  const w = new World();
  // 壁の中央にドアを置く
  for (let x = 28; x <= 34; x++) {
    if (x !== 31) w.place('wood_natural', { x, y: 0, z: 20 }, 0);
  }
  w.place('door_wood', { x: 31, y: 0, z: 20 }, 0);

  const walk = (): number => {
    const p = new Player();
    p.reset(31.5, 0, 21.5, 0);
    for (let i = 0; i < 90; i++) {
      p.update(w, 1 / 60, { forward: 1, strafe: 0, jumpQueued: false }, 0);
    }
    return p.z;
  };

  assert.ok(walk() > 20.5, '閉じたドアを通り抜けてしまっている');
  w.toggleDoor({ x: 31, y: 0, z: 20 });
  assert.ok(walk() < 20, '開いたドアを通れていない');
});

test('サブステップが動かないフレームでは入力が消費されない', () => {
  const w = new World();
  const p = new Player();
  p.reset(32.5, 0, 32.5, 0);
  p.resetAccumulator();
  // dt が固定ステップ（1/60）未満なので、このフレームでは物理が1回も進まない
  const steps = p.update(w, 1 / 240, { forward: 0, strafe: 0, jumpQueued: true }, 0);
  assert.equal(steps, 0);
  assert.equal(p.y, 0);
});

test('120Hz のフレームでもジャンプ入力を取りこぼさない', () => {
  const w = new World();
  const p = new Player();
  p.reset(32.5, 0, 32.5, 0);
  for (let i = 0; i < 30; i++) {
    p.update(w, 1 / 120, { forward: 0, strafe: 0, jumpQueued: false }, 0);
  }
  assert.equal(p.onGround, true);

  // アキュムレータを空にしておくと、次のフレームは必ずサブステップ0になる。
  // Game.frame と同じく「サブステップが動いたフレームでのみ入力を消費する」扱いにする。
  p.resetAccumulator();
  let jumpQueued = true;
  let maxY = 0;
  for (let i = 0; i < 120; i++) {
    const steps = p.update(w, 1 / 120, { forward: 0, strafe: 0, jumpQueued }, 0);
    if (steps > 0) jumpQueued = false;
    maxY = Math.max(maxY, p.y);
  }
  // 通常ブロック1段（1m）を越える高さまで跳べていること
  assert.ok(maxY > 1.0, `ジャンプが取りこぼされている maxY=${maxY}`);
});

// ---------------------------------------------------------------- 設置フィードバック

test('設置できない理由はすべて説明文を持つ', () => {
  // ここに列挙していない理由が PlaceFailure に増えると型エラーになる
  const ALL: Record<PlaceFailure, true> = {
    occupied: true,
    'out-of-bounds': true,
    'no-support': true,
    'player-overlap': true,
    'out-of-reach': true,
    'unknown-block': true,
  };
  for (const reason of Object.keys(ALL) as PlaceFailure[]) {
    assert.ok(placeFailMessage(reason).length > 0, `${reason} の文言がない`);
  }
});

test('ゴーストの色はプレイヤーが原因のときだけ別色になる', () => {
  assert.equal(ghostColorFor(null), GHOST_COLOR_OK);
  assert.equal(ghostColorFor('player-overlap'), GHOST_COLOR_BLOCKED_BY_PLAYER);
  assert.equal(ghostColorFor('no-support'), GHOST_COLOR_INVALID);
  assert.equal(ghostColorFor('occupied'), GHOST_COLOR_INVALID);
});

test('world.canPlace が返した理由をそのまま文言にできる', () => {
  const w = new World();
  const p = new Player();
  p.reset(10.5, 0, 10.5, 0);
  const check = w.canPlace('wood_natural', { x: 10, y: 0, z: 10 }, 0, p.box());
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(placeFailMessage(check.reason), '自分が邪魔で置けません');
});

// ---------------------------------------------------------------- 向きの計算

test('yawTowards は -Z を正面とする', () => {
  const EPS = 1e-9;
  assert.ok(Math.abs(yawTowards(0, -1) - 0) < EPS);
  assert.ok(Math.abs(yawTowards(1, 0) - -Math.PI / 2) < EPS);
  assert.ok(Math.abs(yawTowards(-1, 0) - Math.PI / 2) < EPS);
  assert.ok(Math.abs(Math.abs(yawTowards(0, 1)) - Math.PI) < EPS);
});

test('向き直りは近い方へ回る', () => {
  // +3.0rad から -3.0rad へは、差 -6.0 ではなく +0.28 側が近い
  const next = approachAngle(3.0, -3.0, 1);
  assert.ok(next > 3.0, `遠回りしている next=${next}`);
  assert.ok(Math.abs(normalizeAngle(next) - -3.0) < 1e-9);

  // 補間の割合どおりに近づく
  assert.ok(Math.abs(approachAngle(0, Math.PI / 2, 0.5) - Math.PI / 4) < 1e-9);
  assert.ok(Math.abs(approachAngle(1.2, 1.2, 1) - 1.2) < 1e-9);
});
