import {
  GRASS, DIRT, SAND, WOOD, LEAVES, PLANK, DUST_CRATE, DUST_WOOD,
  METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED, GLASS,
  MC_GRASS, MC_DIRT, MC_SAND, MC_GRAVEL, MC_CLAY, MC_LOG, MC_LEAVES, MC_PLANKS,
  MC_BOOKSHELF, MC_WOOL_WHITE, MC_WOOL_RED, MC_CACTUS, MC_CHEST, MC_CRAFTING, MC_TNT,
  MC_CLOUD, MC_GLASS, MC_IRON, MC_GOLD, MC_DIAMOND, MC_GHOST_SOLID, SLIDE_BLUE, SLIDE_YELLOW, POOL_PANEL,
  YELLOW_SIDING, TEAL_SIDING, MC_GLOWSTONE, BARRICADE,
} from '../../../shared/world/blocks.js';

export const PICKAXE_SWING_SLOTS = Object.freeze(['weapons.knife.fire', 'weapons.knife.fire.2']);
export const PICKAXE_IMPACT_SLOTS = Object.freeze(['pickaxe.impact', 'pickaxe.impact.2']);
const RATES = Object.freeze([1, 0.965, 1.035, 0.985]);

export function pickaxeSampleChoice(index, impact = false) {
  const slots = impact ? PICKAXE_IMPACT_SLOTS : PICKAXE_SWING_SLOTS;
  return { slot: slots[index % slots.length], rate: RATES[index % RATES.length] };
}

const SOFT = new Set([GRASS, DIRT, SAND, WOOD, LEAVES, PLANK, DUST_CRATE, DUST_WOOD,
  MC_GRASS, MC_DIRT, MC_SAND, MC_GRAVEL, MC_CLAY, MC_LOG, MC_LEAVES, MC_PLANKS, MC_BOOKSHELF,
  MC_WOOL_WHITE, MC_WOOL_RED, MC_CACTUS, MC_CHEST, MC_CRAFTING, MC_TNT, MC_CLOUD, SLIDE_BLUE, SLIDE_YELLOW]);
const HARD_METAL = new Set([METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED, MC_IRON, MC_GOLD, MC_DIAMOND, POOL_PANEL]);

export function pickaxeMaterial(type) {
  type = MC_GHOST_SOLID[type] ?? type;
  if (SOFT.has(type)) return 'soft';
  if (HARD_METAL.has(type)) return 'metal';
  return type === GLASS || type === MC_GLASS ? 'glass' : 'stone';
}

// IRON PICK dig/attack banks. Each block plays its material group's dig take:
// quiet and low while mining ("hit"), full on the breaking strike, the way the
// block games voice a pickaxe. Glass alone swaps to a shatter for the break.
export const PICKAXE_DIG_MATERIALS = Object.freeze(['stone', 'wood', 'gravel', 'grass', 'sand', 'cloth', 'glass', 'metal']);
export const PICKAXE_ATTACK_KINDS = Object.freeze(['strong', 'crit', 'knockback', 'backstab', 'armor']);
const bank = (prefix, counts) => Object.freeze(Object.fromEntries(Object.entries(counts).map(([name, n]) =>
  [name, Object.freeze(Array.from({ length: n }, (_, i) => `${prefix}.${name}.${i + 1}`))])));
export const PICKAXE_DIG_SLOTS = bank('pickaxe.dig',
  { stone: 4, wood: 4, gravel: 3, grass: 3, sand: 3, cloth: 3, glass: 3, metal: 3 });
export const PICKAXE_BREAK_SLOTS = bank('pickaxe.break', { glass: 2 });
export const PICKAXE_ATTACK_SLOTS = bank('pickaxe.attack', { strong: 3, crit: 2, knockback: 2, backstab: 2, armor: 2 });

/** Slot -> shipped file, all under weapons/knife/ (kept beside the swing). */
export function pickaxeSampleFiles(root) {
  const files = {};
  for (const [material, slots] of Object.entries(PICKAXE_DIG_SLOTS)) {
    slots.forEach((slot, i) => { files[slot] = `${root}/weapons/knife/dig-${material}-${i + 1}.ogg`; });
  }
  for (const [material, slots] of Object.entries(PICKAXE_BREAK_SLOTS)) {
    slots.forEach((slot, i) => { files[slot] = `${root}/weapons/knife/dig-${material}-break-${i + 1}.ogg`; });
  }
  for (const [kind, slots] of Object.entries(PICKAXE_ATTACK_SLOTS)) {
    slots.forEach((slot, i) => { files[slot] = `${root}/weapons/knife/attack-${kind}-${i + 1}.ogg`; });
  }
  return files;
}

// Block-game sound groups: dirt and clay dig like gravel, TNT like grass,
// cactus and sandbags like wool, glowstone like glass. Plastic slides read as
// a hollow wooden knock. Anything unlisted is stone.
const DIG_GROUPS = new Map();
for (const [material, types] of Object.entries({
  wood: [WOOD, PLANK, DUST_CRATE, DUST_WOOD, YELLOW_SIDING, TEAL_SIDING, MC_LOG, MC_PLANKS, MC_BOOKSHELF,
    MC_CHEST, MC_CRAFTING, SLIDE_BLUE, SLIDE_YELLOW],
  grass: [GRASS, LEAVES, MC_GRASS, MC_LEAVES, MC_TNT],
  gravel: [DIRT, MC_DIRT, MC_GRAVEL, MC_CLAY],
  sand: [SAND, MC_SAND],
  cloth: [MC_WOOL_WHITE, MC_WOOL_RED, MC_CLOUD, MC_CACTUS, BARRICADE],
  glass: [GLASS, MC_GLASS, MC_GLOWSTONE],
  metal: [...HARD_METAL],
})) for (const type of types) DIG_GROUPS.set(type, material);

