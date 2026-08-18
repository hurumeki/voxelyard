/**
 * ワールドの描画（仕様書 セクション3）
 *
 * - 通常ブロック : チャンクごとの Greedy メッシュ
 * - 特殊形状     : ブロック種類ごとの InstancedMesh
 * - 窓のガラス   : 透過用の別 InstancedMesh（不透明描画の後に描かれる）
 * - 地面・外周壁 : voxel 配列とは無関係の静的メッシュ
 *
 * チャンクの再構築は「1フレームに1チャンクまで」に制限し、
 * 設置・破壊直後のフレーム落ちを避ける。
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
} from 'three/webgpu';
import type {
  BufferGeometry as TBufferGeometry,
  DataArrayTexture,
  MeshLambertNodeMaterial,
} from 'three/webgpu';

import { CHUNKS_X, CHUNKS_Y, CHUNKS_Z, GRID_X, GRID_Y, GRID_Z } from '../core/coords.ts';
import { BLOCK_DEFS, blockDefByIndex } from '../core/blocks.ts';
import type { BlockDef } from '../core/blocks.ts';
import { indexToCell } from '../core/coords.ts';
import type { World } from '../game/world.ts';
import { buildChunkGeometry, FACE_BRIGHTNESS } from './greedyMesher.ts';
import { buildBlockGeometrySet } from './blockGeometries.ts';
import type { BlockGeometrySet } from './blockGeometries.ts';
import { createOpaqueBlockMaterial, createTransparentBlockMaterial, TEX_LAYER_ATTRIBUTE } from './materials.ts';
import { textureLayerIndex } from './textures.ts';

const DEG90 = Math.PI / 2;

type InstanceGroup = {
  readonly def: BlockDef;
  readonly variant: 'solid' | 'solidOpen' | 'glass';
  readonly geometry: TBufferGeometry;
  readonly material: MeshLambertNodeMaterial;
  mesh: InstancedMesh;
};

export class WorldRenderer {
  readonly scene = new Scene();
  readonly chunkGroup = new Group();
  readonly instanceGroup = new Group();

  private readonly chunkMeshes = new Map<number, Mesh>();
  private readonly geometrySets = new Map<string, BlockGeometrySet>();
  private readonly instanceGroups: InstanceGroup[] = [];

  private readonly opaqueMaterial;
  private readonly transparentMaterial;

  private pendingChunks: number[] = [];
  private lastSpecialVersion = -1;

  private readonly tmpPos = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpScale = new Vector3(1, 1, 1);
  private readonly tmpAxis = new Vector3(0, 1, 0);

  constructor(texture: DataArrayTexture) {
    this.opaqueMaterial = createOpaqueBlockMaterial(texture);
    this.transparentMaterial = createTransparentBlockMaterial(texture);

    this.scene.add(this.chunkGroup);
    this.scene.add(this.instanceGroup);

    this.setupLights();
    this.buildStaticGeometry();
    this.prepareInstanceGroups();
  }

  // ---------------------------------------------------------------- ライト

  private setupLights(): void {
    // リアルタイム影は使わない（A12X では負荷が大きい）。
    // 立体感は頂点カラーの明度差で表現している。
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.45, 1, 0.28);
    this.scene.add(sun);
    this.scene.add(new AmbientLight(0xffffff, 1.1));
  }

  // ---------------------------------------------------------------- 静的部分

  /** 地面と外周の壁。voxel 配列に含めず、チャンク再構築の対象外とする */
  private buildStaticGeometry(): void {
    // 地面：草テクスチャを1セル1タイルで敷き詰めた1枚の板
    const g = new BufferGeometry();
    const y = 0;
    const positions = new Float32Array([
      0, y, 0,
      0, y, GRID_Z,
      GRID_X, y, GRID_Z,
      GRID_X, y, 0,
    ]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    // Greedy メッシュの上面と同じ UV 対応（u=Z, v=X ではなく u=a1, v=a2 = Z, X）
    const uvs = new Float32Array([0, 0, GRID_Z, 0, GRID_Z, GRID_X, 0, GRID_X]);
    const b = FACE_BRIGHTNESS.top;
    const colors = new Float32Array([b, b, b, b, b, b, b, b, b, b, b, b]);
    const layer = textureLayerIndex('grass_top');
    const layers = new Float32Array([layer, layer, layer, layer]);
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('normal', new BufferAttribute(normals, 3));
    g.setAttribute('uv', new BufferAttribute(uvs, 2));
    g.setAttribute('color', new BufferAttribute(colors, 3));
    g.setAttribute(TEX_LAYER_ATTRIBUTE, new BufferAttribute(layers, 1));
    g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    g.computeBoundingSphere();
    const ground = new Mesh(g, this.opaqueMaterial);
    ground.name = 'ground';
    this.scene.add(ground);

    // 外周の壁：内側から見える半透明の境界表現
    const wallMat = new MeshBasicNodeMaterial();
    wallMat.color.setHex(0x7a9b5c);
    wallMat.transparent = true;
    wallMat.opacity = 0.16;
    wallMat.depthWrite = false;
    wallMat.side = DoubleSide;

    const wallGeo = new BufferGeometry();
    const h = GRID_Y;
    const wp: number[] = [];
    const wi: number[] = [];
    const quad = (
      a: [number, number, number],
      bb: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
    ): void => {
      const s = wp.length / 3;
      wp.push(...a, ...bb, ...c, ...d);
      wi.push(s, s + 1, s + 2, s, s + 2, s + 3);
    };
    quad([0, 0, 0], [GRID_X, 0, 0], [GRID_X, h, 0], [0, h, 0]);
    quad([0, 0, GRID_Z], [GRID_X, 0, GRID_Z], [GRID_X, h, GRID_Z], [0, h, GRID_Z]);
    quad([0, 0, 0], [0, 0, GRID_Z], [0, h, GRID_Z], [0, h, 0]);
    quad([GRID_X, 0, 0], [GRID_X, 0, GRID_Z], [GRID_X, h, GRID_Z], [GRID_X, h, 0]);
    wallGeo.setAttribute('position', new BufferAttribute(new Float32Array(wp), 3));
    wallGeo.setIndex(new BufferAttribute(new Uint16Array(wi), 1));
    wallGeo.computeBoundingSphere();
    const walls = new Mesh(wallGeo, wallMat);
    walls.name = 'walls';
    walls.renderOrder = 2;
    this.scene.add(walls);

    // 空（背景色の代わりに内側から見える大きなボックス）
    const skyMat = new MeshBasicNodeMaterial();
    skyMat.color.setHex(0x9ec8e6);
    // 内側から見るボックスなので、巻き順に依存しないよう両面描画にする
    skyMat.side = DoubleSide;
    skyMat.depthWrite = false;
    const skyGeo = new BufferGeometry();
    buildSkyBox(skyGeo);
    const sky = new Mesh(skyGeo, skyMat);
    sky.name = 'sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    this.scene.add(sky);
  }

  // ---------------------------------------------------------------- インスタンス

  private prepareInstanceGroups(): void {
    for (const def of BLOCK_DEFS) {
      const set = buildBlockGeometrySet(def);
      if (!set) continue;
      this.geometrySets.set(def.blockId, set);

      this.addInstanceGroup(def, 'solid', set.solid);
      if (set.solidOpen) this.addInstanceGroup(def, 'solidOpen', set.solidOpen);
      if (set.glass) this.addInstanceGroup(def, 'glass', set.glass);
    }
  }

  private addInstanceGroup(def: BlockDef, variant: InstanceGroup['variant'], geometry: TBufferGeometry): void {
    const material = variant === 'glass' ? this.transparentMaterial : this.opaqueMaterial;
    const mesh = new InstancedMesh(geometry, material, 16);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = `${def.blockId}:${variant}`;
    if (variant === 'glass') mesh.renderOrder = 1;
    this.instanceGroup.add(mesh);
    this.instanceGroups.push({ def, variant, geometry, material, mesh });
  }

  /** ブロック種類ごとの描画用ジオメトリ（ゴーストにも使う） */
  geometrySetOf(blockId: string): BlockGeometrySet | undefined {
    return this.geometrySets.get(blockId);
  }

  private rebuildInstances(world: World): void {
    const buckets = new Map<InstanceGroup, Matrix4[]>();
    for (const g of this.instanceGroups) buckets.set(g, []);

    for (const cellIdx of world.specialCellIndices()) {
      const c = indexToCell(cellIdx);
      if (world.voxels.isDependent(c.x, c.y, c.z)) continue; // 従属セルは基準セル側で描く
      const blockIndex = world.voxels.getBlockId(c.x, c.y, c.z);
      const def = blockDefByIndex(blockIndex);
      if (!def) continue;
      const rot = world.voxels.getRotation(c.x, c.y, c.z);
      const open = world.voxels.getState(c.x, c.y, c.z);

      this.tmpPos.set(c.x + 0.5, c.y + 0.5, c.z + 0.5);
      this.tmpQuat.setFromAxisAngle(this.tmpAxis, rot * DEG90);
      const matrix = new Matrix4().compose(this.tmpPos, this.tmpQuat, this.tmpScale);

      const wantOpen = def.usesState && open;
      for (const g of this.instanceGroups) {
        if (g.def !== def) continue;
        if (g.variant === 'solid' && wantOpen) continue;
        if (g.variant === 'solidOpen' && !wantOpen) continue;
        buckets.get(g)!.push(matrix);
      }
    }

    for (const g of this.instanceGroups) {
      const list = buckets.get(g)!;
      this.ensureCapacity(g, list.length);
      for (let i = 0; i < list.length; i++) {
        g.mesh.setMatrixAt(i, list[i]);
      }
      g.mesh.count = list.length;
      g.mesh.instanceMatrix.needsUpdate = true;
      g.mesh.visible = list.length > 0;
    }
  }

  private ensureCapacity(group: InstanceGroup, needed: number): void {
    if (needed <= group.mesh.instanceMatrix.count) return;
    let cap = Math.max(16, group.mesh.instanceMatrix.count);
    while (cap < needed) cap *= 2;
    const old = group.mesh;
    this.instanceGroup.remove(old);
    old.dispose();
    const mesh = new InstancedMesh(group.geometry, group.material, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = old.name;
    mesh.renderOrder = old.renderOrder;
    this.instanceGroup.add(mesh);
    group.mesh = mesh;
  }

  // ---------------------------------------------------------------- チャンク

  /**
   * 変更されたチャンクを再構築する。
   * 1フレームにつき1チャンクまで（残りは次フレームへ遅延）。
   */
  update(world: World): void {
    const newDirty = world.takeDirtyChunks();
    for (const c of newDirty) {
      if (!this.pendingChunks.includes(c)) this.pendingChunks.push(c);
    }

    const next = this.pendingChunks.shift();
    if (next !== undefined) this.rebuildChunk(world, next);

    const version = world.getSpecialVersion();
    if (version !== this.lastSpecialVersion) {
      this.lastSpecialVersion = version;
      this.rebuildInstances(world);
    }
  }

  /** 全チャンクを即座に構築する（ワールド読み込み直後） */
  rebuildAll(world: World): void {
    this.pendingChunks = [];
    world.takeDirtyChunks();
    for (let i = 0; i < CHUNKS_X * CHUNKS_Y * CHUNKS_Z; i++) {
      this.rebuildChunk(world, i);
    }
    this.lastSpecialVersion = world.getSpecialVersion();
    this.rebuildInstances(world);
  }

  pendingChunkCount(): number {
    return this.pendingChunks.length;
  }

  private rebuildChunk(world: World, chunkIndex: number): void {
    const cx = chunkIndex % CHUNKS_X;
    const cz = Math.floor(chunkIndex / CHUNKS_X) % CHUNKS_Z;
    const cy = Math.floor(chunkIndex / (CHUNKS_X * CHUNKS_Z));

    const existing = this.chunkMeshes.get(chunkIndex);
    if (existing) {
      this.chunkGroup.remove(existing);
      existing.geometry.dispose();
      this.chunkMeshes.delete(chunkIndex);
    }

    const geo = buildChunkGeometry(world.voxels, cx, cy, cz);
    if (!geo) return;

    const mesh = new Mesh(geo, this.opaqueMaterial);
    mesh.name = `chunk_${cx}_${cy}_${cz}`;
    // フラスタムカリングのためのバウンディングはジオメトリ側で計算済み
    this.chunkGroup.add(mesh);
    this.chunkMeshes.set(chunkIndex, mesh);
  }

  /** ワールドを切り替えるときに全メッシュを破棄する */
  clearWorldMeshes(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.chunkGroup.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
    this.pendingChunks = [];
    this.lastSpecialVersion = -1;
    for (const g of this.instanceGroups) {
      g.mesh.count = 0;
      g.mesh.visible = false;
    }
  }

  add(object: Object3D): void {
    this.scene.add(object);
  }

  dispose(): void {
    this.clearWorldMeshes();
    for (const g of this.instanceGroups) {
      g.mesh.dispose();
      g.geometry.dispose();
    }
    this.instanceGroups.length = 0;
    this.opaqueMaterial.dispose();
    this.transparentMaterial.dispose();
  }
}

/** 内側から見る空用のボックス。ワールドを十分に覆う大きさ */
function buildSkyBox(geo: BufferGeometry): void {
  const s = Math.max(GRID_X, GRID_Z) * 3;
  const cx = GRID_X / 2;
  const cz = GRID_Z / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  const push = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ): void => {
    const i = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const x0 = cx - s;
  const x1 = cx + s;
  const z0 = cz - s;
  const z1 = cz + s;
  const y0 = -s;
  const y1 = s;
  push([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  push([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  push([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  push([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  push([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  geo.computeBoundingSphere();
}
