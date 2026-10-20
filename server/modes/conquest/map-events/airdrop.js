// Supply airdrop, the server half (docs/conquest.md "Map events" > "Supply
// airdrop"; data and the shared pose in shared/map-events/airdrop.js).
//
// The controller keeps its own seeded schedule: the first drop about three
// minutes in, then one every four to six minutes (trigger to trigger). At
// each drop it picks the landing cell (open ground between two flags of
// different owners, a walk node of the bots' surface graph), publishes it as
// the event's runtime anchor and triggers through the director. The warning
// is the transport's run-in and the canopy's sink; at `active` the crate is a
// runtime interaction point. The first completed hold pays `use` and arms the
// claimer with the power weapon for that life (gone at the next loadout:
// respawn or revive); the crate then goes, as it does unclaimed after
// `activeMs`. A spent power weapon leaves the owned list.
import { WEAPON_IDS } from '../../../../shared/combatmath.js';
import { kitLoadout } from '../../../../shared/conquest-kits.js';
import { worldDimensions } from '../../../../shared/world/dimensions.js';
import { FLUID_BLOCKS, RAM_CLASS, isSolidBlock } from '../../../../shared/world/blocks.js';
import { AIRDROP_TUNING, airdropBetween, airdropFlagPairs, airdropRandom } from '../../../../shared/map-events/airdrop.js';
import { surfaceNavigation } from '../../../bot-surface-nav.js';
import { switchWeapon } from '../../../sim/combat.js';
import { MapEventController } from './controller.js';

const TEAMS = ['alpha', 'bravo'];
/** Surface graph node flags (server/bot-surface-nav.js F_WALK, F_WATER). */
const NAV_WALK = 1, NAV_WATER = 2;
const SEED_SALT = 0xa1d7;

/** Fresh seed off the platform CSPRNG, so drawing one never shifts a seeded Math.random. */
function freshSeed() {
  try { return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]; } catch { return (Date.now() ^ SEED_SALT) >>> 0; }
}

export class AirdropController extends MapEventController {
  get rules() { return this.def.tuning ?? AIRDROP_TUNING; }
  get policy() { return this.system.policy; }
  get world() { return this.system.engine?.world ?? null; }

  onReset() {
    // The match seed: off the weather's (drawn just before at the same round start) unless a test pins one.
    const weatherSeed = this.policy?.weather?.seed;
    this.reseed(Number.isFinite(weatherSeed) ? (weatherSeed ^ SEED_SALT) >>> 0 : freshSeed());
    this.holders = new Map();   // entity id -> weapon slot of a granted power weapon
    this.spot = null;
    this.stats = { drops: 0, claims: 0, expired: 0, pickMs: 0 };
  }

  /** Start the schedule over from `seed` (round start; tests). */
  reseed(seed) {
    this.seed = seed >>> 0;
    this.rng = airdropRandom(this.seed);
    this.nextAt = this.system.now + airdropBetween(this.rng, this.rules.firstMs);
  }

  onTick(now) {
    this._sweepHolders();
    if (this.event.phase !== 'idle' || now < this.nextAt) return;
    this.drop(now);
  }

  /** Pick the landing cell and set the drop off (the schedule's next slot is booked at once). */
  drop(now = this.system.now) {
    const t0 = performance.now();
    const spot = this.pickSpot();
    this.stats.pickMs = Math.max(this.stats.pickMs, performance.now() - t0);
    if (!spot || !this.event.def.repeat || this.event.phase !== 'idle') { this.nextAt = now + this.rules.retryMs; return false; }
    this.spot = spot;
    this.event.anchor = { x: spot.x, y: spot.y, z: spot.z };
    this.heading = Math.floor(this.rng() * (360 / this.rules.headingStepDeg));
    if (!this.event.trigger({ team: null, by: null, data: { flags: spot.flags } })) {
      this.event.anchor = null; this.spot = null;
      this.nextAt = now + this.rules.retryMs;
      return false;
    }
    this.stats.drops++;
    this.nextAt = now + airdropBetween(this.rng, this.rules.intervalMs);
    return true;
  }

  onPhase(phase) {
    if (phase === 'active' && this.spot) {
      const r = this.rules;
      this.system.points.add(this.event, { id: 'crate', x: this.spot.x, y: this.spot.y, z: this.spot.z, radius: r.claimRadius,
        holdMs: r.claimMs, teams: 'any', verb: 'Claim crate', glyph: 'event-crate' });
    }
    if (phase === 'cooldown' || phase === 'done' || phase === 'idle') {
      this.system.points.remove(this.event, 'crate');
      this.event.anchor = null;
      this.spot = null;
    }
  }

  onTimer(phase) {
    if (phase !== 'active') return false;
    this.stats.expired++;
    this.event.team = null;
    this.event.finish({ reason: 'expired' });
    return true;
  }

