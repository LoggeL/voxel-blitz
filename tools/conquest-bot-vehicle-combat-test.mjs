// Conquest bot combat against and from vehicles (server/bot-vehicle-combat.js
// and the infantry brain in server/bots.js) on a small flat fixture world:
// hull perception, the unified threat picker with armour effectiveness,
// exposed versus sealed crew, weapon choice, integrated infantry fire, and
// mounted gunnery (tank main gun and coax, 360-degree check, threat-axis slew,
// blocked barrel, jeep pintle). Damage, ammunition and mounts stay
// authoritative in VehicleSystem; the bots only send inputs.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import {
  applyConquestVehicleCombat, applyMountedCombat, bestWeaponFor, infantryArmorEffect, MIN_ARMOR_EFFECT,
  pickBotThreat, pickConquestVehicleTarget, seatedExposed, vehicleCombatWeapon, armorMultiplier, TANK_OMNI_RANGE,
} from '../server/bot-vehicle-combat.js';
import { mulberry32 } from '../shared/noise.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { VEHICLE_RULES, vehicleMaxHp } from '../shared/vehicles.js';
import { vehicleMountOrder } from '../shared/conquest-contract.js';

const slots = WEAPON_IDS.map((_, i) => i), rocket = WEAPON_IDS.indexOf('rocket'), rifle = WEAPON_IDS.indexOf('rifle');
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

function fixture({ tank = false, enemyType = 'tank', enemySeat = 'driver', managed = false, ownSeat = 'driver', ownType = 'tank' } = {}) {
  const blocks = new Set(), floor = 2;
  const spawns = { alpha: [{ x: 40, y: floor, z: 65 }], bravo: [{ x: 40, y: floor, z: 25 }] };
  const vehicleSpawns = [{ id: 'enemy-hull', team: 'bravo', type: enemyType, x: 40, y: floor, z: 25, yaw: 0 }];
  if (tank) vehicleSpawns.push({ id: 'bot-hull', team: 'alpha', type: ownType, x: 40, y: floor, z: 65, yaw: 0 });
  const dims = { sx: 128, sy: 32, sz: 128 };
  const game = new GameEngine({ mode: 'conquest', world: { mapId: 'frontier', dimensions: dims,
    getBlock: (x, y, z) => y < floor || blocks.has(`${x},${y},${z}`) ? 3 : 0,
    heightAt: () => floor - 1, findSpawns: () => spawns.alpha, setBlock: () => false },
  mapMeta: { id: 'frontier', dimensions: dims, spawns: { conquest: spawns },
    conquest: { flags: managed ? [{ id: 'flag', x: 40, y: floor, z: 25, radius: 12 }] : [], bases: {}, vehicleSpawns } } });
  game.now = 100000;
  const bots = managed ? attachBots(game, 1, { difficulties: new Map([['bot-0', 'hard']]) }) : null;
  if (!bots) game.addBot('bot-0');
  game.addClient('human', 'Human driver');
  const p = game.entities.get('bot-0'), human = game.entities.get('human'), hull = game.vehicles.vehicles.get('enemy-hull');
  Object.assign(p, { x: 40, y: floor, z: 65, yaw: 0, pitch: 0, grounded: true, spawnProtectedUntil: 0, weapon: rifle, deployT: 0 });
  Object.assign(human, { x: 40, y: floor, z: 25, yaw: 0, pitch: 0, spawnProtectedUntil: 0 });
  assert.equal(game.mode.teamFor(p), 'alpha'); assert.equal(game.mode.teamFor(human), 'bravo');
  if (enemySeat) assert(game.vehicles.enter(human, hull.id, enemySeat), 'the human crews the enemy hull');
  const own = tank ? game.vehicles.vehicles.get('bot-hull') : null;
  if (own) assert(game.vehicles.enter(p, own.id, ownSeat), 'the bot crews its own hull');
  const br = bots?.brains[0] ?? { id: p.id, index: 0, rng: mulberry32(123), skill: 0.85, difficulty: 'hard', personality: 'skirmisher', reactionScale: 1, seq: 0 };
  const input = () => ({ seq: ++br.seq, keys: {}, yaw: p.yaw, pitch: p.pitch, wantFire: false });
  const arm = (owned, mags = {}) => {
    p.owned = owned.slice();
    for (const id of owned) { const slot = WEAPON_IDS.indexOf(id); p.mag[slot] = mags[id] ?? p.mag[slot] ?? 1; p.reserve[slot] = Math.max(p.reserve[slot] ?? 0, 4); }
    if (!owned.includes(WEAPON_IDS[p.weapon])) p.weapon = WEAPON_IDS.indexOf(owned[0]);
  };
  return { game, p, human, hull, own, br, blocks, input, bots, arm, floor };
}
const run = (f, seconds, decide = null) => {
  for (let i = 0; i < Math.ceil(seconds * 1000 / f.game.intervalMs); i++) { if (decide) decide(); f.game.step(); }
};

