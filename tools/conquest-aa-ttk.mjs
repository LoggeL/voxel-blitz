// Mobile AA time to kill (docs/conquest.md "Mobile AA"): a bot crew on the
// twin 35 mm against one enemy aircraft on a scripted path (hover, circle,
// straight pass), hard and normal difficulty, seeds 1-3. Prints the seconds
// from the first shot to the kill. `node tools/conquest-aa-ttk.mjs`
import { GameEngine } from '../server/game.js';
import { applyMountedCombat } from '../server/bot-vehicle-combat.js';
import { vehicleMaxHp } from '../shared/vehicle-defs.js';
import { mulberry32 } from '../shared/noise.js';

const TICK = 1000 / 60;

function run({ type, path, seconds = 30, difficulty = 'hard', skill = 0.85, seed = 7 }) {
  const floor = 2, dims = { sx: 1200, sy: 200, sz: 1200 };
  const spawns = { alpha: [{ x: 600, y: floor, z: 600 }], bravo: [{ x: 600, y: floor, z: 300 }] };
  const game = new GameEngine({ mode: 'conquest', world: { mapId: 'frontier', dimensions: dims, getBlock: (x, y, z) => y < floor ? 3 : 0,
    heightAt: () => floor - 1, findSpawns: () => spawns.alpha, setBlock: () => false },
  mapMeta: { id: 'frontier', dimensions: dims, spawns: { conquest: spawns }, conquest: { flags: [], bases: {}, vehicleSpawns: [
    { id: 'aa', team: 'alpha', type: 'aa', x: 600, y: floor, z: 600, yaw: 0 },
    { id: 'air', team: 'bravo', type, x: 600, y: floor, z: 300, yaw: 0 }] } } });
  game.now = 100000;
  game.addBot('bot-0'); game.addClient('pilot', 'Pilot');
  const p = game.entities.get('bot-0'), pilot = game.entities.get('pilot');
  Object.assign(p, { x: 600, y: floor, z: 600, spawnProtectedUntil: 0 }); Object.assign(pilot, { x: 600, y: floor, z: 300, spawnProtectedUntil: 0 });
  const aa = game.vehicles.vehicles.get('aa'), air = game.vehicles.vehicles.get('air');
  game.vehicles.enter(pilot, 'air', 'driver'); game.vehicles.enter(p, 'aa', 'driver');
  const br = { id: p.id, index: 0, rng: mulberry32(seed), skill, difficulty, personality: 'skirmisher', reactionScale: 1, seq: 0 };
  let firstFire = null, shots = 0;
  for (let i = 0; i < 60 * seconds; i++) {
    const t = i / 60, s = path(t);
    Object.assign(air, { x: s.x, y: floor + s.y, z: s.z, vx: s.vx, vy: 0, vz: s.vz, speed: Math.hypot(s.vx, s.vz), grounded: false, rotorSpeed: 1, throttle: 1, pitch: 0, roll: 0, yaw: Math.atan2(-s.vx, -s.vz) });
    const inp = { seq: ++br.seq, keys: {}, yaw: p.yaw, pitch: p.pitch, wantFire: false };
    applyMountedCombat(game, br, p, aa, 'driver', game.now, 1 / 60, inp, {});
    game.applyInput(p.id, inp); game.step(TICK);
    if (inp.wantFire) { shots++; if (firstFire == null) firstFire = t; }
    if (!(air.hp > 0)) return { kill: +(t - (firstFire ?? t)).toFixed(2), hp: 0 };
  }
  return { kill: null, hp: Math.round(air.hp), of: vehicleMaxHp(type), firing: firstFire };
}
const hoverAt = (r, h) => () => ({ x: 600, y: h, z: 600 - r, vx: 0, vz: 0 });
const circle = (r, h, v) => t => { const w = v / r, a = w * t; return { x: 600 + r * Math.sin(a), y: h, z: 600 - r * Math.cos(a), vx: v * Math.cos(a), vz: v * Math.sin(a) }; };
// A straight pass, offset `off` m from the AA, starting `start` m out.
const pass = (off, h, v, start) => t => ({ x: 600 + off, y: h, z: 600 - start + v * t, vx: 0, vz: v });
const cases = [
  ['heli hover 200m', 'helicopter', hoverAt(200, 60)],
  ['heli circle 200m @25', 'helicopter', circle(200, 60, 25)],
  ['heli circle 300m @35', 'helicopter', circle(300, 80, 35)],
  ['transport circle 250m @25', 'transport', circle(250, 60, 25)],
  ['jet pass 150m off @60', 'plane', pass(150, 120, 60, 600)],
  ['jet circle 350m @55', 'plane', circle(350, 120, 55)],
];
for (const diff of ['hard', 'normal']) for (const [name, type, path] of cases) {
  const res = [1, 2, 3].map(seed => run({ type, path, difficulty: diff, skill: diff === 'hard' ? 0.85 : 0.6, seed }));
  console.log(diff.padEnd(7), name.padEnd(28), res.map(r => r.kill != null ? `${r.kill}s` : `alive ${r.hp}/${r.of}`).join('  '));
}
