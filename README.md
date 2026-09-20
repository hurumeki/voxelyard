# VoxelYard

ボクセルサンドボックスの PWA。iPad Pro 12.9インチ第3世代（A12X / iPadOS 26 以降）を対象とした私用アプリです。

- 開発仕様書：`docs/spec-v3.md`
- 公開先：GitHub Pages（`main` への push で自動デプロイ）

## 必要環境

| 項目 | 内容 |
|---|---|
| 実機 | iPadOS 26 以降（**WebGPU が必須**） |
| 開発 | Node.js 22 以降 |

起動時に `navigator.gpu` を確認し、未対応なら「iPadOS 26以降が必要です」というエラー画面を表示します。

## セットアップ

```bash
npm ci
npm run gen:assets   # アイコンと無音プレースホルダー音源を生成
npm run dev          # 開発サーバー
```

`npm run dev -- --host` で LAN 公開できますが、**iOS Safari で Service Worker を動かすには HTTPS が必要**です。
PWA 機能の実機確認は GitHub Pages のデプロイ版で行うのが確実です（Cloudflare Tunnel / ngrok でも可）。

デスクトップのブラウザで動作確認したい場合は `?webgl=1` を付けてください。WebGPU のチェックを飛ばし、
WebGL2 バックエンドで起動します（実機では常に WebGPU を使用）。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー |
| `npm run build` | アセット生成 → 型チェック → 本番ビルド |
| `npm run preview` | ビルド結果のプレビュー |
| `npm run typecheck` | 型チェックのみ |
| `npm test` | 論理層のテスト（設置ルール・物理・色・JSON 入出力） |
| `npm run gen:assets` | アイコン／音源プレースホルダーの再生成 |

## デプロイ

`.github/workflows/deploy.yml` が `main` への push で `npm run build` → `dist/` を GitHub Pages へ公開します。
リポジトリの Settings → Pages で Source を「GitHub Actions」に設定してください。

**リポジトリ名を変えた場合**は次の3か所を合わせて変更する必要があります。

1. `vite.config.ts` の `BASE`
2. `index.html` の `apple-touch-icon` / `icon` の href
3. manifest の `start_url` / `scope`（`vite.config.ts` 内で `BASE` から生成）

## 設計の要点

### 単位系

- 1ユニット = ブロック1辺の半分 = 0.5m
- 1セル = 2×2×2ユニット = 1m立方
- **セル座標**（整数、`CellPos`）と**ワールド座標**（メートル、`WorldPos`）を型で区別しています

### データ構造の3層分離

| 層 | 形式 |
|---|---|
| 実行時 | 密な `Uint16Array`（64×32×64 = 256KB）＋色の `Uint8Array`（128KB） |
| IndexedDB | 上記の ArrayBuffer をそのまま保存 |
| JSON 入出力 | 疎な配列（人が読める形式） |

16ビットの内訳は `src/core/voxelData.ts` を参照。ビット操作は必ず同モジュールのヘルパー経由で行います。

### ブロックの色

素材（テクスチャ）と色を分けて持ちます。色は 16ビットに空きがないため、同じ並び順の
`Uint8Array`（1セル1バイト・0 は素の色）へ並行して格納します。パレットと着色の計算は
`src/core/blockColors.ts` に集約してあり、**シェーダーとホットバーのアイコンが同じ式**を使うので
置く前と置いた後の色が一致します。

- ホットバーの「色ぬり」を選ぶと、タップしたブロックを選択中の色へ塗り替えられます
- 設置モードでパレットの色を選ぶと、その色でブロックを置けます
- 色の違うブロックは Greedy Meshing で結合しません（結合キーに色番号を含めています）
- パレットへの追加は**末尾のみ**（並べ替え・削除は保存済みワールドの色番号を壊します）

### 描画

- 通常ブロックはチャンク（16³セル）ごとの **Greedy Meshing**
- 面ごとの明度差は**頂点カラーへ焼き込み**（カスタムシェーダーを書かずに済ませるため）
- テクスチャは**アトラスではなく `DataArrayTexture`**（結合面で UV を繰り返しても隣のタイルへはみ出さない）
- 特殊形状は `InstancedMesh`、窓のガラスは透過用の別メッシュ
- チャンク再構築は 1フレームにつき 1チャンクまで

配列テクスチャのレイヤーを頂点属性で切り替える部分だけは固定機能で表現できないため、
`MeshLambertNodeMaterial` + TSL を使っています（WebGPU / WebGL2 のどちらでも同一コードで動作）。

### 物理

固定タイムステップ（60Hz）のアキュムレータ方式。最大5サブステップで打ち切り、
落下の終端速度は 1ステップの移動量が 0.25ユニット以内に収まる 7.5 m/s。
バックグラウンド復帰時はアキュムレータをリセットします。

## ディレクトリ

```
src/
  core/      座標系・ブロック定義・voxel データ・乱数
  render/    テクスチャ・Greedy Meshing・ジオメトリ・マテリアル・描画
  physics/   プレイヤーの移動と衝突判定
  game/      ワールドのルール・レイキャスト・カメラ・ゲームループ
  input/     タッチ操作
  ui/        HUD・ホットバー・ダイアログ
  storage/   IndexedDB・JSON 入出力
  audio/     サウンド
scripts/     アイコン／音源の生成
tests/       論理層のテスト
```

## 音源の差し替え

`public/assets/sounds/` の `place.wav` / `break.wav` / `bgm.wav` は無音のプレースホルダーです。
同名のファイルを置き換えるだけで有効になります（Service Worker のプリキャッシュ対象に含まれています）。

## テクスチャの差し替え

テクスチャはシード固定の擬似乱数（mulberry32）で手続き的に生成しています。
PNG へ差し替える場合は `src/render/textures.ts` の `TextureSource` インターフェースを実装したものを
`buildBlockTextureArray()` に渡してください。

着色はテクスチャの明暗を残したまま色相だけを差し替えるため、差し替えたテクスチャでも
そのまま色を変えられます（明るさが極端なテクスチャでは `TINT_REFERENCE_LUMINANCE` を調整してください）。
