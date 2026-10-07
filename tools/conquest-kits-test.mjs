// Conquest infantry roles: kit loadouts, down and revive, engineer repair and
// the support resupply aura (WP8). A fake engine/policy/VehicleSystem drives
// the role rules exactly; a final case runs them on the real GameEngine.
import assert from 'node:assert/strict';
import { CONQUEST_RULES, KITS, KIT_IDS, KIT_SIDEARM, decodeConquestPlayer } from '../shared/conquest-contract.js';
import {
  KIT_GADGET_AMMO, KIT_MELEE, KIT_MENU, KIT_ROLE_RULES, applyResupply, isUnsuppressedWeapon, kitGadget, kitIndex,
  kitLoadout, kitMaxGrenades, kitMaxReserve, kitWeapons, normalizeGadget, normalizeKit, normalizeVariant, reserveUnitsPerMagazine,
} from '../shared/conquest-kits.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../shared/grenade-rules.js';
import { PlayerEntity } from '../server/sim/player.js';
import { createConquestRoles, ConquestRoles, hullMaxHp, settleBodyY } from '../server/modes/conquest/roles.js';

const DIMS = { sx: 256, sy: 64, sz: 256 };
const slot = id => WEAPON_IDS.indexOf(id);
const gslot = id => GRENADE_TYPE_IDS.indexOf(id);
const TICK = 1000 / 60;

// ---------------------------------------------------------------- kit table --
{
  assert.equal(normalizeKit('nope'), 'assault');
  assert.equal(normalizeVariant(1), 1);
  assert.equal(normalizeVariant(7), 0);
  assert.equal(kitIndex('recon'), 3);
  assert.equal(kitIndex('nope'), -1);
  assert.equal(KIT_MENU.length, 4);
  for (const kit of KIT_IDS) {
    for (const variant of [0, 1]) {
      const load = kitLoadout(kit, variant);
      const def = KITS[kit];
      const expected = new Set([def.primaries[variant], KIT_SIDEARM, KIT_MELEE, ...(def.gadget ? [def.gadget] : [])]);
      assert.deepEqual(new Set(load.owned), expected, `${kit}/${variant} owns exactly its weapons`);
      assert.equal(load.weapon, slot(def.primaries[variant]), `${kit}/${variant} raises its primary`);
      for (const id of WEAPON_IDS) {
        const i = slot(id);
        if (!expected.has(id)) {
          assert.equal(load.mag[i], 0, `${kit}/${variant} carries no ${id} magazine`);
          assert.equal(load.reserve[i], 0, `${kit}/${variant} carries no ${id} reserve`);
          continue;
        }
        const ammo = KIT_GADGET_AMMO[id];
        assert.equal(load.mag[i], ammo?.mag ?? WEAPONS[id].magSize, `${kit}/${variant} ${id} magazine`);
        assert.equal(load.reserve[i], ammo?.reserve ?? (WEAPONS[id].spareRounds ?? WEAPONS[id].spareMags), `${kit}/${variant} ${id} reserve`);
      }
      for (const type of GRENADE_TYPE_IDS) {
        assert.equal(load.grenades[gslot(type)], def.grenades[type] ?? 0, `${kit} ${type} grenades`);
      }
      assert.deepEqual(kitMaxReserve(kit, variant), load.reserve);
      assert.deepEqual(kitMaxGrenades(kit), load.grenades);
    }
  }
  const engineer = kitLoadout('engineer', 0);
  assert.equal(engineer.mag[slot('rocket')], 1, 'engineer rocket mag 1');
  assert.equal(engineer.reserve[slot('rocket')], 4, 'engineer rocket reserve 4');
  const recon = kitLoadout('recon', 1);
  assert.equal(recon.grenades[gslot('limpet')], 2, 'recon carries two claymores (limpet id)');
  assert.equal(recon.grenades[gslot('pulse')], 1);
  assert.equal(recon.primary, 'longarc');
  assert.equal(isUnsuppressedWeapon('rifle'), true);
  assert.equal(isUnsuppressedWeapon('knife'), false);
  assert.equal(isUnsuppressedWeapon(slot('knife')), false);
  assert.equal(reserveUnitsPerMagazine('rifle'), 1);
  assert.equal(reserveUnitsPerMagazine('shotgun'), WEAPONS.shotgun.magSize, 'tube reserve is loose shells');

  // One resupply pulse: one primary magazine of reserve, one kit grenade, both capped.
  const inv = kitLoadout('engineer', 1);
  inv.reserve[slot('shotgun')] = 10;
  inv.grenades[gslot('smoke')] = 0;
  inv.grenades[gslot('frag')] = 0;
  let given = applyResupply(inv, 'engineer', 1);
  assert.equal(given.reserve, WEAPONS.shotgun.magSize);
  assert.equal(inv.reserve[slot('shotgun')], 10 + WEAPONS.shotgun.magSize);
  assert.equal(given.grenade, 'smoke', 'kit order breaks a grenade deficit tie');
  inv.reserve[slot('shotgun')] = WEAPONS.shotgun.spareRounds - 2;
  given = applyResupply(inv, 'engineer', 1);
  assert.equal(inv.reserve[slot('shotgun')], WEAPONS.shotgun.spareRounds, 'reserve capped at kit maximum');
  assert.equal(given.grenade, 'frag');
  given = applyResupply(inv, 'engineer', 1);
  assert.deepEqual(given, { reserve: 0, grenade: null, gadget: 0 }, 'a full inventory takes nothing');
  assert.equal(inv.reserve[slot('rocket')], 4, 'a pulse without a gadget round leaves the gadget alone');
  // Gadget rounds come back one at a time, capped at the issued total (mag + reserve).
  inv.mag[slot('rocket')] = 0; inv.reserve[slot('rocket')] = 3;
  given = applyResupply(inv, 'engineer', 1, 0, { gadgetRound: true });
  assert.equal(given.gadget, 1); assert.equal(inv.reserve[slot('rocket')], 4, 'one AT rocket back');
  inv.reserve[slot('rocket')] = 5;
  given = applyResupply(inv, 'engineer', 1, 0, { gadgetRound: true });
  assert.equal(given.gadget, 0, 'a full launcher (0 + 5) takes no rocket');
}

