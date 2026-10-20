/**
 * Conquest Support bots and the mortar (shared/mortar-rules.js
 * MORTAR_BOT_RULES). A Support bot that deployed with the MORTAR gadget
 * (BotCommander.gadgetFor) checks for a fire mission every `checkMs` while on
 * foot and out of a fight: spotted enemies clustered on a flag that is being
 * fought over, in range from where he stands, and he himself outside every
 * contested flag zone (so the tube goes down behind the line). He then places
 * the mortar through the same `mortar` intent a human sends, or walks back to
 * his own mortar when it still stands nearby. Only a point the tube stands
 * behind (own side of it on the HQ-to-HQ axis) is a mission, so the mortar
 * goes down behind the own line, never out in front of the fight.
 *
 * Seated, he lays the tube with the same high-arc solution the HUD shows
 * (mortarAim), fires once the mount has slewed onto it and walks the rounds
 * in. He gets out when the mission dries up for `idleExitMs`, when an enemy
 * closes in or when the mortar is hit. think() returns null whenever he has
 * nothing to do with a mortar, so the rest of the brain runs untouched.
 */
import { MORTAR_BOT_RULES, MORTAR_RULES, mortarAim } from '../shared/mortar-rules.js';
import { kitDeployable } from '../shared/conquest-kits.js';
import { VEHICLE_DEFS } from '../shared/vehicle-defs.js';
import { vehicleEnterDistance } from '../shared/vehicles.js';
import { homeAxis, playerSpotted, readConquestView } from './bot-commander.js';