// --- hull perception --------------------------------------------------------------
{
  const f = fixture();
  const observed = pickConquestVehicleTarget(f.game, f.p, f.br);
  assert.equal(observed.target.vehicleId, f.hull.id);
  assert.deepEqual(observed.sighting.aimPoint, [f.hull.x, f.hull.y + VEHICLE_RULES.tank.height / 2, f.hull.z], 'hull centre, not the seated head');
  f.hull.z = 90; assert.equal(pickConquestVehicleTarget(f.game, f.p, f.br), null, 'FOV rejects a hull behind'); f.hull.z = 25;
  for (let x = 0; x < 128; x++) for (let y = 2; y < 10; y++) f.blocks.add(`${x},${y},45`);
  assert.equal(pickConquestVehicleTarget(f.game, f.p, f.br), null, 'a wall blocks every hull sample'); f.blocks.clear();
  f.game.projectiles.smoke.active.set('cloud', { id: 'cloud', x: 40, y: 4, z: 45, radius: 5, createdAt: f.game.now - 2000, expiresAt: f.game.now + 10000 });
  assert.equal(pickConquestVehicleTarget(f.game, f.p, f.br), null, 'a real smoke volume blocks acquisition'); f.game.projectiles.smoke.clear();
  f.hull.team = 'alpha'; assert.equal(pickConquestVehicleTarget(f.game, f.p, f.br), null, 'friendly hull never acquired'); f.hull.team = 'bravo';
  f.hull.hp = 0; assert.equal(pickConquestVehicleTarget(f.game, f.p, f.br), null, 'wreck never acquired'); f.hull.hp = vehicleMaxHp('tank');
  f.game.vehicles.release(f.human); assert.equal(pickConquestVehicleTarget(f.game, f.p, f.br), null, 'empty hull never acquired');
}

// --- unified threat picker: armour effectiveness of the held weapons ----------------
{
  const f = fixture();
  const pick = owned => {
    f.arm(owned);
    return pickBotThreat(f.game, f.p, { ...f.br, enemyId: null, noticeProgress: 0 }, {
      effectFor: (target, distance) => target.kind === 'hull' ? infantryArmorEffect(f.p, slots, target.armor, distance) : 1 });
  };
  assert(armorMultiplier('small', 'heavy') < MIN_ARMOR_EFFECT, 'small arms do nothing to heavy armour (shared matrix)');
  const rifleOnly = pick(['rifle']);
  assert.equal(rifleOnly.target, null, 'a rifle never engages a tank');
  assert.equal(rifleOnly.danger?.target?.vehicleId, f.hull.id, 'the tank is reported as a danger to avoid');
  const engineer = pick(['smg', 'rocket']);
  assert.equal(engineer.target?.vehicleId, f.hull.id, 'an AT rocket makes the tank a target');
  assert.equal(bestWeaponFor(f.p, slots, engineer.target, 40), rocket, 'the rocket is the weapon for the tank');
  f.arm(['rifle']);
  assert.equal(bestWeaponFor(f.p, slots, engineer.target, 40), null, 'no effective weapon, no hull fight');
  // Out of the rocket's band (closer than 10 m) the launcher is not offered.
  f.arm(['smg', 'rocket']);
  assert.equal(bestWeaponFor(f.p, slots, engineer.target, 6), null, 'no point-blank rocket');
}