// ------------------------------------------------- engineer gadget choice --
{
  assert.deepEqual(KITS.engineer.gadgets, ['rocket', 'stinger'], 'the engineer picks the AT launcher or the STINGER');
  assert.equal(KITS.engineer.gadget, 'rocket', 'the AT launcher stays the default gadget');
  for (const kit of ['assault', 'support', 'recon']) {
    assert.equal(normalizeGadget(kit, 1), 0, `${kit} has no gadget choice`);
    assert.equal(kitGadget(kit, 1), null);
  }
  assert.equal(normalizeGadget('engineer', 1), 1);
  assert.equal(normalizeGadget('engineer', 7), 0, 'an unknown gadget index is the default');
  assert.equal(normalizeGadget('engineer', undefined), 0, 'backward compatible: no gadget means AT');
  const at = kitLoadout('engineer', 0), aa = kitLoadout('engineer', 0, 1);
  assert.equal(at.gadget, 'rocket'); assert.equal(aa.gadget, 'stinger');
  assert(aa.owned.includes('stinger') && !aa.owned.includes('rocket'), 'the AA engineer carries the STINGER instead of the rocket');
  assert(at.owned.includes('rocket') && !at.owned.includes('stinger'), 'the AT engineer never owns a STINGER');
  assert.equal(aa.mag[slot('stinger')], KIT_GADGET_AMMO.stinger.mag);
  assert.equal(aa.reserve[slot('stinger')], KIT_GADGET_AMMO.stinger.reserve);
  assert.equal(aa.mag[slot('rocket')] + aa.reserve[slot('rocket')], 0, 'no AT rockets in the AA loadout');
  assert.equal(aa.gadgetIndex, 1); assert.equal(at.gadgetIndex, 0);
  assert.deepEqual(kitWeapons('engineer', 1, 1).owned.sort(), ['knife', 'revolver', 'shotgun', 'stinger']);
  const menu = KIT_MENU.find(k => k.id === 'engineer');
  assert.deepEqual(menu.gadgets.map(g => [g.gadget, g.role]), [['rocket', 'AT'], ['stinger', 'AA']]);
  assert.deepEqual(KIT_MENU.find(k => k.id === 'assault').gadgets, []);
  // STINGER resupply: one missile per gadget round, capped at 1 + 2.
  aa.mag[slot('stinger')] = 0; aa.reserve[slot('stinger')] = 0;
  assert.equal(applyResupply(aa, 'engineer', 0, 1, { gadgetRound: true }).gadget, 1);
  assert.equal(aa.reserve[slot('stinger')], 1);
  aa.reserve[slot('stinger')] = 3;
  assert.equal(applyResupply(aa, 'engineer', 0, 1, { gadgetRound: true }).gadget, 0, 'a full STINGER takes nothing');
}

// --------------------------------------------------------------- fixtures --
function fixture({ live = true } = {}) {
  const engine = {
    now: 100000,
    entities: new Map(),
    tickEvents: [],
    solidAt: (_x, y) => y < 10,
    projectiles: { smoke: { blocksSight: () => false } },
    respawned: [],
    respawnPlayer(p, spawn, opts) {
      this.respawned.push({ id: p.id, spawn, opts });
      p.applySpawn(spawn);
      if (opts?.emitEvent) this.tickEvents.push({ t: 'ev', kind: 'respawn', id: p.id });
      return true;
    },
    vehicles: null,
  };
  const policy = {
    phase: live ? 'live' : 'post',
    refunds: [], awards: [], events: [], respawnHooks: 0, deploy: new Map(),
    teamFor: p => p?.team ?? null,
    refundTicket(team) { this.refunds.push(team); },
    award(id, reason, scale = 1) { this.awards.push([id, reason, scale]); },
    _emit(kind, fields) { this.events.push({ kind, ...fields }); },
    conquestView() { return { squads: new Map([['a1', { team: 'alpha', squadId: 2, leaderId: 'a1' }]]) }; },
    restrictedMs: p => (p?.id === 'b1' ? 4300 : 0),
    // WP1's policy re-applies the deploy choice on respawn; a revive must ignore it.
    onPlayerRespawn(p) {
      this.respawnHooks++;
      const choice = this.deploy.get(p.id) ?? {};
      roles.applyLoadout(p, choice.kit, choice.variant);
      roles.onRespawn(p);
    },
  };
  const roles = createConquestRoles({ policy, engine, rules: CONQUEST_RULES });
  const add = (id, team, kit, variant, x, z, y = 10) => {
    const p = new PlayerEntity(id, id, { x, y, z }, false, DIMS);
    p.team = team;
    engine.entities.set(id, p);
    roles.applyLoadout(p, kit, variant);
    return p;
  };
  const step = (ms = TICK) => { engine.now += ms; roles.tick(engine.now, ms); };
  const kill = (p, killer, weapon = 'rifle', context = {}) => {
    p.hp = 0; p.state = 'dead';
    return roles.onDeath(p, killer, { weapon, ...context });
  };
  return { engine, policy, roles, add, step, kill };
}

// ------------------------------------------------- loadout on a real entity --
{
  const f = fixture();
  assert.ok(f.roles instanceof ConquestRoles);
  const p = f.add('a1', 'alpha', 'support', 1, 50, 50);
  assert.deepEqual(new Set(p.owned), new Set(['minigun', 'revolver', 'knife']));
  assert.equal(WEAPON_IDS[p.weapon], 'minigun');
  assert.equal(f.roles.canUseWeapon(p, 'rifle'), false, 'non-kit weapons are not owned');
  assert.equal(f.roles.canUseWeapon(p, slot('revolver')), true);
  assert.equal(f.roles.canUseWeapon(p, 'knife'), true);
  assert.equal(p.mag[slot('rifle')], 0);
  assert.equal(p.reserve[slot('rocket')], 0);
  assert.equal(p.grenades[gslot('molotov')], 1);
  assert.equal(p.grenades[gslot('frag')], 2);
  assert.equal(p.grenades[gslot('smoke')], 0);
  // Unknown kit keeps the previous kit; an unknown variant is variant 0.
  f.roles.applyLoadout(p, 'bogus');
  assert.equal(f.roles.kitOf(p), 'support');
  f.roles.applyLoadout(p, 'recon', 9);
  assert.equal(WEAPON_IDS[p.weapon], 'sniper');
  const fields = f.roles.snapshotFields(p);
  assert.deepEqual(fields, { kit: 'recon', squad: 2, down: false, spotted: false, restrictedMs: 0, actionProgress: 0 });
  // The cq encoding WP1 builds from these fields round-trips through the contract decoder.
  const cq = [kitIndex(fields.kit), fields.squad, fields.down ? 1 : 0, fields.spotted ? 1 : 0,
    Math.ceil(fields.restrictedMs / 100), 0, Math.round(fields.actionProgress * 100)];
  assert.equal(decodeConquestPlayer({ cq }).kit, 'recon');
  const b = f.add('b1', 'bravo', 'assault', 0, 60, 60);
  assert.equal(f.roles.snapshotFields(b).restrictedMs, 4300, 'restricted timer comes from the policy bounds');
  // WP1's BoundsSystem shape: restrictedMs(playerId, now).
  delete f.policy.restrictedMs;
  f.policy.bounds = { restrictedMs: (id, now) => (id === 'b1' && now === f.engine.now ? 2500 : 0) };
  assert.equal(f.roles.snapshotFields(b).restrictedMs, 2500, 'BoundsSystem timer by id and clock');
  assert.equal(f.roles.snapshotFields(p).restrictedMs, 0);
}

