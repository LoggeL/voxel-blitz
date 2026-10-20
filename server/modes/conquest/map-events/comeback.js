// Comeback call-in, the server half (docs/conquest.md "Comeback call-in";
// data and pure helpers in shared/map-events/comeback.js).
//
//   idle     the deficit watch: a side that meets the earning condition
//            (comebackTrailingTeam, or the Breakthrough rules) for
//            `sustainMs` in a row arms the event for itself (READY). Each
//            side earns it at most once a round.
//   armed    open until one of the side's squad leaders designates: the
//            `use` intent `comeback:call:<kind>:<x>:<z>` (the full map), or
//            after the humans' grace a bot leader through planComebackCall
//            (server/bot-comeback.js), checked once a second.
//   warning  the 5 s telegraph: the target rides `ev` as the runtime anchor
//            with [kind, heading]; an avoid-only hazard zone (no damage) over
//            the strike sends the target side's bots out of it.
//   active   the strike (`plan.activeMs`): real ProjectileSystem rounds,
//            jet bombs released along the line or mortar-type shells falling
//            on seeded points, launched so they land on the planned times.
//            Their blast numbers come from the tuning (no ground fire), their
//            kills credit the designator under `callinBomb` / `callinShell`.
//   cooldown -> idle, so the other side may still earn its own call-in.
//
// Voxel damage is the blasts' ordinary craters (block deltas, so joiners get
// them through the map cache); a rematch restores the world and resets this.
import { AIR } from '../../../../shared/world/blocks.js';
import { worldDimensions } from '../../../../shared/world/dimensions.js';
import { VEHICLE_WEAPON_META } from '../../../../shared/conquest-contract.js';
import {
  COMEBACK_TUNING, comebackBreakthroughTeams, comebackHeadingDeg, comebackKindCode, comebackStrikePlan, comebackTargetRefusal,
  comebackTrailingTeam, parseComebackCall,
} from '../../../../shared/map-events/comeback.js';
import { humanLeadsSquad, planComebackCall } from '../../../bot-comeback.js';
import { MapEventController } from './controller.js';

const TEAMS = ['alpha', 'bravo'];
/** Seconds between the bots' designation checks while READY. */
const BOT_CHECK_MS = 1000;
/** The caller's side follows the strike up on the target for this long after the first impact. */
const FOLLOW_UP_MS = 15000;

export class ComebackController extends MapEventController {
  get tuning() { return this.def.tuning ?? COMEBACK_TUNING; }
  get policy() { return this.system.policy; }
  get meta() { return this.policy?.mapMeta?.conquest ?? null; }

  onReset() {
    this.used = new Set();
    this.held = { alpha: 0, bravo: 0 };
    this.readyAt = null;
    this.strike = null;
    this.extra = null;
    this.nextBotCheck = 0;
    this.followUntil = 0; this.followAt = null; this.followTeam = null;
  }

  wireExtra() { return this.extra; }

  onTick(now, dt) {
    const ev = this.event;
    if (ev.phase === 'idle') this._watch(now, dt);
    else if (ev.phase === 'armed' && !ev.queued) this._botCall(now);
    if (this.strike) this._launch(now);
  }

  /** Sides meeting the earning condition now. */
  _earning() {
    const p = this.policy;
    if (this.system.variant === 'breakthrough') {
      const sectors = p.sectors?.length ?? 0;
      return comebackBreakthroughTeams({ attackers: p.attackerTeam, defenders: p.defenderTeam, tickets: p.tickets?.[p.attackerTeam],
        max: p.ledger?.max, sector: p.bt?.sector ?? 0, sectors, overtime: p.bt?.overtime === true }, this.tuning.breakthrough);
    }
    const team = comebackTrailingTeam(p.tickets, p.ledger?.max, this.tuning.earn);
    return team ? [team] : [];
  }

  _watch(now, dt) {
    const earning = this._earning();
    const sustain = this.system.variant === 'breakthrough' ? this.tuning.breakthrough.sustainMs : this.tuning.earn.sustainMs;
    for (const team of TEAMS) {
      if (this.used.has(team) || !earning.includes(team)) { this.held[team] = 0; continue; }
      this.held[team] += dt;
      if (this.held[team] < sustain || !this.system.director.mayFire(this.event)) continue;
      this.used.add(team);
      this.held = { alpha: 0, bravo: 0 };
      this.readyAt = now;
      this.nextBotCheck = 0;
      this.event.arm({ team, by: null, ms: null, reason: 'ready' });
      return;
    }
  }

