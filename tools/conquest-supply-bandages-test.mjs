// Conquest bandages (docs/conquest.md "Infantry supply" > Bandages): a fresh
// Conquest life carries BANDAGE_RULES.count bandages, each +hp after `seconds`
// standing still with the medkit's cancel rules; every other mode keeps the one
// full-heal medkit. Covers the mode rule, the server sim, the snapshot row, the
// Medic aura and ADRENALINE restocks, the client prediction state and the bots'
// threshold.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameEngine } from '../server/game.js';
import { PlayerEntity } from '../server/sim/player.js';
import { updateMedkit, interruptMedkit } from '../server/sim/medkit.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { createConquestRoles } from '../server/modes/conquest/roles.js';
import { CONQUEST_RULES } from '../shared/conquest-contract.js';
import { KIT_ROLE_RULES } from '../shared/conquest-kits.js';
import { BANDAGE_RULES } from '../shared/supply.js';
import { CONQUEST_MEDKIT_RULES, MEDKIT_RULES, MEDKIT_SECONDS, medkitRulesFor } from '../shared/medkit.js';
import { MedkitState } from '../public/js/player/medkit-state.js';

const DIMS = { sx: 256, sy: 64, sz: 256 };
const TICK = 1000 / 60;
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

// ------------------------------------------------------------ mode rule --
eq([CONQUEST_MEDKIT_RULES.count, CONQUEST_MEDKIT_RULES.hp, CONQUEST_MEDKIT_RULES.seconds], [BANDAGE_RULES.count, BANDAGE_RULES.hp, BANDAGE_RULES.seconds],
  'the Conquest kit rule is BANDAGE_RULES');
eq(medkitRulesFor('conquest'), CONQUEST_MEDKIT_RULES, 'Conquest (and its Breakthrough variant) carry bandages');
for (const mode of ['fun', 'tdm', 'gungame', 'snd', 'ttt', 'titanfall', 'bastion', 'training', undefined]) {
  eq(medkitRulesFor(mode), MEDKIT_RULES, `${mode ?? 'no mode'} keeps the one full-heal medkit`);
}
eq([MEDKIT_RULES.count, MEDKIT_RULES.seconds], [1, MEDKIT_SECONDS]);

// ------------------------------------------------------- engine wiring --
function engine(mode, extra = {}) {
  const dimensions = { sx: 256, sy: 64, sz: 256 };
  const world = { dimensions, getBlock: (_x, y) => (y === 0 ? 3 : 0), setBlock: () => true, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  return new GameEngine({ mode, world, broadcast: () => {}, ...extra,
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] }, fun: [{ x: 20, y: 1, z: 20 }] },
      conquest: { flags: [], bases: {}, vehicleSpawns: [] } } });
}
{
  const cq = engine('conquest');
  cq.addClient('h', 'H');
  const human = cq.entities.get('h');
  eq(human.medkitRules, CONQUEST_MEDKIT_RULES, 'a Conquest room hands its players the bandage rule');
  cq.respawnPlayer(human);
  eq(human.medkit.remaining, BANDAGE_RULES.count, 'a fresh Conquest life has two bandages');
  const other = new GameEngine();
  other.addClient('t', 'T');
  other.addBot?.('b');
  const t = other.entities.get('t');
  eq([other.mode.mode !== 'conquest', t.medkitRules, t.medkit.remaining], [true, MEDKIT_RULES, 1], `${other.mode.mode} keeps one medkit`);
}

// ------------------------------------------------------------ the sim --
{
  const p = new PlayerEntity('p', 'P', { x: 20, y: 1, z: 20 }, false, DIMS, { medkitRules: CONQUEST_MEDKIT_RULES });
  eq(p.medkit.remaining, 2, 'the constructor spawns with the mode count');
  const still = () => Object.assign(p, { state: 'alive', grounded: true, deployT: 0, vx: 0, vy: 0, vz: 0, input: { keys: {} } });
  let request = 0;
  const ask = () => { p.medkitRequest = ++request; };
  const run = seconds => { for (let t = 0; t < seconds - 1e-9; t += 0.05) updateMedkit(p, 0.05, true); };
  still(); p.hp = 30;
  ask(); updateMedkit(p, 0.05, true);
  ok(p.medkit.active, 'J starts a bandage below full HP');
  run(BANDAGE_RULES.seconds - 0.1);
  eq([p.hp, p.medkit.remaining], [30, 2], 'not done before 2.5 s: nothing spent');
  run(0.15);
  eq([p.hp, p.medkit.remaining, p.medkit.active], [70, 1, false], 'one bandage: +40 HP, one left');
  // Damage cancels and keeps the bandage.
  ask(); updateMedkit(p, 0.05, true); run(1);
  interruptMedkit(p); updateMedkit(p, 0.05, true);
  eq([p.medkit.active, p.medkit.remaining, p.hp], [false, 1, 70], 'a hit cancels and keeps the bandage');
  // Movement cancels too.
  ask(); updateMedkit(p, 0.05, true);
  p.input = { keys: { f: true } }; updateMedkit(p, 0.05, true);
  eq([p.medkit.active, p.medkit.remaining], [false, 1], 'moving cancels');
  still();
  ask(); updateMedkit(p, 0.05, true); run(BANDAGE_RULES.seconds + 0.05);
  eq([p.hp, p.medkit.remaining], [100, 0], 'the second bandage caps at 100 HP');
  p.hp = 50; ask(); updateMedkit(p, 0.05, true);
  ok(!p.medkit.active, 'no bandages left: J does nothing');
  // Snapshot: 0..2 on the wire, progress over 2.5 s.
  p.medkit.remaining = 2; p.hp = 50; ask(); updateMedkit(p, 0.05, true); run(1.2);
  const row = makeSnapshot([p], [], [], 0).players[0].medkit;
  eq(row.remaining, 2, 'the snapshot carries two bandages');
  ok(Math.abs(row.progress - 1.2 / BANDAGE_RULES.seconds) < 0.025, `progress runs over 2.5 s (${row.progress})`);
  p.medkit.remaining = 7;
  eq(makeSnapshot([p], [], [], 0).players[0].medkit.remaining, 2, 'the row clamps to the rule count');

  // The classic medkit: one per life, a full heal after MEDKIT_SECONDS.
  const c = new PlayerEntity('c', 'C', { x: 20, y: 1, z: 20 }, false, DIMS);
  Object.assign(c, { state: 'alive', grounded: true, deployT: 0, vx: 0, vy: 0, vz: 0, input: { keys: {} }, hp: 10, medkitRequest: 1 });
  updateMedkit(c, 0.05, true);
  for (let t = 0; t < MEDKIT_SECONDS + 0.05; t += 0.05) updateMedkit(c, 0.05, true);
  eq([c.hp, c.medkit.remaining], [100, 0], 'other modes: one full heal');
  eq(makeSnapshot([c], [], [], 0).players[0].medkit.remaining, 0);
}