// ------------------------------------------------------------ down/revive --
{
  const f = fixture();
  const medic = f.add('a1', 'alpha', 'assault', 0, 50, 50);
  const victim = f.add('a2', 'alpha', 'engineer', 1, 51, 50);
  const enemy = f.add('b1', 'bravo', 'recon', 0, 80, 80);
  victim.yaw = 1.25;
  victim.mag[slot('shotgun')] = 3;
  victim.reserve[slot('rocket')] = 1;
  victim.grenades[gslot('frag')] = 0;
  victim.weapon = slot('rocket');
  f.step();
  assert.equal(f.kill(victim, enemy), true, 'a rifle death leaves a revivable body');
  assert.equal(f.roles.isDown(victim), true);
  assert.equal(f.roles.snapshotFields(victim).down, true);
  assert.equal(f.roles.downedBodies('alpha').length, 1);
  assert.equal(f.roles.downedBodies('bravo').length, 0);
  // The deploy screen picks a different kit; the revive must keep the body's kit.
  f.policy.deploy.set('a2', { kit: 'recon', variant: 1 });

  // Non-assault revivers and out-of-range revivers are refused.
  const engi = f.add('a3', 'alpha', 'engineer', 0, 50.5, 50);
  assert.equal(f.roles.intent(engi, { type: 'support', support: 'revive', targetId: 'a2' }), false, 'engineer cannot revive');
  Object.assign(medic, { x: 53.2, z: 50 });
  assert.equal(f.roles.intent(medic, { type: 'support', support: 'revive', targetId: 'a2' }), false, 'beyond 2 m is refused');
  assert.equal(f.roles.intent(enemy, { type: 'support', support: 'revive', targetId: 'a2' }), false, 'enemies cannot revive');
  Object.assign(medic, { x: 50, z: 50 });

  // Fresh intents advance; a stale intent pauses progress without losing it.
  assert.equal(f.roles.intent(medic, { type: 'support', support: 'revive', targetId: 'a2' }), true);
  for (let i = 0; i < 18; i++) f.step(); // 300 ms with one intent: still fresh
  const progressA = f.roles.snapshotFields(medic).actionProgress;
  assert.ok(progressA > 0.2 && progressA < 0.3, `progress after 300 ms ${progressA}`);
  for (let i = 0; i < 12; i++) f.step(); // the intent is now 500 ms old
  const progressB = f.roles.snapshotFields(medic).actionProgress;
  assert.ok(progressB - progressA < 0.05, 'a stale intent (>350 ms) pauses progress');
  assert.equal(victim.state, 'dead');
  // Keep holding (client re-sends at 5 Hz) until the 1.2 s hold completes.
  let elapsed = 0;
  while (victim.state === 'dead' && elapsed < 2000) {
    if (elapsed % 200 < TICK) f.roles.intent(medic, { type: 'support', support: 'revive', targetId: 'a2' });
    f.step(); elapsed += TICK;
  }
  assert.equal(victim.state, 'alive', 'revive completes');
  assert.ok(f.engine.now - 100000 < CONQUEST_RULES.reviveWindowMs, 'inside the window');
  assert.equal(victim.hp, CONQUEST_RULES.reviveHpFraction * 100, '40% HP');
  assert.deepEqual([victim.x, victim.y, victim.z], [51, 10, 50], 'respawned at the body, feet y');
  assert.equal(victim.yaw, 1.25, 'facing kept');
  assert.equal(f.roles.kitOf(victim), 'engineer', 'kit kept');
  assert.equal(f.roles.variantOf(victim), 1);
  assert.deepEqual(new Set(victim.owned), new Set(['shotgun', 'rocket', 'revolver', 'knife']));
  assert.equal(victim.mag[slot('shotgun')], 3, 'inventory carried by the body is kept');
  assert.equal(victim.reserve[slot('rocket')], 1);
  assert.equal(victim.grenades[gslot('frag')], 0);
  assert.equal(WEAPON_IDS[victim.weapon], 'rocket');
  assert.equal(victim.spawnProtectedUntil, 0, 'no spawn protection on a revive');
  assert.deepEqual(f.policy.refunds, ['alpha'], 'the ticket is refunded');
  assert.ok(f.policy.events.some(e => e.kind === 'revive' && e.id === 'a2' && e.by === 'a1'), 'revive event');
  assert.deepEqual(f.policy.awards.filter(a => a[1] === 'revive'), [['a1', 'revive', 1]]);
  assert.equal(f.policy.respawnHooks, 1, 'policy death bookkeeping is reset');
  assert.deepEqual(f.engine.respawned.at(-1).opts, { emitEvent: true, protect: false });
  assert.equal(f.roles.isDown(victim), false);
  assert.equal(f.roles.snapshotFields(medic).actionProgress, 0, 'session ends with the revive');

  // A policy revive hook (onRevive / onRevived) replaces the generic respawn hook.
  {
    const g = fixture();
    const reviveCalls = [];
    g.policy.onRevived = (p, by) => { reviveCalls.push([p.id, by.id]); g.roles.onRespawn(p); };
    const m = g.add('m', 'alpha', 'assault', 0, 20, 20);
    const v = g.add('v', 'alpha', 'recon', 1, 21, 20);
    g.step();
    g.kill(v, null, 'rifle');
    for (let i = 0; i < 90 && v.state === 'dead'; i++) {
      if (i % 12 === 0) g.roles.intent(m, { type: 'support', support: 'revive', targetId: 'v' });
      g.step();
    }
    assert.equal(v.state, 'alive');
    assert.deepEqual(reviveCalls, [['v', 'm']], 'onRevived(entity, reviver) is called once');
    assert.equal(g.policy.respawnHooks, 0, 'the deploy respawn hook is not used for a revive');
    assert.equal(WEAPON_IDS[v.weapon], 'longarc', 'kit and variant kept');
  }

  // A revive after the player deployed is refused (deploy forfeits the body).
  f.kill(victim, enemy);
  assert.equal(f.roles.isDown(victim), true);
  f.engine.respawnPlayer(victim, { x: 10, y: 10, z: 10 });
  f.policy.onPlayerRespawn(victim);
  assert.equal(f.roles.kitOf(victim), 'recon', 'a deploy applies the chosen kit');
  victim.hp = 0; victim.state = 'dead'; // even dead again without a new death hook, no body is left
  assert.equal(f.roles.isDown(victim), false);
  assert.equal(f.roles.intent(medic, { type: 'support', support: 'revive', targetId: 'a2' }), false, 'revive after deploy refused');

  // The window expires.
  victim.state = 'alive';
  f.kill(victim, enemy);
  for (let t = 0; t < CONQUEST_RULES.reviveWindowMs + 50; t += 50) f.step(50);
  assert.equal(f.roles.isDown(victim), false, 'the body expires after reviveWindowMs');
  assert.equal(f.roles.intent(medic, { type: 'support', support: 'revive', targetId: 'a2' }), false);

  // A player shot mid-air leaves the body on the floor below, where a medic can reach it.
  assert.equal(settleBodyY({ x: 51, y: 13.4, z: 50 }, f.engine.solidAt), 10, 'mid-air body settles onto the floor');
  assert.equal(settleBodyY({ x: 51, y: 10, z: 50 }, f.engine.solidAt), 10, 'a standing body keeps its feet y');
  assert.equal(settleBodyY({ x: 51, y: 13.4, z: 50 }, f.engine.solidAt, (_x, y) => y === 11), 13.4, 'a body over a fluid keeps its height');
  assert.equal(settleBodyY({ x: 51, y: 10.3, z: 50 }, (x, y) => y < 10 || (x === 51 && y === 10)), 10.3,
    'a body stepping onto a block is never pushed into it');
  Object.assign(victim, { state: 'alive', x: 51, y: 13.4, z: 50 });
  f.roles.onRespawn(victim);
  f.kill(victim, enemy);
  assert.equal(f.roles.downedBodies('alpha')[0].y, 10, 'the body rests on the ground');
  for (let i = 0; i < 90 && victim.state === 'dead'; i++) {
    if (i % 12 === 0) assert.equal(f.roles.intent(medic, { type: 'support', support: 'revive', targetId: 'a2' }), true, 'reachable from the ground');
    f.step();
  }
  assert.equal(victim.state, 'alive');
  assert.equal(victim.y, 10, 'revived standing on the floor, not in the air');

  // Moving out of range mid-hold cancels; nearest-body auto target works.
  Object.assign(victim, { state: 'alive', x: 51, y: 10, z: 50 });
  f.kill(victim, enemy);
  assert.equal(f.roles.intent(medic, { type: 'support', support: 'revive' }), true, 'auto-targets the nearest body');
  for (let i = 0; i < 10; i++) f.step();
  Object.assign(medic, { x: 55 });
  f.step();
  assert.equal(f.roles.snapshotFields(medic).actionProgress, 0, 'leaving the 2 m reach cancels');

  // No body for restricted, void, or seated/vehicle-destruction deaths; none outside the live phase.
  for (const weapon of ['restricted', 'world', 'lava']) {
    victim.state = 'alive'; f.roles.onRespawn(victim);
    assert.equal(f.kill(victim, null, weapon), false, `${weapon} deaths are final`);
  }
  victim.state = 'alive'; f.roles.onRespawn(victim);
  assert.equal(f.kill(victim, enemy, 'vehicle', { vehicleDestroyed: true }), false, 'vehicle destruction is final');
  victim.state = 'alive'; f.roles.onRespawn(victim);
  f.engine.vehicles = { vehicles: new Map([['t', { id: 't', type: 'tank', team: 'bravo', hp: 0, x: 52, y: 10, z: 50, wreckAge: 0 }]]) };
  assert.equal(f.kill(victim, enemy, 'vehicle'), false, 'a wreck blast next to a dead hull is final');
  victim.state = 'alive'; f.roles.onRespawn(victim);
  f.engine.vehicles.vehicles.get('t').hp = 500;
  assert.equal(f.kill(victim, enemy, 'vehicle'), true, 'a roadkill by a live hull leaves a body');
  victim.state = 'alive'; f.roles.onRespawn(victim);
  victim.vehicleId = 't'; f.step(); victim.vehicleId = null; // released by killPlayer before the hook
  assert.equal(f.kill(victim, enemy, 'hmg'), false, 'a crew member killed in the seat leaves no body');
  f.engine.vehicles = null;
  const post = fixture({ live: false });
  const late = post.add('x', 'alpha', 'assault', 0, 5, 5);
  assert.equal(post.kill(late, null, 'rifle'), false, 'no bodies outside the live phase');
}

