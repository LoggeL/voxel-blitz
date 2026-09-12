import { CAREER_CATALOG } from '../../../shared/career.js';

export const COSMETIC_AUDIO_CHANNELS = Object.freeze({
  kill: Object.freeze({ key: 'vb-cosmetic-kill-volume', volume: 0.5, seconds: 0.5 }),
  death: Object.freeze({ key: 'vb-cosmetic-death-volume', volume: 0.35, seconds: 1.1 }),
  victory: Object.freeze({ key: 'vb-cosmetic-victory-volume', volume: 0.5, seconds: 4.5 }),
});

export function cosmeticSoundUrl(id, cue) {
  if (!Object.hasOwn(COSMETIC_AUDIO_CHANNELS, cue) || !CAREER_CATALOG.some(item => item.id === id && item.kind === 'sound')) return null;
  return `/assets/audio/cosmetics/${id}/${cue}.ogg`;
}

/** Short cosmetic cues share the game's master bus; never replay a delayed kill after loading. */
export class CosmeticAudio {
  constructor(engine, { fetcher = (...args) => fetch(...args), storage = () => globalThis.localStorage } = {}) {
    this.engine = engine;
    this.fetcher = fetcher;
    this.storage = storage;
    this.buffers = new Map();
    this.loading = new Map();
    this.voices = new Map();
    this.epoch = 0;
  }

  preload() {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state === 'closed') return Promise.resolve();
    const tasks = [];
    for (const item of CAREER_CATALOG.filter(item => item.kind === 'sound')) {
      for (const cue of Object.keys(COSMETIC_AUDIO_CHANNELS)) {
        const url = cosmeticSoundUrl(item.id, cue);
        if (this.buffers.has(url)) continue;
        if (!this.loading.has(url)) {
          const epoch = this.epoch;
          const task = this.fetcher(url).then(response => {
            if (!response.ok) throw new Error('Cosmetic audio unavailable');
            return response.arrayBuffer();
          }).then(bytes => ctx.decodeAudioData(bytes)).then(buffer => {
            if (epoch === this.epoch && ctx === this.engine.ctx) this.buffers.set(url, buffer);
          }).catch(() => {}).finally(() => { if (this.loading.get(url) === task) this.loading.delete(url); });
          this.loading.set(url, task);
        }
        tasks.push(this.loading.get(url));
      }
    }
    return Promise.all(tasks);
  }

  volume(cue) {
    const config = COSMETIC_AUDIO_CHANNELS[cue];
    try {
      const raw = this.storage()?.getItem(config.key);
      if (raw !== null && raw !== undefined && raw !== '') {
        const value = Number(raw);
        if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
      }
    } catch {}
    return config.volume;
  }

  play(id, cue) {
    const url = cosmeticSoundUrl(id, cue);
    const config = COSMETIC_AUDIO_CHANNELS[cue];
    if (cue !== 'victory' && this.voices.has('victory')) return true;
    if (!url || !config) return false;
    const volume = this.volume(cue);
    if (volume <= 0) { this.stop(cue); return true; }
    const ctx = this.engine.ctx;
    const buffer = this.buffers.get(url);
    if (!buffer || !ctx || ctx.state !== 'running' || !this.engine.bus || globalThis.document?.hidden) return false;
    // One melodic event at a time, including fast multi-kills and a kill that ends the match.
    this.stop();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const length = Math.min(buffer.duration, config.seconds);
    source.buffer = buffer;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume * 0.65, now + Math.min(0.004, length / 4));
    gain.gain.setValueAtTime(volume * 0.65, now + Math.max(0.004, length - 0.04));
    gain.gain.linearRampToValueAtTime(0, now + length);
    source.connect(gain).connect(this.engine.bus);
    const voice = { source, gain };
    this.voices.set(cue, voice);
    source.onended = () => {
      source.disconnect(); gain.disconnect();
      if (this.voices.get(cue) === voice) this.voices.delete(cue);
    };
    source.start(now, 0, length);
    return true;
  }

  stop(cue) {
    for (const [key, voice] of this.voices) {
      if (cue && key !== cue) continue;
      try { voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); } catch {}
      this.voices.delete(key);
    }
  }

  clear() { this.epoch++; this.stop(); this.buffers.clear(); this.loading.clear(); }
}
