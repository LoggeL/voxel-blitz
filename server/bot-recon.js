// Conquest bots and the Recon gadgets (docs/conquest.md "Recon gadgets"):
// a Recon bot lays its SPAWN BEACON on quiet ground short of the flag it
// assaults and throws MOTION SENSORS at a flag it fights over, through the
// human throw path (a `throwGrenade` edge with the pouch slot). Any bot with
// no enemy in sight shoots an enemy beacon or sensor it can see. Tuning lives
// in RECON_GADGET_RULES (shared/recon-gadgets.js).

import { GRENADE_TYPE_IDS, grenadeLaunch, stepGrenade } from '../shared/grenade-rules.js';
import { RECON_GADGET_RULES, reconGadgetCenter, reconLineOpen } from '../shared/recon-gadgets.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { AIR } from '../shared/worlddata.js';

const BEACON_SLOT = GRENADE_TYPE_IDS.indexOf('beacon');
const SENSOR_SLOT = GRENADE_TYPE_IDS.indexOf('sensor');
/** A flag already watched by an own sensor this close (m) gets no second one. */
const SENSOR_SPACING = 14;
/** Throw candidates searched for a sensor: charges and pitches (rad). */
const SENSOR_CHARGES = [0, 0.5, 1];
const SENSOR_PITCHES = [0.05, 0.2, 0.35, 0.5, 0.7];
/** A gadget target is looked for this often, and given up after this long. */
const GADGET_SCAN_MS = 500;
const GADGET_GIVE_UP_MS = 5000;
/** Fire once the aim is this close (rad) to the gadget. */
const GADGET_FIRE_ERROR = 0.03;

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class BotRecon {
  constructor(game) {
    this.game = game;
    const world = game.world;
    this.solidAt = world ? (x, y, z) => world.getBlock(x, y, z) !== AIR : () => false;
  }

  get gadgets() { return this.game.mode?.policy?.reconGadgets ?? null; }
  _team(p) { return this.game.mode?.teamFor?.(p) ?? p.team; }
  _eye(p) { return [p.eyeX ?? p.x, p.eyeY ?? p.y + 1.6, p.eyeZ ?? p.z]; }

  _enemyWithin(p, point, range) {
    const team = this._team(p);
    for (const e of this.game.entities.values()) {
      if (e.state !== 'alive' || e.npcRole || !Number.isFinite(e.x)) continue;
      const other = this._team(e);
      if (other && other !== team && flat(e, point) < range) return true;
    }
    return false;
  }

  /**
   * Gadget use with no enemy in sight: lay the beacon or throw a sensor.
   * Returns 'beacon', 'sensor' or null; `inp` carries the throw edge.
   */
  use(br, p, goal, inp, now) {
    const gadgets = this.gadgets;
    if (!gadgets || p.vehicleId || !p.grounded || now < (br.reconCheckAt ?? 0)) return null;
    const hasBeacon = BEACON_SLOT >= 0 && p.grenades?.[BEACON_SLOT] > 0;
    const hasSensor = SENSOR_SLOT >= 0 && p.grenades?.[SENSOR_SLOT] > 0;
    if (!hasBeacon && !hasSensor) return null;
    br.reconCheckAt = now + RECON_GADGET_RULES.botCheckMs;
    const flag = goal?.target;
    if (!flag || !Number.isFinite(flag.x) || !Number.isFinite(flag.radius)) return null;
    const r = RECON_GADGET_RULES;
    const distance = flat(p, flag);
    if (hasBeacon && goal.stance !== 'defend' && distance >= r.botBeaconMin && distance <= r.botBeaconMax
        && !this._enemyWithin(p, p, r.botBeaconSafe)) {
      const own = gadgets.beaconOf(p.id);
      // Keep a beacon that already stands close to this fight.
      if (!own || flat(own, flag) > r.botBeaconMax) {
        Object.assign(inp, { throwGrenade: true, grenadeType: BEACON_SLOT, grenadeCharge: 0, grenadeCook: 0,
          grenadeAim: { yaw: p.yaw, pitch: -1.1 } });
        return 'beacon';
      }
    }
    if (hasSensor && distance >= r.botSensorMin && distance <= r.botSensorMax) {
      for (const s of gadgets.sensors.values()) {
        if (s.ownerId === String(p.id) && flat(s, flag) < SENSOR_SPACING) return null;
      }
      const aim = this.sensorThrow(p, flag);
      if (!aim) return null;
      Object.assign(inp, { throwGrenade: true, grenadeType: SENSOR_SLOT, grenadeCharge: aim.charge, grenadeCook: 0,
        grenadeAim: { yaw: aim.yaw, pitch: aim.pitch } });
      return 'sensor';
    }
    return null;
  }

  /** The throw (charge, yaw, pitch) whose sensor settles closest to `point`, by the real grenade integrator. */
  sensorThrow(p, point) {
    const yaw = Math.atan2(-(point.x - p.x), -(point.z - p.z));
    const eye = this._eye(p);
    let best = null;
    for (const charge of SENSOR_CHARGES) {
      for (const pitch of SENSOR_PITCHES) {
        const dir = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
        const g = { type: 'sensor', ...grenadeLaunch({ x: eye[0], y: p.y, z: eye[2], eyeY: eye[1], dir, charge, type: 'sensor' }) };
        for (let t = 0; t < RECON_GADGET_RULES.sensor.fuseMs; t += 100) stepGrenade(g, 0.1, this.solidAt);
        const miss = Math.hypot(g.x - point.x, g.z - point.z);
        if (!best || miss < best.miss) best = { charge, yaw, pitch, miss };
      }
    }
    return best && best.miss <= RECON_GADGET_RULES.sensor.radius * 0.5 ? best : null;
  }

  /** The nearest enemy beacon or sensor in sight within botShootRange, or null. */
  target(p) {
    const gadgets = this.gadgets;
    if (!gadgets || (!gadgets.beacons.size && !gadgets.sensors.size)) return null;
    const team = this._team(p);
    const eye = this._eye(p);
    let best = null, bestD = RECON_GADGET_RULES.botShootRange;
    for (const g of gadgets.all()) {
      if (g.team === team) continue;
      const c = reconGadgetCenter(g);
      const d = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
      if (d >= bestD || !reconLineOpen(this.solidAt, eye, c)) continue;
      best = g; bestD = d;
    }
    return best;
  }

  /**
   * No enemy in sight: turn on a visible enemy gadget and shoot it with a gun
   * (launchers and the pick give way to a hitscan slot). Returns true while
   * engaged; the caller then holds the legs still.
   */
  shoot(br, p, inp, now, dtS, ownedSlots, turnRate, pitchTurnRate) {
    if (p.vehicleId) { br.gadgetTarget = null; return false; }
    const gadgets = this.gadgets;
    let g = br.gadgetTarget ? gadgets?.beacons.get(br.gadgetTarget) ?? gadgets?.sensors.get(br.gadgetTarget) ?? null : null;
    if (g && now > (br.gadgetGiveUpAt ?? 0)) { br.gadgetIgnore = g.id; g = null; }
    if (!g && now >= (br.gadgetScanAt ?? 0)) {
      br.gadgetScanAt = now + GADGET_SCAN_MS;
      const found = this.target(p);
      if (found && found.id !== br.gadgetIgnore) { g = found; br.gadgetGiveUpAt = now + GADGET_GIVE_UP_MS; }
    }
    br.gadgetTarget = g?.id ?? null;
    if (!g) return false;
    const def = WEAPONS[WEAPON_IDS[p.weapon]];
    const gun = s => { const w = WEAPONS[WEAPON_IDS[s]]; return w && w.mode !== 'melee' && !w.projectile && !w.flame && (p.mag[s] > 0 || p.reserve[s] > 0); };
    if (!gun(p.weapon)) {
      const slot = ownedSlots.find(gun);
      if (slot === undefined) { br.gadgetTarget = null; return false; }
      if (inp.switchTo === undefined) inp.switchTo = slot;
      return true;
    }
    const eye = this._eye(p);
    const c = reconGadgetCenter(g);
    const yawT = Math.atan2(-(c[0] - eye[0]), -(c[2] - eye[2]));
    const pitchT = Math.atan2(c[1] - eye[1], Math.hypot(c[0] - eye[0], c[2] - eye[2]));
    inp.yaw = br.aim.steer('yaw', p.yaw, yawT, turnRate, dtS);
    inp.pitch = br.aim.steer('pitch', p.pitch, pitchT, pitchTurnRate, dtS);
    const error = Math.hypot(Math.atan2(Math.sin(inp.yaw - yawT), Math.cos(inp.yaw - yawT)), inp.pitch - pitchT);
    inp.wantAds = def?.spreadDeg?.ads < def?.spreadDeg?.hip * 0.7;
    if (p.mag[p.weapon] === 0) { if (p.reserve[p.weapon] > 0) inp.reload = true; return true; }
    inp.wantFire = error < GADGET_FIRE_ERROR && (def?.mode === 'auto' || !p.triggerPrev);
    return true;
  }
}
