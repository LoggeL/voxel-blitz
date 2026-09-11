import { combatDamage } from '../shared/combat-balance.js';
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { Input } from '../public/js/engine/input.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { GameEngine } from '../server/game.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { updateTimers } from '../server/sim/movement.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { MINING_HITS, STONE } from '../shared/world/blocks.js';
import { QUICK_MELEE_SECONDS } from '../shared/quick-melee.js';

// Real keyboard edge -> player frame -> prediction -> serialized wire -> authority.
const input = new Input({});
input.fallback = true;
const press = (repeat = false) => input._onKeyDown({ code: 'KeyV', repeat, preventDefault() {} });
press(); input.getKeys();
assert.equal(input.consumeQuickMelee(), true, 'movement sampling cannot swallow V');
assert.equal(input.consumeQuickMelee(), false);
press(true); assert.equal(input.consumeQuickMelee(), false, 'holding V never repeats');
press(); input.setWeaponWheelOpen(true); input.setWeaponWheelOpen(false);
assert.equal(input.consumeQuickMelee(), false, 'wheel clears queued hits');
press(); input.clearTransient(); assert.equal(input.consumeQuickMelee(), false);
input.setGameplayEnabled(false); press(); input.setGameplayEnabled(true);
assert.equal(input.consumeQuickMelee(), false, 'menus cannot queue hits');

let now = 2000, connected = true;
const rig = new ViewmodelRig(new THREE.PerspectiveCamera());
rig.setWeapon('rifle');
for (let i = 0; i < 120; i++) rig.update(1 / 60);
const reports = [], wires = [];
const weapon = new WeaponState({ rig, now: () => now,
  audio: { draw() {}, reloadClick() {}, fire(id) { reports.push(id); } },
  effects: { shoot() {} }, feedback: { addExhaustion() {}, addRecoil() {} },
  network: { isRunning: () => true, isCurrentGeneration: () => true },
  setTimer: () => 0, clearTimer() {},
});
weapon.resetToLoadout();
const player = new LocalPlayer({ input, sendHz: 60, physics: {
  pos: { x: 20.5, y: 15.02, z: 23.5 }, vel: { x: 0, y: 0, z: 0 }, grounded: true,
  step: () => false, eyeY: () => 16.64, setMapMeta() {},
} });
player.setGameplayInputEnabled(true);
const net = { _seq: 0, _timing: { interpolationDelayMs: 100, rttMs: 0 },
  isOpen: () => connected, ws: { send: value => wires.push(JSON.parse(value)) } };
const frame = (allow = true) => player.update(1 / 60, now, { weapon,
  fireAllowed: allow, movementAllowed: true,
  onWeaponIntents: intents => weapon.applyIntents(intents, now, { allowFire: allow, alive: true }),
  beforeSend: () => weapon.tryFire(now, { allowFire: allow, alive: true, yaw: 0, pitch: 0 }),
  sendInput: wire => NetClient.prototype.sendInput.call(net, wire),
});
const originalAmmo = weapon.ammoOf('rifle');
press(); connected = false; frame();
assert.equal(rig._id, 'knife');
assert.ok(rig._swingT > 0, 'actual pickaxe animation starts');
assert.equal(weapon.slot, 0, 'selected weapon and quick-swap history remain intact');
assert.deepEqual(reports, ['knife']);
assert.deepEqual(weapon.ammoOf('rifle'), originalAmmo);
assert.equal(weapon.forceWeapon(1, { now }), false, 'cannot switch during the chop');
connected = true; now += 20; frame();
const hitWire = wires.at(-1);
assert.equal(hitWire.quickMelee, true, 'failed send retains the accepted hit');
assert.deepEqual(hitWire.meleeAim, { yaw: 0, pitch: 0 });
assert.equal(hitWire.wantFire, false, 'quick hit is never a gun shot');
now += 20; frame(); assert.equal(wires.at(-1).quickMelee, undefined, 'only sent once');
press(); frame(); assert.equal(reports.length, 1, 'spam inside recovery is dropped');
now += QUICK_MELEE_SECONDS * 1000;
frame(); assert.equal(rig._id, 'rifle', 'gun returns even after a stalled render');
assert.deepEqual(weapon.ammoOf('rifle'), originalAmmo);
// Interrupting a reload clears both presentation and predicted reload intent.
weapon._ammo.rifle.mag = 2;
assert.equal(weapon.startReload(now), true);
press(); frame(); assert.equal(weapon.reloadRequested, false);
assert.equal(rig._id, 'knife');
weapon.deathReset(); assert.equal(rig._id, 'rifle');
assert.equal(weapon.quickMeleeRequest, null);
player.dispose(); weapon.dispose(); rig.dispose(); input.dispose();