// --- light hulls and exposed crew -----------------------------------------------------
{
  const f = fixture({ enemyType: 'jeep', enemySeat: 'driver' });
  f.arm(['rifle']);
  assert(seatedExposed(f.game, f.human), 'the jeep driver sits exposed');
  const infantry = pickBotThreat(f.game, f.p, { ...f.br, enemyId: null, noticeProgress: 0 }, { includeHulls: false });
  assert.equal(infantry?.target?.id, f.human.id, 'exposed seated crew is an infantry target');
  assert.equal(infantry.kind, 'crew');
  const hull = pickBotThreat(f.game, f.p, { ...f.br, enemyId: null, noticeProgress: 0 }, { includeInfantry: false,
    effectFor: (target, d) => infantryArmorEffect(f.p, slots, target.armor, d) });
  assert.equal(hull?.target?.vehicleId, f.hull.id, 'a rifle is effective enough against a light hull');
  const t = fixture({ enemyType: 'tank', enemySeat: 'driver' });
  assert(!seatedExposed(t.game, t.human), 'the tank driver is sealed');
  assert.equal(pickBotThreat(t.game, t.p, { ...t.br, enemyId: null, noticeProgress: 0 }, { includeHulls: false }), null,
    'a sealed crew member is never shot at as infantry');
}

// --- legacy weapon helper ---------------------------------------------------------------
{
  const f = fixture(); f.p.owned = ['rifle', 'knife']; f.p.mag[rocket] = 1;
  assert.equal(vehicleCombatWeapon(f.p, slots, 40), rifle, 'an unowned rocket is never selected');
  f.p.mag[rifle] = 0; f.p.reserve[rifle] = 10;
  assert.equal(vehicleCombatWeapon(f.p, slots, 40), rifle, 'reload an owned ranged weapon rather than melee');
  f.p.reserve[rifle] = 0; assert.equal(vehicleCombatWeapon(f.p, slots, 40), null, 'no ammunition cannot manufacture a loadout');
}

