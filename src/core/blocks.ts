/**
 * ブロック定義（仕様書 セクション8）
 *
 * blockId 文字列と数値インデックスの対応表をここで一元管理する。
 * 数値インデックスは配列順で決まるため、**既存の要素を並べ替えたり削除したりしてはならない**。
 * 追加は必ず末尾に行うこと（保存済みワールドは blockIdMap で救済されるが、無用な変換を避けるため）。
 */

/** 当たり判定・描画に使うローカルAABB（セル内 0〜1 のメートル空間） */
export type LocalBox = {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
};

/** テクスチャレイヤー名（DataArrayTexture のレイヤーに対応） */
export type TextureName =
  | 'wood'
  | 'stone'
  | 'soil'
  | 'grass_top'
  | 'grass_side'
  | 'plank'
  | 'glass';

/** 描画の扱い */
export type RenderClass =
  /** 不透明な立方体。Greedy Meshing の対象 */
  | 'greedy'
  /** 専用形状。InstancedMesh でまとめて描画 */
  | 'instanced'
  /** 透過を含む。別メッシュ・別マテリアルで不透明描画の後にレンダリング */
  | 'transparent';

/** 形状の種類。ジオメトリ生成・当たり判定の分岐に使う */
export type ShapeKind = 'cube' | 'half' | 'stair' | 'chair' | 'table' | 'door' | 'window';

/** アクションモードでの動作 */
export type ActionKind = 'sit' | 'door';

export type BlockDef = {
  readonly blockId: string;
  readonly name: string;
  readonly category: '基本' | '半ブロック' | '階段' | '家具' | '建具';
  readonly shape: ShapeKind;
  readonly render: RenderClass;
  /** 面ごとのテクスチャレイヤー */
  readonly tex: { readonly top: TextureName; readonly bottom: TextureName; readonly side: TextureName };
  /** 水平90°回転が意味を持つか */
  readonly rotatable: boolean;
  /** 占有セル数（テーブルのみ 2） */
  readonly cellCount: 1 | 2;
  /** アクションモードでの動作 */
  readonly action?: ActionKind;
  /** state ビット（bit12）を使うか */
  readonly usesState: boolean;
};

/**
 * 定義本体。配列インデックス + 1 が voxel に格納される blockId インデックスになる
 * （0 は「空」のため）。
 */
export const BLOCK_DEFS: readonly BlockDef[] = [
  {
    blockId: 'wood_natural',
    name: 'ナチュラルウッド',
    category: '基本',
    shape: 'cube',
    render: 'greedy',
    tex: { top: 'wood', bottom: 'wood', side: 'wood' },
    rotatable: false,
    cellCount: 1,
    usesState: false,
  },
  {
    blockId: 'stone_natural',
    name: 'ナチュラルストーン',
    category: '基本',
    shape: 'cube',
    render: 'greedy',
    tex: { top: 'stone', bottom: 'stone', side: 'stone' },
    rotatable: false,
    cellCount: 1,
    usesState: false,
  },
  {
    blockId: 'soil_natural',
    name: 'ナチュラルソイル',
    category: '基本',
    shape: 'cube',
    render: 'greedy',
    tex: { top: 'soil', bottom: 'soil', side: 'soil' },
    rotatable: false,
    cellCount: 1,
    usesState: false,
  },
  {
    blockId: 'grass_natural',
    name: 'ナチュラルグラス',
    category: '基本',
    shape: 'cube',
    render: 'greedy',
    tex: { top: 'grass_top', bottom: 'soil', side: 'grass_side' },
    rotatable: false,
    cellCount: 1,
    usesState: false,
  },
  {
    blockId: 'wood_half',
    name: 'ウッドハーフ',
    category: '半ブロック',
    shape: 'half',
    render: 'instanced',
    tex: { top: 'wood', bottom: 'wood', side: 'wood' },
    rotatable: false,
    cellCount: 1,
    usesState: false,
  },
  {
    blockId: 'stone_half',
    name: 'ストーンハーフ',
    category: '半ブロック',
    shape: 'half',
    render: 'instanced',
    tex: { top: 'stone', bottom: 'stone', side: 'stone' },
    rotatable: false,
    cellCount: 1,
    usesState: false,
  },
  {
    blockId: 'wood_stair',
    name: 'ウッドステア',
    category: '階段',
    shape: 'stair',
    render: 'instanced',
    tex: { top: 'wood', bottom: 'wood', side: 'wood' },
    rotatable: true,
    cellCount: 1,
    usesState: false,
  },
  {
    blockId: 'chair_wood',
    name: '木の椅子',
    category: '家具',
    shape: 'chair',
    render: 'instanced',
    tex: { top: 'plank', bottom: 'plank', side: 'plank' },
    rotatable: true,
    cellCount: 1,
    action: 'sit',
    usesState: false,
  },
  {
    blockId: 'table_wood',
    name: '木のテーブル',
    category: '家具',
    shape: 'table',
    render: 'instanced',
    tex: { top: 'plank', bottom: 'plank', side: 'plank' },
    rotatable: true,
    cellCount: 2,
    usesState: false,
  },
  {
    blockId: 'door_wood',
    name: '木のドア',
    category: '建具',
    shape: 'door',
    render: 'instanced',
    tex: { top: 'plank', bottom: 'plank', side: 'plank' },
    rotatable: true,
    cellCount: 1,
    action: 'door',
    usesState: true,
  },
  {
    blockId: 'window_wood',
    name: '木の窓',
    category: '建具',
    shape: 'window',
    render: 'transparent',
    tex: { top: 'plank', bottom: 'plank', side: 'plank' },
    rotatable: true,
    cellCount: 1,
    usesState: false,
  },
];

