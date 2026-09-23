import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../public/js/vendor/three.module.js';
import { FireFieldFX } from '../public/js/weapons/fire-fields.js';
import { Effects } from '../public/js/weapons/effects.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { FrameRateController } from '../public/js/engine/frame-rate.js';
import { sfx } from '../public/js/audio/sfx.js';
import { GameplayUiFlow } from '../public/js/session/gameplay-ui.js';
import { applySnapshotBlocks } from '../public/js/combat/feedback.js';
import { MolotovFireSystem } from '../server/sim/molotov-fire.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { MOLOTOV_FIRE } from '../shared/molotov-rules.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

const EPOCH = Date.UTC(2026, 8, 8, 12);
const near = (a, b, message) => assert(Math.abs(a - b) < 1e-5, `${message}: ${a} vs ${b}`);

function serverFieldSnapshot(at = EPOCH) {
  const fire = new MolotovFireSystem();
  fire.ignite({ id: 'bottle-1', ownerId: 'owner', x: 20.25, y: 1.17, z: 20.5 }, {
    now: at, entities: new Map(), canAffectWorld: () => true,
    getBlock: (_x, y) => y === 0 ? 1 : 0,
  });
  return makeSnapshot([], [], [], at, undefined, [], [], fire.snapshot());
}

// Use the exact Game methods, without starting its browser/UI constructor.
// The actual network, snapshot, effect, and gameplay-input lifecycle modules run below.
const mainSource = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
const classStart = mainSource.indexOf('class Game {');
const classEnd = mainSource.indexOf('\nconst debugParams =', classStart);
assert(classStart >= 0 && classEnd > classStart, 'composition root class can be isolated from browser startup');
const { copySmokeFields } = await import('../shared/smoke-rules.js');
const Game = new Function('WEAPON_IDS', 'applySnapshotBlocks', 'copySmokeFields', 'nowMs', 'sfx',
  `return (${mainSource.slice(classStart, classEnd)});`)(WEAPON_IDS, applySnapshotBlocks, copySmokeFields, () => performance.now(), sfx);

function effectFacade(scene) {
  const effects = Object.create(Effects.prototype);
  effects._disposed = false;
  effects._trauma = 0;
  effects.fireFields = new FireFieldFX(scene);
  for (const key of ['tracers', 'railBeams', 'flames', 'impacts', 'goreFx', 'brass', 'projectiles', 'popLines']) {
    effects[key] = { update() {}, dispose() {} };
  }
  return effects;
}

// Wire snapshots, including immutable nested cells, are sufficient for a late join.
{
  const scene = new THREE.Scene();
  const fx = new FireFieldFX(scene);
  const net = new NetClient();
  try {
    const authoritative = serverFieldSnapshot();
    net._onTick(JSON.parse(JSON.stringify(authoritative)));
    const snapshot = net.latestSnapshots.at(-1);
    assert.equal(snapshot.events.length, 0, 'late-join fixture has no historical ignition event');
    assert.equal(snapshot.serverNow, EPOCH, 'wire epoch survives the local network timeline mapping');
    assert(Object.isFrozen(snapshot.fireFields[0].cells[0]));
    fx.sync(snapshot.fireFields, snapshot.serverNow);
    assert.equal(fx.fields.size, 1);
    assert.equal(fx.geometry.instanceCount, authoritative.fireFields[0].cells.length * 2);
    assert.equal(fx.centers.count, MOLOTOV_FIRE.maxFields * MOLOTOV_FIRE.maxCells * 2);
    assert.equal(fx.material.depthTest, true, 'existing terrain occludes fire');
    assert.equal(fx.material.depthWrite, false);
    const centers = fx.centers.array.slice(0, fx.geometry.instanceCount * 3);
    assert(centers.every(Number.isFinite));
    assert.equal(scene.children.filter(child => child.name === 'molotov-ground-fire').length, 1);

    const gpuTimeBefore = Math.fround(fx.material.uniforms.time.value);
    fx.update(1 / 60);
    const gpuTimeAfter = Math.fround(fx.material.uniforms.time.value);
    assert(gpuTimeAfter > gpuTimeBefore && gpuTimeAfter < 1,
      'GPU Float32 time advances at 60 FPS even when server timestamps use epoch milliseconds');
    assert.notDeepEqual(fx.centers.array.slice(0, centers.length), centers,
      'visible flame heights also animate between frames');
    fx.sync(snapshot.fireFields, EPOCH + 50);
    assert.equal(Math.fround(fx.material.uniforms.time.value), gpuTimeAfter,
      'new authority timestamps do not jump or reset the animation phase');
    fx.update(1000);
    assert.equal(fx.geometry.instanceCount, 0, 'a long suspended frame retires expired fire');
    assert(fx.material.uniforms.time.value < 1, 'animation time remains bounded after long runtime');

    fx.sync(authoritative.fireFields, EPOCH + MOLOTOV_FIRE.durationMs - 500);
    assert(fx.geometry.instanceCount > 0, 'late sync restores still-live fire from the snapshot alone');
    assert(fx.shapes.getW(0) > 0 && fx.shapes.getW(0) < 1, 'last half-second fades visibly');
    fx.update(0.5);
    assert.equal(fx.fields.size, 0); assert.equal(fx.geometry.instanceCount, 0);
  } finally { fx.dispose(); }
}

