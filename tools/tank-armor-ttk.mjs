// Tank armour TTK report: the old facing-zone model against the part,
// slope and ricochet model (shared/tank-armor.js), for the AP shell, the
// RX-8 HAVOC and the HE shell. Rounds fly level (0-6 degrees down) from a
// sector of azimuths at a point drawn uniformly over the hull silhouette.
// Prints the mean damage per hit, the ricochet / no-penetration shares and
// the hits to kill (to 0 HP) and to disable (25 % HP, or the first rear AT
// hit of 30 % HP), averaged over random sequences.
//   node tools/tank-armor-ttk.mjs [--samples 4000]
import { tankArmorHit, TANK_DISABLE_PARTS } from '../shared/tank-armor.js';
import { classifyHitZone, armorMultiplier } from '../shared/vehicle-armor.js';
import { VEHICLE_DEFS, VEHICLE_WEAPONS, CONQUEST_ROCKET_PROFILE, VEHICLE_DAMAGE_RULES } from '../shared/vehicle-defs.js';

const argIndex = process.argv.indexOf('--samples');
const SAMPLES = argIndex > 0 ? Number(process.argv[argIndex + 1]) : 4000;
const def = VEHICLE_DEFS.tank, HW = def.collider.halfWidth, HL = def.collider.halfLength, H = def.height, HP = def.hp;
const WEAPONS = {
  'AP shell': { weapon: 'tankAP', cls: 'at', direct: VEHICLE_WEAPONS.tankAP.damage, splash: VEHICLE_WEAPONS.tankAP.splash },
  'RX-8 HAVOC': { weapon: 'rocket', cls: 'at', direct: CONQUEST_ROCKET_PROFILE.hullDirect, splash: CONQUEST_ROCKET_PROFILE.hullSplash },
  'HE shell': { weapon: 'tankHE', cls: 'he', direct: VEHICLE_WEAPONS.tankHE.damage, splash: VEHICLE_WEAPONS.tankHE.splash },
};
const SECTORS = { front: [-30, 30], side: [60, 120], rear: [150, 210], 'all-round': [0, 360] };

let seed = 7;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const tank = { type: 'tank', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, turretYaw: 0 };

/** Entry of a ray into the collider box (hull at the origin), else null. */
function enter(o, d) {
  const lo = [-HW, 0, -HL], hi = [HW, H, HL];
  let near = -Infinity, far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return null; continue; }
    const a = (lo[i] - o[i]) / d[i], b = (hi[i] - o[i]) / d[i];
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return near > 0 ? o.map((v, i) => v + d[i] * near) : null;
}

/** One hit: { old, now, outcome, rearAt } dealt HP. */
function sampleHit(spec, [from, to]) {
  for (;;) {
    const az = (from + random() * (to - from)) * Math.PI / 180, down = random() * 6 * Math.PI / 180;
    // Direction of travel toward the hull: from azimuth `az` (0 = in front, + toward the right flank).
    const d = [-Math.sin(az) * Math.cos(down), -Math.sin(down), Math.cos(az) * Math.cos(down)];
    const target = [(random() * 2 - 1) * HW, random() * H, (random() * 2 - 1) * HL];
    const o = target.map((v, i) => v - d[i] * 60), point = enter(o, d);
    if (!point) continue;
    // The old model: one facing zone from the impact point, the splash at the same point.
    const zone = classifyHitZone(point, [HW, H / 2, HL], H / 2);
    const old = (spec.direct + spec.splash) * armorMultiplier(spec.cls, 'heavy', zone);
    const direct = tankArmorHit(tank, point, { dir: d, cls: spec.cls, weapon: spec.weapon });
    if (direct.outcome === 'rico') return { old, oldRear: zone === 'rear', now: 0, outcome: 'rico', nowRear: false };
    const splash = tankArmorHit(tank, point, { cls: spec.cls, weapon: spec.weapon });
    const now = spec.direct * direct.multiplier + spec.splash * splash.multiplier;
    return { old, oldRear: zone === 'rear', now, outcome: direct.outcome, nowRear: TANK_DISABLE_PARTS.includes(direct.part), part: direct.part };
  }
}

/** Mean hits to kill and to disable over random sequences of hits. */
function hitsTo(spec, sector, key) {
  let kill = 0, disable = 0;
  const runs = Math.max(200, SAMPLES / 4);
  for (let r = 0; r < runs; r++) {
    let hp = HP, n = 0, disabledAt = 0;
    while (hp > 0 && n < 60) {
      const hit = sampleHit(spec, sector), dealt = hit[key], rear = key === 'old' ? hit.oldRear : hit.nowRear;
      hp -= dealt; n++;
      if (!disabledAt && hp > 0 && (hp <= HP * VEHICLE_DAMAGE_RULES.disabledFraction
        || spec.cls === 'at' && rear && dealt >= HP * VEHICLE_DAMAGE_RULES.disableHitFraction)) disabledAt = n;
    }
    kill += n; disable += disabledAt || n;
  }
  return { kill: kill / runs, disable: disable / runs };
}

const rows = [];
for (const [name, spec] of Object.entries(WEAPONS)) {
  for (const [sectorName, sector] of Object.entries(SECTORS)) {
    let old = 0, now = 0, rico = 0, nopen = 0;
    const parts = {};
    for (let i = 0; i < SAMPLES; i++) {
      const hit = sampleHit(spec, sector);
      old += hit.old; now += hit.now;
      if (hit.outcome === 'rico') rico++; else if (hit.outcome === 'nopen') nopen++;
      if (hit.part) parts[hit.part] = (parts[hit.part] ?? 0) + 1;
    }
    const before = hitsTo(spec, sector, 'old'), after = hitsTo(spec, sector, 'now');
    const top = Object.entries(parts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p} ${Math.round(n / SAMPLES * 100)}%`).join(', ');
    rows.push({ weapon: name, sector: sectorName, 'old dmg': Math.round(old / SAMPLES), 'new dmg': Math.round(now / SAMPLES),
      'rico %': +(rico / SAMPLES * 100).toFixed(1), 'nopen %': +(nopen / SAMPLES * 100).toFixed(1),
      'old kill': +before.kill.toFixed(2), 'new kill': +after.kill.toFixed(2), 'old disable': +before.disable.toFixed(2), 'new disable': +after.disable.toFixed(2), parts: top });
  }
}
console.table(rows);
