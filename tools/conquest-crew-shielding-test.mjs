import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { fireOneShot, resolveWeaponIntent } from '../server/sim/combat.js';
import { igniteFromLava, updateBurn } from '../server/sim/fire.js';
import { combatDamage } from '../shared/combat-balance.js';
import { WEAPONS, WEAPON_IDS, PLAYER_HALF } from '../shared/combatmath.js';
import { FLAME_RULES } from '../shared/flame-rules.js';
import { vehicleSeats } from '../shared/vehicle-seats.js';
import { EXPOSED_CREW_DAMAGE, armorMultiplier } from '../shared/vehicle-armor.js';
import { vehicleDef } from '../shared/vehicle-defs.js';
import { occupantHitPose } from '../server/sim/vehicle-damage.js';

function fixture(type) {
  const frames = [], platforms = new Set(), dimensions = { sx: 512, sy: 64, sz: 512 };
  const world = { dimensions,
    getBlock: (x, y, z) => y === 0 || platforms.has(`${x},${y},${z}`) ? 3 : 0,
    findSpawns: () => [{ x: 400, y: 1, z: 400 }], setBlock() {},
  };
  const game = new GameEngine({ mode: 'conquest', world,
    mapMeta: { id: 'frontier', dimensions,
      spawns: { conquest: { alpha: [{ x: 400, y: 1, z: 400 }], bravo: [{ x: 440, y: 1, z: 400 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'v', type, team: 'alpha', x: 200, y: 1, z: 200, yaw: 0 }] },
    }, broadcast: frame => frames.push(frame),
  });
  const seats = vehicleSeats(type);
  for (const [i] of seats.entries()) game.addClient(`crew${i}`, `Crew ${i}`);
  game.addClient('enemy', 'Enemy'); game.addClient('control', 'Control');
  const crew = seats.map((seat, i) => game.entities.get(`crew${i}`));
  const enemy = game.entities.get('enemy'), control = game.entities.get('control');
  for (const p of [...crew, control]) game.mode.policy.setLobbyTeam(p, 'alpha');
  game.mode.policy.setLobbyTeam(enemy, 'bravo');
  for (const [i, p] of [...crew, enemy, control].entries()) Object.assign(p, {
    x: 400 + i * 5, y: 1, z: 400, hp: 100, armor: 0, spawnProtectedUntil: 0,
    input: { keys: {}, yaw: 0, pitch: 0 }, grounded: true,
  });
  const vehicle = game.vehicles.vehicles.get('v');
  const board = p => {
    Object.assign(p, { x: vehicle.x, y: vehicle.y, z: vehicle.z });
    game.applyInput(p.id, { keys: {}, yaw: 0, pitch: 0,
      vehicleAction: { type: 'enter', vehicleId: vehicle.id } });
    assert.equal(p.vehicleId, vehicle.id);
  };
  return { game, crew, enemy, control, vehicle, board, frames, platforms };
}

function aimAt(enemy, victim, weapon, centerY = victim.eyeY, hull = null) {
  // Approach a seated body from outside its hull (seat side), so another crew
  // member never stands between the attacker and the target.
  let ox = 0, oz = 1;
  if (hull && victim.vehicleId === hull.id) {
    const dx = victim.x - hull.x, dz = victim.z - hull.z, length = Math.hypot(dx, dz);
    if (length > 0.2) { ox = dx / length; oz = dz / length; }
  }
  Object.assign(enemy, { x: victim.x + ox * 1.8, y: victim.y, z: victim.z + oz * 1.8,
    yaw: Math.atan2(ox, oz), pitch: 0,
    weapon: WEAPON_IDS.indexOf(weapon), deployT: 0, cooldown: 0, quickMeleeT: 0,
    triggerPrev: false, fireEdgeQueued: false, quickMeleeQueued: null,
  });
  enemy.pitch = Math.atan2(centerY - enemy.eyeY, 1.8);
  enemy.input = { keys: {}, yaw: enemy.yaw, pitch: enemy.pitch, wantFire: true };
}

function swing(f, victim, quick = false) {
  // Exposed crew are a crouched body under the seat hip; aim at that body.
  aimAt(f.enemy, victim, quick ? 'rifle' : 'knife', occupantHitPose(victim).y + PLAYER_HALF.h, f.vehicle);
  if (quick) {
    f.enemy.input.wantFire = false;
    f.enemy.quickMeleeQueued = { yaw: f.enemy.yaw, pitch: f.enemy.pitch };
  }
  resolveWeaponIntent(f.enemy, 1 / 60, f.game.contexts.combat);
  f.enemy.input.wantFire = false;
}

function flame(f, victim) {
  aimAt(f.enemy, victim, 'flamethrower', victim.vehicleId ? occupantHitPose(victim).y + PLAYER_HALF.h : victim.eyeY, f.vehicle);
  fireOneShot(f.enemy, f.game.contexts.combat);
  f.enemy.input.wantFire = false;
  f.game.flames.step(FLAME_RULES.range / FLAME_RULES.speed, f.game.contexts.combat);
}

function igniteGroundFire(f, victim, id) {
  // An elevated spill puts every physical seat inside real ground-fire contact
  // height. A ground-level spill alone would miss the higher passenger mounts.
  for (let x = Math.floor(victim.x - 4); x <= Math.ceil(victim.x + 4); x++) {
    for (let z = Math.floor(victim.z - 4); z <= Math.ceil(victim.z + 4); z++) {
      f.platforms.add(`${x},1,${z}`);
    }
  }
  const field = f.game.projectiles.fire.ignite({ id, ownerId: f.enemy.id, owner: f.enemy,
    x: victim.x, y: 2.2, z: victim.z }, f.game.contexts.projectiles);
  assert(field, 'supported elevated spill creates ground fire');
  return field;
}

function fireTick(f, seconds) {
  f.game.now += seconds * 1000;
  f.game.projectiles.fire.step(seconds, f.game.contexts.projectiles);
}

const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-7, message);
const bodyHits = (f, player) => f.game.tickEvents.filter(event => event.kind === 'hit' && event.victim === player.id);