// Oversized/malformed snapshots cannot exceed the shared renderer/server budget.
{
  const scene = new THREE.Scene();
  const fx = new FireFieldFX(scene);
  try {
    const row = serverFieldSnapshot().fireFields[0];
    const manyCells = Array.from({ length: MOLOTOV_FIRE.maxCells + 30 }, (_, i) => [i + 0.5, 1.04, 20.5]);
    const manyFields = Array.from({ length: MOLOTOV_FIRE.maxFields + 10 }, (_, i) => ({
      ...row, id: `field-${i}`, cells: manyCells,
    }));
    fx.sync(manyFields, EPOCH);
    assert.equal(fx.fields.size, MOLOTOV_FIRE.maxFields);
    assert.equal(fx.geometry.instanceCount, fx.centers.count);
    assert([...fx.fields.values()].every(field => field.cells.length === MOLOTOV_FIRE.maxCells));
    fx.sync([{ ...row, cells: [[1, 2, 3], [NaN, 2, 3], [1, 2], null] },
      { ...row, id: 'invalid', x: Infinity }, { ...row, id: 'expired', expiresAt: EPOCH }], EPOCH);
    assert.equal(fx.fields.size, 1); assert.equal(fx.geometry.instanceCount, 2);
    for (const empty of [[], undefined, null]) {
      fx.sync([row], EPOCH); assert(fx.geometry.instanceCount > 0);
      fx.sync(empty, EPOCH);
      assert.equal(fx.fields.size, 0); assert.equal(fx.geometry.instanceCount, 0);
    }
  } finally { fx.dispose(); }
  assert.equal(scene.children.length, 0, 'disposing removes the shared fire draw from the scene');
}