// --- integrated infantry: the engineer's rocket hurts the tank, a rifle never fires on it --
{
  const f = fixture({ managed: true });
  f.arm(['smg', 'rocket'], { rocket: 1, smg: 30 });
  const hp = f.hull.hp, shots = f.p.shotSeq;
  run(f, 9);
  assert(f.p.shotSeq > shots, 'the engineer bot fires on the occupied enemy tank');
  assert(f.hull.hp < hp, 'its rocket damages the human-driven tank within nine seconds');
  assert(f.p.weapon === rocket || f.p.reserve[rocket] < 4, 'the rocket was selected and spent');
  f.bots.dispose();
}
{
  const f = fixture({ managed: true });
  f.arm(['rifle'], { rifle: 30 });
  const hp = f.hull.hp, shots = f.p.shotSeq;
  run(f, 4);
  assert.equal(f.p.shotSeq, shots, 'a rifle bot holds fire on a tank it cannot hurt');
  assert.equal(f.hull.hp, hp);
  f.bots.dispose();
}
// --- the AA engineer: the STINGER is only for airborne aircraft ------------------------------
{
  const stinger = WEAPON_IDS.indexOf('stinger');
  const t = fixture();
  t.arm(['smg', 'stinger']);
  const tankTarget = pickBotThreat(t.game, t.p, { ...t.br, enemyId: null, noticeProgress: 0 }, { includeInfantry: false,
    effectFor: (target, d) => infantryArmorEffect(t.p, slots, target, d) });
  assert.equal(tankTarget?.target ?? null, null, 'a STINGER engineer never takes on a tank');
  assert.equal(bestWeaponFor(t.p, slots, { kind: 'hull', armor: 'heavy', vehicle: t.hull }, 40), null, 'no STINGER against armour');
  const h = fixture({ enemyType: 'helicopter', enemySeat: 'driver' });
  h.arm(['smg', 'stinger']);
  const landed = { kind: 'hull', armor: 'air', vehicle: h.hull };
  h.hull.grounded = true;
  assert.equal(bestWeaponFor(h.p, slots, landed, 40), null, 'a landed helicopter cannot be locked, so no STINGER');
  h.hull.grounded = false;
  assert.equal(bestWeaponFor(h.p, slots, landed, 40), stinger, 'the STINGER answers an airborne helicopter');
  assert.equal(bestWeaponFor(h.p, slots, landed, 400), null, 'beyond lock range the STINGER waits');
}
// --- integrated: an AA engineer bot locks and kills a human-flown helicopter with STINGERs ---
{
  const f = fixture({ managed: true, enemyType: 'helicopter', enemySeat: 'driver' });
  const stinger = WEAPON_IDS.indexOf('stinger');
  f.arm(['smg', 'stinger'], { stinger: 1, smg: 30 });
  f.p.reserve[stinger] = 2;
  const path = { x: 40, y: f.floor + 24, z: 6 };
  const pin = () => Object.assign(f.hull, { ...path, vx: 6, vy: 0, vz: 0, grounded: false, rotorSpeed: 1, pitch: 0, roll: 0, yaw: 0 });
  pin();
  const hp = f.hull.hp;
  let locked = false, launched = 0;
  run(f, 14, () => {
    pin(); path.x = 40 + Math.sin(f.game.now / 3000) * 10;
    locked ||= (f.p.lockProgress ?? 0) >= 1;
    launched = Math.max(launched, [...f.game.projectiles.active.values()].filter(r => r.weaponKey === 'stinger').length);
  });
  assert.equal(WEAPON_IDS[f.p.weapon] === 'stinger' || f.p.mag[stinger] + f.p.reserve[stinger] < 3, true, 'the STINGER was raised');
  assert(locked, 'the bot holds the seeker on the helicopter until it locks');
  assert(launched > 0 || f.hull.hp < hp, 'the bot fires the STINGER only once locked');
  assert(!(f.hull.hp > 0), `two STINGER hits bring the helicopter down (${hp} -> ${f.hull.hp})`);
  f.bots.dispose();
}
// --- integrated: an AT engineer bot leads a crossing tank -------------------------------------
{
  const f = fixture({ managed: true });
  f.arm(['smg', 'rocket'], { rocket: 1, smg: 30 });
  const hp = f.hull.hp;
  let x = 22;
  run(f, 12, () => { x = x > 58 ? 22 : x + 5 / 60; Object.assign(f.hull, { x, z: 15, yaw: -Math.PI / 2, speed: 5 }); });
  assert(f.hull.hp < hp, 'the AT engineer leads a tank crossing at 5 m/s and hits it');
  f.bots.dispose();
}
{
  // A friendly or empty hull in the lane holds the trigger.
  for (const team of ['alpha', 'bravo']) {
    const f = fixture({ managed: true, enemyType: 'jeep' });
    f.arm(['rifle'], { rifle: 30 });
    f.game.vehicles.vehicles.set('blocker', { ...f.hull, id: 'blocker', team, type: 'tank', x: 40, y: 2, z: 45, hp: 1000,
      occupantId: null, seatOccupants: {} });
    const hp = f.hull.hp; run(f, 3);
    assert.equal(f.hull.hp, hp, `a ${team} hull in the line of fire blocks the shot`);
    f.bots.dispose();
  }
}

