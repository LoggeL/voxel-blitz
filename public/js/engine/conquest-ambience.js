// Battlefield ambience for Conquest: smoke plumes from the Kessler Works
// chimneys, smoke columns over the burnt-out wreck props along the front and
// artillery flashes beyond the map edge. Everything is drawn by the shared
// ParticleField (WP6, public/js/fx/particle-field.js): this module only owns a
// handful of emitters and a salvo scheduler, so it adds no draw call and no
// program, and its CPU cost per frame is a few comparisons.
//
// Sources come from the authored map metadata: mapMeta.landmarks (chimneys),
// mapMeta.conquest.dressing (wreck props with their smoke anchor) and an
// optional explicit mapMeta.conquest.ambience list. Chimney tops can also be
// found in the voxel world itself (tall narrow stacks around the works flag)
// when a `getBlock` is supplied and the metadata does not list them. Nothing
// here touches gameplay: the ambience is static scenery, never an event source.
//
// Particle budget: at most AMBIENCE_PARTICLE_BUDGET live particles in steady
// state (a quarter of the Low tier's alpha pool), so vehicle FX always keep
// most of the shared field. Sunlit motes and valley mist are the map's air
// particles (map-ambience.js, configured by the weather preset in
// map-atmosphere.js), not this module.

import { mulberry32 } from '../../../shared/noise.js';
import { CONQUEST_WIND_YAW } from './conquest-world.js';

export const AMBIENCE_CAPS = Object.freeze({ chimneys: 4, wrecks: 8 });
/** Seconds between off-map artillery salvos (min, max). */
export const ARTILLERY_INTERVAL = Object.freeze([2.6, 7.5]);
/** Metres beyond the map edge where salvos land (before the horizon ring rises). */
export const ARTILLERY_BEYOND = Object.freeze([14, 56]);
/** Steady-state live particles the ambience may hold in the shared field. */
export const AMBIENCE_PARTICLE_BUDGET = 480;
/** Downwind unit vector shared with the flag cloths (conquest-world.js). */
export const AMBIENCE_WIND = Object.freeze([Math.cos(CONQUEST_WIND_YAW), 0, -Math.sin(CONQUEST_WIND_YAW)]);

// Linear RGB (ParticleField colours are linear; > 1 blooms on HDR tiers).
const WEATHER = Object.freeze({
  golden: Object.freeze({
    plume0: [0.2, 0.18, 0.165], plume1: [0.5, 0.46, 0.42],
    smoke0: [0.06, 0.055, 0.05], smoke1: [0.24, 0.22, 0.2],
    flash: [6, 3.4, 1.3], flashSmoke: [0.3, 0.27, 0.24], flashes: 1, alpha: 1, wind: 1.6,
  }),
  mist: Object.freeze({
    plume0: [0.3, 0.3, 0.31], plume1: [0.56, 0.57, 0.58],
    smoke0: [0.09, 0.09, 0.095], smoke1: [0.3, 0.3, 0.31],
    flash: [5, 3.4, 1.8], flashSmoke: [0.42, 0.43, 0.44], flashes: 0.7, alpha: 0.85, wind: 0.8,
  }),
  overcast: Object.freeze({
    plume0: [0.22, 0.225, 0.235], plume1: [0.47, 0.48, 0.5],
    smoke0: [0.07, 0.07, 0.075], smoke1: [0.26, 0.265, 0.27],
    flash: [5.4, 3.3, 1.5], flashSmoke: [0.36, 0.37, 0.38], flashes: 0.85, alpha: 0.95, wind: 2.2,
  }),
});

/**
 * Emitter recipes. rate is particles per second; life/scale/alpha/speed are
 * multipliers of the ParticleField preset (smokeColumn lives 7-10 s and grows
 * 1.6 -> 7.5 m); velocity is the downwind drift added to every particle.
 */
const RECIPES = Object.freeze({
  // Kessler Works stacks: a dense plume that climbs ~60 m and leans downwind.
  chimney: Object.freeze({ kind: 'smokeColumn', rate: 3.2, life: 1.45, scale: 1.55, alpha: 0.85, speed: 1, spread: 0.16, drift: 1 }),
  // Burnt-out hulks: an oily black column and a few embers.
  wreck: Object.freeze({ kind: 'smokeColumn', rate: 2.2, life: 1.15, scale: 1, alpha: 0.8, speed: 0.9, spread: 0.24, drift: 0.8 }),
  embers: Object.freeze({ kind: 'ember', rate: 1.4, life: 1, scale: 1.3, alpha: 1, speed: 0.8, spread: 0.7, drift: 0.4 }),
});