const R = MORTAR_BOT_RULES;
const TYPE = MORTAR_RULES.type;
const TUBE = VEHICLE_DEFS[TYPE].mounts[MORTAR_RULES.mount];
const LIGHT_TARGETS = new Set(['jeep', 'jeep_at', TYPE]);
const ACTIVE_FLAG_STATES = new Set(['contested', 'capturing', 'neutralizing']);
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class ConquestMortarBots {
  constructor(game, bots) { this.game = game; this.bots = bots; this.state = new Map(); }
  active() { return this.game.mode?.mode === 'conquest' && !!this.game.vehicles?.mortars; }
  clear() { this.state.clear(); }
  release(id) { this.state.delete(String(id)); }
  teamOf(p) { return this.game.mode?.teamFor?.(p) ?? p?.team ?? null; }
  _state(br) {
    let s = this.state.get(br.id);
    if (!s) this.state.set(br.id, s = { checkAt: 0, retargetAt: 0, target: null, offset: [0, 0], spread: R.spreadStart, shots: -1, idleSince: 0, hp: null });
    return s;
  }

  /** Whether this bot deployed as a Support carrying the mortar. */
  carriesMortar(p) {
    const roles = this.game.mode?.policy?.roles;
    return !!roles && kitDeployable(roles.kitOf?.(p) ?? 'assault', roles.gadgetOf?.(p) ?? 0) === TYPE;
  }

  /**
   * The best fire mission for `team` from `origin`: the densest group of
   * spotted enemies (infantry, crews and light hulls) near a fought-over flag,
   * between R.minRange and R.maxRange flat metres. { point:[x,y,z], count } or null.
   */
  mission(origin, team, now = this.game.now) {
    const view = readConquestView(this.game);
    const flags = view.flags.filter(f => ACTIVE_FLAG_STATES.has(f.state) && Number.isFinite(f.x));
    if (!flags.length) return null;
    // Behind the line: the tube no farther toward the enemy HQ than the point (R.behindSlack m).
    const axis = homeAxis(view.bases), length = axis ? Math.hypot(axis.b.x - axis.a.x, axis.b.z - axis.a.z) : 0;
    const sign = team === 'bravo' ? -1 : 1;
    const behind = point => !axis || sign * (axis.t(origin) - axis.t(point)) * length <= R.behindSlack;
    const near = o => flags.some(f => flat(o, f) <= (f.radius ?? 20) + R.flagSlack);
    const enemies = [], friends = [];
    for (const o of this.game.entities.values()) {
      if (o.state !== 'alive') continue;
      const hull = o.vehicleId ? this.game.vehicles.vehicles.get(o.vehicleId) : null;
      if (this.teamOf(o) === team) { if (!hull) friends.push(o); continue; }
      if (hull && !LIGHT_TARGETS.has(hull.type)) continue;
      if (!hull && !playerSpotted(this.game, o)) continue;
      if (hull && !(hull.spotted?.[team] > now) && !playerSpotted(this.game, o)) continue;
      const at = hull ?? o;
      if (near(at)) enemies.push({ x: at.x, y: at.y, z: at.z });
    }
    for (const v of this.game.vehicles.vehicles.values()) {
      if (!(v.hp > 0) || !v.team || v.team === team || !LIGHT_TARGETS.has(v.type) || !(v.spotted?.[team] > now) || !near(v)) continue;
      if (!enemies.some(e => Math.hypot(e.x - v.x, e.z - v.z) < 1)) enemies.push({ x: v.x, y: v.y, z: v.z });
    }
    let best = null;
    for (const e of enemies) {
      const members = enemies.filter(o => flat(o, e) <= R.clusterRadius);
      if (members.length < R.minCluster) continue;
      const point = { x: 0, y: 0, z: 0 };
      for (const m of members) { point.x += m.x / members.length; point.y += m.y / members.length; point.z += m.z / members.length; }
      const range = flat(point, origin);
      if (range < R.minRange || range > R.maxRange || !behind(point)) continue;
      // Never onto own soldiers: as many mates as enemies at the point drop it.
      if (friends.filter(f => flat(f, point) <= MORTAR_RULES.snapRadius / 6).length >= members.length) continue;
      if (!best || members.length > best.count || (members.length === best.count && range < best.range)) best = { point: [point.x, point.y, point.z], count: members.length, range };
    }
    return best;
  }

  /** Inside the zone of a flag that is being fought over (no mortar goes down there). */
  inFight(p) {
    return readConquestView(this.game).flags.some(f => ACTIVE_FLAG_STATES.has(f.state) && flat(p, f) <= (f.radius ?? 20) + 4);
  }

  think(br, p, goal, now, dtS, inp) {
    if (!this.active() || p.state !== 'alive') return null;
    const vehicles = this.game.vehicles;
    const v = p.vehicleId ? vehicles.vehicles.get(p.vehicleId) : null;
    if (v) return v.type === TYPE ? this.operate(br, p, v, now, inp) : null;
    if (!this.carriesMortar(p) || br.enemyId || goal?.support || goal?.kind === 'board' || !p.grounded) return null;
    const s = this._state(br), team = this.teamOf(p);
    // Walk back to an own mortar that still stands nearby, while it has a mission.
    const own = vehicles.mortars.mortarOf(p.id);
    if (own && !own.seatOccupants?.[MORTAR_RULES.seat] && flat(p, own) <= R.boardRange && s.boardMission > now) {
      const enter = flat(p, own) <= vehicleEnterDistance(TYPE) - 0.4 ? { type: 'enter', vehicleId: own.id, seatId: MORTAR_RULES.seat } : null;
      return { board: { vehicleId: own.id, point: { x: own.x, y: own.y, z: own.z }, arrive: 1.2, enter } };
    }
    if (now < s.checkAt) return null;
    s.checkAt = now + R.checkMs;
    if (this.inFight(p)) return null;
    // A mission for the own mortar when it stands within reach, else for one placed here.
    const near = own && flat(p, own) <= R.boardRange ? own : null;
    const mission = this.mission(near ?? p, team, now);
    if (!mission) return null;
    if (near) { s.boardMission = now + R.checkMs * 2; return null; }
    if (br.rng() >= R.deployChance) return null;
    if (this.game.mode.conquestIntent?.(p, { type: 'mortar' }) !== true) return null;
    const placed = vehicles.vehicles.get(p.vehicleId);
    if (!placed) return null;
    Object.assign(s, { target: mission.point, retargetAt: now + R.retargetMs, spread: R.spreadStart, shots: -1, idleSince: now, hp: placed.hp });
    this.roll(br, s);
    return this.operate(br, p, placed, now, inp);
  }

  /** A fresh random miss for the next round, within the current spread. */
  roll(br, s) {
    const a = br.rng() * Math.PI * 2, r = Math.sqrt(br.rng()) * s.spread;
    s.offset = [Math.cos(a) * r, Math.sin(a) * r];
  }

  /** Seated at a mortar: lay, fire, walk the rounds in, get out when done or threatened. */
  operate(br, p, v, now, inp) {
    const s = this._state(br), team = this.teamOf(p), seatId = MORTAR_RULES.seat;
    const leave = () => {
      // Out, and no straight walk back in: the next mission check waits a while.
      // The hull and tube readings go too, so a later return to this (damaged)
      // mortar starts from its hit points then, not an old reading.
      inp.vehicleAction = { type: 'exit' }; br.intendsMove = false;
      Object.assign(s, { target: null, boardMission: 0, checkAt: now + R.checkMs * 4, hp: null, shots: -1 });
      return { vehicle: v, seatId, weapon: false };
    };
    inp.keys = { ...inp.keys, f: false, b: false, l: false, r: false, jump: false, sprint: false };
    inp.wantFire = false;
    if (s.hp == null) s.hp = v.hp;
    if (v.hp < s.hp - 0.5) return leave();
    s.hp = v.hp;
    for (const o of this.game.entities.values()) {
      if (o.state === 'alive' && this.teamOf(o) !== team && !o.vehicleId && Math.hypot(o.x - p.x, o.z - p.z) <= R.threatRadius) return leave();
    }
    if (now >= s.retargetAt || !s.target) {
      s.retargetAt = now + R.retargetMs;
      const mission = this.mission(v, team, now);
      if (mission) {
        if (!s.target || Math.hypot(mission.point[0] - s.target[0], mission.point[2] - s.target[2]) > R.clusterRadius) {
          s.spread = R.spreadStart; this.roll(br, s);
        }
        s.target = mission.point; s.idleSince = now;
      } else s.target = null;
    }
    if (!s.target) return now - s.idleSince > R.idleExitMs ? leave() : { vehicle: v, seatId, weapon: false };
    const aimPoint = [s.target[0] + s.offset[0], s.target[1], s.target[2] + s.offset[1]];
    const solution = mortarAim(v, TUBE, aimPoint);
    if (!Number.isFinite(solution?.pitch)) { s.target = null; return { vehicle: v, seatId, weapon: false }; }
    inp.yaw = solution.yaw; inp.pitch = solution.pitch;
    const tube = this.game.vehicles.mounts.state(v, MORTAR_RULES.mount);
    if (!tube) return { vehicle: v, seatId, weapon: false };
    if (s.shots < 0) s.shots = tube.shots;
    if (tube.shots !== s.shots) {
      // A round left the tube: the next one lands closer.
      s.shots = tube.shots;
      s.spread = Math.max(R.spreadMin, s.spread * R.spreadShrink);
      this.roll(br, s);
    }
    const laid = Math.abs(wrap(solution.yaw - tube.yaw)) <= R.aimTolerance && Math.abs(solution.pitch - tube.pitch) <= R.aimTolerance;
    inp.wantFire = laid && tube.cooldown <= 0 && !(tube.reloadT > 0) && tube.ammo !== 0;
    br.intendsMove = false;
    return { vehicle: v, seatId, weapon: false };
  }
}
