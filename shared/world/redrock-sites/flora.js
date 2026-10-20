// Redrock Canyon flora: sparse desert scrub, saguaro cacti, boulder tumbles
// and date palms along the reservoir. Planned once on the west half (alpha
// frame) and planted twice, the east copy mirrored about x = 384, so both
// teams cross the same cover. Plants only fill air, keep off roads, water,
// cliffs, pads, plateaus, the places and every site footprint, and tall
// plants keep FLAG_CLEAR from each flag (the commander stages squads and
// sets transports down there). The counts are small: the far shell budget
// (docs/graphics.md) is shared with the strata cliffs, which cost far more.

import { REDROCK_PLAN } from '../redrock-plan.js';
import {
  redrockTerrain, redrockScrubDensity, REDROCK_CELL_KIND as KIND, REDROCK_RUNWAYS, riverOffset, REDROCK_DAM,
} from '../redrock-terrain.js';
import { roadClearance } from './plan.js';
import { seededRandom } from '../frontier-sites/kit.js';
import { palm, saguaro, scrub, boulders } from './props.js';
import { REDROCK_LOCATION_KEEP_OUT } from './locations.js';
import { OASIS_SITE } from './oasis.js';
import { MINE_SITE } from './mine.js';
import { DAM_SITE } from './dam.js';
import { RADAR_SITE } from './radar.js';
import { RAILHEAD_SITE } from './railhead.js';

const { sx: SX } = REDROCK_PLAN.dimensions;
export const REDROCK_FLAG_CLEAR = 82;
const PITCH = 6.5;
const SITES = [OASIS_SITE, MINE_SITE, DAM_SITE, RADAR_SITE, RAILHEAD_SITE];
/** Per-half caps (the planted total is twice these). */
export const REDROCK_FLORA_CAPS = Object.freeze({ scrub: 1500, saguaro: 380, boulders: 170, palm: 70 });

let keep = null;
function keepOuts() {
  if (keep) return keep;
  const rects = [];
  const pad = (r, m) => ({ minX: r.minX - m, minZ: r.minZ - m, maxX: r.maxX + 1 + m, maxZ: r.maxZ + 1 + m });
  for (const site of SITES) {
    for (const b of site.buildings) rects.push(pad(b, 4));
    for (const l of site.landmarks) rects.push({ minX: l.x - 9, maxX: l.x + 9, minZ: l.z - 9, maxZ: l.z + 9 });
    for (const [x, z] of site.spawns) rects.push({ minX: x - 3, maxX: x + 3, minZ: z - 3, maxZ: z + 3 });
  }
  for (const r of REDROCK_LOCATION_KEEP_OUT) rects.push(pad(r, 2));
  // Both halves' footprints, mirrored into the west frame.
  keep = [...rects, ...rects.map(r => ({ minX: SX - r.maxX, maxX: SX - r.minX, minZ: r.minZ, maxZ: r.maxZ }))];
  return keep;
}

function allowed(x, z, terrain, { tall }) {
  if (x < 26 || z < 26 || x >= SX - 26 || z >= SX - 26) return false;
  for (const r of REDROCK_RUNWAYS) if (Math.abs(x + 0.5 - r.x) < 36) return false;
  const { kind, heights, water } = terrain;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const j = (z + dz) * SX + x + dx, k = kind[j];
    if (water[j]) return false;
    if (k === KIND.RIVER || k === KIND.FORD || k === KIND.BRIDGE || k === KIND.CLIFF || k === KIND.PLATEAU || k === KIND.ROAD) return false;
    if (tall && k === KIND.PAD) return false;
    if (Math.abs(heights[j] - heights[z * SX + x]) > 1) return false;
  }
  const px = x + 0.5, pz = z + 0.5;
  for (const f of REDROCK_PLAN.flags) {
    const fx = f.x <= SX / 2 ? f.x : SX - f.x;
    if (Math.hypot(px - fx, pz - f.z) < (tall ? REDROCK_FLAG_CLEAR : f.radius + 4)) return false;
  }
  for (const hq of Object.values(REDROCK_PLAN.hqs)) if (Math.hypot(px - hq.x, pz - hq.z) < hq.radius + 10) return false;
  for (const r of keepOuts()) if (px >= r.minX && px <= r.maxX && pz >= r.minZ && pz <= r.maxZ) return false;
  return roadClearance(px, pz) >= (tall ? 3 : 1.5);
}

let plan = null;
/** Deterministic west-half plan: [{type, x, z, height, seed}] (mirrored east when planted). */
export function redrockFloraPlan() {
  if (plan) return plan;
  const terrain = redrockTerrain();
  const rng = seededRandom(0x5a6a);
  const out = [];
  const count = { scrub: 0, saguaro: 0, boulders: 0, palm: 0 };
  const caps = REDROCK_FLORA_CAPS;
  for (let gz = 26; gz < SX - 26; gz += PITCH) for (let gx = 26; gx < SX / 2 - 2; gx += PITCH) {
    const x = Math.floor(gx + rng() * PITCH * 0.8), z = Math.floor(gz + rng() * PITCH * 0.8);
    if (x >= SX / 2 - 1) continue;
    const roll = rng(), seed = Math.floor(rng() * 0xffffffff);
    const px = x + 0.5, pz = z + 0.5;
    const dr = Math.abs(riverOffset(px, pz));
    const lakeside = pz < REDROCK_DAM.z0 && pz > 150 && dr < 34;
    const density = redrockScrubDensity(px, pz);
    let type = null;
    if (lakeside && roll < 0.32) type = 'palm';
    else if (roll < density * 0.55) type = 'scrub';
    else if (roll < density * 0.55 + 0.07) type = 'saguaro';
    else if (roll < density * 0.55 + 0.1) type = 'boulders';
    if (!type || count[type] >= caps[type]) continue;
    if (!allowed(x, z, terrain, { tall: type !== 'scrub' })) continue;
    count[type]++;
    out.push(Object.freeze({ type, x, z, seed, height: type === 'palm' ? 7 + (seed % 4) : type === 'saguaro' ? 3 + (seed % 5) : 0 }));
  }
  plan = Object.freeze(out);
  return plan;
}

export function buildRedrockFlora(kit) {
  const planted = { scrub: 0, saguaro: 0, boulders: 0, palm: 0 };
  for (const p of redrockFloraPlan()) {
    for (const x of [p.x, SX - 1 - p.x]) {
      const rng = seededRandom(p.seed);
      // Never plant into a structure built after the plan was drawn.
      const g = kit.top(x, p.z);
      if (kit.solid(x, g + 1, p.z) || kit.solid(x, g + 2, p.z)) continue;
      if (p.type === 'palm') palm(kit, x, p.z, p.height, rng);
      else if (p.type === 'saguaro') saguaro(kit, x, p.z, p.height, rng);
      else if (p.type === 'boulders') boulders(kit, x, p.z, rng);
      else scrub(kit, x, p.z, rng);
      planted[p.type]++;
    }
  }
  kit.feature('flora', { ...planted });
  return planted;
}