/** blockId 文字列 → 数値インデックス（1 始まり。0 は空） */
export const BLOCK_INDEX_BY_ID: ReadonlyMap<string, number> = new Map(
  BLOCK_DEFS.map((d, i) => [d.blockId, i + 1] as const),
);

/** 数値インデックス → 定義。0（空）は undefined */
export function blockDefByIndex(index: number): BlockDef | undefined {
  return index >= 1 ? BLOCK_DEFS[index - 1] : undefined;
}

export function blockDefById(blockId: string): BlockDef | undefined {
  const idx = BLOCK_INDEX_BY_ID.get(blockId);
  return idx === undefined ? undefined : BLOCK_DEFS[idx - 1];
}

export function blockIndexOf(blockId: string): number {
  return BLOCK_INDEX_BY_ID.get(blockId) ?? 0;
}

/** 現行定義の blockIdMap（保存時にワールドへ埋め込む） */
export function currentBlockIdMap(): Record<string, string> {
  const map: Record<string, string> = {};
  BLOCK_DEFS.forEach((d, i) => {
    map[String(i + 1)] = d.blockId;
  });
  return map;
}

const U = 0.5; // 1ユニット = 0.5m

const FULL_BOX: LocalBox = { min: [0, 0, 0], max: [1, 1, 1] };
const LOWER_HALF_BOX: LocalBox = { min: [0, 0, 0], max: [1, U, 1] };

/**
 * 階段の当たり判定（回転前、rotationY=0 の状態）。
 * rotationY=0 の正面は -Z。奥（-Z 側）が高さ2ユニット、手前（+Z 側）が高さ1ユニット。
 */
const STAIR_BOXES: readonly LocalBox[] = [
  { min: [0, 0, 0], max: [1, 1, U] }, // 奥側：高さ2ユニット
  { min: [0, 0, U], max: [1, U, 1] }, // 手前側：高さ1ユニット
];

/**
 * 回転前のローカル当たり判定ボックス群を返す。
 * 呼び出し側で rotationY に応じてセル中心まわりに回転させること。
 */
export function localCollisionBoxes(def: BlockDef, stateOpen: boolean): readonly LocalBox[] {
  switch (def.shape) {
    case 'cube':
    case 'window':
      return [FULL_BOX];
    case 'half':
      return [LOWER_HALF_BOX];
    case 'stair':
      return STAIR_BOXES;
    case 'chair':
      // 座面まで（自動で登れる高さ）
      return [LOWER_HALF_BOX];
    case 'table':
      // 2セルとも全高（テーブル高 = 2ユニット = 1m）
      return [FULL_BOX];
    case 'door':
      // 開いている間は通行可能（当たり判定を無効化）
      return stateOpen ? [] : [FULL_BOX];
  }
}

/** 面が完全に塞がっている（Greedy Meshing で隣接面を隠せる）ブロックか */
export function isOpaqueFullCube(def: BlockDef | undefined): boolean {
  return def !== undefined && def.shape === 'cube';
}
