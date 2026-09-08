import {
  GRASS, DIRT, SAND, WOOD, LEAVES, PLANK, DUST_CRATE, DUST_WOOD,
  METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED, GLASS,
} from '../../../shared/world/blocks.js';

export const PICKAXE_SWING_SLOTS = Object.freeze(['weapons.knife.fire', 'weapons.knife.fire.2']);
export const PICKAXE_IMPACT_SLOTS = Object.freeze(['pickaxe.impact', 'pickaxe.impact.2']);
const RATES = Object.freeze([1, 0.985, 1.015, 0.995]);

export function pickaxeSampleChoice(index, impact = false) {
  const slots = impact ? PICKAXE_IMPACT_SLOTS : PICKAXE_SWING_SLOTS;
  return { slot: slots[index % slots.length], rate: RATES[index % RATES.length] };
}

export function pickaxeMaterial(type) {
  if ([GRASS, DIRT, SAND, WOOD, LEAVES, PLANK, DUST_CRATE, DUST_WOOD].includes(type)) return 'soft';
  if ([METAL, ACCENT, RUST, BUS_YELLOW, TRUCK_RED].includes(type)) return 'metal';
  return type === GLASS ? 'glass' : 'stone';
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
    for (const hz of [720, 1135]) primitives.tone(out, {
      t0: at + 0.003, type: 'sine', f0: hz, att: 0.003, dec: 0.07, g: 0.018,
    });
  }
  if (broken) {
    // Loose fragments follow the one impact. No second attack or tonal chirp.
    const frequency = material === 'soft' ? 600 : material === 'glass' ? 3800 : 1500;
    for (let i = 0; i < 3; i++) primitives.hiss(out, {
      t0: at + 0.025 + i * 0.038, filter: 'bandpass', f: frequency * (1 - i * 0.1),
      q: 0.6, att: 0.006, dec: 0.075 - i * 0.01, g: 0.13 - i * 0.027,
    });
  }
}
