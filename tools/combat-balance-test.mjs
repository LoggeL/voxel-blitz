import assert from 'node:assert/strict';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot } from '../server/sim/combat.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { COMBAT_DAMAGE_SCALE } from '../shared/combat-balance.js';

assert.equal(COMBAT_DAMAGE_SCALE, 0.8);
for (const bot of [false, true]) {
  const attacker = new PlayerEntity('a', 'Attacker', { x: 20, y: 1, z: 20 });
  const target = new PlayerEntity('v', 'Victim', { x: 20, y: 1.5, z: 15 }, bot);
  Object.assign(attacker, { weapon: WEAPON_IDS.indexOf('rifle'), yaw: 0, pitch: 0, adsT: 1 });
  const hits = [];
  const ctx = { entities: new Map([['a', attacker], ['v', target]]), now: 1000,
    computeConeDeg: () => 0, solidAt: () => false, canDamage: () => true,
    pushEvent: event => { if (event.kind === 'hit') hits.push(event); },
    killPlayer: victim => { victim.state = 'dead'; } };
  for (let shot = 1; shot <= 5; shot++) {
    fireOneShot(attacker, ctx);
    assert.equal(target.hp, 100 - shot * 20);
    assert.equal(target.state, shot < 5 ? 'alive' : 'dead');
    assert.equal(hits.at(-1).dmg, 20, 'wire hit reports the balanced damage');
    assert.equal(hits.at(-1).healthDamage, 20, 'accepted HP loss agrees with wire damage');
  }
}
console.log('Combat balance: humans and bots survive four close rifle body hits and die on the fifth, with matching authoritative HP and hit feedback.');
