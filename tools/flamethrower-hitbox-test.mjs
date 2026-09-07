import assert from 'node:assert/strict';
import { PlayerEntity, aimAngles, fwdFromYawPitch } from '../server/sim/player.js';
import { FlameSystem } from '../server/sim/fire.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

function scenario({ victimAt = [10.5, 0.5, 8.5], prone = false, aim = null, solidAt = () => 0 } = {}) {
  const owner = new PlayerEntity('owner', 'Owner', { x: 10.5, y: 0.5, z: 10.5, index: 0 }, false);
  const victim = new PlayerEntity('victim', 'Victim', { x: victimAt[0], y: victimAt[1], z: victimAt[2], index: 0 }, false);
  owner.weapon = WEAPON_IDS.indexOf('flamethrower');
  victim.proneT = prone ? 1 : 0;
  victim.yaw = 0;
  const eye = [owner.x, owner.eyeY, owner.z];
  const direction = aim ? (() => { const a = aimAngles(eye, aim); return fwdFromYawPitch(a.yaw, a.pitch); })() : { x: 0, y: 0, z: -1 };
  const events = [];
  const ctx = { flames: new FlameSystem(),
    entities: new Map([[owner.id, owner], [victim.id, victim]]),
    canDamage: () => true, solidAt, pushEvent: event => events.push(event),
    killPlayer: () => assert.fail('one flame shot must not kill a healthy target'),
  };
  ctx.flames.launch(owner, eye, direction, ctx);
  ctx.flames.step(0.6, ctx);
  return { victim, events };
}
function hit(result, label) {
  assert.ok(result.victim.hp < 100, label);
  assert.equal(result.victim.burning, 0.75, label);
  assert.equal(result.events.length, 1, 'one hit per victim, irrespective of sampled volumes');
}
hit(scenario(), 'point-blank level aim hits the head');
hit(scenario({ prone: true, aim: [10.5, 0.75, 9.7] }), 'prone feet behind the head remain hittable');
hit(scenario({ prone: true, aim: [10.5, 0.98, 8.5] }), 'prone head remains hittable');
hit(scenario({ victimAt: [10.5, 0.5, 5.5], solidAt: (_x, y, z) => z === 7 && y < 2 }),
  'exposed head above chest-high cover receives fire');
hit(scenario({ victimAt: [10.85, 0.5, 5.5], solidAt: (_x, y, z) => z === 7 && y < 2 }),
  'growing packet catches an exposed head beside the central ray');
const blocked = scenario({ solidAt: (_x, _y, z) => z === 9 });
assert.equal(blocked.victim.hp, 100, 'full wall blocks every body sample');
assert.equal(blocked.victim.burning, 0);
const outside = scenario({ victimAt: [13.5, 0.5, 5.5] });
assert.equal(outside.victim.hp, 100, 'body outside flame cone is not ignited');
console.log('Flame hitboxes: close head, prone head/feet, exposed cover, cone edge and full occlusion passed.');