const TYPES = ['jeep', 'tank', 'helicopter', 'transport', 'plane'];
const sealed = (f, p) => !vehicleSeats(f.vehicle.type).find(seat => seat.id === p.vehicleSeatId)?.exposed;

// Sealed seats protect each physical body through full and quick melee,
// travelling fire packets and elevated Molotov fields. Exposed seats (every
// jeep seat, the tank commander, the transport door gunners) are a crouched
// body at the seat pose and take the same attacks at the exposed-crew share,
// still without being shoved out of the seat.
for (const type of TYPES) {
  for (const attack of ['melee', 'quick-melee', 'flame', 'molotov']) {
    const f = fixture(type);
    for (const p of f.crew) f.board(p);
    const hullHp = f.vehicle.hp;
    for (const p of f.crew) {
      const hp = p.hp, armor = p.armor, knockback = [p.vx, p.vy, p.vz], shielded = sealed(f, p);
      let field = null;
      if (attack === 'melee' || attack === 'quick-melee') swing(f, p, attack === 'quick-melee');
      if (attack === 'flame') flame(f, p);
      if (attack === 'molotov') { field = igniteGroundFire(f, p, p.id); fireTick(f, 0.25); }
      assert.deepEqual([p.vx, p.vy, p.vz], knockback, `${attack} cannot knock a mounted body away from its seat`);
      if (shielded) {
        assert.equal(p.hp, hp, `${type} ${p.vehicleSeatId}: ${attack} cannot damage a sealed crew body`);
        assert.equal(p.armor, armor, `${attack} cannot consume sealed armor`);
        assert.equal(p.burn, null, `${attack} cannot ignite a sealed body`);
        assert.equal(p.molotovBurning, 0);
        assert.equal(bodyHits(f, p).length, 0, `${attack} cannot emit a sealed crew body hit`);
      } else {
        // Ground fire reaches an open seat only where its cells meet the seated body.
        const reachable = attack !== 'molotov' || f.game.projectiles.fire._contact(field, p, f.game.contexts.projectiles);
        if (reachable) {
          assert(p.hp < hp, `${type} ${p.vehicleSeatId}: ${attack} reaches the exposed crew body`);
          assert(bodyHits(f, p).length > 0, 'exposed crew damage keeps hit feedback');
        } else assert.equal(p.hp, hp);
      }
    }
    // Melee never touches the hull. Fire washing over a light hull deals the
    // fire class (0.3 per s); heavy and air armour ignore fire entirely.
    if (attack.includes('melee') || armorMultiplier('fire', vehicleDef(type).armor) === 0) assert.equal(f.vehicle.hp, hullHp, `${attack} leaves the ${type} hull alone`);
    else assert(f.vehicle.hp <= hullHp && f.vehicle.hp > hullHp * 0.9, `${attack} only singes the light ${type} hull`);
    for (const p of f.crew) if (sealed(f, p)) assert.equal(p.hp, 100, 'other sealed seats are protected too');

    // The same accepted attack still damages an ordinary on-foot target.
    Object.assign(f.control, { x: 350, y: attack === 'molotov' ? 2 : 1, z: 350 });
    if (attack === 'melee' || attack === 'quick-melee') swing(f, f.control, attack === 'quick-melee');
    if (attack === 'flame') flame(f, f.control);
    if (attack === 'molotov') { igniteGroundFire(f, f.control, 'control'); fireTick(f, 0.25); }
    assert(f.control.hp < 100, `${attack} keeps ordinary on-foot damage`);
    assert(bodyHits(f, f.control).length > 0, 'on-foot damage retains hit feedback');
  }
}