  _botCall(now) {
    if (now < this.nextBotCheck) return;
    this.nextBotCheck = now + BOT_CHECK_MS;
    const team = this.event.team, d = this.tuning.designate;
    const wait = humanLeadsSquad(this.policy, team) ? d.humanGraceMs : d.botDelayMs;
    if (now - (this.readyAt ?? now) < wait) return;
    const pick = planComebackCall(this.policy, team, this.tuning);
    if (pick) this.designate(pick.by, pick.kind, pick.x, pick.z);
  }

  /** The `use` intent's own keys (MapEventSystem.intent): `call:<kind>:<x>:<z>`. */
  onIntent(entity, rest) {
    const call = parseComebackCall(rest);
    return call ? this.designate(entity, call.kind, call.x, call.z) : false;
  }

  /** Why `entity` may not designate now, or null. */
  refusal(entity, x, z) {
    const ev = this.event, p = this.policy;
    if (ev.phase !== 'armed' || ev.queued || !entity) return 'phase';
    if (p.teamFor(entity) !== ev.team) return 'team';
    if (p.squads?.map?.().get(String(entity.id))?.leaderId !== String(entity.id)) return 'leader';
    return comebackTargetRefusal(this.meta, x, z, this.tuning.designate);
  }

  /** A squad leader of the READY side calls the strike on (x, z). Returns true when accepted. */
  designate(entity, kind, x, z) {
    if (this.refusal(entity, x, z) || (kind !== 'bomber' && kind !== 'artillery')) return false;
    const ev = this.event, team = ev.team, now = this.system.now;
    const target = { x: Math.round(x), z: Math.round(z) };
    const headingDeg = comebackHeadingDeg(this.meta, team, target);
    const seed = (Math.round(now) ^ Math.imul(target.x, 73856093) ^ Math.imul(target.z, 19349663)) >>> 0;
    const plan = comebackStrikePlan({ kind, target, headingDeg, seed, tuning: this.tuning });
    const warnMs = this.def.durations.warningMs ?? 0;
    const startAt = now + warnMs;
    const by = String(entity.id);
    ev.anchor = { x: target.x, y: this._ground(target.x, target.z), z: target.z };
    this.extra = [comebackKindCode(kind), headingDeg];
    this.strike = { kind, plan, startAt, team, by, shots: this._shots(kind, plan, startAt, ev.anchor.y), fired: 0, lost: 0,
      salvo: `comeback:${this.event.fires}:${Math.round(now)}` };
    if (!ev.trigger({ team, by, data: { kind, heading: headingDeg } })) { this.strike = null; this.extra = null; ev.anchor = null; return false; }
    // Avoid-only (no damage): the target side's bots leave the strike zone from the telegraph on.
    this.system.hazards.add(ev, { kind: 'fire', ...plan.zone, dps: 0, by, from: now, until: startAt + plan.activeMs, avoid: true });
    this.system.award(by, 'use');
    return true;
  }

  /** Feet height of the highest non-air cell of a column (where a round would burst), or 0. */
  _ground(x, z) {
    const world = this.system.engine?.world;
    if (!world) return 0;
    const xi = Math.floor(x), zi = Math.floor(z);
    for (let y = worldDimensions(world).sy - 1; y > 0; y--) if (world.getBlock(xi, y, zi) !== AIR) return y + 1;
    return 0;
  }

