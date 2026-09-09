import assert from 'node:assert/strict';
import { CombatFeedback } from '../public/js/combat/feedback.js';
import { evProjectileLaunch } from '../server/protocol/events.js';

const launches = [];
const sounds = [];
let running = true;
const feedback = new CombatFeedback({
  effects: { projectileLaunch: (event, options) => launches.push({ event, options }) },
  sfx: { grenadeThrow: (charge, options) => sounds.push({ charge, options }) },
  getMyId: () => 'local',
  isRunning: () => running,
});

for (const type of ['frag', 'limpet', 'pulse', 'molotov', 'smoke']) {
  const remote = evProjectileLaunch('remote', `remote-${type}`, type, [5, 2, 1], [1, 2, 3], 1000);
  feedback.handleEvent(remote);
  assert.equal(launches.at(-1).options.fromSelf, false);
  assert.deepEqual(sounds.at(-1), { charge: 0.5, options: { pos: [5, 2, 1] } },
    `${type} uses its authoritative launch position and default strength when charge is absent`);
  const before = sounds.length;
  feedback.handleEvent(evProjectileLaunch('local', `local-${type}`, type, [0, 1, 0], [1, 2, 3], 1000));
  assert.equal(launches.at(-1).options.fromSelf, true);
  assert.equal(sounds.length, before, 'authoritative local launch never doubles predicted hand audio');
}
assert.equal(sounds.length, 5, 'each remote throwable type plays exactly one throw cue');

const charged = evProjectileLaunch('remote', 'charged', 'frag', [6, 3, 2], [1, 2, 3], 1000);
feedback.handleEvent({ ...charged, charge: 0.85 });
assert.equal(sounds.at(-1).charge, 0.85, 'a supplied charge is preserved');
const beforeOtherProjectiles = sounds.length;
for (const type of ['rocket', 'bolt']) {
  feedback.handleEvent(evProjectileLaunch('remote', type, type, [5, 2, 1], [1, 2, 3], 1000));
}
assert.equal(sounds.length, beforeOtherProjectiles, 'tube and coil projectiles keep their existing weapon launch audio');
running = false;
feedback.handleEvent(charged);
assert.equal(sounds.length, beforeOtherProjectiles, 'inactive sessions never replay throw sounds');

console.log('Grenade feedback audio: remote frag/limpet/pulse position, optional charge, local prediction deduplication and weapon exclusions passed.');
