import { WEAPON_IDS } from '../../../shared/combatmath.js';

const SLOT_ROOT = '/assets/audio';

const sampleFileSlots = {
  'weapons.rifle.fire': `${SLOT_ROOT}/weapons/rifle/fire.ogg`,
  'weapons.smg.fire': `${SLOT_ROOT}/weapons/smg/fire.ogg`,
  'weapons.shotgun.fire': `${SLOT_ROOT}/weapons/shotgun/fire.ogg`,
  'weapons.sniper.fire': `${SLOT_ROOT}/weapons/sniper/fire.ogg`,
  'weapons.lmg.fire': `${SLOT_ROOT}/weapons/lmg/fire.ogg`,
  'weapons.revolver.fire': `${SLOT_ROOT}/weapons/revolver/fire.ogg`,
  'ui.hitmark.body': `${SLOT_ROOT}/ui/hitmark-body.ogg`,
  'ui.hitmark.head': `${SLOT_ROOT}/ui/hitmark-head.ogg`,
  'movement.footstep': `${SLOT_ROOT}/movement/footstep.ogg`,
  'combat.bulletWhiz': `${SLOT_ROOT}/combat/bullet-whiz.ogg`,
  'combat.grenadeExplosion': `${SLOT_ROOT}/combat/grenade-explosion.ogg`,
  'human.pain.light': `${SLOT_ROOT}/human/pain-light.ogg`,
  'human.pain.heavy': `${SLOT_ROOT}/human/pain-heavy.ogg`,
  'human.pain.head': `${SLOT_ROOT}/human/pain-head.ogg`,
  'human.death.self': `${SLOT_ROOT}/human/death-self.ogg`,
  'human.death.far': `${SLOT_ROOT}/human/death-far.ogg`,
  'impact.stone': `${SLOT_ROOT}/impacts/stone.ogg`,
  'impact.wood': `${SLOT_ROOT}/impacts/wood.ogg`,
  'impact.metal': `${SLOT_ROOT}/impacts/metal.ogg`,
  'impact.glass': `${SLOT_ROOT}/impacts/glass.ogg`,
  'impact.flesh': `${SLOT_ROOT}/impacts/flesh.ogg`,
};

for (const weapon of WEAPON_IDS) {
  // These names document the stable slots without forcing absent assets to be
  // fetched. Callers opt in by passing only licensed entries to load().
  for (let step = 1; step <= 3; step++) {
    sampleFileSlots[`weapons.${weapon}.reload.${step}`] =
      `${SLOT_ROOT}/weapons/${weapon}/reload-${step}.ogg`;
  }
  sampleFileSlots[`weapons.${weapon}.draw`] = `${SLOT_ROOT}/weapons/${weapon}/draw.ogg`;
}

export const SAMPLE_FILE_SLOTS = Object.freeze(sampleFileSlots);

// Only files that ship with the game belong here. The wider slot catalog stays
// optional, so one missing sample never turns into a startup fetch waterfall.
export const BUILTIN_SAMPLE_MANIFEST = Object.freeze({
  'weapons.rifle.fire': SAMPLE_FILE_SLOTS['weapons.rifle.fire'],
  'weapons.smg.fire': SAMPLE_FILE_SLOTS['weapons.smg.fire'],
  'weapons.shotgun.fire': SAMPLE_FILE_SLOTS['weapons.shotgun.fire'],
  'weapons.sniper.fire': SAMPLE_FILE_SLOTS['weapons.sniper.fire'],
  'weapons.lmg.fire': SAMPLE_FILE_SLOTS['weapons.lmg.fire'],
  'weapons.revolver.fire': SAMPLE_FILE_SLOTS['weapons.revolver.fire'],
  'weapons.rifle.reload.2': SAMPLE_FILE_SLOTS['weapons.rifle.reload.2'],
  'weapons.smg.reload.2': SAMPLE_FILE_SLOTS['weapons.smg.reload.2'],
  'weapons.lmg.reload.2': SAMPLE_FILE_SLOTS['weapons.lmg.reload.2'],
  'weapons.revolver.reload.2': SAMPLE_FILE_SLOTS['weapons.revolver.reload.2'],
  'weapons.shotgun.reload.3': SAMPLE_FILE_SLOTS['weapons.shotgun.reload.3'],
  'weapons.sniper.reload.3': SAMPLE_FILE_SLOTS['weapons.sniper.reload.3'],
});

/** Optional decoded-buffer adapter; missing/unloaded slots return false. */
export class LocalSampleBank {
  constructor({ getContext, addCleanup } = {}) {
    if (typeof getContext !== 'function') {
      throw new TypeError('LocalSampleBank requires a context getter');
    }
    this._getContext = getContext;
    this._addCleanup = typeof addCleanup === 'function' ? addCleanup : null;
    this._buffers = new Map();
  }

  async load(manifest = {}, fetchImpl = globalThis.fetch) {
    const ctx = this._getContext();
    if (!ctx || typeof ctx.decodeAudioData !== 'function' || typeof fetchImpl !== 'function') {
      return Object.freeze({ loaded: 0, failed: Object.keys(manifest).length });
    }

    let loaded = 0;
    let failed = 0;
    await Promise.all(Object.entries(manifest).map(async ([slot, url]) => {
      if (typeof slot !== 'string' || typeof url !== 'string' || !url) {
        failed++;
        return;
      }
      try {
        const response = await fetchImpl(url);
        if (!response?.ok) throw new Error(`sample fetch failed: ${url}`);
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        this._buffers.set(slot, buffer);
        loaded++;
      } catch (_) {
        failed++;
      }
    }));
    return Object.freeze({ loaded, failed });
  }

  play(slot, output, { gain = 1, rate = 1 } = {}) {
    const ctx = this._getContext();
    const buffer = this._buffers.get(slot);
    if (!ctx || !buffer || !output) return false;

    const source = ctx.createBufferSource();
    const level = ctx.createGain();
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.25, Math.min(4, Number(rate) || 1));
    level.gain.value = Math.max(0, Number(gain) || 0);
    source.connect(level).connect(output);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { source.disconnect(); } catch (_) {}
      try { level.disconnect(); } catch (_) {}
    };
    source.onended = cleanup;
    this._addCleanup?.(output, cleanup);
    source.start(ctx.currentTime);
    return true;
  }

  clear() {
    this._buffers.clear();
  }
}
