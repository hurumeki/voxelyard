/**
 * サウンド（仕様書 セクション12）
 *
 * iOS ではユーザー操作を経ないと音声が再生されないため、
 * 最初のタップで AudioContext を生成・resume する。
 *
 * 音源は未確定なので /assets/sounds/ に無音のプレースホルダーを置いてある。
 * 同名のファイルを差し替えるだけで有効になる。
 */

const SOUND_FILES = {
  place: 'assets/sounds/place.wav',
  break: 'assets/sounds/break.wav',
  bgm: 'assets/sounds/bgm.wav',
} as const;

export type SoundName = keyof typeof SOUND_FILES;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private readonly buffers = new Map<SoundName, AudioBuffer>();
  private bgmSource: AudioBufferSourceNode | null = null;
  private masterGain: GainNode | null = null;
  private unlocked = false;
  private enabled = true;
  private loadPromise: Promise<void> | null = null;

  /** 最初のユーザー操作で呼ぶ。以降は何もしない */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    this.unlocked = true;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);
    try {
      await this.ctx.resume();
    } catch {
      // 一部の環境では resume が拒否されるが、次の操作で再度試みられる
    }
    await this.loadAll();
    if (this.enabled) this.startBgm();
  }

  private loadAll(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    const base = import.meta.env.BASE_URL;
    this.loadPromise = (async () => {
      await Promise.all(
        (Object.keys(SOUND_FILES) as SoundName[]).map(async (name) => {
          try {
            const res = await fetch(`${base}${SOUND_FILES[name]}`);
            if (!res.ok) return;
            const data = await res.arrayBuffer();
            if (!this.ctx) return;
            const buf = await this.ctx.decodeAudioData(data);
            this.buffers.set(name, buf);
          } catch {
            // プレースホルダーが未配置でもゲームは動作し続ける
          }
        }),
      );
    })();
    return this.loadPromise;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.masterGain) this.masterGain.gain.value = enabled ? 1 : 0;
    if (enabled) this.startBgm();
    else this.stopBgm();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  playEffect(name: 'place' | 'break'): void {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.masterGain);
    src.start();
  }

  private startBgm(): void {
    if (!this.ctx || !this.masterGain || this.bgmSource) return;
    const buf = this.buffers.get('bgm');
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.masterGain);
    src.start();
    this.bgmSource = src;
  }

  private stopBgm(): void {
    if (!this.bgmSource) return;
    try {
      this.bgmSource.stop();
    } catch {
      // 既に停止している場合は無視
    }
    this.bgmSource.disconnect();
    this.bgmSource = null;
  }

  /** バックグラウンドへ回るとき */
  suspend(): void {
    void this.ctx?.suspend();
  }

  /** 復帰時 */
  resume(): void {
    void this.ctx?.resume();
  }
}