  onUse(point, entity, team) {
    if (point.id !== 'crate' || this.event.phase !== 'active' || !entity) return;
    this.grant(entity);
    this.system.award(entity.id, 'use');
    this.stats.claims++;
    this.event.team = team;
    this.event.by = String(entity.id);
    this.event.finish({ reason: 'claimed', data: { weapon: this.rules.weapon.id } });
  }

  /**
   * Arm `entity` with the power weapon for this life and refill its kit:
   * every kit weapon's magazine and reserve and every pouch slot up to the
   * kit issue (never below what it carries), a spent medkit re-armed. A bot
   * raises the weapon at once; a human's client raises it with the gadget key.
   */
  grant(entity) {
    const roles = this.policy?.roles;
    const load = kitLoadout(roles?.kitOf?.(entity) ?? 'assault', roles?.variantOf?.(entity) ?? 0, roles?.gadgetOf?.(entity) ?? 0);
    const W = this.rules.weapon, slot = WEAPON_IDS.indexOf(W.id);
    if (slot < 0) return false;
    for (const id of load.owned) {
      const s = WEAPON_IDS.indexOf(id);
      if (s < 0 || !Array.isArray(entity.mag) || !Array.isArray(entity.reserve)) continue;
      entity.mag[s] = Math.max(entity.mag[s] | 0, load.mag[s]);
      entity.reserve[s] = Math.max(entity.reserve[s] | 0, load.reserve[s]);
    }
    if (Array.isArray(entity.grenades)) load.grenades.forEach((n, i) => { entity.grenades[i] = Math.max(entity.grenades[i] | 0, n); });
    if (entity.medkit && typeof entity.medkit === 'object' && !entity.medkit.active) entity.medkit.remaining = Math.max(1, entity.medkit.remaining | 0);
    // The power weapon goes first in the owned list: the kit's gadget key (3) raises it (kitDigitWeapon).
    const owned = Array.isArray(entity.owned) ? entity.owned.filter(id => id !== W.id) : load.owned.slice();
    entity.owned = [W.id, ...owned];
    if (Array.isArray(entity.mag)) entity.mag[slot] = W.mag;
    if (Array.isArray(entity.reserve)) entity.reserve[slot] = W.reserve;
    this.holders.set(String(entity.id), slot);
    if (entity.bot && !entity.vehicleId) switchWeapon(entity, slot);
    return true;
  }

  /** Drop spent or lost power weapons: a new loadout replaced the owned list, or both magazine and reserve are empty. */
  _sweepHolders() {
    if (!this.holders?.size) return;
    const id = this.rules.weapon.id;
    for (const [key, slot] of this.holders) {
      const p = this.system.entity(key);
      if (!p || !Array.isArray(p.owned) || !p.owned.includes(id)) { this.holders.delete(key); continue; }
      if ((p.mag?.[slot] | 0) > 0 || (p.reserve?.[slot] | 0) > 0 || p.reloading) continue;
      p.owned = p.owned.filter(w => w !== id);
      this.holders.delete(key);
      if (p.weapon === slot) {
        const primary = WEAPON_IDS.indexOf(p.owned[0]);
        if (primary >= 0) switchWeapon(p, primary);
      }
    }
  }

  wireExtra() {
    return this.spot && (this.event.phase === 'warning' || this.event.phase === 'active' || this.event.phase === 'armed') ? [this.heading | 0] : null;
  }

  /* ------------------------------------------------------------ landing spot */

  /**
   * The landing cell {x, y, z, flags} or null: a seeded point between a pair
   * of fronting flags, then the nearest seeded cell around it that passes
   * `openCell` (AIRDROP_TUNING.spot).
   */
  pickSpot() {
    const world = this.world, policy = this.policy;
    if (!world || !policy) return null;
    const S = this.rules.spot, rng = this.rng;
    const capture = policy.capture;
    const flags = capture?.flags ?? [];
    let pairs = airdropFlagPairs(flags, { pairMaxM: S.pairMaxM, locked: capture?.locked ?? null });
    // One side holding every open flag: drop between its two flags nearest the enemy's HQ.
    if (!pairs.length) {
      const open = flags.filter(f => !capture?.locked?.(f));
      pairs = open.length >= 2 ? [{ a: open[0], b: open[1], d: 0 }] : [];
    }
    if (!pairs.length) return null;
    const pair = pairs[Math.floor(rng() * Math.min(S.pairPick, pairs.length))];
    const t = airdropBetween(rng, S.lerp), side = (rng() * 2 - 1) * S.sideM;
    const dx = pair.b.x - pair.a.x, dz = pair.b.z - pair.a.z, len = Math.hypot(dx, dz) || 1;
    const base = { x: pair.a.x + dx * t - (dz / len) * side, z: pair.a.z + dz * t + (dx / len) * side };
    const nav = surfaceNavigation(world);
    const want = nav ? new Set([pair.a, pair.b].map(f => nav.component[nav.nodeAt({ x: f.x, y: f.y, z: f.z })]).filter(c => c >= 0)) : null;
    // Seeded candidates around the base point; the nearest passing one wins (the base point itself first).
    const cells = [{ x: base.x, z: base.z, d: 0 }];
    for (let i = 0; i < S.tries; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * S.searchM;
      cells.push({ x: base.x + Math.cos(a) * r, z: base.z + Math.sin(a) * r, d: r });
    }
    cells.sort((p, q) => p.d - q.d);
    for (const c of cells) {
      const spot = this.openCell(Math.floor(c.x), Math.floor(c.z), nav, want);
      if (spot) return { ...spot, flags: [pair.a.id, pair.b.id] };
    }
    return null;
  }