const textOf = (entry) => `${entry?.id ?? ''} ${entry?.kind ?? ''} ${entry?.name ?? ''} ${entry?.type ?? ''}`.toLowerCase();
const finitePoint = (entry) => entry && [entry.x, entry.y, entry.z].every(Number.isFinite);

/** Tall, narrow stacks within `radius` of (cx, cz) whose top reaches `minTop`: one point per stack. */
export function findChimneyTops(getBlock, { cx, cz, radius = 70, minTop = 66, maxY = 80, sx = Infinity, sz = Infinity } = {}) {
  if (typeof getBlock !== 'function' || !Number.isFinite(cx) || !Number.isFinite(cz)) return [];
  const tops = [];
  for (let z = Math.max(0, Math.floor(cz - radius)); z <= Math.min(sz - 1, Math.ceil(cz + radius)); z += 1) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(sx - 1, Math.ceil(cx + radius)); x += 1) {
      let y = maxY - 1;
      while (y >= minTop && getBlock(x, y, z) === 0) y--;
      if (y < minTop) continue;
      tops.push({ x, y: y + 1, z });
    }
  }
  // Connected groups of tall columns are stacks; a chimney is narrow
  // (<= 6 m across), which keeps cooling towers and halls out.
  const byKey = new Map(tops.map((top) => [`${top.x},${top.z}`, top]));
  const seen = new Set();
  const stacks = [];
  for (const top of tops) {
    const key = `${top.x},${top.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cells = [top], queue = [top];
    while (queue.length) {
      const cell = queue.pop();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = `${cell.x + dx},${cell.z + dz}`;
        if (seen.has(next) || !byKey.has(next)) continue;
        seen.add(next);
        cells.push(byKey.get(next)); queue.push(byKey.get(next));
      }
    }
    const xs = cells.map((c) => c.x), zs = cells.map((c) => c.z);
    if (Math.max(...xs) - Math.min(...xs) > 6 || Math.max(...zs) - Math.min(...zs) > 6) continue;
    stacks.push({
      x: xs.reduce((a, b) => a + b, 0) / cells.length + 0.5,
      y: Math.max(...cells.map((c) => c.y)),
      z: zs.reduce((a, b) => a + b, 0) / cells.length + 0.5,
    });
  }
  return stacks;
}

/**
 * Ambience sources of a map: chimney tops (landmarks whose id/kind/name says
 * chimney, or an explicit list), wreck props (mapMeta.conquest.dressing rows of
 * kind wreck, wreck landmarks, or an explicit list) and chimneys found in the
 * voxel world around the works flag when the metadata lists none.
 */
export function conquestAmbienceSources(mapMeta, { getBlock = null } = {}) {
  const landmarks = Array.isArray(mapMeta?.landmarks) ? mapMeta.landmarks : [];
  const explicit = mapMeta?.conquest?.ambience || {};
  const dressing = Array.isArray(mapMeta?.conquest?.dressing) ? mapMeta.conquest.dressing
    : Array.isArray(mapMeta?.dressing) ? mapMeta.dressing : [];
  const pick = (list, pattern) => list.filter((entry) => finitePoint(entry) && pattern.test(textOf(entry)))
    .map(({ x, y, z }) => ({ x, y, z }));
  let chimneys = [
    ...(Array.isArray(explicit.chimneys) ? explicit.chimneys.filter(finitePoint) : []),
    ...pick(landmarks, /chimney|smokestack/),
  ];
  const wrecks = [
    ...(Array.isArray(explicit.wrecks) ? explicit.wrecks.filter(finitePoint) : []),
    ...pick(dressing, /wreck|burnt|burning/),
    ...pick(landmarks, /wreck|burnt|burning/),
  ];
  const dims = mapMeta?.dimensions || null;
  if (!chimneys.length && getBlock) {
    const works = (mapMeta?.conquest?.flags || []).find((flag) => flag?.site === 'works');
    if (works) chimneys = findChimneyTops(getBlock, { cx: works.x, cz: works.z, sx: dims?.sx, sz: dims?.sz, maxY: dims?.sy || 80 });
  }
  const unique = (points) => points.filter((p, i) => points.findIndex((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3) === i);
  return {
    chimneys: unique(chimneys).slice(0, AMBIENCE_CAPS.chimneys),
    wrecks: unique(wrecks).slice(0, AMBIENCE_CAPS.wrecks),
    bounds: dims ? { minX: 0, maxX: dims.sx, minZ: 0, maxZ: dims.sz } : mapMeta?.conquest?.combatArea || null,
    ground: Number.isFinite(mapMeta?.groundLevel) ? mapMeta.groundLevel : 24,
    height: Number.isFinite(dims?.sy) ? dims.sy : 80,
  };
}

/** Steady-state live particles of one recipe's emitter (rate x mean preset life x life scale). */
function steadyParticles(recipe, presetLife) {
  return recipe.rate * ((presetLife[0] + presetLife[1]) / 2) * recipe.life;
}

export class ConquestAmbience {
  /**
   * @param {{scene?:object, fx:{emit:Function, addEmitter:Function, removeEmitter:Function}|null,
   *   mapMeta:object, weather?:string, getBlock?:Function, seed?:number}} options fx is the
   *   shared ParticleField; getBlock finds unlisted chimneys and the ground under the salvos.
   */
  constructor({ scene = null, fx = null, mapMeta = null, weather = 'golden', getBlock = null, seed = 0x51ac7 } = {}) {
    this.scene = scene;
    this.fx = fx && typeof fx.emit === 'function' && typeof fx.addEmitter === 'function' ? fx : null;
    this.weather = WEATHER[weather] ? weather : 'golden';
    this.look = WEATHER[this.weather];
    this.getBlock = typeof getBlock === 'function' ? getBlock : null;
    this.sources = conquestAmbienceSources(mapMeta, { getBlock: this.getBlock });
    this.rng = mulberry32(seed >>> 0);
    this.emitters = [];
    this.flashes = 0;
    this.salvoIn = this.nextInterval() * 0.4;
    this.pending = [];
    this.disposed = false;
    this.elapsed = 0;
    this.lastUpdateMs = 0;
    this.edgeGround = new Map();
    if (!this.fx) return;
    for (const top of this.sources.chimneys) {
      this.addSource(RECIPES.chimney, [top.x, top.y + 0.8, top.z], this.look.plume0, this.look.plume1, 'chimney');
    }
    for (const wreck of this.sources.wrecks) {
      this.addSource(RECIPES.wreck, [wreck.x, wreck.y + 0.4, wreck.z], this.look.smoke0, this.look.smoke1, 'wreck');
      this.addSource(RECIPES.embers, [wreck.x, wreck.y + 0.2, wreck.z], null, null, 'wreck');
    }
  }

  addSource(recipe, pos, color0, color1, source) {
    const drift = this.look.wind * recipe.drift;
    const params = {
      life: recipe.life, scale: recipe.scale, alpha: recipe.alpha * this.look.alpha, speed: recipe.speed, spread: recipe.spread,
      // Leaving the stack straight up, then carried downwind.
      dir: [AMBIENCE_WIND[0] * 0.12, 1, AMBIENCE_WIND[2] * 0.12],
      velocity: [AMBIENCE_WIND[0] * drift, 0, AMBIENCE_WIND[2] * drift],
      source,
    };
    if (color0) { params.color0 = color0; params.color1 = color1; }
    const handle = this.fx.addEmitter({ kind: recipe.kind, pos, rate: recipe.rate, params });
    if (handle != null) this.emitters.push({ handle, recipe, source });
  }

  nextInterval() {
    const [lo, hi] = ARTILLERY_INTERVAL;
    return lo + (hi - lo) * this.rng();
  }

  /** Ground height at the map edge column nearest (x, z): the salvo stands on the rim, not under it. */
  rimGround(x, z) {
    const b = this.sources.bounds;
    const ix = Math.max(b.minX, Math.min(b.maxX - 1, Math.floor(x)));
    const iz = Math.max(b.minZ, Math.min(b.maxZ - 1, Math.floor(z)));
    const key = ((ix >> 3) << 16) | (iz >> 3);
    let ground = this.edgeGround.get(key);
    if (ground != null) return ground;
    ground = this.sources.ground + 24;
    if (this.getBlock) {
      let y = this.sources.height - 1;
      while (y > 0 && this.getBlock(ix, y, iz) === 0) y--;
      if (y > 0) ground = y + 1;
    }
    this.edgeGround.set(key, ground);
    return ground;
  }

  /**
   * A point just beyond the map edge, before the horizon ring rises: mostly
   * behind the two HQ lines (west and east, where each side's guns stand),
   * sometimes beyond the north and south rims.
   */
  artilleryPoint() {
    const b = this.sources.bounds;
    if (!b) return null;
    const side = this.rng();
    const beyond = ARTILLERY_BEYOND[0] + (ARTILLERY_BEYOND[1] - ARTILLERY_BEYOND[0]) * this.rng();
    const along = 0.1 + 0.8 * this.rng();
    let x, z;
    if (side < 0.35) { x = b.minX - beyond; z = b.minZ + (b.maxZ - b.minZ) * along; }
    else if (side < 0.7) { x = b.maxX + beyond; z = b.minZ + (b.maxZ - b.minZ) * along; }
    else if (side < 0.85) { z = b.minZ - beyond; x = b.minX + (b.maxX - b.minX) * along; }
    else { z = b.maxZ + beyond; x = b.minX + (b.maxX - b.minX) * along; }
    return { x, y: this.rimGround(x, z) + 6 + this.rng() * 18, z };
  }

  update(dt = 0, _camera = null) {
    if (this.disposed || !this.fx) return;
    const started = typeof performance !== 'undefined' ? performance.now() : 0;
    const step = Math.max(0, Math.min(0.25, Number(dt) || 0));
    this.elapsed += step;
    this.salvoIn -= step;
    if (this.salvoIn <= 0) {
      this.salvoIn = this.nextInterval();
      if (this.rng() < this.look.flashes) {
        const shots = 1 + Math.floor(this.rng() * 3);
        const origin = this.artilleryPoint();
        for (let i = 0; origin && i < shots; i++) {
          this.pending.push({ at: this.elapsed + i * (0.18 + this.rng() * 0.3),
            pos: [origin.x + (this.rng() - 0.5) * 50, origin.y + (this.rng() - 0.5) * 6, origin.z + (this.rng() - 0.5) * 50] });
        }
      }
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const flash = this.pending[i];
      if (flash.at > this.elapsed) continue;
      this.pending.splice(i, 1);
      // Distant gun flash: big, short and over-bright (it blooms on HDR tiers),
      // then a slow grey burst cloud.
      this.fx.emit('muzzle', flash.pos, { count: 2, scale: 15, life: 4, color: this.look.flash, source: 'artillery' });
      this.fx.emit('smoke', flash.pos, { count: 3, scale: 4.5, life: 1.6, speed: 1.5, spread: 1.2,
        alpha: 0.55, color0: this.look.flashSmoke, color1: this.look.flashSmoke, source: 'artillery' });
      this.flashes++;
    }
    if (started) this.lastUpdateMs = performance.now() - started;
  }

  /**
   * Expected steady-state live particles for this ambience given the field's
   * preset lifetimes (`presets` = FX_PRESETS), plus the salvo worst case.
   */
  particleLoad(presets) {
    let total = 0;
    for (const { recipe } of this.emitters) total += steadyParticles(recipe, presets[recipe.kind].life);
    // One salvo of three shots: 2 flash + 3 smoke particles each, smoke living up to 4.2 x 1.6 s.
    const salvo = 3 * (2 + 3);
    return Math.ceil(total + salvo * Math.ceil((presets.smoke.life[1] * 1.6) / ARTILLERY_INTERVAL[0]));
  }

  get stats() {
    return { chimneys: this.sources.chimneys.length, wrecks: this.sources.wrecks.length, emitters: this.emitters.length,
      flashes: this.flashes, pending: this.pending.length, lastUpdateMs: this.lastUpdateMs, draws: 0 };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { handle } of this.emitters) this.fx?.removeEmitter(handle);
    this.emitters.length = 0;
    this.pending.length = 0;
    this.edgeGround.clear();
  }
}