// ------------------------------------------------------------------ repair --
class FakeVehicleSystem {
  constructor(vehicles) { this.vehicles = new Map(vehicles.map(v => [v.id, v])); this.calls = []; this.spots = []; }
  repair(vehicleId, amountHp, byPlayer) {
    const v = this.vehicles.get(vehicleId);
    if (!v || !(v.hp > 0) || !(amountHp > 0)) return 0;
    const before = v.hp;
    v.hp = Math.min(v.maxHp, v.hp + amountHp);
    if (v.disabled && v.hp > v.maxHp * 0.3) v.disabled = false;
    this.calls.push({ vehicleId, amountHp, by: byPlayer.id });
    return v.hp - before;
  }
  spot(vehicleId, team, untilMs) { this.spots.push({ vehicleId, team, untilMs }); }
}
{
  const f = fixture();
  const tank = { id: 'alpha-tank', type: 'tank', team: 'alpha', x: 60, y: 10, z: 60, yaw: 0, hp: 240, maxHp: 1000, disabled: true };
  const enemyTank = { id: 'bravo-tank', type: 'tank', team: 'bravo', x: 90, y: 10, z: 60, yaw: 0, hp: 240, maxHp: 1000 };
  f.engine.vehicles = new FakeVehicleSystem([tank, enemyTank]);
  assert.equal(hullMaxHp(tank), 1000);
  const engi = f.add('a1', 'alpha', 'engineer', 0, 60, 63.2); // ~1.3 m off the tank's rear plate
  const assault = f.add('a2', 'alpha', 'assault', 0, 60, 63.2);
  assert.equal(f.roles.intent(assault, { type: 'support', support: 'repair', targetId: 'alpha-tank' }), false, 'only engineers repair');
  assert.equal(f.roles.intent(engi, { type: 'support', support: 'repair', targetId: 'bravo-tank' }), false, 'enemy hulls are refused');
  const far = f.add('a3', 'alpha', 'engineer', 0, 60, 70);
  assert.equal(f.roles.intent(far, { type: 'support', support: 'repair', targetId: 'alpha-tank' }), false, 'beyond 3.5 m is refused');
  assert.equal(f.roles.intent(engi, { type: 'support', support: 'repair', targetId: 'alpha-tank' }), true);
  const hold = (player, ticks, targetId = 'alpha-tank', support = 'repair') => {
    for (let i = 0; i < ticks; i++) {
      if (i % 12 === 0) f.roles.intent(player, { type: 'support', support, targetId });
      f.step();
    }
  };
  // Half a second at 5 Hz: 4% restored, still below the 30% disabled line.
  hold(engi, 30);
  assert.ok(Math.abs(tank.hp - 280) < 1e-6, `8% max HP per second (${tank.hp})`);
  assert.equal(tank.disabled, true, 'still disabled at 28%');
  assert.ok(Math.abs(f.roles.snapshotFields(engi).actionProgress - 0.28) < 1e-6, 'cq[6] shows hull health while repairing');
  hold(engi, 30);
  assert.ok(Math.abs(tank.hp - 320) < 1e-6, `one second restores 80 HP (${tank.hp})`);
  assert.equal(tank.disabled, false, 'repair above 30% clears disabled');
  assert.ok(f.engine.vehicles.calls.every(c => c.by === 'a1' && c.vehicleId === 'alpha-tank'));
  assert.deepEqual(f.policy.awards.filter(a => a[1] === 'repair'), [], 'no award before 10% is repaired');
  hold(engi, 15); // 1.25 s total = 10%
  assert.deepEqual(f.policy.awards.filter(a => a[1] === 'repair'), [['a1', 'repair', 1]], 'one award per 10% repaired');
  // Taking damage interrupts the repair.
  const hpBefore = tank.hp;
  engi.takeDamage(10, false, null, 'rifle');
  hold(engi, 30);
  assert.equal(tank.hp, hpBefore, 'a damaged repairer stops repairing');
  hold(engi, 60);
  assert.ok(tank.hp > hpBefore, 'repair resumes once the repairer is no longer under fire');
  // Stale intents pause; repair never exceeds max HP.
  for (let i = 0; i < 30; i++) f.step(); // the last intent goes stale after 350 ms
  const paused = tank.hp;
  for (let i = 0; i < 60; i++) f.step();
  assert.equal(tank.hp, paused, 'no intent, no repair');
  tank.hp = 995;
  hold(engi, 60);
  assert.equal(tank.hp, 1000, 'capped at max HP');
  const awardsAtFull = f.policy.awards.length;
  hold(engi, 60);
  assert.equal(f.policy.awards.length, awardsAtFull, 'a full hull earns nothing');
  // Auto-target: the nearest damaged friendly hull.
  tank.hp = 500;
  assert.equal(f.roles.intent(engi, { type: 'support', support: 'repair' }), true);
  // A seated engineer cannot repair.
  engi.vehicleId = 'alpha-tank';
  assert.equal(f.roles.intent(engi, { type: 'support', support: 'repair', targetId: 'alpha-tank' }), false);
  engi.vehicleId = null;
}