// A ground-level spill beside a jeep burns its open-seat crew (never a sealed tank driver).
for (const type of ['jeep', 'tank']) {
  const f = fixture(type), p = f.crew[0];
  f.board(p);
  const field = f.game.projectiles.fire.ignite({ id: 'beside', ownerId: f.enemy.id, owner: f.enemy, x: p.x, y: 1.2, z: p.z }, f.game.contexts.projectiles);
  assert(field, 'ground spill creates fire');
  fireTick(f, 0.5);
  if (type === 'jeep') assert(p.hp < 100 && bodyHits(f, p).length > 0, 'ground fire reaches the exposed jeep driver');
  else assert.equal(p.hp, 100, 'ground fire never reaches the sealed tank driver');
}

// Exposed crew take infantry damage at 0.8x: the same flame hit on foot and in an open seat.
{
  const f = fixture('jeep'), gunner = f.crew[1];
  f.board(f.crew[0]); f.board(gunner);
  assert.equal(gunner.vehicleSeatId, 'gunner');
  // A direct flame hit has no facing multiplier, so the two doses compare 1:1.
  flame(f, gunner); const seated = 100 - gunner.hp;
  Object.assign(f.control, { x: 350, y: 1, z: 350 });
  flame(f, f.control); const onFoot = 100 - f.control.hp;
  assert(onFoot > 0 && Math.abs(seated - onFoot * EXPOSED_CREW_DAMAGE) < 0.11, `exposed share ${seated} vs ${onFoot}`);
}