  /**
   * Feet y of the open-sky standing surface of a column, or null: water, or a
   * built or grown block first (RAM_CLASS: foliage, glass, planks, siding,
   * masonry, so no canopy, roof or wall top). Non-solid props are looked through.
   */
  skyGround(x, z) {
    const world = this.world, { sx, sy, sz } = worldDimensions(world);
    if (x < 0 || z < 0 || x >= sx || z >= sz) return null;
    for (let y = sy - 1; y > 0; y--) {
      const block = world.getBlock(x, y, z);
      if (!block) continue;
      if (FLUID_BLOCKS.has(block)) return null;
      if (!isSolidBlock(block)) continue;
      return RAM_CLASS[block] ? null : y + 1;
    }
    return null;
  }

  /** {x, y, z} at the centre of cell (x, z) when it is valid open ground for a crate, else null. */
  openCell(x, z, nav = null, components = null) {
    const S = this.rules.spot, meta = this.policy?.mapMeta?.conquest ?? {};
    const area = meta.combatArea;
    const cx = x + 0.5, cz = z + 0.5;
    if (area && (cx < area.minX + S.edgeM || cx > area.maxX - S.edgeM || cz < area.minZ + S.edgeM || cz > area.maxZ - S.edgeM)) return null;
    for (const base of Object.values(meta.bases ?? {})) {
      if (base && Math.hypot(cx - base.x, cz - base.z) < (base.radius ?? 0) + S.hqClearM) return null;
    }
    for (const flag of this.policy?.capture?.flags ?? []) {
      if (Math.hypot(cx - flag.x, cz - flag.z) < (flag.radius ?? 0) + S.flagClearM) return null;
    }
    const y = this.skyGround(x, z);
    if (y == null) return null;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const n = this.skyGround(x + dx, z + dz);
      if (n == null || Math.abs(n - y) > S.flatM) return null;
    }
    if (nav) {
      const node = nav.nodeAt({ x: cx, y, z: cz }, 1);
      if (node < 0 || !(nav.flags[node] & NAV_WALK) || (nav.flags[node] & NAV_WATER) || Math.abs(nav.height[node] - y) > 1) return null;
      if (components?.size && !components.has(nav.component[node])) return null;
    }
    return { x: cx, y: y + 0.02, z: cz };
  }

  /* ------------------------------------------------------------------- bots */

  /** Living, unseated soldiers of each team within `r` of a point. */
  _near(point, r) {
    const out = { alpha: 0, bravo: 0 };
    for (const p of this.system.engine?.entities?.values?.() ?? []) {
      if (!p || p.state !== 'alive' || Math.hypot(p.x - point.x, p.z - point.z) > r) continue;
      if (this.policy?.roles?.isDown?.(p) === true) continue;
      const team = this.policy?.teamFor?.(p);
      if (team in out) out[team]++;
    }
    return out;
  }

  /**
   * Both teams go for the crate: while it sinks the nearest free bots run to
   * the landing cell; once it is down one claims it with an escort, unless
   * the enemy outnumbers them there by `maxDeficit` (then the escort only
   * closes in); a crate the enemy is claiming is attacked first.
   */
  botTasks(team) {
    const spot = this.spot, phase = this.event.phase;
    if (!spot || (phase !== 'warning' && phase !== 'active')) return [];
    const B = this.rules.bots;
    const rival = TEAMS.find(t => t !== team);
    if (phase === 'warning') {
      return [this.areaTask('landing', spot, { kind: 'hold', radius: B.escortRadius, priority: B.landingPriority, squad: B.landingSquad, range: B.range })];
    }
    const point = this.point('crate');
    const tasks = [];
    if (point?.userTeam === rival) {
      tasks.push(this.areaTask('contest', spot, { kind: 'attack', radius: B.contestRadius, priority: B.contestPriority, squad: B.escortSquad, range: B.range }));
    }
    const near = this._near(spot, B.threatRadius);
    if (near[rival] - near[team] < B.maxDeficit) {
      const claim = this.useTask('crate', team, { priority: B.claimPriority, squad: 1, range: B.range });
      if (claim) tasks.push(claim);
    }
    tasks.push(this.areaTask('escort', spot, { kind: 'hold', radius: B.escortRadius, priority: B.landingPriority, squad: B.escortSquad, range: B.range }));
    return tasks;
  }
}