function harness() {
  const engine = new GameEngine();
  engine.addClient('miner', 'Miner');
  const p = engine.entities.get('miner');
  Object.assign(p, { x: 20.5, y: 15.02, z: 23.5, yaw: 0, pitch: 0, deployT: 0, cooldown: 0 });
  const blocks = new Map([['20,16,21', STONE]]), events = [], deltas = [];
  const key = (x,y,z) => `${x},${y},${z}`;
  const ctx = { now: 0, entities: engine.entities, blockHp: new Map(), blockMining: new Map(),
    canFire: p => p.state === 'alive', canDamage: (a,b) => a.id !== b.id, canUseWeapon: () => true,
    getBlock: (x,y,z) => blocks.get(key(x,y,z)) || 0,
    setBlock: (x,y,z,v) => blocks.set(key(x,y,z),v),
    solidAt: (x,y,z) => blocks.get(key(x,y,z)) || 0,
    pushEvent: ev => events.push(ev), pushBlockDelta: (...args) => deltas.push(args),
    killPlayer: victim => { victim.state = 'dead'; },
  };
  const tap = () => {
    engine.applyInput('miner', hitWire);
    // Release/look packets arriving in the same tick must retain the hit's aim.
    engine.applyInput('miner', { ...hitWire, quickMelee: false, yaw: Math.PI });
    p.yaw = Math.PI;
    resolveWeaponIntent(p, 0.05, ctx);
  };
  return { engine, p, ctx, events, deltas, tap, blocks };
}
{
  const h = harness(), ammo = h.p.mag.slice();
  for (let i = 0; i < MINING_HITS[STONE]; i++) {
    updateTimers(h.p, 0.61); h.ctx.now += 610; h.tap();
    assert.equal(h.p.weapon, 0);
  }
  assert.equal(h.deltas.length, 1, 'repeated V hits mine stone cumulatively');
  assert.equal(h.events.filter(e => e.kind === 'shoot').length, MINING_HITS[STONE]);
  assert.ok(h.events.filter(e => e.kind === 'shoot').every(e => e.w === 'knife'));
  assert.deepEqual(h.p.mag, ammo, 'server consumes no gun ammo');
  h.tap(); assert.equal(h.events.filter(e => e.kind === 'shoot').length, MINING_HITS[STONE]);
}
for (const blocked of ['vault', 'deploy', 'dead', 'grenade', 'mode']) {
  const h = harness();
  if (blocked === 'vault') h.p.vault = {};
  if (blocked === 'deploy') h.p.deployT = 1;
  if (blocked === 'dead') h.p.state = 'dead';
  if (blocked === 'grenade') h.p.grenadeHandlingQueued = true;
  if (blocked === 'mode') h.ctx.canFire = () => false;
  h.tap(); assert.equal(h.events.length, 0, `${blocked} rejects quick melee`);
  assert.equal(h.p.quickMeleeQueued, null, 'blocked hits cannot fire later');
}
{
  const h = harness(); h.engine.addClient('victim', 'Victim');
  const v = h.engine.entities.get('victim');
  Object.assign(v, { x: h.p.x, y: h.p.y, z: h.p.z - 1.3, yaw: Math.PI, pitch: 0 });
  h.tap(); assert.equal(v.hp, 100 - combatDamage(WEAPONS.knife.damage[0]), 'nearby enemy takes pickaxe damage');
  assert.equal(h.events.some(e => e.kind === 'mine'), false, 'enemy hit takes priority over mining');
  updateTimers(h.p, 0.61); h.blocks.set('20,16,22', STONE); h.tap();
  assert.equal(v.hp, 100 - combatDamage(WEAPONS.knife.damage[0]), 'wall blocks melee damage');
}
{
  const h = harness(); h.p.chaosUpgrades = { knife: 1, rifle: 3 };
  let blasts = 0; h.ctx.chaosBlast = () => blasts++;
  h.tap(); assert.equal(blasts, 1, 'quick hit uses pickaxe Chaos upgrades');
}
console.log('Quick melee: keyboard lifecycle, full client/wire/server flow, animation return, reload interruption, mining, damage, cover, cooldown and mode gates passed.');