export function pickaxeDigMaterial(type) {
  return DIG_GROUPS.get(MC_GHOST_SOLID[type] ?? type) || 'stone';
}

/** Per-material no-repeat take choice. Mining contacts are quiet and pitched
 * down; the breaking strike is full level near the recorded pitch. `has`
 * filters to loaded slots so a missing take never silences the contact. */
export class PickaxeDigVariations {
  constructor() { this.last = new Map(); }

  _pick(key, slots, random) {
    const previous = this.last.get(key);
    const choices = slots.length > 1 ? slots.filter((slot) => slot !== previous) : slots;
    const slot = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
    this.last.set(key, slot);
    return slot;
  }

  dig(material, broken, random = Math.random, has = () => true) {
    if (!Object.hasOwn(PICKAXE_DIG_SLOTS, material)) material = 'stone';
    const shatter = broken && (PICKAXE_BREAK_SLOTS[material] || []).filter(has);
    const slots = shatter?.length ? shatter : PICKAXE_DIG_SLOTS[material].filter(has);
    if (!slots.length) return null;
    const jitter = random();
    return { material, broken: !!broken, slot: this._pick(`${material}:${!!shatter?.length}`, slots, random),
      rate: broken ? 0.96 + jitter * 0.08 : (material === 'glass' ? 0.88 : 0.76) + jitter * 0.06,
      gain: broken ? 1 : 0.42 };
  }

  attack(kind, random = Math.random, has = () => true) {
    if (!Object.hasOwn(PICKAXE_ATTACK_SLOTS, kind)) kind = 'strong';
    const slots = PICKAXE_ATTACK_SLOTS[kind].filter(has);
    return slots.length ? { kind, slot: this._pick(`attack:${kind}`, slots, random),
      rate: 0.97 + random() * 0.06, gain: 1 } : { kind, slot: null, rate: 1, gain: 1 };
  }
}

/** Procedural melee hit for an unloaded bank: body thump plus the kind's colour. */
export function renderMeleeHitFallback(out, primitives, kind) {
  const at = primitives.nowT();
  const heavy = kind === 'backstab' || kind === 'crit';
  if (kind !== 'armor') primitives.tone(out, { t0: at, type: 'sine', f0: heavy ? 150 : 170,
    f1: heavy ? 48 : 62, att: 0.002, dec: heavy ? 0.12 : 0.09, g: heavy ? 0.42 : 0.36 });
  primitives.hiss(out, { t0: at, filter: 'lowpass', f: kind === 'armor' ? 2600 : 1200,
    q: 0.6, att: 0.002, dec: 0.06, g: 0.3 });
  if (kind === 'armor') for (const hz of [310, 745, 1280]) primitives.tone(out, {
    t0: at, type: 'sine', f0: hz, att: 0.002, dec: 0.07, g: 0.08,
  });
  if (kind === 'crit') for (let i = 0; i < 4; i++) primitives.tone(out, {
    t0: at + 0.012 + i * 0.02, type: 'sine', f0: 3800 + i * 900, att: 0.001, dec: 0.03, g: 0.05 * 0.85 ** i,
  });
  if (kind === 'knockback') primitives.hiss(out, { t0: at + 0.04, filter: 'bandpass', f: 700,
    sweepTo: 1600, sweepMs: 0.12, q: 0.8, att: 0.03, dec: 0.1, g: 0.2 });
}

/** Short physical contact fallback; the recording already supplies the strike. */
export function renderPickaxeContact(out, primitives, material, { sampled, broken }) {
  const at = primitives.nowT();
  if (!sampled) {
    primitives.hiss(out, { t0: at, filter: 'lowpass', f: material === 'soft' ? 720 : 2100,
      q: 0.6, att: 0.003, dec: 0.1, g: 0.37 });
    primitives.tone(out, { t0: at, type: 'sine', f0: material === 'soft' ? 125 : 185,
      att: 0.004, dec: 0.06, g: 0.11 });
  }
  if (material === 'metal') {
    for (const hz of [640, 1547]) primitives.tone(out, {
      t0: at + 0.003, type: 'sine', f0: hz, att: 0.003, dec: hz < 1000 ? 0.16 : 0.095, g: 0.028,
    });
  }
  if (broken) {
    // Loose fragments follow the one impact. No second attack or tonal chirp.
    const frequency = material === 'soft' ? 600 : material === 'glass' ? 3800 : 1500;
    for (let i = 0; i < 3; i++) primitives.hiss(out, {
      t0: at + 0.025 + i * 0.048, filter: 'bandpass', f: frequency * (1 - i * 0.1),
      q: 0.6, att: 0.006, dec: 0.075 - i * 0.01, g: 0.16 - i * 0.035,
    });
  }
}