// ---------------------------------------------------------------- resupply --
{
  const f = fixture();
  const support = f.add('s1', 'alpha', 'support', 0, 100, 100);
  const mate = f.add('a1', 'alpha', 'assault', 0, 104, 100);
  const farMate = f.add('a2', 'alpha', 'assault', 0, 120, 100);
  const enemy = f.add('b1', 'bravo', 'assault', 0, 101, 100);
  const rifle = slot('rifle');
  for (const p of [mate, farMate, enemy]) { p.reserve[rifle] = 1; p.grenades[gslot('frag')] = 0; p.grenades[gslot('smoke')] = 0; }
  support.reserve[slot('lmg')] = 0;
  support.grenades[gslot('molotov')] = 0;
  // Nothing before the first 4 s pulse.
  for (let t = 0; t < 3900; t += 100) f.step(100);
  assert.equal(mate.reserve[rifle], 1);
  f.step(100);
  assert.equal(mate.reserve[rifle], 2, 'one primary magazine per pulse');
  assert.equal(mate.grenades[gslot('frag')], 1, 'one kit grenade per pulse');
  assert.equal(support.reserve[slot('lmg')], 1, 'the supporter resupplies itself');
  assert.equal(support.grenades[gslot('molotov')], 1, 'the only missing kit grenade is restored');
  assert.equal(support.grenades[gslot('frag')], 2, 'full frags stay at the kit count');
  assert.equal(farMate.reserve[rifle], 1, 'beyond 8 m gets nothing');
  assert.equal(enemy.reserve[rifle], 1, 'enemies get nothing');
  assert.deepEqual(f.policy.awards, [['s1', 'resupply', 1]], 'one award per resupplied mate, none for self');
  // Pulses continue every 4 s; the award is rate limited to once per 15 s per mate.
  for (let t = 0; t < 4000 * 5; t += 100) f.step(100);
  assert.equal(mate.reserve[rifle], Math.min(WEAPONS.rifle.spareMags, 2 + 5), 'reserve capped at the kit maximum');
  assert.equal(mate.grenades[gslot('frag')], 2, 'frag capped at the kit count');
  assert.equal(mate.grenades[gslot('smoke')], 1, 'smoke capped at the kit count');
  const awards = f.policy.awards.filter(a => a[0] === 's1' && a[1] === 'resupply').length;
  assert.equal(awards, 2, `award at most once per 15 s per mate (${awards})`);
  // A second supporter does not double the rate for the same mate.
  const support2 = f.add('s2', 'alpha', 'support', 0, 104, 101);
  mate.reserve[rifle] = 0;
  for (let t = 0; t < 4000; t += 100) f.step(100);
  assert.equal(mate.reserve[rifle], 1, 'one refill per mate per pulse interval');
  // Dead and seated players neither give nor receive.
  support.state = 'dead'; support2.vehicleId = 'jeep';
  const before = mate.reserve[rifle];
  for (let t = 0; t < 8000; t += 100) f.step(100);
  assert.equal(mate.reserve[rifle], before);
}