// The shared blast path damages the hull and visible on-foot bodies. Sealed
// seats stay protected from direct splash; exposed seats take the crew share.
// No seated body is ever moved by the impulse.
for (const type of TYPES) {
  for (const blast of ['frag', 'pulse', 'rocket', 'mgl', 'bubble']) {
    const f = fixture(type);
    for (const p of f.crew) f.board(p);
    Object.assign(f.control, { x: 203, y: 1, z: 200 });
    const hullHp = f.vehicle.hp;
    f.game.projectiles.chaosBlast(f.enemy, [200, 2, 200], blast, 7, 10, 10, f.game.contexts.projectiles);
    assert(f.vehicle.hp < hullHp && f.vehicle.hp > 0, `${blast} retains nonlethal hull splash through the armour matrix`);
    assert(f.control.hp < 100, `${blast} retains on-foot splash damage`);
    for (const p of f.crew) {
      assert.deepEqual([p.vx, p.vy, p.vz], [0, 0, 0], `${blast} cannot move a mounted body`);
      if (sealed(f, p)) {
        assert.equal(p.hp, 100, `${type} ${p.vehicleSeatId}: ${blast} cannot bypass the sealed hull`);
        assert.equal(bodyHits(f, p).length, 0);
      } else {
        assert(p.hp < 100, `${type} ${p.vehicleSeatId}: ${blast} splash reaches the exposed crew`);
        assert(bodyHits(f, p).length > 0);
      }
    }
  }
}

// Rifle fire: the jeep gunner and passengers are killable; the tank driver,
// helicopter pilot and gunner and jet pilot are not (the hull takes the round).
// Each seat is tested alone so no other crew member stands in the line of fire.
for (const type of TYPES) {
  for (const seat of vehicleSeats(type)) {
    const f = fixture(type), p = f.crew[seat.index];
    Object.assign(p, { x: f.vehicle.x, y: f.vehicle.y, z: f.vehicle.z });
    f.game.applyInput(p.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'enter', vehicleId: f.vehicle.id, seatId: seat.id } });
    assert.equal(p.vehicleSeatId, seat.id);
    const head = p.y + (seat.exposed ? 0.4 : 0.9), hullHp = f.vehicle.hp;
    let shots = 0;
    while (p.state === 'alive' && shots++ < 30) {
      Object.assign(f.enemy, { x: p.x + 6, y: p.y, z: p.z, weapon: WEAPON_IDS.indexOf('rifle'), deployT: 0, cooldown: 0 });
      const pitch = Math.atan2(head - f.enemy.eyeY, 6);
      f.enemy.input = { keys: {}, yaw: Math.PI / 2, pitch };
      fireOneShot(f.enemy, f.game.contexts.combat, 1, { yaw: Math.PI / 2, pitch });
    }
    if (!seat.exposed) {
      assert.equal(p.hp, 100, `${type} ${seat.id}: rifle rounds stop at the hull`);
      assert.equal(p.state, 'alive');
      assert(f.vehicle.hp <= hullHp, 'the hull takes the rounds instead');
    } else {
      assert.equal(p.state, 'dead', `${type} ${seat.id}: an exposed crew member is killable by rifle fire`);
      assert.equal(p.vehicleId, null, 'a killed crew member leaves the seat');
    }
  }
}

// A real flame graze before boarding retains its original health, owner and
// duration. Sealed seats advance the timer without body damage; exposed seats
// keep burning at the crew share.
for (const type of TYPES) {
  const f = fixture(type);
  for (const [i, p] of f.crew.entries()) {
    Object.assign(p, { x: 350 + i * 5, y: 1, z: 350 });
    flame(f, p);
    near(p.hp, 95.2, 'on-foot flame graze has its existing direct damage');
    updateBurn(p, 0.2, f.game.contexts.combat);
    assert.equal(p.burn.elapsed, 0.2, 'preboarding partial burn batch exists');
    const burn = p.burn, hp = p.hp;
    f.board(p);
    assert.equal(p.hp, hp, 'boarding does not heal prior damage');
    assert.equal(p.burn, burn, 'boarding retains the burn state');
  }
  Object.assign(f.enemy, { x: 450, y: 1, z: 450 });
  const hp = f.crew.map(p => p.hp);
  f.game.step(400);
  for (const [i, p] of f.crew.entries()) {
    near(p.burning, 0.9, `${type} ${p.vehicleSeatId}: mounted burn retains its countdown`);
    assert.equal(p.burn.owner, f.enemy);
    if (sealed(f, p)) {
      assert.equal(p.hp, hp[i]);
      assert.equal(p.burn.elapsed, 0, 'sealed time and pending preboarding dose do not accrue body damage');
    } else assert(p.hp < hp[i], 'an open seat keeps burning');
  }
  f.game.step(1000);
  for (const [i, p] of f.crew.entries()) {
    assert.equal(p.burning, 0); assert.equal(p.burn, null);
    if (sealed(f, p)) { assert.equal(p.hp, hp[i]); assert.equal(p.state, 'alive'); }
  }
  const snapshot = f.frames.at(-1);
  for (const p of f.crew) if (p.state === 'alive') assert.equal(snapshot.players.find(row => row.id === p.id).burning, 0);
}

