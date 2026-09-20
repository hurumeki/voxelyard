/**
 * プレイヤーの見た目（仕様書 セクション9）
 * シンプルなボクセル人型（頭・胴・腕2本・脚2本の直方体構成）。
 * カスタマイズ機能は持たない。
 *
 * 正面は -Z（yaw = 0 の向き）。三人称カメラは通常プレイヤーの背後にあるため、
 * 顔だけでなく「髪＝後頭部側」でも前後が分かるようにしてある。
 */

import { BoxGeometry, Group, Mesh, MeshLambertNodeMaterial, Object3D } from 'three/webgpu';
import { PLAYER_HEIGHT } from '../physics/player.ts';

const LEG_H = 0.78;
const TORSO_H = 0.6;
const HEAD_H = PLAYER_HEIGHT - LEG_H - TORSO_H; // 0.37

const HEAD_W = 0.34;
/** 頭の中心の高さ */
const HEAD_Y = LEG_H + TORSO_H + HEAD_H / 2;
/** 顔のパーツを頭の表面から浮かせる量（z-fighting 回避） */
const SURFACE = 0.01;
/** 胴の中心の高さ */
const TORSO_Y = LEG_H + TORSO_H / 2;
const TORSO_D = 0.24;

function material(hex: number): MeshLambertNodeMaterial {
  const m = new MeshLambertNodeMaterial();
  m.color.setHex(hex);
  return m;
}

/** 指定位置に置くだけの直方体（顔や髪などの装飾パーツ用） */
function plate(
  w: number,
  h: number,
  d: number,
  mat: MeshLambertNodeMaterial,
  x: number,
  y: number,
  z: number,
): Mesh {
  const mesh = new Mesh(new BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

/** 上端を原点に合わせた直方体（関節を上端に置いて回転させるため） */
function limb(w: number, h: number, d: number, mat: MeshLambertNodeMaterial): Object3D {
  const pivot = new Object3D();
  const mesh = new Mesh(new BoxGeometry(w, h, d), mat);
  mesh.position.y = -h / 2;
  pivot.add(mesh);
  return pivot;
}

export class PlayerModel {
  readonly root = new Group();

  private readonly leftArm: Object3D;
  private readonly rightArm: Object3D;
  private readonly leftLeg: Object3D;
  private readonly rightLeg: Object3D;
  private readonly body = new Group();
  private readonly materials: MeshLambertNodeMaterial[] = [];

  private phase = 0;

  constructor() {
    const skin = material(0xe0b48c);
    const shirt = material(0x6f8f57);
    const pants = material(0x4a5568);
    const hair = material(0x3b2b21);
    const eye = material(0x27282f);
    const mouth = material(0x8f4b45);
    const front = material(0xd9e4c3);
    this.materials.push(skin, shirt, pants, hair, eye, mouth, front);

    this.root.add(this.body);

    const head = new Mesh(new BoxGeometry(HEAD_W, HEAD_H, HEAD_W), skin);
    head.position.y = HEAD_Y;
    this.body.add(head);

    const torso = new Mesh(new BoxGeometry(0.42, TORSO_H, TORSO_D), shirt);
    torso.position.y = TORSO_Y;
    this.body.add(torso);

    this.addFacing(hair, eye, mouth, front);

    const armY = LEG_H + TORSO_H - 0.04;
    this.leftArm = limb(0.12, 0.56, 0.12, shirt);
    this.leftArm.position.set(-0.27, armY, 0);
    this.body.add(this.leftArm);

    this.rightArm = limb(0.12, 0.56, 0.12, shirt);
    this.rightArm.position.set(0.27, armY, 0);
    this.body.add(this.rightArm);

    this.leftLeg = limb(0.15, LEG_H, 0.15, pants);
    this.leftLeg.position.set(-0.1, LEG_H, 0);
    this.body.add(this.leftLeg);

    this.rightLeg = limb(0.15, LEG_H, 0.15, pants);
    this.rightLeg.position.set(0.1, LEG_H, 0);
    this.body.add(this.rightLeg);
  }

  /**
   * 前後を見分けるためのパーツ。
   * 顔（-Z 側）だけだと背後からのカメラでは向きが読めないので、
   * 後頭部と側頭部を髪で覆い、胴にも前だけの当て布を入れて差をつける。
   */
  private addFacing(
    hair: MeshLambertNodeMaterial,
    eye: MeshLambertNodeMaterial,
    mouth: MeshLambertNodeMaterial,
    front: MeshLambertNodeMaterial,
  ): void {
    const faceZ = -HEAD_W / 2 - SURFACE;
    const backZ = HEAD_W / 2 + SURFACE;
    const sideX = HEAD_W / 2 + SURFACE;
    const headTop = LEG_H + TORSO_H + HEAD_H;

    // 目・口（正面 = -Z）
    this.body.add(plate(0.07, 0.07, 0.02, eye, -0.08, HEAD_Y + 0.05, faceZ));
    this.body.add(plate(0.07, 0.07, 0.02, eye, 0.08, HEAD_Y + 0.05, faceZ));
    this.body.add(plate(0.12, 0.03, 0.02, mouth, 0, HEAD_Y - 0.09, faceZ));

    // 髪：天面・後頭部・側頭部
    this.body.add(plate(HEAD_W + 0.02, 0.06, HEAD_W + 0.02, hair, 0, headTop - 0.02, 0));
    this.body.add(plate(HEAD_W + 0.02, HEAD_H - 0.08, 0.02, hair, 0, HEAD_Y - 0.02, backZ));
    this.body.add(plate(0.02, HEAD_H - 0.12, HEAD_W - 0.06, hair, -sideX, HEAD_Y - 0.03, 0.02));
    this.body.add(plate(0.02, HEAD_H - 0.12, HEAD_W - 0.06, hair, sideX, HEAD_Y - 0.03, 0.02));

    // 胴の正面だけ色を変える
    this.body.add(
      plate(0.2, 0.26, 0.02, front, 0, TORSO_Y + 0.05, -TORSO_D / 2 - SURFACE),
    );
  }

  /**
   * @param speed 水平移動速度（m/s）。歩行アニメーションの速さに使う
   */
  update(
    x: number,
    y: number,
    z: number,
    yaw: number,
    speed: number,
    seated: boolean,
    dt: number,
  ): void {
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;

    if (seated) {
      // 椅子に座ったポーズ：腰と膝を曲げ、全体を座面の高さへ下げる
      this.body.position.y = -0.36;
      this.leftLeg.rotation.x = -Math.PI / 2;
      this.rightLeg.rotation.x = -Math.PI / 2;
      this.leftArm.rotation.x = -Math.PI / 6;
      this.rightArm.rotation.x = -Math.PI / 6;
      return;
    }

    this.body.position.y = 0;
    if (speed > 0.15) {
      this.phase += dt * speed * 3.4;
      const swing = Math.sin(this.phase) * Math.min(1, speed / 4) * 0.7;
      this.leftLeg.rotation.x = swing;
      this.rightLeg.rotation.x = -swing;
      this.leftArm.rotation.x = -swing;
      this.rightArm.rotation.x = swing;
    } else {
      // 立ち止まったら徐々に直立へ戻す
      const decay = Math.exp(-10 * dt);
      this.leftLeg.rotation.x *= decay;
      this.rightLeg.rotation.x *= decay;
      this.leftArm.rotation.x *= decay;
      this.rightArm.rotation.x *= decay;
    }
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}
