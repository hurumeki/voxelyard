import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages はリポジトリ名がパスに入るため base を合わせる。
// リポジトリ名を変更した場合はここと manifest の start_url / scope を合わせて変更すること。
const BASE = '/voxelyard/';

export default defineConfig({
  base: BASE,
  build: {
    target: 'es2022',
    // three.js は大きいのでチャンクサイズ警告のしきい値を上げておく
    chunkSizeWarningLimit: 2048,
  },
  plugins: [
    VitePWA({
      // 更新は自前のバナーから適用するため prompt
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['.nojekyll', 'icons/*.png', 'assets/sounds/*.wav'],
      manifest: {
        name: 'VoxelYard',
        short_name: 'VoxelYard',
        description: 'ボクセルサンドボックス（私用）',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'landscape',
        background_color: '#1b1f16',
        theme_color: '#7a9b5c',
        icons: [
          { src: `${BASE}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${BASE}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
          {
            src: `${BASE}icons/icon-512-maskable.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // キャッシュ名にバージョンを含める（voxelyard-cache-v1-*）
        cacheId: 'voxelyard-cache-v1',
        // アプリシェル・アセットはすべてプリキャッシュ（Cache First）
        globPatterns: ['**/*.{js,css,html,png,svg,wav,woff2}'],
        // three.js の WebGPU ビルドは 1MB を超えるため上限を引き上げる
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: `${BASE}index.html`,
      },
      devOptions: {
        // 開発中は Service Worker を無効化（仕様書 11章の推奨）
        enabled: false,
      },
    }),
  ],
});
