import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { CombatFeedback } from '../public/js/combat/feedback.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { FLAME_RULES } from '../shared/flame-rules.js';
import { FlameFX } from '../public/js/weapons/flame.js';

function setup() {
  let now = 0, stops = 0, boltClacks = 0;
  const reports = [], shots = [];
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
  rig.onBoltClack = () => boltClacks++;
  const state = new WeaponState({ rig,
    audio: { draw() {}, reloadClick() {}, fire: (...args) => reports.push(args), stopFlame: () => stops++ },
    effects: { shoot: event => shots.push({ at: now, event }) },
    feedback: { addExhaustion() {}, addRecoil() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true },
    now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5,
  });
  state.resetToLoadout(); state.forceWeapon(WEAPON_IDS.indexOf('flamethrower'), { now });
  for (let i = 0; i < 240; i++) rig.update(1 / 120, { grounded: true });
  now = 2000;
  const context = { allowFire: true, alive: true };
  const frame = (at, held = true, extra = {}) => {
    const dt = Math.max(0, (at - now) / 1000); now = at;
    state.applyIntents({ fireHeld: held, ...extra }, now, context);
    state.tryFire(now, context); rig.update(dt, { grounded: true });
  };
  return { state, rig, shots, reports, frame, context,
    get stops() { return stops; }, get clacks() { return boltClacks; } };
}

for (const fps of [30, 60, 144]) {
  const s = setup();
  try {
    for (let i = 0; i < fps * 8; i++) s.frame(2000 + i * 1000 / fps);
    assert.equal(s.shots.length, 160, `${fps}fps sustains 20 fuel packets per second for eight seconds`);
    assert.equal(s.state.ammoOf('flamethrower').mag, 0);
    const gaps = s.shots.slice(1).map((shot, i) => shot.at - s.shots[i].at);
    assert.ok(Math.max(...gaps) <= 50 + 1000 / fps + 1e-6);
    assert.equal(s.clacks, 0, 'continuous nozzle never racks a bolt');
    assert.equal(s.rig._cur.flash.grp.visible, false, 'no strobing firearm flash');
    const count = s.shots.length;
    s.frame(10020, false); s.frame(10040, false);
    assert.equal(s.shots.length, count); assert.equal(s.state.flameFiring, false);
    assert.equal(s.stops, 1, 'release fades the sustained local audio once');
  } finally { s.state.dispose(); s.rig.dispose(); }
}
for (const stop of ['reload', 'death', 'switch', 'authority', 'menu', 'dispose']) {
  const s = setup();
  try {
    s.frame(2000); assert.equal(s.state.flameFiring, true);
    if (stop === 'reload') s.frame(2010, true, { reload: true });
    if (stop === 'death') s.state.deathReset();
    if (stop === 'switch') s.state.forceWeapon(0, { now: 2010 });
    if (stop === 'authority') { s.context.allowFire = false; s.frame(2010); }
    if (stop === 'menu') s.state.menuReset();
    if (stop === 'dispose') s.state.dispose();
    assert.equal(s.state.flameFiring, false, stop);
    assert.equal(s.stops, 1, `${stop} fades flame audio immediately`);
  } finally { s.state.dispose(); s.rig.dispose(); }
}
{
  const s = setup();
  try {
    s.frame(2000); s.frame(5000);
    assert.equal(s.shots.length, 2, 'a stalled frame never catches up missed fuel in a burst');
  } finally { s.state.dispose(); s.rig.dispose(); }
}
console.log('Continuous flame client: 30/60/144fps cadence, eight-second fuel, no bolt/flash, release/reload/death/swap/phase/menu/dispose and stalled frames passed.');

{
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
  rig.setWeapon('rifle'); rig.update(0.25); rig.update(0.25);
  rig.equipWeapon('flamethrower');
  const { weaponSwapProfile } = await import('../shared/weapon-swap.js');
  const duration = weaponSwapProfile(WEAPONS.flamethrower).total;
  for (let elapsed = 0; elapsed < duration + 0.1; elapsed += 0.1) rig.update(0.1, { grounded: true });
  assert.equal(rig._id, 'flamethrower');
  assert.ok(rig._depT >= 1, '10fps deploy uses elapsed time, not capped spring time');
  assert.equal(rig.fire(), true);
  assert.ok(Number.isFinite(rig.root.position.x));
  rig.dispose();
}
console.log('Flame deploy respects elapsed time on slow render frames without uncapping springs.');

{
  const visuals = [], sounds = [];
  const feedback = new CombatFeedback({
    effects: { shoot: event => visuals.push(event) },
    sfx: { fire: (...args) => sounds.push(args) },
    isRunning: () => true, getMyId: () => 1,
  });
  const shot = { kind: 'shoot', w: 'flamethrower', o: [0, 2, 0], d: [0, 0, -1] };
  feedback.handleEvent({ ...shot, id: 1 });
  assert.equal(visuals.length, 0, 'ordinary local jet remains locally predicted');
  for (const id of [1, 2]) {
    const jet = { ...shot, id, chaosFlame: true, d: [0.2, 0, -0.98] };
    feedback.handleEvent(jet);
    assert.equal(visuals.at(-1), jet, 'authoritative side-jet direction reaches the flame renderer');
  }
  assert.equal(visuals.length, 2, 'local and remote Chaos side jets are rendered');
  assert.equal(sounds.length, 0, 'side jets do not multiply the continuous firing audio');
}
console.log('Chaos side flames render for local and remote shooters without replaying firing audio.');

{
  const flame = new FlameFX(new THREE.Scene(), () => 0);
  try {
    flame.shoot({ o: [0, 2, 0], d: [0, 0, -1] });
    const puff = flame.puffs[0];
    assert.equal(puff.life, FLAME_RULES.range / FLAME_RULES.speed,
      'visual lifetime follows the same thirty-two-metre flight as the server');
    flame.update(0.8);
    assert.ok(puff.position.length() > 23 && puff.age < puff.life,
      'flame visuals visibly travel beyond the previous eighteen-metre reach');
    flame.update(FLAME_RULES.range / FLAME_RULES.speed);
    assert.equal(flame.geometry.instanceCount, 0, 'extended flight still expires');
  } finally { flame.dispose(); }
}
console.log('Flame particles match the extended thirty-two-metre server flight.');
