/**
 * Service Worker の登録と更新検知（仕様書 セクション11）
 *
 * 新しいバージョンが用意できたら画面下部にバナーを出し、
 * タップで skipWaiting → clients.claim → リロードする。
 */

import { registerSW } from 'virtual:pwa-register';
import { el } from './ui/dom.ts';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      showUpdateBanner(() => {
        void updateSW(true);
      });
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // 起動のたびに更新を確認する（オフライン時は失敗しても無害）
      void registration.update().catch(() => undefined);
    },
    onRegisterError(error) {
      console.warn('Service Worker の登録に失敗しました', error);
    },
  });
}

function showUpdateBanner(onUpdate: () => void): void {
  if (document.getElementById('update-banner')) return;
  const button = el('button', { className: 'btn btn-primary', text: '更新する' });
  const banner = el('div', {
    attrs: { id: 'update-banner' },
    children: [el('div', { text: '新しいバージョンがあります' }), button],
  });
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = '更新中…';
    onUpdate();
  });
  document.body.appendChild(banner);
}