// --- mounted gunnery: the bot tank driver's main gun -------------------------------------
{
  const f = fixture({ tank: true });
  const hp = f.hull.hp, mag = f.p.mag.slice();
  const decide = () => { const inp = f.input(); applyConquestVehicleCombat(f.game, f.br, f.p, f.game.now, f.game.intervalMs / 1000, inp, slots, { tank: f.own }); f.game.applyInput(f.p.id, inp); };
  run(f, 10, decide);
  assert(f.hull.hp < hp, 'the bot tank damages the occupied human tank');
  assert.deepEqual(f.p.mag, mag, 'mounted fire never touches infantry ammunition');
  assert(Math.abs(wrap(f.own.yaw)) < 0.05, 'turret aim leaves the hull orientation alone');
}
{
  // 360-degree check: an enemy soldier 20 m behind the tank is found and engaged.
  const f = fixture({ tank: true });
  f.game.vehicles.release(f.human);
  Object.assign(f.human, { x: 40, y: 2, z: 65 + 20, spawnProtectedUntil: 0 });
  assert(20 < TANK_OMNI_RANGE, 'the target is inside the omni check radius');
  const decide = () => { const inp = f.input(); applyConquestVehicleCombat(f.game, f.br, f.p, f.game.now, f.game.intervalMs / 1000, inp, slots, { tank: f.own }); f.game.applyInput(f.p.id, inp); };
  run(f, 8, decide);
  assert(f.human.hp < 100 || f.human.state === 'dead', 'the turret swings round and hits the infantryman behind');
}
{
  // No target: the guns slew along the commander's threat axis with a sweep.
  const f = fixture({ tank: true });
  f.game.vehicles.release(f.human);
  Object.assign(f.human, { x: 120, y: 2, z: 120 });
  const inp = f.input();
  const result = applyMountedCombat(f.game, f.br, f.p, f.own, 'driver', f.game.now, 1 / 60, inp, { threatAxis: 1.2 });
  assert.equal(result.target, null);
  assert(Math.abs(wrap(inp.yaw - 1.2)) <= 0.71, 'idle turret watches the threat axis');
  assert.equal(inp.wantFire, false);
}
{
  // A wall right at the muzzle: the gun never fires into it.
  const f = fixture({ tank: true });
  for (let x = 36; x <= 44; x++) for (let y = 2; y <= 6; y++) f.blocks.add(`${x},${y},59`);
  const shots = [];
  const decide = () => { const inp = f.input(); applyConquestVehicleCombat(f.game, f.br, f.p, f.game.now, f.game.intervalMs / 1000, inp, slots, { tank: f.own }); if (inp.wantFire) shots.push(1); f.game.applyInput(f.p.id, inp); };
  run(f, 4, decide);
  assert.equal(shots.length, 0, 'a blocked barrel never pulls the trigger');
  assert.equal(f.hull.hp, vehicleMaxHp('tank'));
}
{
  // Recognition is per life of the gunner and per target.
  const f = fixture({ tank: true });
  const decide = () => { const inp = f.input(); const r = applyConquestVehicleCombat(f.game, f.br, f.p, f.game.now, f.game.intervalMs / 1000, inp, slots, { tank: f.own }); f.game.applyInput(f.p.id, inp); return r; };
  run(f, 1, decide);
  assert(f.br.mounted.progress >= 1, 'the hull is recognised after a moment');
  f.p.lives++;
  assert.equal(decide().recognized, false, 'a fresh gunner life must recognise the hull again');
}
{
  // Jeep pintle: the gunner bot works the HMG on exposed infantry.
  const f = fixture({ tank: true, ownType: 'jeep', ownSeat: 'gunner' });
  f.game.vehicles.release(f.human);
  Object.assign(f.human, { x: 40, y: 2, z: 35, spawnProtectedUntil: 0 });
  assert(vehicleMountOrder('jeep').includes('gunner:pintle'), 'the jeep gunner owns the pintle mount');
  const decide = () => { const inp = f.input(); applyMountedCombat(f.game, f.br, f.p, f.own, 'gunner', f.game.now, f.game.intervalMs / 1000, inp, {}); f.game.applyInput(f.p.id, inp); };
  run(f, 6, decide);
  assert(f.human.hp < 100 || f.human.state === 'dead', 'the pintle HMG hits the enemy soldier');
}
{
  // Integrated: a managed bot seated as tank driver fights through the brain.
  const f = fixture({ managed: true, tank: true });
  const hp = f.hull.hp;
  run(f, 10);
  assert(f.hull.hp < hp, 'the integrated tank driver aims and fires its main gun');
  f.bots.dispose();
}