// ------------------------------------------- Medic aura and ADRENALINE --
{
  const eng = { now: 100000, entities: new Map(), tickEvents: [], solidAt: (_x, y) => y < 10, vehicles: null,
    projectiles: { smoke: { blocksSight: () => false } } };
  const policy = { phase: 'live', awards: [], events: [], teamFor: p => p?.team ?? null,
    award(id, reason, scale = 1) { this.awards.push([id, reason, scale]); }, _emit(kind, f) { this.events.push({ kind, ...f }); }, refundTicket() {} };
  const roles = createConquestRoles({ policy, engine: eng, rules: CONQUEST_RULES });
  const add = (id, team, kit, x, z) => {
    const p = new PlayerEntity(id, id, { x, y: 10, z }, false, DIMS, { medkitRules: CONQUEST_MEDKIT_RULES });
    p.team = team; eng.entities.set(id, p); roles.applyLoadout(p, kit, 0); roles.onRespawn(p); return p;
  };
  const run = ms => { for (let t = 0; t < ms; t += TICK) { eng.now += TICK; roles.tick(eng.now, TICK); } };
  const medic = add('m', 'alpha', 'medic', 50, 50);
  const mate = add('a', 'alpha', 'assault', 52, 50);
  mate.medkit.remaining = 0;
  run(KIT_ROLE_RULES.healIntervalMs + 50);
  eq(mate.medkit.remaining, 1, 'the aura gives a bandage back');
  run(KIT_ROLE_RULES.medkitRestockMs - KIT_ROLE_RULES.healIntervalMs * 2);
  eq(mate.medkit.remaining, 1, 'one per medkitRestockMs');
  run(KIT_ROLE_RULES.healIntervalMs * 2 + 50);
  eq(mate.medkit.remaining, 2, 'a mate at 1/2 gets topped up (not only when spent)');
  run(KIT_ROLE_RULES.medkitRestockMs + 50);
  eq(mate.medkit.remaining, 2, 'capped at BANDAGE_RULES.count');
  ok(medic.medkit.remaining === 2, 'the Medic keeps its own bandages');
  // ADRENALINE: an enemy kill gives one bandage back.
  medic.state = 'dead'; eng.entities.delete('m');
  const foe = add('e', 'bravo', 'recon', 60, 50);
  mate.medkit.remaining = 0;
  run(TICK);
  foe.hp = 0; foe.state = 'dead';
  roles.onDeath(foe, mate, { weapon: 'rifle' });
  eq(mate.medkit.remaining, 1, 'ADRENALINE: +1 bandage, not a full refill');
}

// ------------------------------------------------- client prediction --
{
  const s = new MedkitState(CONQUEST_MEDKIT_RULES);
  eq(s.remaining, 2, 'the predicted state starts at the rule count');
  s.reconcile({ remaining: 1, active: false, ack: 0 });
  ok(s.begin(), 'J predicts a bandage with one left');
  s.cancel();
  s.reconcile({ remaining: 0, active: false, ack: 1 });
  ok(!s.begin(), 'none left: no prediction');
  const classic = new MedkitState();
  eq(classic.remaining, 1, 'other modes predict one medkit');
  // Bots: below 60 HP and with any bandage left (the second one too).
  const bots = readFileSync(new URL('../server/bots.js', import.meta.url), 'utf8');
  ok(/const MEDKIT_BOT_HP = 60;/.test(bots) && /p\.medkit\.remaining >= 1 && p\.hp < MEDKIT_BOT_HP/.test(bots), 'bots bandage below 60 HP with any left');
}

console.log(`conquest-supply-bandages-test: ${checks} checks passed`);