// Leaving a sealed seat before the burn expires resumes only the remaining
// on-foot exposure. Ownerless lava afterburn follows the same rule.
for (const type of TYPES) {
  for (const source of ['flamethrower', 'lava']) {
    const f = fixture(type);
    for (const p of f.crew) {
      if (source === 'flamethrower') flame(f, p);
      else igniteFromLava(p, 1.5);
      f.board(p);
    }
    const crew = f.crew.filter(p => sealed(f, p));
    if (!crew.length) continue;
    Object.assign(f.enemy, { x: 450, y: 1, z: 450 });
    const hp = crew.map(p => p.hp);
    f.game.step(600);
    for (const [i, p] of crew.entries()) {
      assert.equal(p.hp, hp[i]); near(p.burning, 0.9, 'mounted afterburn expires on the same clock');
      assert(f.game.vehicles.exit(p));
      assert.equal(p.hp, hp[i]);
    }
    f.game.step(500);
    for (const [i, p] of crew.entries()) {
      near(p.hp, hp[i] - combatDamage(WEAPONS.flamethrower.flame.damagePerS * 0.5),
        'exit resumes existing on-foot DPS without mounted-time catch-up');
      near(p.burning, 0.4);
    }
  }
}

// A partial ground-fire batch cannot flush against a player who boarded a
// sealed seat, while an exited occupant is vulnerable to ordinary ground exposure again.
{
  const f = fixture('tank'), p = f.crew[0];
  Object.assign(p, { x: 200, y: 2, z: 200 });
  igniteGroundFire(f, p, 'pending'); fireTick(f, 0.1);
  assert.equal(p.hp, 100); assert(f.game.projectiles.fire.pending.has(p.id));
  f.board(p); assert.equal(p.vehicleSeatId, 'driver');
  fireTick(f, 0.25);
  assert.equal(p.hp, 100); assert.equal(p.molotovBurning, 0);
  assert.equal(f.game.projectiles.fire.pending.has(p.id), false);
  f.game.vehicles.release(p);
  Object.assign(p, { x: 200, y: 2, z: 200 }); fireTick(f, 0.25);
  near(p.hp, 94, 'after exit, ground fire applies one ordinary interval without pending mounted damage');
}

// Crew death remains owned by hull destruction, even when the crew is burning.
for (const type of TYPES) {
  const f = fixture(type);
  for (const p of f.crew) { igniteFromLava(p, 4); f.board(p); p.armor = 100; }
  assert(f.game.vehicles.damage(f.vehicle.id, 10000, f.enemy, { explosive: true }));
  assert.equal(f.enemy.kills, f.crew.length);
  for (const p of f.crew) {
    assert.equal(p.state, 'dead'); assert.equal(p.deaths, 1);
    assert.equal(p.vehicleId, null); assert.equal(p.vehicleSeatId, null);
    assert.equal(f.game.tickEvents.filter(event => event.kind === 'kill' && event.victim === p.id).length, 1);
  }
}

console.log('Conquest crew shielding: sealed vs exposed seats through melee/quick melee/flame/Molotov/blasts and rifle fire, the 0.8x crew share, retained afterburn, exit DPS, pending exposure, snapshots and authoritative hull deaths passed');
