import { announcerCueInfo } from '../../../shared/announcer.js';

export const ANNOUNCER_GAIN = 0.65;
export const ANNOUNCER_COALESCE_MS = 80;

/** One local voice. A burst keeps its strongest call and never builds a speech queue. */
export class AnnouncerVoice {
  constructor(engine, getBuffer, {
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = timer => clearTimeout(timer),
    hidden = () => globalThis.document?.hidden === true,
  } = {}) {
    Object.assign(this, { engine, getBuffer, schedule, cancel, hidden });
    this.pending = null;
    this.timer = null;
    this.voice = null;
    /** Buffers handed over by other loaders (Conquest objective calls), keyed by cue id. */
    this.extraBuffers = new Map();
  }

  /** Register a decoded buffer for a whitelisted cue (objective calls load lazily in Conquest). */
  registerBuffer(cue, buffer) {
    if (!announcerCueInfo(cue) || !buffer) return false;
    this.extraBuffers.set(cue, buffer);
    return true;
  }

  _buffer(cue) {
    return this.getBuffer(cue) || this.extraBuffers.get(cue) || null;
  }

  play(cue) {
    const info = announcerCueInfo(cue);
    if (!info) return false;
    if (this.engine.ctx?.state !== 'running' || !this.engine.bus || this.hidden()) {
      this.stop();
      return false;
    }
    if (!this._buffer(cue)) return false;
    // Objective calls rank below every multikill call (priorities < 2).
    const priority = info.priority;
    if (this.pending && announcerCueInfo(this.pending).priority >= priority) return true;
    if (this.voice && this.engine.now < this.voice.until && this.voice.priority >= priority) return true;
    this.pending = cue;
    if (this.timer === null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        const selected = this.pending;
        this.pending = null;
        this._start(selected);
      }, ANNOUNCER_COALESCE_MS);
    }
    return true;
  }

  _start(cue) {
    const ctx = this.engine.ctx;
    const buffer = this._buffer(cue);
    if (!buffer || ctx?.state !== 'running' || !this.engine.bus || this.hidden()) return;
    this._stopVoice();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const at = ctx.currentTime;
    const end = at + buffer.duration;
    source.buffer = buffer;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(ANNOUNCER_GAIN, at + Math.min(0.008, buffer.duration / 4));
    gain.gain.setValueAtTime(ANNOUNCER_GAIN, Math.max(at + buffer.duration / 4, end - 0.02));
    gain.gain.linearRampToValueAtTime(0, end);
    source.connect(gain).connect(this.engine.bus);
    const voice = { source, gain, until: end, priority: announcerCueInfo(cue).priority };
    this.voice = voice;
    source.onended = () => {
      source.disconnect(); gain.disconnect();
      if (this.voice === voice) this.voice = null;
    };
    source.start(at);
  }

  _stopVoice() {
    if (!this.voice) return;
    const { source, gain } = this.voice;
    this.voice = null;
    try { source.stop(); } catch {}
    source.disconnect(); gain.disconnect();
  }

  stop() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.pending = null;
    this._stopVoice();
  }
}
