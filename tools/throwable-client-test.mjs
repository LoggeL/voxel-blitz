import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../public/js/vendor/three.module.js';
import { FireFieldFX } from '../public/js/weapons/fire-fields.js';
import { Effects } from '../public/js/weapons/effects.js';
import { NetClient } from '../public/js/engine/netclient.js';
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
const Game = new Function('WEAPON_IDS', 'applySnapshotBlocks',
  `return (${mainSource.slice(classStart, classEnd)});`)(WEAPON_IDS, applySnapshotBlocks);

function effectFacade(scene) {
  const effects = Object.create(Effects.prototype);
  effects._disposed = false;
  effects._trauma = 0;
  effects.fireFields = new FireFieldFX(scene);
  for (const key of ['tracers', 'railBeams', 'flames', 'impacts', 'goreFx', 'brass', 'projectiles']) {
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
    clock: { stop() {} }, weaponWheel: { reset() {} }, _world: {},
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
    game.disposeLiveResources();
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

console.log('Throwable client: server-to-net-to-main fire snapshots, shared GPU bounds, epoch-safe animation, pause/resume, reconnect, disposal and expiry passed.');
