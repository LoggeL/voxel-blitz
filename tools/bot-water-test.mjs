import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, GROUND, MC_WATER } from '../shared/worlddata.js';
import { attachBots } from '../server/bots.js';

const FEET = GROUND + 1.02;
const meta = getMapMeta('foundry');
const DRY = meta.spawns.fun[1];
const make = () => new GameEngine({ mode: 'fun', mapMeta: meta, broadcast: () => {} });

/** A 5x5 two-deep open pool on verified flat ground: feet and head wet. */
function flood(e, bx, bz) {
  const fy = Math.floor(FEET);
  for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
    e.world.setBlock(bx + dx, fy, bz + dz, MC_WATER);
    e.world.setBlock(bx + dx, fy + 1, bz + dz, MC_WATER);
  }
  return { x: bx + 2.5, y: FEET, z: bz + 2.5 };
}
const wet = (e, p) => e.fluidAt(Math.floor(p.x), Math.floor(p.y + 0.55), Math.floor(p.z));
const parkDry = (p) => Object.assign(p, { x: DRY.x, y: DRY.y, z: DRY.z, vx: 0, vy: 0, vz: 0 });

{
  // Head-submerged grace, then damage, then death; surfacing resets the clock.
  const e = make();
  e.addClient('p0', 'Diver');
  const p = e.entities.get('p0');
  const pool = flood(e, 10, 20);
  Object.assign(p, { x: pool.x, y: pool.y, z: pool.z, vx: 0, vy: 0, vz: 0 });
  assert(wet(e, p), 'diver starts in the water');
  for (let i = 0; i < 140; i++) e.step(50);
  assert.equal(p.hp, 100, 'full hp inside the 8s grace');
  parkDry(p);
  for (let i = 0; i < 200; i++) e.step(50);
  assert.equal(p.hp, 100, 'surfacing before grace resets drowning');
  Object.assign(p, { x: pool.x, y: pool.y, z: pool.z, vx: 0, vy: 0, vz: 0 });
  let dead = false;
  for (let i = 0; i < 500 && !dead; i++) { e.step(50); dead = p.state !== 'alive'; }
  assert(dead, 'staying under kills');
  assert.equal(p.deaths, 1);
  e.stop();
  console.log('ok: drowning grace, damage, death and surface reset');
}
{
  // Bots swim out instead of treading water until they drown.
  const e = make();
  e.addClient('p0', 'Lifeguard');
  parkDry(e.entities.get('p0'));
  const manager = attachBots(e, 1, {});
  const bot = e.entities.get('bot-0');
  const pool = flood(e, 46, 68);
  Object.assign(bot, { x: pool.x, y: pool.y, z: pool.z, vx: 0, vy: 0, vz: 0 });
  assert(wet(e, bot), 'bot starts in the water');
  let dry = false;
  for (let i = 0; i < 600 && !dry; i++) { e.step(50); dry = !wet(e, bot); }
  assert(dry, 'bot leaves the pool');
  assert.equal(bot.state, 'alive', 'escaped before the grace ran out');
  manager.dispose();
  e.stop();
  console.log('ok: bots escape open water for dry footing');
}
console.log('Bot water tests passed');
