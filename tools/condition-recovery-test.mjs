import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { PlayerEntity } from '../server/sim/player.js';
import { updateCondition } from '../server/sim/movement.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { AimSway } from '../public/js/player/aim-sway.js';
import { BreathHold, recoverConditions } from '../shared/conditions.js';
import { CONDITION_RULES, WEAPONS, computeSpreadConeDeg } from '../shared/combatmath.js';

const spawn = { x: 4, y: 1, z: 4, index: 0 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
function server(shift = false, crouch = false) {
  const p = new PlayerEntity('p', 'P', spawn, false);
  Object.assign(p, { hp: 25, panic: 1, pain: 1, grounded: true, ads: true,
    adsT: 1, deployT: 0, crouch, input: { keys: { sprint: shift } } });
  return p;
}
for (const hz of [30, 60, 144]) {
  const resting = server(); const steady = server(true); const crouched = server(true, true);
  for (let i = 0; i < hz; i++) {
    for (const p of [resting, steady, crouched]) updateCondition(p, 1 / hz);
  }
  assert.ok(crouched.panic < steady.panic && steady.panic < resting.panic);
  for (let i = 0; i < hz; i++) updateCondition(resting, 1 / hz);
  close(resting.panic, 0.88); close(resting.pain, 0.545);
  for (let i = 0; i < hz * 2; i++) updateCondition(resting, 1 / hz);
  close(resting.panic, 0.76); close(resting.pain, 0.3175);
  for (let i = 0; i < hz * 16; i++) updateCondition(resting, 1 / hz);
  close(resting.panic, 0);
  assert.ok(resting.pain > 0.09 && resting.pain < 0.091,
    'pain approaches its injury floor without crossing it');
  for (let i = 0; i < hz * 5; i++) updateCondition(steady, 1 / hz);
  assert.equal(steady.breath.exhausted, true);
  assert.equal(steady.breath.holding, false);
  assert.equal(steady.breath.reserve, 0);
}
// Authority and local prediction integrate the same action and condition state.
for (const hz of [30, 60, 144]) {
  const p = server(true, true);
  const local = { _alive: true, _hp: 25, panic: 1, pain: 1, exhaustion: 0, burning: 0,
    keys: { sprint: true, crouch: true }, physics: { _crouching: true } };
  const sway = new AimSway();
  for (let frame = 0; frame < hz * 8; frame++) {
    const pressed = frame < hz * 3 || frame > hz * 6;
    p.input.keys.sprint = pressed;
    local.keys.sprint = pressed;
    updateCondition(p, 1 / hz);
    local._aim = sway.update(1 / hz, { grounded: true, stationary: true,
      shift: pressed, crouching: true, panic: local.panic, pain: local.pain, ads: 1 });
    LocalPlayer.prototype._updateConditionEstimates.call(local, 1 / hz, false);
    close(local.panic, p.panic); close(local.pain, p.pain);
    close(sway.breath.reserve, p.breath.reserve);
  }
}
for (const changes of [ { grounded: false }, { reloading: true }, { adsT: 0.4 },
  { deployT: 1 }, { vault: {} }, { vx: 1 },
  { input: { keys: { sprint: true }, reload: true } },
  { input: { keys: { sprint: true }, switchTo: 1 } }, { input: { keys: { sprint: true, f: true } } } ]) {
  const p = Object.assign(server(true), changes);
  updateCondition(p, 1 / 60);
  assert.equal(p.breath.holding, false, JSON.stringify(changes));
  close(p.breath.reserve, 1);
}
const calmBreath = new BreathHold(); const injuredBreath = new BreathHold();
calmBreath.update(.1, { eligible: true, pressed: true });
injuredBreath.update(.1, { eligible: true, pressed: true, panic: 1, pain: 1 });
close(calmBreath.reserve, injuredBreath.reserve);
const p = server(); p.armor = 15; p.pain = 0;
p.takeDamage(20); close(p.pain, 5 * .012);
p.applySpawn(spawn); close(p.breath.reserve, 1); assert.equal(p.breath.exhausted, false);
const condition = { panic: 1, pain: 1, exhaustion: 0 };
recoverConditions(condition, 10, { hp: 25, burning: 1 });
assert.ok(condition.panic > 0, 'active flames retain an immediate danger floor');
for (const def of Object.values(WEAPONS)) {
  const calm = computeSpreadConeDeg(def, 0, 0, 1);
  const hurt = computeSpreadConeDeg(def, 0, 0, 1, 1, 0, false, 1);
  assert.ok(hurt - calm < .13, `${def.id} keeps a deliberate ADS countershot possible`);
}

// Residual ADS during weapon deploy cannot allow local recovery.
const deployGetter = Object.getOwnPropertyDescriptor(WeaponState.prototype, 'isDeploying').get;
assert.equal(deployGetter.call({ _now: () => 50, _deployUntil: 100 }), true);
assert.equal(deployGetter.call({ _now: () => 100, _deployUntil: 100 }), false);

// Real network normalization and tick ordering: a pending switch must stop the
// recovery bonus before resolveWeaponIntent applies the new weapon later in tick.
{
  const engine = new GameEngine();
  engine.addClient('steady', 'Steady');
  const p = engine.entities.get('steady');
  Object.assign(p, { panic: 1, grounded: true, ads: true, adsT: 1, deployT: 0 });
  const input = { keys: { sprint: true }, wantAds: true, weapon: p.weapon };
  engine.applyInput(p.id, input);
  engine.step(20);
  assert.equal(p.breath.holding, true, 'stationary ADS and Shift engage authoritative recovery');
  const reserve = p.breath.reserve;
  const panic = p.panic;
  engine.applyInput(p.id, { ...input, weapon: (p.weapon + 1) % 12 });
  assert.equal(p.input.switchTo, 1, 'wire weapon is normalized to switchTo');
  engine.step(20);
  assert.equal(p.breath.holding, false, 'pending normalized switch cancels same tick');
  close(p.breath.reserve, reserve);
  close(p.panic, panic - CONDITION_RULES.panicDecayPerS * .02);
}

console.log('Conditions: low-health recovery, finite steady action, crouch, authority/prediction parity, eligibility, armor wounds and bounded spread passed.');