// -------------------------------------------------- real engine integration --
{
  const { GameEngine } = await import('../server/game.js');
  const world = {
    dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (_x, y) => (y < 2 ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }],
    setBlock: () => {},
  };
  const game = new GameEngine({
    mode: 'conquest',
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [] } },
    world, broadcast: () => {},
  });
  game.addClient('m', 'Medic'); game.addClient('v', 'Victim'); game.addClient('e', 'Enemy'); game.addClient('w', 'Wing');
  const medic = game.entities.get('m'), victim = game.entities.get('v'), enemy = game.entities.get('e');
  for (const p of game.entities.values()) p.team = game.mode.teamFor(p);
  // Same team for the medic and the victim regardless of the balancer.
  const team = medic.team;
  const mate = [victim, enemy, game.entities.get('w')].find(p => p.team === team);
  const foe = [victim, enemy, game.entities.get('w')].find(p => p.team !== team);
  const wiredRoles = Object.values(game.mode.policy ?? {}).find(value => value instanceof ConquestRoles) ?? null;
  const roles = wiredRoles ?? createConquestRoles({
    engine: game,
    policy: {
      get phase() { return game.mode.phase; },
      teamFor: p => game.mode.teamFor(p),
      refundTicket: teamId => { refunds.push(teamId); },
      award: (id, reason) => { awards.push([id, reason]); },
      _emit: (kind, fields) => game.tickEvents.push({ t: 'ev', kind, at: game.now, ...fields }),
      onPlayerRespawn: p => game.mode.onPlayerRespawn(p),
    },
  });
  const refunds = [], awards = [];
  roles.applyLoadout(medic, 'assault', 0);
  roles.applyLoadout(mate, 'support', 0);
  Object.assign(medic, { x: 40.5, y: 2, z: 40.5 });
  Object.assign(mate, { x: 41.5, y: 2, z: 40.5 });
  Object.assign(foe, { x: 60.5, y: 2, z: 60.5 });
  game.step(); if (!wiredRoles) roles.tick(game.now, 1000 / 60);
  const ticketsBefore = game.mode.policy?.tickets?.[team];
  mate.takeDamage(500, false, foe, 'rifle');
  game.killPlayer(mate, foe, 'rifle', false);
  if (!wiredRoles) roles.onDeath(mate, foe, { weapon: 'rifle' });
  assert.equal(roles.isDown(mate), true, 'real engine death leaves a body');
  const wireEvents = [];
  let lastSnapshot = null;
  let sawDownRow = false, sawProgressRow = false;
  let revived = false;
  for (let i = 0; i < 120 && !revived; i++) {
    if (i % 12 === 0) {
      const intent = { type: 'support', support: 'revive', targetId: mate.id };
      if (wiredRoles && typeof game.mode.conquestIntent === 'function') game.mode.conquestIntent(medic, intent);
      else roles.intent(medic, intent);
    }
    const events = [];
    const broadcast = game.broadcast;
    game.broadcast = snapshot => {
      events.push(...(snapshot?.events ?? []));
      wireEvents.push(...(snapshot?.events ?? []));
      lastSnapshot = snapshot;
      const victimRow = snapshot?.players?.find(row => row.id === mate.id);
      const medicRow = snapshot?.players?.find(row => row.id === medic.id);
      if (victimRow?.cq?.[2] === 1) sawDownRow = true;
      if ((medicRow?.cq?.[6] ?? 0) > 0) sawProgressRow = true;
    };
    game.step();
    game.broadcast = broadcast;
    if (!wiredRoles) roles.tick(game.now, 1000 / 60);
    revived = mate.state === 'alive';
  }
  assert.equal(revived, true, 'real engine revive completes');
  assert.equal(mate.hp, 40);
  assert.deepEqual([mate.x, mate.y, mate.z], [41.5, 2, 40.5]);
  assert.equal(roles.kitOf(mate), 'support');
  assert.equal(WEAPON_IDS[mate.weapon], 'lmg');
  assert.equal(game.mode.canUseWeapon(mate, 'rifle') === false || !wiredRoles, true, 'wired policy gates non-kit weapons');
  if (wiredRoles) {
    assert.equal(sawDownRow, true, 'wired: the body is published as cq[2]=1');
    assert.equal(sawProgressRow, true, 'wired: the medic publishes hold progress in cq[6]');
    assert.ok(wireEvents.some(e => e.kind === 'revive' && e.id === mate.id && e.by === medic.id), 'wired: revive event on the wire');
    assert.ok(wireEvents.some(e => e.kind === 'score' && e.id === medic.id && e.reason === 'revive'), 'wired: revive score event');
    const row = lastSnapshot?.players?.find(r => r.id === mate.id);
    assert.equal(row?.cq?.[0], 2, 'wired: cq[0] carries the support kit index');
    assert.equal(row?.cq?.[2], 0, 'wired: no longer down');
    assert.deepEqual(new Set(row?.owned ?? mate.owned), new Set(['lmg', 'revolver', 'knife']), 'wired: owned list is the kit');
    if (Number.isFinite(ticketsBefore)) assert.equal(game.mode.policy.tickets[team], ticketsBefore, 'wired: the death ticket is refunded');
  } else {
    assert.deepEqual(refunds, [team]);
    assert.deepEqual(awards, [[medic.id, 'revive']]);
  }
  // The revived player dies normally again (policy death bookkeeping was reset).
  const deathsBefore = mate.deaths;
  mate.takeDamage(500, false, foe, 'rifle');
  game.killPlayer(mate, foe, 'rifle', false);
  assert.equal(mate.deaths, deathsBefore + 1);
  assert.ok(Number.isFinite(mate.respawnAt) && mate.respawnAt > game.now, 'the policy schedules the next respawn');
  console.log(`  real engine: ${wiredRoles ? 'policy-wired roles' : 'standalone roles on GameEngine (WP1 wiring not present yet)'}`);
}

