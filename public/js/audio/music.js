export const DEFAULT_MENU_TRACK = '/assets/audio/music/menu-pulse.ogg';
export const MENU_GAIN = 0.16;
const FADE_IN_SECONDS = 0.65;
const FADE_OUT_SECONDS = 0.55;

/** Owns one decoded, restartable menu loop outside the bounded SFX voice pool. */
export class MenuMusicLoop {
  constructor({ getContext, getDestination, url = DEFAULT_MENU_TRACK } = {}) {
    if (typeof getContext !== 'function' || typeof getDestination !== 'function') {
      throw new TypeError('MenuMusicLoop requires audio context and destination getters');
    }
    this._getContext = getContext;
    this._getDestination = getDestination;
    this._url = url;
    this._buffer = null;
    this._loadPromise = null;
    this._voice = null;
    this._retiringVoices = new Set();
    this._wanted = false;
    this._generation = 0;
  }

  async start(fetchImpl = globalThis.fetch) {
    this._wanted = true;
    if (this._voice) return true;
    const generation = ++this._generation;
    const buffer = await this._load(fetchImpl);
    if (!buffer || !this._wanted || generation !== this._generation) return false;

    const ctx = this._getContext();
    const destination = this._getDestination();
    if (!ctx || ctx.state === 'closed' || !destination) return false;

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(MENU_GAIN, ctx.currentTime + FADE_IN_SECONDS);
    source.connect(gain).connect(destination);
    const voice = { source, gain };
    this._voice = voice;
    source.onended = () => this._cleanupVoice(voice);
    source.start(ctx.currentTime);
    return true;
  }

  stop(fadeSeconds = FADE_OUT_SECONDS) {
    this._wanted = false;
    this._generation++;
    const voice = this._voice;
    if (!voice) return false;
    this._voice = null;
    this._retiringVoices.add(voice);

    const ctx = this._getContext();
    const fade = Math.max(0, Number(fadeSeconds) || 0);
    const now = ctx?.currentTime || 0;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + fade);
      voice.source.stop(now + fade);
    } catch (_) {
      this._cleanupVoice(voice);
    }
    return true;
  }

  dispose() {
    this._wanted = false;
    this._generation++;
    const voice = this._voice;
    this._voice = null;
    const voices = voice
      ? [voice, ...this._retiringVoices]
      : [...this._retiringVoices];
    this._retiringVoices.clear();
    for (const ownedVoice of voices) {
      try { ownedVoice.source.stop(); } catch (_) {}
      this._cleanupVoice(ownedVoice);
    }
    this._buffer = null;
    this._loadPromise = null;
  }

  async _load(fetchImpl) {
    if (this._buffer) return this._buffer;
    if (this._loadPromise) return this._loadPromise;
    const ctx = this._getContext();
    if (!ctx || typeof ctx.decodeAudioData !== 'function' || typeof fetchImpl !== 'function') {
      return null;
    }

    const loading = (async () => {
      try {
        const response = await fetchImpl(this._url);
        if (!response?.ok) return null;
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        if (this._loadPromise !== loading) return null;
        this._buffer = buffer;
        return buffer;
      } catch (_) {
        return null;
      } finally {
        if (this._loadPromise === loading) this._loadPromise = null;
      }
    })();
    this._loadPromise = loading;
    return loading;
  }

  _cleanupVoice(voice) {
    if (!voice) return;
    if (this._voice === voice) this._voice = null;
    this._retiringVoices.delete(voice);
    try { voice.source.disconnect(); } catch (_) {}
    try { voice.gain.disconnect(); } catch (_) {}
  }
}
