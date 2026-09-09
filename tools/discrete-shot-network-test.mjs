import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

for (const id of ['sniper', 'revolver', 'shotgun']) {
  let now = 2000, tap = false, held = false, connected = true;
  const calls = { sound: 0, recoil: 0, shot: 0 };
  const input = new Proxy({ consumeDelta: () => ({ dx: 0, dy: 0 }),
    consumeFireTap: () => { const value = tap; tap = false; return value; },
    get wantFireHeld() { return held; }, getKeys: () => ({}),
    setGameplayEnabled() {},
  }, { get: (target, key) => target[key] ?? (() => false) });
  const player = new LocalPlayer({ input, sendHz: 60, physics: {
    pos: { x: 4, y: 1, z: 4 }, vel: { x: 0, y: 0, z: 0 }, grounded: true,
    step: () => false, eyeY: () => 2.62, setMapMeta() {},
  } });
  player.setGameplayInputEnabled(true);
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera());
  const weapon = new WeaponState({ rig, now: () => now,
    audio: { draw() {}, reloadClick() {}, fire() { calls.sound++; } },
    feedback: { addExhaustion() {}, addRecoil() { calls.recoil++; } },
    effects: { shoot() { calls.shot++; } }, setTimer: () => 0, clearTimer() {},
    network: { isRunning: () => true, isCurrentGeneration: () => true },
  });
  weapon.resetToLoadout(); weapon.forceWeapon(WEAPON_IDS.indexOf(id), { now });
  for (let i = 0; i < 240; i++) rig.update(1 / 120);
  now += 2000;
  const wires = [];
  const frame = (pressed = false) => {
    tap = pressed; held = pressed;
    player.update(1 / 60, now, { weapon, fireAllowed: true, movementAllowed: true,
      onWeaponIntents: intents => weapon.applyIntents(intents, now, { allowFire: true }),
      beforeSend: () => weapon.tryFire(now, { allowFire: true, alive: true }),
      sendInput: wire => { if (!connected) return false; wires.push(wire); return true; },
    });
  };
  frame(true);
  assert.equal(wires.at(-1).wantFire, true, `${id}: accepted shot reaches authority`);
  assert.deepEqual(calls, { sound: 1, recoil: 1, shot: 1 });
  now += 20; frame();
  // Wall clock is ready, but the rig is still cycling after a stalled render.
  now += 60000 / weapon.def.rpm + 10; frame(true);
  assert.equal(wires.at(-1).wantFire, false, `${id}: busy rig cannot send a silent shot`);
  assert.deepEqual(calls, { sound: 1, recoil: 1, shot: 1 });
  for (let i = 0; i < 360; i++) rig.update(1 / 120);
  now += 3000; frame();
  connected = false; frame(true);
  assert.deepEqual(calls, { sound: 2, recoil: 2, shot: 2 });
  connected = true; now += 20; frame();
  assert.equal(wires.at(-1).wantFire, true, `${id}: accepted shot survives failed send and release`);
  now += 20; frame();
  assert.equal(wires.at(-1).wantFire, false, `${id}: accepted shot is consumed once`);
  player.dispose(); weapon.dispose(); rig.dispose();
}
console.log('Discrete shot network: real rig rejection, report/recoil parity, failed sends and exactly-once release passed.');