// ------------------------------------------- bot takeover keeps the role --
{
  const { GameEngine } = await import('../server/game.js');
  const world = {
    dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (_x, y) => (y < 2 ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }],
    setBlock: () => {},
  };
  const game = new GameEngine({
    mode: 'conquest',
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [] } },
    world, broadcast: () => {},
  });
  const roles = game.mode.policy?.roles;
  if (!(roles instanceof ConquestRoles) || typeof game.takeoverBot !== 'function') {
    console.log('  bot takeover: skipped (policy wiring not present)');
  } else {
    game.addBot('bot-s', 'BotSupport');
    game.addClient('m', 'Medic');
    game.addClient('x', 'Other');
    const bot = game.entities.get('bot-s');
    const team = game.mode.teamFor(bot);
    const medic = [game.entities.get('m'), game.entities.get('x')].find(p => game.mode.teamFor(p) === team)
      ?? (game.mode.setLobbyTeam(game.entities.get('m'), team), game.entities.get('m'));
    roles.applyLoadout(bot, 'support', 1);
    roles.applyLoadout(medic, 'assault', 0);
    Object.assign(bot, { x: 40.5, y: 2, z: 40.5 });
    Object.assign(medic, { x: 41.5, y: 2, z: 40.5 });
    game.step();
    bot.takeDamage(500, false, null, 'rifle');
    game.killPlayer(bot, null, 'rifle', false);
    assert.equal(roles.isDown(bot), true, 'the bot leaves a body');
    assert.ok(game.takeoverBot('bot-s', 'human-s', 'Human'), 'a human takes over the downed bot');
    game.step();
    assert.equal(roles.isDown(bot), true, 'the body survives the takeover under the new id');
    assert.equal(roles.kitOf(bot), 'support', 'the kit survives the takeover');
    assert.equal(roles.variantOf(bot), 1);
    assert.equal(roles.states.has('bot-s'), false, 'no state is left under the bot id');
    let revived = false;
    for (let i = 0; i < 120 && !revived; i++) {
      if (i % 12 === 0) game.mode.conquestIntent(medic, { type: 'support', support: 'revive', targetId: 'human-s' });
      game.step();
      revived = bot.state === 'alive';
    }
    assert.equal(revived, true, 'the taken-over body is revived under the human id');
    assert.equal(WEAPON_IDS[bot.weapon], 'minigun', 'revived with the support variant kept');
    console.log('  bot takeover: role state follows the entity');
  }
}

// ------------------------------------- real VehicleSystem repair (WP2 API) --
{
  const { GameEngine } = await import('../server/game.js');
  const world = {
    dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (_x, y) => (y < 2 ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }],
    setBlock: () => {},
  };
  const game = new GameEngine({
    mode: 'conquest',
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [
        { id: 'alpha-tank', team: 'alpha', type: 'tank', x: 40.5, y: 2, z: 40.5, yaw: 0 },
        { id: 'bravo-tank', team: 'bravo', type: 'tank', x: 90.5, y: 2, z: 40.5, yaw: 0 },
      ] } },
    world, broadcast: () => {},
  });
  if (typeof game.vehicles?.repair !== 'function') {
    console.log('  real VehicleSystem repair: skipped (VehicleSystem.repair not present yet)');
  } else {
    game.addClient('e1', 'Engineer'); game.addClient('x1', 'Other');
    const engineer = [...game.entities.values()].find(p => game.mode.teamFor(p) === 'alpha');
    const tank = game.vehicles.vehicles.get('alpha-tank');
    const wired = Object.values(game.mode.policy ?? {}).find(value => value instanceof ConquestRoles) ?? null;
    const roles = wired ?? createConquestRoles({ engine: game, policy: {
      get phase() { return game.mode.phase; }, teamFor: p => game.mode.teamFor(p), award() {}, refundTicket() {},
    } });
    roles.applyLoadout(engineer, 'engineer', 0);
    const max = hullMaxHp(tank);
    assert.ok(max > 0, 'registry max HP');
    tank.hp = Math.round(max * 0.7); // above WP2's 60% regen cap, so only the repair adds HP
    Object.assign(engineer, { x: tank.x + 2.6, y: tank.y, z: tank.z, vehicleId: null });
    const send = () => (wired ? game.mode.conquestIntent(engineer, { type: 'support', support: 'repair', targetId: 'alpha-tank' })
      : roles.intent(engineer, { type: 'support', support: 'repair', targetId: 'alpha-tank' }));
    assert.equal(send(), true, 'engineer beside the real hull may repair');
    const events = [];
    game.broadcast = snapshot => events.push(...(snapshot?.events ?? []));
    const before = tank.hp;
    for (let i = 0; i < 60; i++) {
      if (i % 12 === 0) send();
      game.step();
      if (!wired) roles.tick(game.now, 1000 / 60);
    }
    const gained = tank.hp - before;
    assert.ok(Math.abs(gained - max * CONQUEST_RULES.repairPerSecFraction) <= max * 0.01 + 1,
      `real hull gains about 8% per second (${gained} of ${max})`);
    assert.ok(events.some(e => e.kind === 'vehicle_repaired' && e.vehicleId === 'alpha-tank'), 'vehicle_repaired on the wire');
    console.log('  real VehicleSystem repair: passed');
  }
}