// Real main and Effects methods reconcile fire while paused and across a new session.
{
  const scene = new THREE.Scene();
  const net = new NetClient();
  const game = Object.create(Game.prototype);
  let inputEnabled = false;
  const hud = { settingsOpen: false, isBuyMenuOpen: () => false,
    openSettings() { this.settingsOpen = true; }, closeSettings() { this.settingsOpen = false; },
    toggleBuyMenu() {}, setMatchState() {} };
  Object.assign(game, { running: true, _loopGeneration: 0, _rafId: 0,
    _lastConsumedSnapSeq: null, _pendingAuthoritativeSnapshots: [], hud,
    clock: { stop() {} }, frameRate: new FrameRateController(), weaponWheel: { reset() {} }, _world: {},
    player: { alive: true, reconcile: () => ({}), resetForMenu() {} },
    effects: effectFacade(scene),
    session: { net, myId: 'self', phase: 'booting', baseFov: 75, confirmPurchase: () => null,
      syncBuyMenuState() {}, restoreGameplayFocus() {} },
  });
  const lifecycle = { liveActive: true, phase: 'live', disconnected: false, tornDown: false };
  const flow = new GameplayUiFlow({ hud, gameplay: { running: true, alive: true }, lifecycle,
    input: { setGameplayEnabled: value => { inputEnabled = value; }, consumeBuyMenuRequest() {}, requestLock() {} },
    unlockAudio() {} });
  net.on('tick', snapshot => game.handleTick(snapshot));
  try {
    const row = serverFieldSnapshot().fireFields[0];
    const deliver = (at, fields) => net._onTick(makeSnapshot([], [], [], at, undefined, [], [], fields));
    deliver(EPOCH, [row]);
    assert.equal(game.effects.fireFields.fields.size, 0, 'boot snapshots queue before scene activation');
    assert.equal(game._pendingAuthoritativeSnapshots.length, 1);
    game.session.phase = 'live';
    game.flushPendingAuthoritativeSnapshots();
    game.consumeLatestAuthoritativeState();
    assert.equal(game.effects.fireFields.fields.size, 1, 'boot queue and latest state restore one field without duplicates');
    flow.syncInput(); assert.equal(inputEnabled, true);
    assert.equal(flow.pauseFromKeyboard(), true); assert.equal(inputEnabled, false);
    assert.equal(hud.settingsOpen, true);
    deliver(EPOCH + 100, []);
    assert.equal(game.effects.fireFields.fields.size, 0, 'pause does not freeze authoritative hazard clearing');
    deliver(EPOCH + 200, [row]);
    assert.equal(game.effects.fireFields.fields.size, 1, 'new fire appears behind an open pause menu');
    flow.resumeFromSettings(); assert.equal(inputEnabled, true);
    assert.equal(game.effects.fireFields.fields.size, 1, 'resume retains already reconciled live hazards');

    const oldFx = game.effects.fireFields;
    const oldEffects = game.effects;
    let geometryDisposals = 0, materialDisposals = 0;
    oldFx.geometry.addEventListener('dispose', () => geometryDisposals++);
    oldFx.material.addEventListener('dispose', () => materialDisposals++);
    for (let i = 0; i <= 120; i++) {
      game.frameRate.begin(i * 1000 / 60); game.frameRate.end(2);
    }
    assert.equal(game.frameRate.snapshot.ready, true);
    game.disposeLiveResources();
    assert.equal(game.frameRate.snapshot.ready, false, 'teardown discards the previous match frame timings');
    assert.equal(oldFx.fields.size, 0); assert.equal(oldFx.mesh.parent, null);
    assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1);
    assert.equal(game._lastConsumedSnapSeq, null, 'new connection may restart snapshot sequence numbers');
    oldEffects.syncFireFields([row], EPOCH + 300);
    oldEffects.update(0.01); oldEffects.dispose();
    assert.equal(oldFx.fields.size, 0, 'late callbacks cannot resurrect disposed fire');
    assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1);

    net._resetSessionState(true);
    game.running = true;
    game.effects = effectFacade(scene);
    deliver(EPOCH + 300, [row]);
    assert.equal(game.effects.fireFields.fields.size, 1,
      'reconnecting recovers fire from a new sequence without an explosion event');
    const remoteClock = game.effects.fireFields.now;
    game.effects.update(0.05, 8);
    near(game.effects.fireFields.now - remoteClock, 8000, 'effects forwards real elapsed time during a suspended frame');
    assert.equal(game.effects.fireFields.fields.size, 0, 'clock expiry works if the connection stops delivering');
  } finally { game.effects?.dispose(); }
}

