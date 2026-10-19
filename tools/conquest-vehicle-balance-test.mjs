// Vehicle pack balance gate (docs/conquest.md "Vehicle balance"): pins the
// audited outcomes of the 2026-10-19 pack against its counters, through the
// authoritative server on flat fixtures (tools/lib/vehicle-balance.mjs). The
// full report with the bot-match tally is tools/conquest-vehicle-balance.mjs.
import assert from 'node:assert/strict';
import {
  BALANCE_WEAPONS, SECTORS, damageRig, hitsToKill, shotTimes, beamTrial, targetPath, mineTrial, bombSortie,
} from './lib/vehicle-balance.mjs';
import { VEHICLE_WEAPONS } from '../shared/vehicle-defs.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };
const rig = damageRig();
const kill = (weapon, type, sector = 'side', runs = 60) => hitsToKill(BALANCE_WEAPONS[weapon], type, SECTORS[sector], { rig, runs });
const near = (value, want, slack, message) => assert(Math.abs(value - want) <= slack, `${message}: ${value.toFixed(2)} vs ${want.toFixed(2)} ±${slack}`);
const rate = r => r.hits / Math.max(1, r.settled);

test('hits to kill: the pack weapons sit beside the RX-8, the STINGER and the AP shell', () => {
  for (const weapon of ['towMissile', 'guidedMissile', 'rocket', 'tankAP', 'atmine', 'jetBomb']) {
    for (const type of ['jeep', 'jeep_at']) assert.equal(kill(weapon, type, 'side', 5).kill, 1, `one ${weapon} wrecks a ${type}`);
  }
  for (const weapon of ['towMissile', 'guidedMissile', 'rocket']) assert.equal(kill(weapon, 'helicopter', 'side', 5).kill, 3, `${weapon}: three on a helicopter`);
  assert.equal(kill('stinger', 'helicopter', 'side', 5).kill, 2);
  assert.equal(kill('stinger', 'plane', 'side', 5).kill, 3);
  assert.equal(kill('aaMissile', 'helicopter', 'side', 5).kill, 2);
  assert.equal(kill('jetBomb', 'helicopter', 'side', 5).kill, 1, 'a bomb on an airframe');
  // The guided missiles carry a 360 warhead against the RX-8's 380: a hair more hits on the tank, never a different count class.
  for (const sector of ['front', 'side', 'rear']) {
    const tow = kill('towMissile', 'tank', sector, 150).kill, rx8 = kill('rocket', 'tank', sector, 150).kill, ap = kill('tankAP', 'tank', sector, 150).kill;
    near(tow, rx8, 0.4, `TOW vs RX-8 on the tank ${sector}`);
    assert(tow >= ap, `the TOW is no better than the AP shell on the tank ${sector} (${tow.toFixed(2)} vs ${ap.toFixed(2)})`);
  }
  const mine = kill('atmine', 'tank', 'side', 20);
  assert.deepEqual([mine.disable, mine.kill], [1, 2], 'one mine cripples a tank, two destroy it');
  assert.equal(kill('guidedMissile', 'tank', 'side', 5).rico >= 0, true);
});

test('cadence: the TOW box and the guided rails fire on the authoritative timers', () => {
  const tow = BALANCE_WEAPONS.towMissile.cadence, gm = BALANCE_WEAPONS.guidedMissile.cadence;
  assert.deepEqual([1, 2, 3, 4].map(n => shotTimes(tow, n)), [0, tow.cooldown, 2 * tow.cooldown, 2 * tow.cooldown + tow.reload]);
  assert.deepEqual([1, 2, 3, 4].map(n => shotTimes(gm, n)), [0, gm.cooldown, gm.rearm, gm.rearm + gm.cooldown]);
  assert.equal(shotTimes(BALANCE_WEAPONS.rocket.cadence, 6), Infinity, 'an Engineer carries five rockets');
});