// ------------------------- real hull destruction: crew leave no body (WP2) --
{
  const { GameEngine } = await import('../server/game.js');
  const world = {
    dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (_x, y) => (y < 2 ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }],
    setBlock: () => {},
  };
  const game = new GameEngine({
    mode: 'conquest',
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [
        { id: 'alpha-tank', team: 'alpha', type: 'tank', x: 40.5, y: 2, z: 40.5, yaw: 0 },
      ] } },
    world, broadcast: () => {},
  });
  const wired = Object.values(game.mode.policy ?? {}).find(value => value instanceof ConquestRoles) ?? null;
  if (!wired || typeof game.vehicles?.action !== 'function' || typeof game.vehicles?.destroy !== 'function') {
    console.log('  real hull destruction: skipped (policy wiring or VehicleSystem not present)');
  } else {
    game.addClient('a1', 'Crew'); game.addClient('b1', 'Enemy');
    const crew = [...game.entities.values()].find(p => game.mode.teamFor(p) === 'alpha');
    const enemy = [...game.entities.values()].find(p => game.mode.teamFor(p) === 'bravo');
    game.step();
    const tank = game.vehicles.vehicles.get('alpha-tank');
    Object.assign(crew, { x: tank.x + 2, y: 2, z: tank.z });
    assert.equal(game.vehicles.action(crew, { type: 'enter', vehicleId: 'alpha-tank' }), true, 'crew boards the real hull');
    game.step();
    game.vehicles.destroy(tank, enemy);
    game.step();
    assert.equal(crew.state, 'dead', 'crew dies with the hull');
    assert.equal(wired.isDown(crew), false, 'vehicle destruction leaves no revivable body');
    assert.equal(wired.snapshotFields(crew).down, false, 'cq down flag stays clear');
    // Control: an infantry death on the same engine does leave a body.
    Object.assign(enemy, { x: 80.5, y: 2, z: 80.5 });
    game.killPlayer(enemy, crew, 0, false);
    game.step();
    assert.equal(wired.isDown(enemy), true, 'infantry death leaves a body');
    console.log('  real hull destruction: crew leave no body');
  }
}

// ----------------- real engine: the deploy gadget choice is authoritative (AT or STINGER) --
{
  const { GameEngine } = await import('../server/game.js');
  const world = {
    dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (_x, y) => (y < 2 ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }],
    setBlock: () => {},
  };
  const game = new GameEngine({
    mode: 'conquest',
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [] } },
    world, broadcast: () => {},
  });
  game.addClient('aa', 'Engineer'); game.addClient('sup', 'Support'); game.addClient('foe', 'Enemy'); game.addClient('w', 'Wing');
  const eng = game.entities.get('aa');
  const team = game.mode.teamFor(eng);
  const support = [...game.entities.values()].find(p => p !== eng && game.mode.teamFor(p) === team);
  const foe = [...game.entities.values()].find(p => game.mode.teamFor(p) !== team);
  game.step();
  const respawnWith = (p, intent) => {
    p.takeDamage(500, false, foe, 'rifle');
    game.killPlayer(p, foe, 'rifle', false);
    assert.equal(game.mode.conquestIntent(p, { type: 'deploy', spawn: 'hq', ...intent }), true, `deploy ${JSON.stringify(intent)} accepted`);
    for (let i = 0; i < 60 * 8 && p.state !== 'alive'; i++) game.step();
    assert.equal(p.state, 'alive', 'deployed');
  };
  respawnWith(eng, { kit: 'engineer', variant: 0, gadget: 1 });
  assert.deepEqual(new Set(eng.owned), new Set(['smg', 'stinger', 'revolver', 'knife']), 'gadget 1: the engineer deploys with the STINGER');
  assert.equal(eng.mag[slot('stinger')], 1); assert.equal(eng.reserve[slot('stinger')], 2);
  assert.equal(eng.mag[slot('rocket')] + eng.reserve[slot('rocket')], 0, 'and without AT rockets');
  assert.equal(game.mode.canUseWeapon(eng, 'stinger'), true);
  assert.equal(game.mode.canUseWeapon(eng, 'rocket'), false, 'the AT launcher is not owned by an AA engineer');
  assert.deepEqual(game.mode.policy.kitFor(eng), { kit: 'engineer', variant: 0, gadget: 1 });
  // A later deploy without a gadget field is the backward-compatible AT default.
  respawnWith(eng, { kit: 'engineer', variant: 1 });
  assert.deepEqual(new Set(eng.owned), new Set(['shotgun', 'rocket', 'revolver', 'knife']), 'no gadget: the AT launcher');
  assert.equal(game.mode.canUseWeapon(eng, 'stinger'), false);
  // The support aura hands gadget rounds back (one per gadgetResupplyMs).
  respawnWith(eng, { kit: 'engineer', variant: 0, gadget: 1 });
  respawnWith(support, { kit: 'support', variant: 0 });
  Object.assign(eng, { x: 40.5, y: 2, z: 40.5 }); Object.assign(support, { x: 42.5, y: 2, z: 40.5 });
  Object.assign(foe, { x: 100.5, y: 2, z: 100.5 });
  eng.mag[slot('stinger')] = 0; eng.reserve[slot('stinger')] = 0;
  for (let i = 0; i < 60 * (KIT_ROLE_RULES.resupplyIntervalMs / 1000 + 1); i++) {
    Object.assign(eng, { x: 40.5, z: 40.5 }); Object.assign(support, { x: 42.5, z: 40.5 });
    game.step();
  }
  assert.equal(eng.reserve[slot('stinger')], 1, 'one STINGER back from the support aura');
  for (let i = 0; i < 60 * 5; i++) { Object.assign(eng, { x: 40.5, z: 40.5 }); Object.assign(support, { x: 42.5, z: 40.5 }); game.step(); }
  assert.equal(eng.reserve[slot('stinger')], 1, 'gadget rounds are rationed to one per 12 s');
  // Free-for-all modes never hand out the kit-only STINGER.
  const ffa = new GameEngine({ mode: 'ffa', world, broadcast: () => {} });
  ffa.addClient('x', 'X');
  const x = ffa.entities.get('x');
  assert.equal(ffa.mode.canUseWeapon(x, 'stinger'), false, 'FFA refuses the kit-only STINGER');
  assert.equal(x.mag[slot('stinger')] + x.reserve[slot('stinger')], 0, 'FFA spawns carry no STINGER');
  console.log('  real engine: gadget choice (STINGER / AT default), gadget resupply, FFA exclusion');
}

console.log('Conquest kits: loadouts per kit and variant, down/revive window and refusals, repair rate/disabled/interrupt/awards, resupply caps and award limit, engineer gadget choice (AT / STINGER) and gadget resupply, real-engine revive passed.');
