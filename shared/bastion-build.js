// Bastion build catalog and the shared placement predicate (server accept and
// client ghost run the same rules). Keeps shared/bastion.js free of block ids.
import { BARRICADE, AIR, GROUND, isSolidBlock } from './world/blocks.js';
import { BASTION_RULES, STRUCTURE_KINDS } from './bastion.js';
import { BASTION_BREAK_PHASES } from './modes.js';

export { STRUCTURE_KINDS };

export const BASTION_STRUCTURES = Object.freeze({
  sandbag: Object.freeze({ name: 'SANDBAG LINE', price: 40, kind: 'block', width: 3, height: 1,
    description: 'Three sandbag blocks, 480 HP each. Kneel-high cover; enemies must breach or go around.' }),
  wall: Object.freeze({ name: 'BARRICADE WALL', price: 90, kind: 'block', width: 3, height: 2,
    description: 'Three-wide, two-high barricade, 480 HP per block. Vehicles ram it.' }),
  turret: Object.freeze({ name: 'SENTRY TURRET', price: 350, kind: 'objective', hp: 400, half: Object.freeze([0.45, 0.55, 0.45]),
    ammo: 240, damage: 12, rpm: 360, range: 26, turnRate: 4,
    description: 'Auto-fires at the nearest hostile in sight, 240 rounds. Refilled every break and by ammo crates.' }),
  crate: Object.freeze({ name: 'AMMO CRATE', price: 200, kind: 'objective', hp: 250, half: Object.freeze([0.5, 0.4, 0.5]),
    charges: 6, radius: 2.5, turretRadius: 6,
    description: 'Six refills: +1 reserve magazine and +25 HP for a defender within 2.5 m, once per wave. Refills turrets within 6 m.' }),
});

/** Footprint cells for a kind at a cell with facing 0..3 (0/2 = along x, 1/3 = along z). */
export function structureFootprint(kind, cell, facing) {
  const def = BASTION_STRUCTURES[kind]; if (!def) return [];
  if (def.kind === 'objective') return [{ x: cell.x, y: cell.y, z: cell.z }];
  const alongX = (facing & 1) === 0, cells = [];
  for (let y = 0; y < def.height; y++) for (let n = -1; n <= 1; n++)
    cells.push({ x: cell.x + (alongX ? n : 0), y: cell.y + y, z: cell.z + (alongX ? 0 : n) });
  return cells;
}

const inBox = (b, x, z) => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;
const inRect = (r, x, z) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
const fail = reason => ({ ok: false, reason });

/**
 * Shared placement predicate, identical on server accept and client ghost.
 * First failing rule wins; the order is the contract.
 * @returns {{ok:boolean, reason:string|null}}
 *   reason ∈ kind|phase|alive|reach|zone|ingress|objective|spawn|air|floor|occupied|structure|budget|credits
 */
export function canPlaceStructure({ getBlock, layout, stageIndex, kind, cell, facing, player, phase, budget, credits, structures, occupied }) {
  const def = BASTION_STRUCTURES[kind];
  if (!def || !cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y) || !Number.isInteger(cell.z)
    || !Number.isInteger(facing) || facing < 0 || facing > 3) return fail('kind');
  if (!BASTION_BREAK_PHASES.includes(phase)) return fail('phase');
  if (player?.state !== 'alive') return fail('alive');
  if (Math.hypot(player.x - (cell.x + 0.5), player.z - (cell.z + 0.5)) > BASTION_RULES.buildRadius
    || Math.abs(player.y - cell.y) > 3) return fail('reach');
  const stage = layout?.stages?.[stageIndex];
  const cells = structureFootprint(kind, cell, facing);
  if (!stage || cell.y !== GROUND + 1
    || cells.some(c => !inRect(stage.buildZone, c.x, c.z) || !inRect(layout.bounds, c.x, c.z))) return fail('zone');
  if (cells.some(c => (layout.ingress ?? []).some(b => inBox(b, c.x, c.z)) || (layout.solids ?? []).some(b => inBox(b, c.x, c.z)))) return fail('ingress');
  const o = stage.objective;
  if (cells.some(c => Math.abs(c.x + 0.5 - o.x) <= o.half[0] + 2.0 && Math.abs(c.z + 0.5 - o.z) <= o.half[2] + 2.0)) return fail('objective');
  const spawns = [...(stage.defenders ?? []), ...(stage.supply ? [stage.supply] : [])];
  if (cells.some(c => spawns.some(p => Math.hypot(c.x + 0.5 - p.x, c.z + 0.5 - p.z) <= 1.5))) return fail('spawn');
  if (cells.some(c => getBlock(c.x, c.y, c.z) !== AIR)) return fail('air');
  if (cells.some(c => c.y === cell.y && !isSolidBlock(getBlock(c.x, c.y - 1, c.z)))) return fail('floor');
  if (typeof occupied === 'function' && occupied(cells) === true) return fail('occupied');
  if ((structures ?? []).some(s => cells.some(c => Math.floor(s.x) === c.x && Math.floor(s.y) === c.y && Math.floor(s.z) === c.z))) return fail('structure');
  const line = def.kind === 'block' ? budget?.barricadeVoxels : budget?.[kind + 's'];
  if (line && (def.kind === 'block' ? line.used + cells.length > line.max : line.used >= line.max)) return fail('budget');
  if (!(credits >= def.price)) return fail('credits');
  return { ok: true, reason: null };
}