  /**
   * Each round's launch: when, where from and with what velocity, so it
   * lands on its planned point at its planned time (the bombs' fall and the
   * shells' arcs integrate with their weapon's gravity).
   */
  _shots(kind, plan, startAt, targetY) {
    const t = kind === 'bomber' ? this.tuning.bomber : this.tuning.artillery;
    const g = VEHICLE_WEAPON_META[t.weapon]?.gravity ?? 9.8;
    return plan.drops.map(drop => {
      const gy = this._ground(drop.x, drop.z);
      const impactAt = startAt + drop.atMs;
      if (kind === 'bomber') {
        const releaseY = targetY + t.altitude, fall = Math.sqrt(2 * Math.max(4, releaseY - gy) / g);
        const back = t.speed * fall;
        return { launchAt: impactAt - fall * 1000, impactAt, origin: [drop.x - plan.dir.x * back, releaseY, drop.z - plan.dir.z * back],
          velocity: [plan.dir.x * t.speed, 0, plan.dir.z * t.speed], done: false };
      }
      const T = t.flightMs / 1000;
      const origin = [drop.x - plan.dir.x * t.backM, gy + t.riseM, drop.z - plan.dir.z * t.backM];
      const velocity = [(drop.x - origin[0]) / T, (gy - origin[1]) / T + 0.5 * g * T, (drop.z - origin[2]) / T];
      return { launchAt: impactAt - t.flightMs, impactAt, origin, velocity, done: false };
    });
  }

  /** The player credited with the strike: the designator, else (left the match) any member of the side. */
  _owner() {
    const s = this.strike;
    let owner = this.system.entity(s.by);
    if (!owner) {
      const pool = [...(this.system.engine?.combatants?.values?.() ?? [])].filter(e => this.policy.teamFor(e) === s.team);
      owner = pool.find(e => e.state === 'alive') ?? pool[0] ?? null;
      if (owner) s.by = String(owner.id);
    }
    return owner;
  }

  _launch(now) {
    const s = this.strike, engine = this.system.engine;
    const t = s.kind === 'bomber' ? this.tuning.bomber : this.tuning.artillery;
    for (const shot of s.shots) {
      if (shot.done || now < shot.launchAt) continue;
      shot.done = true;
      const owner = this._owner();
      const ctx = engine?.vehicles?.projectileContext?.();
      const speed = Math.hypot(...shot.velocity);
      const dir = speed > 1e-6 ? shot.velocity.map(v => v / speed) : [0, -1, 0];
      const round = owner && ctx ? engine.projectiles?.launchVehicleProjectile?.(owner,
        { weapon: t.weapon, origin: shot.origin, dir, velocity: shot.velocity, vehicleId: null }, ctx) : null;
      if (!round) { s.lost++; continue; }
      // The call-in's own blast and kill key (the jet bomb's ground fire stays off).
      round.weaponKey = t.killKey;
      round.salvo = s.salvo;
      round.blastRules = Object.freeze({ ...round.blastRules, ...t.blast, knockbackRadius: t.blast.damageRadius, burn: null });
      s.fired++;
    }
    if (s.shots.every(shot => shot.done) && this.event.phase !== 'warning' && this.event.phase !== 'active') this.strike = null;
  }

  /** The telegraph ran out: the strike phase lasts its plan. */
  onTimer(phase) {
    if (phase === 'warning' && this.strike) { this.event.setPhase('active', { ms: Math.max(0, this.strike.startAt + this.strike.plan.activeMs - this.system.now) }); return true; }
    return false;
  }

  onPhase(phase) {
    if (phase === 'cooldown' || phase === 'done' || phase === 'idle') {
      this.event.anchor = null;
      this.extra = null;
      this.system.hazards.clear(this.event);
      this.followUntil = this.strike ? this.strike.startAt + FOLLOW_UP_MS : this.followUntil;
      this.followAt = this.strike ? { ...this.strike.plan.drops[Math.floor(this.strike.plan.drops.length / 2)] } : this.followAt;
      this.followTeam = this.strike?.team ?? this.followTeam;
      if (this.strike && this.strike.shots.every(shot => shot.done)) this.strike = null;
    }
  }

  /** The caller's side closes on the target as the strike lands (an attack task for a few nearby bots). */
  botTasks(team) {
    const now = this.system.now;
    const live = this.strike && (this.event.phase === 'active' || this.event.phase === 'warning') ? this.strike : null;
    const at = live ? live.plan.drops[Math.floor(live.plan.drops.length / 2)] : (now < (this.followUntil ?? 0) ? this.followAt : null);
    const owner = live ? live.team : this.followTeam;
    if (!at || team !== owner || (live && now < live.startAt)) return [];
    const y = this.event.anchor?.y ?? this._ground(at.x, at.z);
    return [this.areaTask('follow-up', { x: at.x, y, z: at.z }, { kind: 'attack', radius: 10, priority: 2, squad: 3 })];
  }
}