// World preview: the landing zone is the shared effect radius, bounces are marked,
// the arc reads through cover, and a cooked frag bursting mid-air ends dotted.
{
  const { ProjectileFX } = await import('../public/js/weapons/projectiles.js');
  const { grenadeEffectRadius, predictGrenadePath } = await import('../shared/grenade-rules.js');
  const scene = new THREE.Scene();
  const floor = (_x, y) => (y < 1 ? 1 : 0);
  const fx = new ProjectileFX(scene, floor);
  try {
    const launch = { type: 'frag', x: 4, y: 2.6, z: 4, vx: 0, vy: 4, vz: -9 };
    const shown = fx.setPreview(launch);
    const expected = predictGrenadePath(launch, floor, { maxPoints: 96 });
    assert(shown.bounces.length > 0, 'a frag at the floor bounces');
    const dots = fx.bounceDots.filter(dot => dot.visible);
    assert.equal(dots.length, Math.min(fx.bounceDots.length, expected.bounces.length));
    assert.deepEqual(dots[0].position.toArray(), expected.bounces[0], 'bounce dots sit on the shared prediction');
    assert.equal(fx.landingRing.scale.x, grenadeEffectRadius('frag'), 'landing zone is the blast radius');
    assert.equal(fx.landingDisc.parent, fx.landingRing, 'translucent disc scales with the ring');
    assert.equal(fx.previewGhost.visible, true);
    assert.equal(fx.previewGhostMaterial.depthTest, false, 'ghost arc reads through walls');
    assert.equal(fx.previewGhostMaterial.opacity, 0.25);
    assert.equal(fx.previewGhost.geometry, fx.previewLine.geometry, 'ghost shares the live arc');
    assert.equal(fx.previewTail.visible, false, 'a resting frag has no mid-air tail');
    assert.equal(fx.previewLine.geometry.drawRange.count, shown.points.length);

    fx.setPreview({ ...launch, type: 'molotov', effectRadius: 4.2 });
    assert.equal(fx.landingRing.scale.x, 4.2, 'a supplied chaos-scaled effect radius wins');
    fx.setPreview({ ...launch, type: 'smoke', chaosLevel: 1 });
    assert.equal(fx.landingRing.scale.x, grenadeEffectRadius('smoke', 1));
    assert.equal(fx.bounceDotMaterial.color.getHex(), fx.previewMaterial.color.getHex(), 'marks follow the type colour');

    const airburst = fx.setPreview({ ...launch, vy: 9, fuseMs: 400 });
    assert.equal(airburst.rests, false);
    const line = fx.previewLine.geometry.drawRange.count;
    const tail = fx.previewTail.geometry.drawRange;
    assert.equal(fx.previewTail.visible, true, 'a cooked frag bursting mid-air ends in a dotted tail');
    assert(fx.previewTailMaterial.opacity < fx.previewMaterial.opacity && fx.previewTailMaterial.dashSize < fx.previewMaterial.dashSize);
    assert.equal(tail.start, line - 1, 'the tail continues from the last bright point');
    assert.equal(tail.start + tail.count, airburst.points.length, 'bright arc plus tail cover the whole path');
    fx.setPreview({ ...launch, type: 'pulse', vy: 9, fuseMs: 400 });
    assert.equal(fx.previewTail.visible, false, 'only cook types show the mid-air tail');

    fx.setPreview({ ...launch, type: 'limpet', n: [0, 0, 1] });
    assert(!fx.previewLine.visible && !fx.previewGhost.visible && !fx.landingRing.visible
      && fx.bounceDots.every(dot => !dot.visible), 'the claymore ghost replaces the arc');
    fx.setPreview(launch);
    fx.setPreview(null);
    assert(!fx.previewLine.visible && !fx.previewGhost.visible && !fx.previewTail.visible
      && !fx.landingRing.visible && fx.bounceDots.every(dot => !dot.visible), 'release hides every preview part');
  } finally { fx.dispose(); }
  for (const part of [fx.previewGhost, fx.previewTail, fx.landingRing, ...fx.bounceDots]) {
    assert.equal(part.parent, null, 'disposal detaches every preview part');
  }
}

console.log('Throwable client: server-to-net-to-main fire snapshots, shared GPU bounds, epoch-safe animation, pause/resume, reconnect, disposal and expiry, and the effect-radius world preview passed.');