{
  // Spotting: a bot calls a contact out only when its current view puts the
  // contact inside the server's spot cone; the server then marks it.
  const f = fixture({ managed: true, enemySeat: null });
  const { bots } = f, br = bots.brains[0];
  Object.assign(f.human, { x: 40, y: f.floor, z: 35 });   // 30 m straight down the bot's -z view
  Object.assign(f.p, { yaw: Math.PI / 2, pitch: 0 });
  assert(!bots.spotInView(f.p, f.human), 'a contact 90 degrees off the view is outside the spot cone');
  br.spotAt = undefined; br.spottedId = undefined;
  bots.callSpot(br, f.p, f.human, f.game.now, { spotMs: 7000 });
  assert.equal(br.spotAt, undefined, 'a call the cone cannot confirm does not spend the rate limit');
  f.p.yaw = 0;
  assert(bots.spotInView(f.p, f.human), 'a contact on the crosshair is inside the spot cone');
  bots.callSpot(br, f.p, f.human, f.game.now, { spotMs: 7000 });
  assert.equal(br.spotAt, f.game.now, 'a confirmed call is sent');
  assert(f.game.mode.policy.roles?.spotting?.isSpotted(f.human), 'the server marks the called-out enemy');
  const hullTarget = { kind: 'hull', type: 'tank', x: f.hull.x, y: f.hull.y, z: f.hull.z, eyeY: f.hull.y + 1.2 };
  assert(bots.spotInView(f.p, hullTarget), 'a hull ahead is inside the cone widened by its own radius');
  bots.dispose();
}

{
  // A mount that cannot bring its best target to bear blacklists it and
  // engages the next-best visible threat instead of idling.
  const f = fixture({ tank: true });
  let soldier = null;
  for (let i = 0; i < 4 && !soldier; i++) {
    f.game.addClient(`rifleman-${i}`, 'Rifleman');
    const q = f.game.entities.get(`rifleman-${i}`);
    if (f.game.mode.teamFor(q) === 'bravo') soldier = q;
  }
  assert(soldier, 'a second enemy (infantry) joins bravo');
  Object.assign(soldier, { x: 40, y: f.floor, z: 45, yaw: 0, pitch: 0, spawnProtectedUntil: 0, state: 'alive' });
  const hullId = `vehicle:${f.hull.id}`;
  const first = applyMountedCombat(f.game, f.br, f.p, f.own, 'driver', f.game.now, 1 / 60, f.input(), {});
  assert.equal(first?.target?.id, hullId, 'the enemy tank outscores the rifleman');
  f.br.mounted.blacklist.set(hullId, f.game.now + 2500);
  f.br.mounted.targetId = null;
  const next = applyMountedCombat(f.game, f.br, f.p, f.own, 'driver', f.game.now, 1 / 60, f.input(), {});
  assert.equal(next?.target?.id, soldier.id, 'with the tank blacklisted the gun takes the rifleman');
  const picked = pickBotThreat(f.game, f.p, { ...f.br, enemyId: null, noticeProgress: 0 }, { exclude: id => id === hullId });
  assert.equal(picked?.target?.id, soldier.id, 'pickBotThreat skips excluded targets');
}

{
  // Idle Conquest bots take turns sweeping for threats (SCAN_EVERY); a held target is re-checked every tick.
  const f = fixture({ managed: true, enemySeat: null });
  const { bots } = f, br = bots.brains[0];
  Object.assign(f.human, { x: 40, y: f.floor, z: 35 });
  Object.assign(f.p, { yaw: 0, pitch: 0 });
  br.enemyId = null;
  bots.tickIndex = (2 - (br.index % 2) + 1) % 2;   // (tickIndex + index) odd: not this bot's turn
  assert.equal(bots.pickThreat(f.p, br, slots, f.game.now), null, 'an idle bot off its turn does not sweep');
  bots.tickIndex++;
  assert.equal(bots.pickThreat(f.p, br, slots, f.game.now)?.id, f.human.id, 'on its turn the sweep finds the enemy');
  bots.tickIndex++;
  assert.equal(bots.pickThreat(f.p, br, slots, f.game.now)?.id, f.human.id, 'the held target is kept off-turn');
  bots.dispose();
}

console.log('Conquest bot vehicle combat: hull perception, armour-weighted threat picker, exposed crew, engineer AT fire (static and crossing), AA engineer STINGER lock and kill, held rifle fire, mounted main gun, 360-degree check, threat-axis slew, blocked barrel, recognition, mount blacklist fallback, staggered idle scans, pintle HMG and spot calls passed.');
