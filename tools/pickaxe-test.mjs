import assert from 'node:assert/strict';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { WEAPONS } from '../shared/combatmath.js';
import { MINING_HITS, STONE } from '../shared/world/blocks.js';

function setup(type = STONE, distance = 2) {
  const blocks = new Map([[`0,2,${3 - distance}`, type]]);
  const events = [], deltas = [];
  const key = (x, y, z) => `${x},${y},${z}`;
  const p = { id: 'miner', x: 0.5, z: 3.5, eyeY: 2.5, yaw: 0, pitch: 0,
    def: WEAPONS.knife, weapon: 9, cooldown: 0, deployT: 0,
    input: { wantFire: true }, shotSeq: 0, mag: [], reserve: [] };
  const ctx = { now: 0, entities: new Map(), blockHp: new Map(),
    canFire: () => true, canUseWeapon: () => true, canDamage: () => true,
    getBlock: (x, y, z) => blocks.get(key(x, y, z)) || 0,
    setBlock: (x, y, z, v) => blocks.set(key(x, y, z), v),
    solidAt: (x, y, z) => blocks.get(key(x, y, z)) || 0,
    pushEvent: e => events.push(e), pushBlockDelta: (...d) => deltas.push(d) };
  const swing = () => { p.cooldown = 0; ctx.now += 500; resolveWeaponIntent(p, 0.5, ctx); };
  return { p, ctx, events, deltas, swing };
}
for (const [type, required] of Object.entries(MINING_HITS)) {
  const s = setup(Number(type));
  for (let i = 1; i < required; i++) { s.swing(); assert.equal(s.deltas.length, 0); }
  s.swing(); assert.equal(s.deltas.length, 1, `material ${type} breaks on swing ${required}`);
  assert.equal(s.events.filter(e => e.kind === 'mine').at(-1).progress, 1);
}
{
  const s = setup(); s.swing(); s.swing();
  s.p.input.wantFire = false; resolveWeaponIntent(s.p, 0.02, s.ctx);
  s.p.input.wantFire = true; s.swing(); assert.equal(s.p.mining.hits, 1);
  s.ctx.now += 900; s.swing(); assert.equal(s.p.mining.hits, 1);
  s.p.yaw = Math.PI; s.swing(); assert.equal(s.p.mining, null);
}
{
  const s = setup(STONE, 5); s.swing(); assert.equal(s.events.filter(e => e.kind === 'mine').length, 0);
}
{
  const s = setup(); s.ctx.canFire = () => false; s.swing(); assert.equal(s.events.length, 0);
}
{
  const s = setup(); s.swing(); const n = s.events.length;
  resolveWeaponIntent(s.p, 0.01, s.ctx); assert.equal(s.events.length, n, 'cooldown prevents faster mining');
}
console.log('Pickaxe: all materials, release, timeout, aim, reach, fire gating and cadence passed.');
