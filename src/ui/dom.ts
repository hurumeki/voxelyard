/** 素の DOM 操作のための最小限のヘルパー（UI フレームワークは使わない） */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    html?: string;
    attrs?: Record<string, string>;
    children?: (Node | null | undefined)[];
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) node.setAttribute(k, v);
  }
  for (const child of options.children ?? []) {
    if (child) node.appendChild(child);
  }
  return node;
}

/** HUD 上の操作要素であることを示す印。タッチ操作の対象から除外される */
export function asUiControl<T extends HTMLElement>(node: T): T {
  node.setAttribute('data-ui-control', '');
  return node;
}

export function requireEl<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`要素が見つかりません: ${selector}`);
  return node;
}

/** 短いメッセージを画面上部に表示する */
let toastTimer: number | undefined;
export function toast(message: string, durationMs = 2600): void {
  let node = document.getElementById('toast');
  if (!node) {
    node = el('div', { attrs: { id: 'toast' } });
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.add('hidden'), durationMs);
}

/** 確認ダイアログ。OK なら true */
export function confirmDialog(title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = el('div', { className: 'modal-backdrop' });
    const cancel = el('button', { className: 'btn', text: 'キャンセル' });
    const ok = el('button', { className: 'btn btn-danger', text: okLabel });
    const modal = el('div', {
      className: 'modal',
      children: [
        el('h2', { text: title }),
        el('div', { className: 'modal-body', children: [el('p', { text: message })] }),
        el('div', { className: 'modal-actions', children: [cancel, ok] }),
      ],
    });
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = (result: boolean): void => {
      backdrop.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
  });
}

/** テキスト入力ダイアログ。キャンセル時は null */
export function promptDialog(
  title: string,
  initialValue: string,
  label = '名前',
): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = el('div', { className: 'modal-backdrop' });
    const input = el('input', { attrs: { type: 'text', maxlength: '60' } });
    input.value = initialValue;
    const cancel = el('button', { className: 'btn', text: 'キャンセル' });
    const ok = el('button', { className: 'btn btn-primary', text: '決定' });
    const modal = el('div', {
      className: 'modal',
      children: [
        el('h2', { text: title }),
        el('div', {
          className: 'modal-body',
          children: [
            el('div', {
              className: 'field',
              children: [el('label', { text: label }), input],
            }),
          ],
        }),
        el('div', { className: 'modal-actions', children: [cancel, ok] }),
      ],
    });
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.focus();

    const close = (result: string | null): void => {
      backdrop.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => close(input.value.trim() || null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim() || null);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