test('beam: lead short enough that a perfectly tracked missile catches crossing armour', () => {
  for (const key of ['towMissile', 'guidedMissile']) assert(VEHICLE_WEAPONS[key].beam.lead <= 10, `${key} beam lead`);
  const tow = beamTrial({ shooterType: 'jeep_at', targetType: 'tank', path: targetPath({ speed: 10, range: 300 }), seconds: 40 });
  assert(rate(tow) >= 0.9, `ideal TOW vs a tank crossing at 10 m/s, 300 m: ${tow.hits}/${tow.settled}`);
  const gm = beamTrial({ shooterType: 'helicopter', targetType: 'jeep', path: targetPath({ speed: 15, range: 200 }), seconds: 40 });
  assert(rate(gm) >= 0.9, `ideal GUIDED MSL vs a jeep crossing at 15 m/s, 200 m: ${gm.hits}/${gm.settled}`);
  // A jeep flat out across the line of sight still slips the slower TOW (lag = lead x 20 / 65 m/s, 2.5 m).
  const fast = beamTrial({ shooterType: 'jeep_at', targetType: 'jeep', path: targetPath({ speed: 20, range: 120 }), seconds: 40 });
  assert(rate(fast) <= 0.7, `a 20 m/s broadside jeep evades most TOWs: ${fast.hits}/${fast.settled}`);
});

test('beam: the bot gunner sights the hull (no lead) and keeps the missile on it until it lands', () => {
  const tow = beamTrial({ shooterType: 'jeep_at', targetType: 'tank', operator: 'bot', path: targetPath({ speed: 8, range: 100 }), seconds: 45 });
  assert(tow.settled >= 6 && rate(tow) >= 0.8, `bot TOW vs a tank crossing at 8 m/s, 100 m: ${tow.hits}/${tow.settled}`);
  let riding = 0, switched = 0;
  const gm = beamTrial({ shooterType: 'helicopter', targetType: 'tank', operator: 'bot', path: targetPath({ speed: 8, range: 200 }), seconds: 45,
    onTick: ({ game, shooter, gunner, input }) => {
      const flying = [...game.projectiles.active.values()].some(r => r.beam?.operatorId === String(gunner.id));
      if (!flying) return;
      riding++;
      if (input.vehicleAction?.type === 'weapon' || (input.wantFire && shooter.sel?.gunner !== 1)) switched++;
    } });
  assert(gm.settled >= 4 && rate(gm) >= 0.5, `bot GUIDED MSL vs a tank crossing at 8 m/s, 200 m: ${gm.hits}/${gm.settled}`);
  assert(riding > 60, 'the missiles were in flight');
  assert.equal(switched, 0, 'no weapon switch or chin cannon fire while a missile rides the sight');
});

test('AT mine: a driven-over tank takes the belly charge; a side-by-side pair destroys it; a fast jeep dies', () => {
  for (const speed of [3, 13]) {
    const one = mineTrial({ type: 'tank', speed });
    assert(one.detonated === 1 && one.lost >= 600 && one.disabled && !one.destroyed, `one mine at ${speed} m/s: ${JSON.stringify(one)}`);
    const track = mineTrial({ type: 'tank', speed, offset: 1.5 });
    assert(track.lost >= 600 && track.disabled, `a mine under the track at ${speed} m/s: ${JSON.stringify(track)}`);
  }
  const skirt = mineTrial({ type: 'tank', speed: 8, offset: 2.05 });
  assert(skirt.detonated === 1 && skirt.tracks && !skirt.disabled, `a mine at the skirt breaks the tracks: ${JSON.stringify(skirt)}`);
  const pair = mineTrial({ type: 'tank', speed: 8, mines: 2, spacing: 1.2, across: true, offset: -0.6 });
  assert(pair.destroyed, `two mines side by side: ${JSON.stringify(pair)}`);
  const jeep = mineTrial({ type: 'jeep', speed: 24 });
  assert(jeep.detonated === 1 && jeep.destroyed, `a jeep at full speed: ${JSON.stringify(jeep)}`);
  const beside = mineTrial({ type: 'jeep', speed: 12, offset: 1.6 });
  assert.equal(beside.detonated, 0, 'a mine beside the wheels stays live');
});

test('bombs: one two-bomb pass kills most of a squad standing within 6 m', () => {
  let dead = 0;
  for (const seed of [1, 2, 3]) {
    const r = bombSortie({ squad: 4, spread: 6, error: 0, seed });
    assert.equal(r.fired, 2, 'both bombs released');
    dead += r.dead;
  }
  assert(dead / 3 >= 2, `dead of four per pass: ${(dead / 3).toFixed(2)}`);
});

console.log(`conquest vehicle balance test: ${passed} passed`);
