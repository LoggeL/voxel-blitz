#!/usr/bin/env node
/**
 * Titanfall on-gun ammo displays (public/js/guns/weapon-display.js; docs/titanfall.md §8 On-gun displays):
 * every titanfall pilot gun seats a panel, the display model follows the predicted weapon state and the
 * `tfs` lock, it exists only in titanfall, repaints only on change, and leaves with its gun.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../public/js/vendor/three.module.js';
import { buildGun } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { HIP } from '../public/js/guns/models/common.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import {
  DISPLAY_WEAPONS, WEAPON_TINT, applyWeaponDisplay, createWeaponDisplayModel, paintWeaponDisplay, weaponDisplayEnabled,
  weaponDisplayInView, weaponDisplayModel,
} from '../public/js/guns/weapon-display.js';
import { MODE_IDS } from '../shared/modes.js';
import { TITAN_PILOT_AT, TITAN_PILOT_PRIMARIES, TITAN_PILOT_SIDEARM } from '../shared/titan-contract.js';
import { WEAPONS, WEAPON_IDS, chargeFromHold } from '../shared/combatmath.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };
const TF = { mode: 'titanfall' };
const root = new URL('..', import.meta.url);

// 1. Every titanfall pilot gun has a display mount; nothing else does.
check(() => assert.deepEqual([...DISPLAY_WEAPONS].sort(),
  [...TITAN_PILOT_PRIMARIES, TITAN_PILOT_SIDEARM, ...TITAN_PILOT_AT].sort(), 'display weapons = the titanfall pilot guns'));
for (const id of WEAPON_IDS) {
  const pilotGun = DISPLAY_WEAPONS.includes(id);
  check(() => assert.equal(weaponDisplayEnabled('titanfall', id), pilotGun, `${id}: display only on pilot guns`));
  if (!pilotGun) continue;
  const bundle = buildGun(id, new MaterialCache());
  const mount = bundle.body.userData.displayMount;
  check(() => {
    assert.ok(mount, `${id} builder seats a display mount`);
    for (const key of ['x', 'y', 'z', 'w', 'h']) assert.ok(Number.isFinite(mount[key]), `${id} mount.${key}`);
    assert.ok(mount.seat === 'deck' || mount.seat === 'rear', `${id} seat ${mount.seat}`);
    // Top rear of the receiver, near the centre line (Halo rear deck counter), not on a flank.
    assert.ok(Math.abs(mount.x) <= 0.06 && mount.y > 0.04 && mount.y < 0.2 && mount.z > 0 && mount.z < 0.25,
      `${id} counter on the top rear (${mount.x}, ${mount.y}, ${mount.z})`);
    assert.ok(mount.w >= 0.035 && mount.w <= 0.06 && mount.h >= 0.025 && mount.h <= 0.045 && mount.w / mount.h > 1.1
      && mount.w / mount.h < 1.6, `${id} compact counter ${mount.w}×${mount.h}`);
  });
  applyWeaponDisplay(bundle, id, weaponDisplayModel({ wid: id, mag: 1, reserve: 1 }, TF));
  const panel = bundle.weaponDisplay.mesh;
  bundle.root.updateMatrixWorld(true);
  // Faces back toward the shooter: the screen normal points at the hip eye (minus the hip offset, turned by the hip
  // yaw) and at the sight eye (minus the ADS offset), square enough to read from both.
  const T = bundle.T, hip = T.hipOffset || HIP, yaw = T.hipYaw || 0;
  const hipEye = new THREE.Vector3(-hip.x * Math.cos(yaw) + hip.z * Math.sin(yaw), -hip.y, -hip.x * Math.sin(yaw) - hip.z * Math.cos(yaw));
  const adsEye = new THREE.Vector3(-T.adsOffset.x, -T.adsOffset.y, -T.adsOffset.z);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(panel.quaternion);
  check(() => {
    const toHip = hipEye.clone().sub(panel.position).normalize().dot(normal);
    const toAds = adsEye.clone().sub(panel.position).normalize().dot(normal);
    assert.ok(toHip > 0.85 && toAds > 0.85, `${id}: faces the eye (hip ${toHip.toFixed(2)}, sight ${toAds.toFixed(2)})`);
    assert.ok(normal.z > 0.85 && normal.y > 0.05, `${id}: faces back and tilts up (${normal.toArray().map(v => v.toFixed(2))})`);
  });
  // Seated on the gun, not standing off it: rays against the seat axis (deck: down, rear: forward) through a 5×5
  // grid on the screen, starting just above / behind it, find the gun's surface; the screen stays clear of it by at
  // most 2 cm and the pod reaches into it (no gap). SKIPJACK is Blender-only and builds no geometry in Node.
  const inHand = object => !!object && (/^hand_/.test(object.name) || inHand(object.parent));
  const gunMeshes = [];
  bundle.body.traverseVisible(object => { if (object.isMesh && !inHand(object) && object !== panel) gunMeshes.push(object); });
  const axis = new THREE.Vector3(...(mount.seat === 'rear' ? [0, 0, 1] : [0, 1, 0]));
  const toLocal = bundle.body.matrixWorld.clone().invert();
  const ray = new THREE.Raycaster();
  let surface = -Infinity, gap = Infinity;
  for (let iu = 0; iu < 5; iu++) for (let iv = 0; iv < 5; iv++) {
    const on = new THREE.Vector3((iu / 4 - 0.5) * mount.w, (iv / 4 - 0.5) * mount.h, 0).applyMatrix4(panel.matrix);
    ray.set(on.clone().addScaledVector(axis, 0.006).applyMatrix4(bundle.body.matrixWorld), axis.clone().negate().transformDirection(bundle.body.matrixWorld));
    ray.far = 0.3;
    const hit = ray.intersectObjects(gunMeshes, false)[0];
    if (!hit) continue;
    const s = hit.point.clone().applyMatrix4(toLocal).dot(axis);
    surface = Math.max(surface, s);
    gap = Math.min(gap, on.dot(axis) - s);
  }
  if (id === 'mgl' && surface === -Infinity) continue;
  check(() => {
    assert.ok(Number.isFinite(surface), `${id}: gun surface ${mount.seat === 'rear' ? 'ahead of' : 'under'} the screen`);
    const position = panel.geometry.attributes.position;
    const along = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(panel.matrix).dot(axis));
    assert.ok(gap >= 0, `${id}: the screen stays clear of the gun`);
    // A step under the housing's front edge (the THUNDERBOLT hump) holds it up; the pod fills the rest.
    assert.ok(gap < 0.03, `${id}: the screen stands ${gap.toFixed(3)} m off the gun`);
    assert.ok(Math.min(...along) < surface - 0.003, `${id}: the pod reaches into the gun`);
  });
}
check(() => assert.equal(weaponDisplayEnabled('titanfall', 'knife'), false, 'the knife has no magazine and no panel'));

// 2. Titanfall only: every other mode gets no model, and an unhooked rig never grows a panel.
const read = { wid: 'rifle', mag: 30, reserve: 90, reloading01: null, charge01: 0, ready01: 1 };
for (const mode of MODE_IDS) {
  check(() => assert.equal(weaponDisplayModel(read, { mode }) !== null, mode === 'titanfall', `${mode}: display model`));
}
{
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
  rig.setWeapon('rifle');
  for (let i = 0; i < 30; i++) rig.update(1 / 60, { grounded: true });
  check(() => assert.equal(rig._cur.body.getObjectByName('weaponDisplay'), undefined, 'no panel without titanfall'));
  check(() => assert.equal(rig.weaponDisplayLive, false));
  rig.dispose();
}

// 3. Model values from the predicted weapon state (WeaponState.readDisplay) and the tfs lock.
{
  let now = 10_000;
  const weapon = new WeaponState({
    rig: { root: { visible: true }, setWeapon() {}, reload() {}, pumpAnim() {}, boltAnim() {}, ads() {}, equipWeapon() {}, fire: () => true },
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} }, feedback: { addExhaustion() {}, addRecoil() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true }, now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5,
  });
  weapon.resetToLoadout();
  const owned = ['rifle', 'shotgun', 'revolver', 'chargerifle', 'knife'];
  const select = (id) => { weapon.forceWeapon(WEAPON_IDS.indexOf(id), { mode: 'titanfall', owned, now }); now += 5000; };
  const ammo = (id, mag, reserve) => {
    const mags = WEAPON_IDS.map(() => NaN), reserves = WEAPON_IDS.map(() => NaN);
    mags[WEAPON_IDS.indexOf(id)] = mag; reserves[WEAPON_IDS.indexOf(id)] = reserve;
    weapon.adoptServerAmmo(mags, reserves);
  };
  const scratch = {}, out = createWeaponDisplayModel();
  const model = (lock = 0) => weaponDisplayModel(weapon.readDisplay(scratch, now), { mode: 'titanfall', lock }, out);
  select('rifle');
  ammo('rifle', 30, 90);
  check(() => {
    const m = model();
    assert.equal(m, out, 'the caller-owned model is refilled, not reallocated');
    assert.equal(weapon.readDisplay(scratch, now), scratch);
    assert.deepEqual([m.id, m.mag, m.reserve, m.magSize, m.low, m.reload], ['rifle', 30, 90, 30, false, -1]);
  });
  // Low: the stock card's rule, at most 22 % of 30 (7 rounds).
  ammo('rifle', 7, 90);
  check(() => assert.equal(model().low, true, '7 / 30 is low'));
  ammo('rifle', 8, 90);
  check(() => assert.equal(model().low, false, '8 / 30 is not low'));
  // Reloading: the predicted reload's progress in 5 % steps.
  ammo('rifle', 4, 90);
  check(() => assert.equal(weapon.startReload(now), true));
  const reloadMs = weapon._reloadState.dur;
  now += reloadMs * 0.5;
  check(() => assert.equal(model().reload, 10, 'half-way through the reload'));
  now += reloadMs;
  weapon.tickReload(now);
  check(() => assert.equal(model().reload, -1, 'the finished reload shows the count again'));
  // CR-6 charge and vent come from the held capacitor and the fire cadence.
  select('chargerifle');
  weapon._chargeStart = now - 550;
  check(() => {
    const m = model();
    assert.equal(m.extra, 'charge');
    assert.equal(m.charge, Math.round(chargeFromHold(WEAPONS.chargerifle, 550) * 20));
  });
  weapon._chargeStart = null;
  weapon._nextFireAt = now + 0.5 * 60000 / WEAPONS.chargerifle.rpm;
  check(() => assert.deepEqual([model().charge, model().ready], [0, 10], 'venting half-way'));
  // A fresh draw is no vent, bolt, pump or arc: only a shot's cadence that outlasts the draw counts.
  weapon.forceWeapon(WEAPON_IDS.indexOf('rifle'), { mode: 'titanfall', owned, now });
  now += 5000;
  weapon.forceWeapon(WEAPON_IDS.indexOf('chargerifle'), { mode: 'titanfall', owned, now });
  now += 50;
  check(() => {
    assert.ok(weapon.isDeploying, 'still drawing');
    assert.equal(model().ready, 20, 'drawing: ready, not venting');
    assert.equal(paintRing(model()).lit, 3, 'drawing: the ring shows the magazine, not a vent');
  });
  now += 5000;
  // M-DOCK tube reload (staged): shells seat one at a time and a shot interrupts, so the count stays up.
  select('shotgun');
  ammo('shotgun', 1, 20);
  check(() => assert.equal(weapon.startReload(now), true));
  const stages = WEAPONS.shotgun.reloadStages;
  now += (stages.start + stages.perRound * 2.5) * 1000;
  weapon.tickReload(now);
  check(() => {
    const m = model();
    assert.ok(m.staged && m.reload >= 0 && m.mag >= 3, `staged reload with seated shells (mag ${m.mag})`);
    const texts = paintTexts(m), ring = paintRing(m);
    assert.ok(texts.includes(String(m.mag)), texts.join('|'));
    assert.ok(!texts.includes('RELOADING'), 'the count is not replaced');
    assert.deepEqual([ring.segments, ring.lit, ring.color], [20, m.reload, '#ffffff'], 'the ring fills white as shells seat');
  });
  weapon.cancelReload();
  check(() => assert.equal(model().staged, false));
  // ARCHER lock from tfs[11]; a single-round launcher is low only when empty.
  const archer = { wid: 'archer', mag: 1, reserve: 4, reloading01: null, charge01: 0, ready01: 1 };
  check(() => {
    const m = weaponDisplayModel(archer, { mode: 'titanfall', lock: 0.55 });
    assert.deepEqual([m.lock, m.low], [11, false]);
    assert.equal(weaponDisplayModel(archer, { mode: 'titanfall', lock: 1 }).lock, 20);
    assert.equal(weaponDisplayModel({ ...archer, mag: 0 }, TF).low, true);
  });
  check(() => {
    const kraber = weaponDisplayModel({ wid: 'kraber', mag: 3, reserve: 12, reloading01: null, ready01: 0.3 }, TF);
    assert.deepEqual([kraber.extra, kraber.ready], ['bolt', 6]);
  });
  weapon.dispose();
}

// 4. Paint: what the counter says in each state. A recording context keeps each text with its colour and each ring
// segment (an arc pair) as lit (filled in the ring colour), track (dim fill) or outlined (low ammo).
function paintRecord(model) {
  const texts = [], segments = [];
  let fillStyle = '', strokeStyle = '', arcs = 0;
  const context = new Proxy({
    measureText: (text) => ({ width: String(text).length * 10 }),
    fillText: (text) => texts.push({ text: String(text), color: fillStyle }),
    beginPath: () => { arcs = 0; },
    arc: () => { arcs++; },
    fill: () => { if (arcs === 2) segments.push({ kind: 'fill', color: fillStyle }); },
    stroke: () => { if (arcs === 2) segments.push({ kind: 'outline', color: strokeStyle }); },
  }, {
    get: (target, key) => key === 'fillStyle' ? fillStyle : key === 'strokeStyle' ? strokeStyle : target[key] ?? (() => {}),
    set: (_target, key, value) => { if (key === 'fillStyle') fillStyle = value; if (key === 'strokeStyle') strokeStyle = value; return true; },
  });
  paintWeaponDisplay(context, 256, 199, model);
  return { texts, segments };
}
function paintTexts(model) { return paintRecord(model).texts.map(entry => entry.text); }
function paintRing(model) {
  const { segments } = paintRecord(model);
  const lit = segments.filter(segment => segment.kind === 'fill' && segment.color !== '#ffffff1f');
  return { segments: segments.length, lit: lit.length, color: lit[0]?.color ?? null,
    outlined: segments.filter(segment => segment.kind === 'outline').length };
}
const shown = (values, lock = 0) => weaponDisplayModel({ reloading01: null, charge01: 0, ready01: 1, ...values }, { mode: 'titanfall', lock });
const TINT = id => `#${WEAPON_TINT[id].toString(16).padStart(6, '0')}`;
// Compact: the count (zero-padded to the magazine's digits) and the reserve, no tag, mode or labels.
check(() => assert.deepEqual(paintTexts(shown({ wid: 'rifle', mag: 30, reserve: 90 })), ['30', '90']));
check(() => assert.deepEqual(paintRing(shown({ wid: 'rifle', mag: 30, reserve: 90 })), { segments: 20, lit: 20, color: TINT('rifle'), outlined: 0 }));
check(() => assert.deepEqual(paintRing(shown({ wid: 'rifle', mag: 15, reserve: 90 })), { segments: 20, lit: 10, color: TINT('rifle'), outlined: 0 }));
check(() => assert.deepEqual(paintRing(shown({ wid: 'kraber', mag: 3, reserve: 12 })), { segments: 4, lit: 3, color: TINT('kraber'), outlined: 0 }, 'one segment per round'));
check(() => assert.deepEqual(paintRing(shown({ wid: 'archer', mag: 1, reserve: 4 })), { segments: 1, lit: 1, color: TINT('archer'), outlined: 0 }));
// Low: count and ring in the warning red, and the drained slots outlined (reads without colour).
check(() => {
  const { texts } = paintRecord(shown({ wid: 'rifle', mag: 5, reserve: 90 }));
  assert.deepEqual(texts, [{ text: '05', color: '#ff3355' }, { text: '90', color: '#e8ecf1d0' }]);
  assert.deepEqual(paintRing(shown({ wid: 'rifle', mag: 5, reserve: 90 })), { segments: 20, lit: 4, color: '#ff3355', outlined: 16 });
  assert.equal(paintRing(shown({ wid: 'revolver', mag: 1, reserve: 18 })).outlined, 5, 'IRONCLAD: the outline cue, its tint is near the red');
});
check(() => assert.deepEqual(paintTexts(shown({ wid: 'rifle', mag: 0, reserve: 90 })), ['00', 'RELOAD']));
check(() => assert.deepEqual(paintTexts(shown({ wid: 'rifle', mag: 0, reserve: 0 })), ['00', '0']));
// Reloading: RELOADING replaces the count, the ring fills white.
check(() => {
  const model = shown({ wid: 'rifle', mag: 0, reserve: 90, reloading01: 0.4 });
  assert.deepEqual(paintTexts(model), ['RELOADING', '90']);
  assert.deepEqual(paintRing(model), { segments: 20, lit: 8, color: '#ffffff', outlined: 0 });
});
// The weapon's own state runs on the ring: CR-6 charge, ARCHER lock (red once locked), the bolt / arc / pump cycle.
check(() => assert.deepEqual(paintRing(shown({ wid: 'chargerifle', mag: 3, reserve: 9, charge01: 0.5 })), { segments: 20, lit: 10, color: TINT('chargerifle'), outlined: 0 }));
check(() => assert.deepEqual(paintTexts(shown({ wid: 'chargerifle', mag: 3, reserve: 9, charge01: 0.5 })), ['3', '9']));
check(() => assert.deepEqual(paintRing(shown({ wid: 'archer', mag: 1, reserve: 4 }, 0.55)), { segments: 20, lit: 11, color: TINT('archer'), outlined: 0 }));
check(() => assert.deepEqual(paintRing(shown({ wid: 'archer', mag: 1, reserve: 4 }, 1)), { segments: 20, lit: 20, color: '#ff3355', outlined: 0 }));
check(() => assert.deepEqual(paintRing(shown({ wid: 'thunderbolt', mag: 4, reserve: 12, ready01: 0.5 })), { segments: 20, lit: 10, color: `${TINT('thunderbolt')}8c`, outlined: 0 }));
check(() => assert.deepEqual(paintRing(shown({ wid: 'kraber', mag: 3, reserve: 12, ready01: 0.3 })).lit, 6));

// 5. One mesh per gun, repainted only on change, removed and disposed with the gun.
{
  const bundle = buildGun('rifle', new MaterialCache());
  const model = shown({ wid: 'rifle', mag: 30, reserve: 90 });
  check(() => assert.equal(applyWeaponDisplay(bundle, 'rifle', model), true));
  const display = bundle.weaponDisplay;
  check(() => {
    assert.equal(display.mesh.parent, bundle.body);
    let meshes = 0;
    display.mesh.traverse(object => { if (object.isMesh) meshes++; });
    assert.equal(meshes, 1, 'one mesh per weapon');
    assert.deepEqual(display.mesh.geometry.groups.map(group => group.materialIndex), [0, 1], 'two draws: housing, screen');
    assert.equal(display.paints, 1);
  });
  applyWeaponDisplay(bundle, 'rifle', shown({ wid: 'rifle', mag: 30, reserve: 90 }));
  check(() => assert.equal(display.paints, 1, 'same values: no repaint'));
  applyWeaponDisplay(bundle, 'rifle', shown({ wid: 'rifle', mag: 29, reserve: 90 }));
  check(() => assert.equal(display.paints, 2, 'a shot repaints once'));
  applyWeaponDisplay(bundle, 'rifle', shown({ wid: 'smg', mag: 36, reserve: 108 }));
  check(() => assert.deepEqual([bundle.weaponDisplay, display.paints, display.shown.mag], [display, 2, 29], 'mid-swap the holstering gun keeps its paint'));
  let disposed = 0;
  display.mesh.geometry.addEventListener('dispose', () => disposed++);
  for (const material of display.mesh.material) material.addEventListener('dispose', () => disposed++);
  applyWeaponDisplay(bundle, 'rifle', null);
  check(() => assert.deepEqual([bundle.weaponDisplay, display.mesh.parent, disposed], [null, null, 3], 'null strips and disposes the panel'));
}
{
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
  rig.setWeapon('kraber');
  rig.setWeaponDisplay(shown({ wid: 'kraber', mag: 4, reserve: 12 }));
  for (let i = 0; i < 30; i++) rig.update(1 / 60, { grounded: true });
  const mesh = rig._cur.body.getObjectByName('weaponDisplay');
  check(() => assert.ok(mesh && rig.weaponDisplayLive, 'titanfall: the drawn kraber shows its panel'));
  rig.root.visible = false;
  check(() => assert.equal(rig.weaponDisplayLive, false, 'scoped / spectating / seated: the ammo card returns'));
  rig.root.visible = true;
  rig.setWeaponDisplay(null);
  check(() => assert.deepEqual([rig._cur.weaponDisplay, mesh.parent, rig.weaponDisplayLive], [null, null, false], 'leaving titanfall strips every panel'));
  rig.setWeapon('archer');
  rig.setWeaponDisplay(shown({ wid: 'archer', mag: 1, reserve: 4 }));
  for (let i = 0; i < 30; i++) rig.update(1 / 60, { grounded: true });
  check(() => assert.equal(rig.weaponDisplayLive, true, 'ARCHER from the hip: panel'));
  rig.ads(1);
  for (let i = 0; i < 90; i++) rig.update(1 / 60, { grounded: true });
  check(() => assert.equal(rig.weaponDisplayLive, false, 'ARCHER aiming: the housing hides the panel, the card returns'));
  let disposed = 0;
  rig._cur.weaponDisplay.mesh.geometry.addEventListener('dispose', () => disposed++);
  rig.dispose();
  check(() => assert.equal(disposed, 1, 'the panel is disposed with the rig'));
}

// 6. Tints are the style.css --w-* palette; titanfall.css hides the ammo card while a counter is live, on desktop and
// touch, and moves the desktop grenade card into the freed corner.
{
  const css = readFileSync(new URL('public/style.css', root), 'utf8');
  for (const [id, color] of Object.entries(WEAPON_TINT)) {
    const match = css.match(new RegExp(`--w-${id}:\\s*#([0-9a-f]{6})`, 'i'));
    check(() => assert.equal(match && parseInt(match[1], 16), color, `${id} tint matches --w-${id}`));
  }
  const tf = readFileSync(new URL('public/styles/titanfall.css', root), 'utf8');
  check(() => assert.match(tf, /^body\[data-titanfall-gun-display\] :is\(#ammo, #charge-meter\) \{ display: none !important; \}/m,
    'the card hides on desktop and touch'));
  check(() => assert.doesNotMatch(tf, /vb-touch-mode\) body\[data-titanfall-gun-display\] :is\(#ammo/, 'no desktop-only guard'));
  check(() => assert.match(tf, /html:not\(\.vb-touch-mode\) body\[data-titanfall-gun-display\] #grenade-count \{ right: 22px; \}/,
    'desktop: the grenade card takes the freed corner'));
  const ui = readFileSync(new URL('public/js/titanfall/titan-ui.js', root), 'utf8');
  check(() => assert.match(ui, /delete d\.body\.dataset\.titanfallGunDisplay/, 'titan-ui dispose drops the body flag'));
}

// 7. On screen. From the hip at FOV 65-100 in 16:9 (1920×1080) and 16:10 (1920×1200) every counter lies inside the
// view, below the aim point, above the bottom edge and clear of the bottom-right HUD block (the AT chip, right 22 px
// bottom 164 px, about 235 × 54 px, and the grenade card moved under it, right 22 px bottom 102 px). The rear counter
// sits closer to the eye than the old flank panel, so at the narrowest FOV (65) it reaches lower: the bottom bound
// there is -0.98 instead of -0.9 (the HUD block, not a bottom row, is what it must not cover). While aiming down
// sights every counter the sight picture does not hide (not scoped, not adsHidden) shows below the aim point.
const HUD_BLOCK = Object.freeze({ left: 1920 - 22 - 236, bottom: 164 + 56 });
for (const id of DISPLAY_WEAPONS) for (const fov of [65, 75, 100]) for (const [width, height] of [[1920, 1080], [1920, 1200]]) {
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  rig.setWeapon(id);
  rig.setWeaponDisplay(shown({ wid: id, mag: 1, reserve: 1 }));
  const step = () => { for (let i = 0; i < 60; i++) rig.update(1 / 60, { grounded: true, aimSwayScale: 0, reducedMotion: true }); };
  step();
  const panel = rig._cur.weaponDisplay?.mesh;
  const mount = rig._cur.body.userData.displayMount;
  const corners = () => {
    camera.updateMatrixWorld(true);
    panel.updateWorldMatrix(true, false);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]]
      .map(([u, v]) => new THREE.Vector3(u * mount.w / 2, v * mount.h / 2, 0).applyMatrix4(panel.matrixWorld).project(camera));
  };
  const hip = corners();
  check(() => {
    const where = `${id} fov ${fov} ${width}×${height}`;
    const bottom = fov < 75 ? -0.98 : -0.9;
    for (const corner of hip) {
      assert.ok(Math.abs(corner.x) < 0.95 && corner.y > bottom && corner.y < 0, `${where}: corner at ${corner.x.toFixed(2)}, ${corner.y.toFixed(2)}`);
    }
    const right = Math.max(...hip.map(corner => (corner.x + 1) / 2 * width));
    const low = Math.min(...hip.map(corner => (corner.y + 1) / 2 * height));
    assert.ok(right < HUD_BLOCK.left || low > HUD_BLOCK.bottom, `${where}: clear of the AT chip and grenade card (${right.toFixed(0)}, ${low.toFixed(0)} px)`);
  });
  if (fov === 75 && width === 1920 && height === 1080 && !WEAPONS[id].scoped && !mount.adsHidden) {
    camera.fov = WEAPONS[id].adsFov;
    camera.updateProjectionMatrix();
    rig.ads(1);
    step();
    const ads = corners();
    check(() => {
      const top = Math.max(...ads.map(corner => corner.y));
      const below = Math.atan(-top * Math.tan(camera.fov * Math.PI / 360)) * 180 / Math.PI;
      assert.ok(below > 0.8 && Math.min(...ads.map(corner => corner.y)) > -0.9 && ads.every(corner => Math.abs(corner.x) < 0.5),
        `${id} ADS: counter below the aim point (top ${below.toFixed(1)}° below)`);
    });
  }
  rig.dispose();
}

// 7b. Off the view's edge. A portrait phone (390×844) holds the gun at the right edge, where the counter falls off
// screen (all but the ARCHER, which its narrow pose moves inward): weaponDisplayLive stays false, so the ammo card
// keeps showing. Phone landscape (844×390) shows every counter. A reload dip does not re-measure, so the card never
// flickers in a reload.
for (const id of DISPLAY_WEAPONS) for (const [width, height] of [[844, 390], [390, 844]]) {
  const camera = new THREE.PerspectiveCamera(75, width / height, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  rig.setWeapon(id);
  rig.setWeaponDisplay(shown({ wid: id, mag: 1, reserve: 1 }));
  for (let i = 0; i < 60; i++) rig.update(1 / 60, { grounded: true, aimSwayScale: 0, reducedMotion: true });
  const share = weaponDisplayInView(rig._cur, camera);
  const expected = width > height || id === 'archer';
  check(() => assert.equal(rig.weaponDisplayLive, expected,
    `${id} ${width}×${height}: counter ${(share * 100).toFixed(0)} % in view, live ${rig.weaponDisplayLive}`));
  if (expected && id === 'rifle') {
    rig.reload(WEAPONS.rifle.reloadTime, 'magswap');
    let flips = 0;
    for (let i = 0, was = rig.weaponDisplayLive; i < WEAPONS.rifle.reloadTime * 60; i++) {
      rig.update(1 / 60, { grounded: true, aimSwayScale: 0, reducedMotion: true });
      if (rig.weaponDisplayLive !== was) { flips++; was = rig.weaponDisplayLive; }
    }
    check(() => assert.equal(flips, 0, `${id} ${width}×${height}: the reload keeps the counter live`));
  }
  rig.dispose();
}

// 8. titan-ui syncGunDisplay: the drawn pilot gun feeds the rig, the body flag follows weaponDisplayLive, the knife
// keeps the built panels, leaving the pilot layout strips them once, and dispose drops the flag.
{
  const { installFakeDom } = await import('./lib/conquest-ui-dom.mjs');
  installFakeDom({ width: 1920, height: 1080 });
  const contract = await import('../shared/titan-contract.js');
  const { titanfallHudFixtures, FIXTURE_NOW } = await import('../public/js/capture/titanfall-hud-fixtures.js');
  const ui = await import('../public/js/titanfall/titan-ui.js');
  const fixtures = titanfallHudFixtures();
  const pilot = fixtures.find(fixture => fixture.id === 'pilot-ready'), titan = fixtures.find(fixture => fixture.id === 'titan');
  const calls = [];
  const rig = { model: null, onScreen: true,
    setWeaponDisplay(model) { calls.push(model ? model.id : null); this.model = model; },
    get weaponDisplayLive() { return !!this.model && this.onScreen; } };
  const weapon = { wid: 'rifle', def: { id: 'rifle' },
    readDisplay(out) { return Object.assign(out, { wid: this.wid, mag: 9, reserve: 30, reloading01: null, reloadStaged: false, charge01: 0, ready01: 1 }); } };
  const app = { myId: 'me', net: { on: () => () => {}, sendTitanfall: () => true }, hud: { spectator: { setSuppressed() {} } }, rig, weapon,
    session: { gameplayInputEnabled: true, setOverlayBlock() {}, restoreGameplayFocus() {} }, input: { exit() {}, requestLock() {} } };
  let current = pilot;
  const client = { snapshot: () => current.snapshot, selfRow: () => current.self, selfTf: () => contract.decodeTitanfallPlayer(current.self),
    selfFrame: () => contract.decodeTitanfallSelf(current.tfs) };
  const step = () => { ui.tick(current.snapshot, 0); ui.frame(1 / 60, { nowMs: FIXTURE_NOW }); };
  const flag = () => document.body.dataset.titanfallGunDisplay;
  ui.init(app, client);
  step();
  check(() => assert.deepEqual([calls.at(-1), rig.model.mag, flag()], ['rifle', 9, ''], 'on foot: the rifle panel is fed, the card hides'));
  weapon.wid = 'archer';
  step();
  check(() => assert.deepEqual([rig.model.id, rig.model.lock], ['archer', 12], 'the ARCHER lock comes from tfs (0.6)'));
  rig.onScreen = false;
  step();
  check(() => assert.equal(flag(), undefined, 'panel off screen (scoped, third person): the card returns'));
  rig.onScreen = true;
  weapon.wid = 'knife';
  const before = calls.length;
  step();
  check(() => assert.deepEqual([calls.length, rig.model?.id, flag()], [before, 'archer', undefined], 'knife: panels kept, no strip, card back'));
  weapon.wid = 'rifle';
  step();
  check(() => assert.deepEqual([calls.at(-1), flag()], ['rifle', ''], 'back to the rifle'));
  current = titan;
  step();
  const stripped = calls.length;
  step();
  check(() => assert.deepEqual([calls.at(-1), calls.length, flag()], [null, stripped, undefined], 'in the titan: stripped once, card flag gone'));
  current = pilot;
  step();
  ui.dispose();
  check(() => assert.deepEqual([calls.at(-1), flag()], [null, undefined], 'dispose strips the panels and drops the flag'));
}

console.log(`titanfall weapon display: ${checks} checks passed`);
