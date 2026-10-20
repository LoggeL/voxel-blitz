/**
 * Conquest bots and the Engineer's FPV drone (shared/fpv-rules.js
 * FPV_BOT_RULES). An Engineer bot that deployed with the FPV gadget
 * (BotCommander.gadgetFor) looks for a target every `checkMs` while on foot
 * and out of a fight: an enemy armoured or crewed hull 60-300 m away, and,
 * rarely, a knot of enemies on a fought-over flag. It launches through the
 * same `fpv` intent a human sends and flies a plain path with the human
 * controls (look yaw / pitch, W, jump, crouch): climb to `cruise` m over the
 * target, close in, then dive onto its top. The charge fires on contact.
 * think() returns null whenever the bot has nothing to do with a drone, so
 * the rest of the brain runs untouched.
 *
 * Any bot shoots an enemy drone it sees within `shootRange` (`closeRange`
 * even mid-fight), switching to a gun first (shoot()).
 */
import { FPV_BOT_RULES, FPV_RULES } from '../shared/fpv-rules.js';
import { kitDeployable } from '../shared/conquest-kits.js';
import { vehicleDef } from '../shared/vehicle-defs.js';
import { vehicleSeats, vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { reconLineOpen } from '../shared/recon-gadgets.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { AIR } from '../shared/worlddata.js';
import { readConquestView } from './bot-commander.js';

const R = FPV_BOT_RULES;
const TYPE = FPV_RULES.type;
const ACTIVE_FLAG_STATES = new Set(['contested', 'capturing', 'neutralizing']);
const ARMOURED = new Set(['heavy', 'medium']);
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** Steering rates of the bot's look while flying (rad/s). */
const TURN_RATE = 2.4, PITCH_RATE = 2;

export class ConquestFpvBots {
  constructor(game, bots) {
    this.game = game; this.bots = bots; this.state = new Map();
    const world = game.world;
    this.solidAt = world ? (x, y, z) => world.getBlock(x, y, z) !== AIR : () => false;
  }
  get system() { return this.game.mode?.mode === 'conquest' ? this.game.vehicles?.fpv ?? null : null; }
  clear() { this.state.clear(); }
  release(id) { this.state.delete(String(id)); }
  teamOf(p) { return this.game.mode?.teamFor?.(p) ?? p?.team ?? null; }
  _state(br) {
    let s = this.state.get(br.id);
    if (!s) this.state.set(br.id, s = { checkAt: 0, target: null, point: null, phase: 'climb', slowSince: 0 });
    return s;
  }

  /** Whether this bot deployed as an Engineer carrying the drone. */
  carriesDrone(p) {
    const roles = this.game.mode?.policy?.roles;
    return !!roles && kitDeployable(roles.kitOf?.(p) ?? 'assault', roles.gadgetOf?.(p) ?? 0) === TYPE;
  }

  /** An enemy armoured or crewed hull in range (nearest first), or null. */
  hullTarget(p, team) {
    let best = null;
    for (const v of this.game.vehicles.vehicles.values()) {
      if (!(v.hp > 0) || v.padInactive || !v.team || v.team === team || v.type === TYPE) continue;
      const def = vehicleDef(v);
      if (!def || def.deployable) continue;
      const crewed = vehicleSeats(v).some(seat => vehicleSeatOccupantId(v, seat.id) != null);
      if (!crewed && !ARMOURED.has(def.armor)) continue;
      const d = flat(p, v);
      if (d < R.minRange || d > R.maxRange || (best && d >= best.d)) continue;
      best = { v, d };
    }
    return best?.v ?? null;
  }

  /** The centre of `minCluster`+ enemies on foot on a fought-over flag in range, or null. */
  clusterTarget(p, team) {
    const flags = readConquestView(this.game).flags.filter(f => ACTIVE_FLAG_STATES.has(f.state) && Number.isFinite(f.x));
    if (!flags.length) return null;
    const enemies = [];
    for (const o of this.game.entities.values()) {
      if (o.state !== 'alive' || o.vehicleId || this.teamOf(o) === team) continue;
      if (flags.some(f => flat(o, f) <= (f.radius ?? 20))) enemies.push(o);
    }
    for (const e of enemies) {
      const members = enemies.filter(o => flat(o, e) <= R.clusterRadius);
      if (members.length < R.minCluster) continue;
      const point = { x: 0, y: 0, z: 0 };
      for (const m of members) { point.x += m.x / members.length; point.y += (m.y + 1) / members.length; point.z += m.z / members.length; }
      const d = flat(point, p);
      if (d >= R.minRange && d <= R.maxRange) return point;
    }
    return null;
  }

  think(br, p, goal, now, dtS, inp) {
    const fpv = this.system;
    if (!fpv || p.state !== 'alive') return null;
    const flying = fpv.linkedDrone(p);
    if (flying) return this.fly(br, p, flying, now, dtS, inp);
    if (p.vehicleId || !this.carriesDrone(p) || br.enemyId || goal?.support || goal?.kind === 'board' || !p.grounded) return null;
    if (!(fpv.dronesLeft(p.id) > 0) || fpv.droneOf(p.id) || (fpv.readyAt.get(String(p.id)) ?? -Infinity) > fpv.now()) return null;
    const s = this._state(br);
    if (now < s.checkAt) return null;
    s.checkAt = now + R.checkMs;
    const team = this.teamOf(p);
    const hull = br.rng() < R.hullChance ? this.hullTarget(p, team) : null;
    const point = hull ? null : br.rng() < R.clusterChance ? this.clusterTarget(p, team) : null;
    if (!hull && !point) return null;
    if (this.game.mode.conquestIntent?.(p, { type: 'fpv' }) !== true) return null;
    const v = fpv.linkedDrone(p);
    if (!v) return null;
    Object.assign(s, { target: hull?.id ?? null, point: point ? { ...point } : hull ? { x: hull.x, y: hull.y + 1, z: hull.z } : null,
      phase: 'climb', slowSince: 0 });
    return this.fly(br, p, v, now, dtS, inp);
  }

  /** Flying: climb over the target, close in, dive on its top. The charge fires on contact. */
  fly(br, p, v, now, dtS, inp) {
    const s = this._state(br);
    inp.keys = { ...inp.keys, f: false, b: false, l: false, r: false, jump: false, crouch: false, sprint: false };
    inp.wantFire = false; inp.wantAds = false;
    br.intendsMove = false;
    const hull = s.target ? this.game.vehicles.vehicles.get(s.target) : null;
    if (hull?.hp > 0) s.point = { x: hull.x, y: hull.y + (vehicleDef(hull)?.height ?? 2) * 0.8, z: hull.z };
    const point = s.point ?? { x: v.x + Math.sin(-v.yaw) * 20, y: v.y - 30, z: v.z - Math.cos(v.yaw) * 20 };
    const dx = point.x - v.x, dz = point.z - v.z, d = Math.hypot(dx, dz), height = v.y - point.y;
    const bingo = v.batteryUntil - now < R.bingoMs;
    if (s.phase !== 'dive' && (bingo || d <= Math.max(6, height * R.diveRatio))) s.phase = 'dive';
    else if (s.phase === 'climb' && height >= R.cruise - 2) s.phase = 'approach';
    const yawT = Math.atan2(-dx, -dz);
    let pitchT = 0;
    if (s.phase === 'dive') {
      pitchT = Math.atan2(point.y - (v.y + 0.15), Math.max(0.1, d));
      inp.keys.f = true;
    } else {
      inp.keys.f = s.phase === 'approach' || d > R.cruise * 2;
      inp.keys.jump = height < R.cruise - 1;
      inp.keys.crouch = height > R.cruise + 3;
      pitchT = s.phase === 'climb' ? 0.2 : 0;
    }
    inp.yaw = v.yaw + Math.max(-TURN_RATE * dtS, Math.min(TURN_RATE * dtS, wrap(yawT - v.yaw)));
    const lim = FPV_RULES.flight.pitchLimit;
    inp.pitch = Math.max(-lim, Math.min(lim, v.lookPitch + Math.max(-PITCH_RATE * dtS, Math.min(PITCH_RATE * dtS, pitchT - v.lookPitch))));
    // Stuck against a wall or under a roof: fire the charge where it is.
    if (v.speed < 2 && now - v.launchedAt > 2500) {
      s.slowSince ||= now;
      if (now - s.slowSince > 2500) inp.wantFire = true;
    } else s.slowSince = 0;
    return { vehicle: v, seatId: null, weapon: false };
  }

  _eye(p) { return [p.eyeX ?? p.x, p.eyeY ?? p.y + 1.6, p.eyeZ ?? p.z]; }

  /** The nearest enemy drone in sight within reach (`closeRange` mid-fight), or null. */
  target(p, fighting) {
    const fpv = this.system;
    if (!fpv?.owned.size) return null;
    const team = this.teamOf(p), eye = this._eye(p);
    let best = null, bestD = fighting ? R.closeRange : R.shootRange;
    for (const v of fpv.live()) {
      if (v.team === team) continue;
      const c = [v.x, v.y + 0.15, v.z];
      const d = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
      if (d >= bestD || !reconLineOpen(this.solidAt, eye, c, 0.3)) continue;
      best = v; bestD = d;
    }
    return best;
  }

  /**
   * An enemy drone in sight: turn on it and shoot it with a gun (launchers
   * and the pick give way to a hitscan slot). Returns true while engaged; the
   * caller then holds the legs still.
   */
  shoot(br, p, inp, now, dtS, ownedSlots, turnRate, pitchTurnRate, fighting) {
    if (p.vehicleId) { br.droneTarget = null; return false; }
    const fpv = this.system;
    let v = br.droneTarget ? this.game.vehicles.vehicles.get(br.droneTarget) : null;
    if (!(v?.hp > 0) || now > (br.droneGiveUpAt ?? 0)) v = null;
    if (!v && now >= (br.droneScanAt ?? 0)) {
      br.droneScanAt = now + R.scanMs;
      v = fpv ? this.target(p, fighting) : null;
      if (v) br.droneGiveUpAt = now + R.giveUpMs;
    }
    br.droneTarget = v?.id ?? null;
    if (!v) return false;
    const def = WEAPONS[WEAPON_IDS[p.weapon]];
    const gun = slot => { const w = WEAPONS[WEAPON_IDS[slot]]; return w && w.mode !== 'melee' && !w.projectile && !w.flame && (p.mag[slot] > 0 || p.reserve[slot] > 0); };
    if (!gun(p.weapon)) {
      const slot = ownedSlots.find(gun);
      if (slot === undefined) { br.droneTarget = null; return false; }
      if (inp.switchTo === undefined) inp.switchTo = slot;
      return true;
    }
    const eye = this._eye(p);
    // Lead the frame by one tick of its flight.
    const c = [v.x + (v.vx || 0) * 0.05, v.y + 0.15 + (v.vy || 0) * 0.05, v.z + (v.vz || 0) * 0.05];
    const yawT = Math.atan2(-(c[0] - eye[0]), -(c[2] - eye[2]));
    const pitchT = Math.atan2(c[1] - eye[1], Math.hypot(c[0] - eye[0], c[2] - eye[2]));
    inp.yaw = br.aim.steer('yaw', p.yaw, yawT, turnRate, dtS);
    inp.pitch = br.aim.steer('pitch', p.pitch, pitchT, pitchTurnRate, dtS);
    const error = Math.hypot(wrap(inp.yaw - yawT), inp.pitch - pitchT);
    inp.wantAds = false;
    if (p.mag[p.weapon] === 0) { if (p.reserve[p.weapon] > 0) inp.reload = true; return true; }
    inp.wantFire = error < R.fireError && (def?.mode === 'auto' || !p.triggerPrev);
    return true;
  }
}
