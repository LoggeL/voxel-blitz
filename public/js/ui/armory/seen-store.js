// Per-viewer NEW flags. Local only (D8): no route, no migration. Every storage
// access is guarded; without storage there are simply no flags.
import { LEGACY_NODE_IDS, legacyCareerLevel } from '../../../../shared/career.js';

export const SEEN_PREFIX = 'vb-armory-seen:v1:';
export const INTRO_KEY = 'vb-armory-intro:v1';
const LEGACY = new Set(LEGACY_NODE_IDS);
/** The four legacy rewards whose gates the redesign lowered, with their frozen old gates.
 * Seeding treats them as seen only when the old rules had already granted them. */
const LOWERED_GATES = Object.freeze({
  'rifle-overdrive': profile => legacyCareerLevel(profile.xp) >= 15 && (profile.mastery?.rifle?.kills || 0) >= 250,
  'revolver-high-noon': profile => legacyCareerLevel(profile.xp) >= 35 && (profile.mastery?.revolver?.kills || 0) >= 1000,
  'minigun-foundry': profile => legacyCareerLevel(profile.xp) >= 75 && (profile.mastery?.minigun?.kills || 0) >= 5000,
  'revenant': profile => legacyCareerLevel(profile.xp) >= 100 && (profile.pvpKills || 0) >= 10000,
});
const seenBefore = (profile, id) => LEGACY.has(id) && (!LOWERED_GATES[id] || LOWERED_GATES[id](profile));

const storageOf = storage => {
  try { return storage === undefined ? globalThis.localStorage || null : storage; } catch { return null; }
};
const read = (storage, key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
const write = (storage, key, value) => { try { storage?.setItem(key, value); return true; } catch { return false; } };

export class SeenStore {
  /** `userId` null means the guest career. */
  constructor(userId = null, storage) {
    this.storage = storageOf(storage);
    this.key = `${SEEN_PREFIX}${userId || 'guest'}`;
    this.ids = null;
    this.xp = null;
    this.intro = false;
    this.available = false;
    const raw = read(this.storage, this.key);
    if (raw === null) return;
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value?.ids)) return;
      this.ids = new Set(value.ids.filter(id => typeof id === 'string'));
      this.xp = Number.isFinite(value.xp) ? value.xp : null;
      this.intro = value.intro === true;
      this.available = true;
    } catch { /* corrupt value: reseed */ }
  }

  save() {
    if (!this.ids) return;
    this.available = write(this.storage, this.key, JSON.stringify({ ids: [...this.ids], xp: this.xp, ...(this.intro ? { intro: true } : {}) }));
  }

  /** First run seeds `owned ∩ LEGACY_NODE_IDS`, minus lowered-gate rewards the old rules
   * had not granted yet, so only rewards this redesign adds or opens read NEW. */
  sync(profile) {
    if (!profile || !this.storage) return { firstRun: false };
    if (this.ids) return { firstRun: false };
    this.ids = new Set((profile.owned || []).filter(id => seenBefore(profile, id)));
    this.xp = Number(profile.xp) || 0;
    this.intro = (profile.owned || []).some(id => !this.ids.has(id));
    this.save();
    if (!this.available) { this.ids = null; this.xp = null; this.intro = false; return { firstRun: false }; }
    return { firstRun: true };
  }

  isNew(id) { return !!this.ids && this.available && !this.ids.has(id); }
  newIds(profile) { return this.ids && this.available ? (profile?.owned || []).filter(id => !this.ids.has(id)) : []; }

  markSeen(...ids) {
    if (!this.ids || !this.available) return false;
    const before = this.ids.size;
    for (const id of ids.flat()) if (typeof id === 'string') this.ids.add(id);
    if (this.ids.size === before) return false;
    this.save();
    return true;
  }

  markAllSeen(profile) { return this.markSeen(profile?.owned || []); }

  /** XP baseline for "since your last visit"; moved on dialog close. */
  get baseline() { return this.available ? this.xp : null; }
  setBaseline(xp) {
    if (!this.ids || !Number.isFinite(xp) || this.xp === xp) return;
    this.xp = xp;
    this.save();
  }

  get showIntro() { return this.available && this.intro && read(this.storage, INTRO_KEY) === null; }
  dismissIntro() { write(this.storage, INTRO_KEY, '1'); }
}
