import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';

// Remote footfalls fire from the roster in step with the gait phase, carry
// the body position and loudness, and stay silent for quiet or hidden motion.
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };
try {
  const steps = [];
  const roster = new AvatarRoster({ scene: new THREE.Scene(), footstep: (remote, volume, body) => steps.push({ id: remote.id, x: remote.x, volume, body }) });
  try {
    const remote = { id: 'runner', name: 'Runner', x: 4, y: 2, z: 3, yaw: 0, pitch: 0, weapon: 0,
      state: 'alive', grounded: true, vaulting: false, moveSpeed: 6.2, crouch: false };
    const remotes = new Map([[remote.id, remote]]);
    const run = (frames, mutate = () => {}) => {
      for (let frame = 0; frame < frames; frame++) {
        mutate(frame);
        remotes.set(remote.id, { ...remote });
        roster.sync(remotes, 1 / 60, frame * 1000 / 60);
      }
    };
    run(120, (frame) => { remote.x = 4 + frame * 6.2 / 60; });
    assert.ok(steps.length >= 6 && steps.length <= 10, `two seconds of sprinting produce a steady cadence (${steps.length})`);
    assert.ok(steps.every((step) => step.id === 'runner'), 'steps carry the body');
    assert.ok(steps.slice(2).every((step) => step.volume > 0.9), 'once the smoothed speed settles, sprint steps are loud');
    assert.ok(steps.at(-1).x > steps[0].x, 'each step reports the current body position');
    assert.ok(steps[0].body && steps.every((step) => step.body === steps[0].body),
      'new network snapshot objects keep the same avatar identity for sample variation');

    steps.length = 0;
    remote.crouch = true;
    run(120);
    assert.equal(steps.length, 0, 'crouch-walking is silent');

    remote.crouch = false;
    remote.grounded = false;
    run(60);
    assert.equal(steps.length, 0, 'airborne bodies are silent');

    remote.grounded = true;
    remote.moveSpeed = 2.2;
    run(180);
    assert.equal(steps.length, 0, 'creeping below the step speed is silent');

    remote.moveSpeed = 4.4;
    run(180);
    const walkSteps = steps.length;
    assert.ok(walkSteps >= 4, `walking is audible (${walkSteps})`);
    assert.ok(steps.every((step) => step.volume > 0.4 && step.volume < 0.9), 'walking steps are quieter than sprinting');
  } finally { roster.dispose(); }
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
console.log('ok: roster footfalls follow the gait, carry position and loudness, and stay silent when crouched, airborne or creeping');
