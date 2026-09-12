export const MUSIC_VOLUME_KEY = 'vb-music-volume';
export const DEFAULT_MUSIC_VOLUME = 80;
const LEGACY_MUSIC_KEY = 'vb-menu-music';

const normalize = (value, fallback) => {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback;
};

function browserStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

/** One percentage shared by every music control, independent of SFX volume. */
export class MusicVolumePreference {
  constructor(storage = browserStorage()) {
    this.listeners = new Set();
    this.configure(storage);
  }

  configure(storage) {
    this.storage = storage;
    this.value = DEFAULT_MUSIC_VOLUME;
    try {
      const saved = storage?.getItem(MUSIC_VOLUME_KEY);
      const legacy = storage?.getItem(LEGACY_MUSIC_KEY);
      this.value = normalize(saved, legacy === '0' || legacy === 'false' ? 0 : DEFAULT_MUSIC_VOLUME);
      // Keep the old flag consistent for clients returning to an older build.
      this.persist();
    } catch (_) {}
    this.notify(false);
    return this.value;
  }

  set(value, { gesture = false } = {}) {
    this.value = normalize(value, this.value);
    this.persist();
    this.notify(gesture);
    return this.value;
  }

  persist() {
    try {
      this.storage?.setItem(MUSIC_VOLUME_KEY, String(this.value));
      this.storage?.setItem(LEGACY_MUSIC_KEY, this.value > 0 ? '1' : '0');
    } catch (_) {}
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(gesture) {
    for (const callback of this.listeners) callback(this.value, { gesture });
  }
}

export const musicVolume = new MusicVolumePreference();
