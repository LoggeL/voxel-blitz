// Registry of the linear-defense (Bastion) layouts plus the helpers every
// consumer shares: defender containment, wave planning and stage lookup.
import { REACTOR_LAYOUT } from './reactor-layout.js';
import { CAUSEWAY_LAYOUT } from './causeway-layout.js';
import { GROUND } from './blocks.js';

export const BASTION_LAYOUTS = Object.freeze({ reactor: REACTOR_LAYOUT, causeway: CAUSEWAY_LAYOUT });
export const PVE_MAP_IDS = Object.freeze(Object.keys(BASTION_LAYOUTS));

/** Derived defender-solid column for a stage objective (max exclusive). */
export function bastionObjectiveSolid(o) {
  return { minX: Math.floor(o.x - o.half[0] / 2), maxX: Math.ceil(o.x + o.half[0] / 2),
    minZ: Math.floor(o.z - o.half[2] / 2), maxZ: Math.ceil(o.z + o.half[2] / 2),
    maxY: GROUND + 1 + Math.ceil(2 * o.half[1]) };
}

/** Invisible walls for defenders only: ingress gates, authored solids and every objective column. */
export function bastionDefenderSolid(layout, x, y, z) {
  if (!layout || y <= GROUND) return false;
  const inBox = b => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;
  if ((layout.ingress ?? []).some(inBox)) return true;
  if ((layout.solids ?? []).some(b => y < b.maxY && inBox(b))) return true;
  return (layout.stages ?? []).some(s => { const b = bastionObjectiveSolid(s.objective); return y < b.maxY && inBox(b); });
}

export function bastionPlannedWaves(layout) { return layout.stages.reduce((n, s) => n + s.waves.length, 0); }
export function bastionHoldWaves(layout) { return layout.stages.filter(s => s.kind === 'hold').reduce((n, s) => n + s.waves.length, 0); }

/** {index, stage, stageWave} for a 1-based global wave; waves beyond the plan map to the last stage. */
export function bastionStageOfWave(layout, wave) {
  const w = Math.max(1, wave | 0), stages = layout.stages;
  let before = 0;
  for (let i = 0; i < stages.length; i++) {
    if (i === stages.length - 1 || w <= before + stages[i].waves.length) return { index: i, stage: stages[i], stageWave: w - before };
    before += stages[i].waves.length;
  }
  return { index: 0, stage: stages[0], stageWave: w };
}
