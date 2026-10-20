// Conquest supply crates (docs/conquest.md "Infantry supply" > "Supply crates"):
// the Support's AMMO CRATE and the Medic's MEDICAL CRATE. Contract and kits,
// placement and the wire codec, then through the real GameEngine tick: one per
// owner (a second placement moves it), the ammo and heal pulses with their
// awards, enemies never served, bullets / melee / blasts destroy it with
// gadget_destroyed, the 60 s linger after the owner's death, leave and rematch
// cleanup, the bot placement and the client models.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS, parseConquestIntent } from '../server/protocol/admission.js';
import { CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, CONQUEST_INTENT_SHAPE, CRATE_TYPE_IDS, KITS, SCORE_POINTS } from '../shared/conquest-contract.js';
import { KIT_GADGET_LABELS, KIT_ROLE_RULES, kitCrate, kitDeployable, kitGadget, kitLoadout } from '../shared/conquest-kits.js';
import { SUPPLY_CRATE_RULES as R, decodeSupplyCrates, encodeSupplyCrates, placeCrate, rayCrate } from '../shared/supply-crates.js';
import { decodeConquestMatch } from '../shared/conquest.js';
import { attachBots } from '../server/bots.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { SupplyCrateView } from '../public/js/engine/supply-crate-view.js';
import { DEPLOYABLE_ART } from '../public/js/ui/hud-support.js';
import { conquestTouchFields, crateMapItems, crateMarkerModels, kitCards, supplyCrateBanner } from '../public/js/ui/conquest-hud-state.js';

// ---------------------------------------------------------------- contract, kits, rules, codec
{
  assert.equal(CONQUEST_CONTRACT_VERSION, 8);
  assert.deepEqual(KITS.support.gadgets, ['ammocrate', 'mortar'], 'the ammo crate is the Support default');
  assert.deepEqual(KITS.medic.gadgets, ['medcrate']);
  assert.deepEqual(CRATE_TYPE_IDS, ['ammocrate', 'medcrate']);
  assert.equal(CONQUEST_EVENT_KINDS.at(-1), 'supply_crate', 'appended');
  assert.equal(CONQUEST_INTENT_SHAPE.crate, '1');
  assert.deepEqual(parseConquestIntent({ t: 'conquest', crate: 1 }), { type: 'crate' });
  assert.equal(parseConquestIntent({ t: 'conquest', crate: 2 }), null);
  assert.deepEqual([kitDeployable('support', 0), kitDeployable('support', 1), kitDeployable('medic', 0), kitCrate('support', 1)],
    ['ammocrate', 'mortar', 'medcrate', null]);
  assert.equal(kitGadget('support', 0), null, 'the crate is no weapon');
  assert.equal(kitLoadout('support', 0, 0).gadget, null, 'and gives no launcher');
  assert.equal(KIT_GADGET_LABELS.ammocrate.name, 'AMMO CRATE');
  assert.equal(KIT_GADGET_LABELS.medcrate.name, 'MEDICAL CRATE');
  assert.ok(DEPLOYABLE_ART.ammocrate.endsWith('ammocrate.png') && DEPLOYABLE_ART.medcrate.endsWith('medcrate.png'));

  // Placement: the mortar's spot ahead, on the floor; nothing over a pit or into a wall.
  const floor = (_x, y) => y < 2;
  const spot = placeCrate({ x: 10.5, y: 2, z: 10.5, yaw: 0 }, floor);
  assert.ok(Math.abs(spot.z - (10.5 - R.placeForward)) < 1e-9 && spot.y === 2 && spot.mount[1] === 1, 'on the floor ahead');
  assert.equal(placeCrate({ x: 10.5, y: 2, z: 10.5, yaw: 0 }, () => false).reason, 'ground');
  assert.equal(placeCrate({ x: 10.5, y: 2, z: 10.5, yaw: 0 }, (x, y, z) => y < 2 || (z === 9 && y < 5)).reason, 'blocked', 'a wall ahead');
  const box = { x: 0, y: 0, z: 0 };
  assert.ok(Math.abs(rayCrate(box, [0, R.centerY, 5], [0, 0, -1], 50) - (5 - R.half[2])) < 1e-9);
  assert.equal(rayCrate(box, [2, R.centerY, 5], [0, 0, -1], 50), null);

  const wire = encodeSupplyCrates([{ id: 'sc1', ownerId: 'p1', team: 'bravo', kind: 'medcrate', x: 1.234, y: 2, z: 3, yaw: Math.PI / 2, hp: 60, expiresAt: 5050 }], 1000);
  assert.deepEqual(wire, [['sc1', 'p1', 1, 1, 1.23, 2, 3, 90, 50, 41]]);
  const [back] = decodeSupplyCrates(wire);
  assert.deepEqual([back.team, back.kind, back.hpFraction, back.lingerMs], ['bravo', 'medcrate', 0.5, 4100]);
  assert.ok(Math.abs(back.yaw - Math.PI / 2) < 1e-9);
  assert.equal(encodeSupplyCrates([]), null, 'omitted while empty');
  assert.deepEqual(decodeSupplyCrates(undefined), []);
}

// ---------------------------------------------------------------- engine fixture
const SX = 200, SY = 32, SZ = 160;
const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const ring = (x, z) => Array.from({ length: 12 }, (_, i) => spot(x + Math.round(Math.cos(i * Math.PI / 6) * 6), z + Math.round(Math.sin(i * Math.PI / 6) * 6)));
const flagRow = (id, x, z, home) => ({ id, name: id, ...spot(x, z), radius: 10, home, spawns: ring(x, z) });

function fixture() {
  const hq = (team, x) => ({ id: team, name: team, ...spot(x, 80), radius: 12, spawns: [spot(x, 74), spot(x, 77), spot(x, 80), spot(x, 83), spot(x, 86)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ }, spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns: [],
      flags: [flagRow('A', 50, 40, 'alpha'), flagRow('B', 50, 120, 'alpha'), flagRow('C', 100, 80, null), flagRow('D', 150, 40, 'bravo'), flagRow('E', 150, 120, 'bravo')] } };
  const removed = new Set();
  const solid = (x, y, z) => x < 0 || z < 0 || x >= SX || z >= SZ || (y < 2 && !removed.has(`${x},${y},${z}`));
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (solid(x, y, z) ? 1 : 0),
    findSpawns: () => [spot(20, 20)], setBlock: () => true };
  const events = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
  const policy = game.mode.policy;
  const run = ms => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
  const human = (id, team) => { game.addClient(id, id); const p = game.entities.get(id); if (team && policy.teamFor(p) !== team) policy.setLobbyTeam(p, team); return p; };
  const place = (p, x, z, yaw = 0) => Object.assign(p, { x: x + 0.5, y: 2, z: z + 0.5, vx: 0, vy: 0, vz: 0, yaw, pitch: 0, grounded: true,
    spawnProtectedUntil: 0, spawnProtected: false });
  const kit = (p, k, gadget = 0) => policy.roles.applyLoadout(p, k, 0, gadget);
  const crateEvents = state => events.filter(e => e.kind === 'supply_crate' && (!state || e.state === state));
  const scores = (id, reason) => events.filter(e => e.kind === 'score' && e.id === id && e.reason === reason);
  return { game, events, policy, run, human, place, kit, crateEvents, scores, removed };
}

// ---------------------------------------------------------------- ammo crate
{
  const f = fixture();
  const { game, policy, run } = f;
  const s = f.human('p1', 'alpha'), mate = f.human('p2', 'alpha'), enemy = f.human('p3', 'bravo');
  run(TICK_MS);
  assert.equal(policy.phase, 'live');
  f.place(s, 60, 80); f.place(mate, 62, 78); f.place(enemy, 58, 78);
  f.kit(s, 'support', 0); f.kit(mate, 'assault'); f.kit(enemy, 'assault');
  // A Support on the mortar, or an Assault, has no crate to place.
  f.kit(s, 'support', 1);
  assert.equal(game.mode.conquestIntent(s, { type: 'crate' }), false, 'the mortar Support has no crate');
  f.kit(s, 'support', 0);
  assert.equal(game.mode.conquestIntent(mate, { type: 'crate' }), false, 'an Assault has none');
  assert.equal(game.mode.conquestIntent(s, { type: 'crate' }), true, 'the Support places his ammo crate');
  const crate = policy.supplyCrates.crateOf(s.id);
  assert.ok(crate && crate.kind === 'ammocrate' && crate.team === 'alpha' && crate.z < s.z && crate.y === 2, 'on the floor ahead');
  assert.equal(game.mode.conquestIntent(s, { type: 'crate' }), false, 'a move straight away is refused');
  game.step(TICK_MS);
  assert.equal(f.crateEvents('refused').at(-1).reason, 'cooldown');
  f.place(s, 60, 80); f.place(mate, 62, 78); f.place(enemy, 58, 78);

  // Pulses: the mate gets a magazine and a grenade, the enemy beside it nothing; the owner is paid once per cooldown.
  f.place(s, 30, 30); // away from his own Support aura: only the crate serves
  const slot = kitLoadout('assault').weapon;
  const drain = () => { mate.reserve[slot] = 0; mate.grenades.fill(0); enemy.reserve[slot] = 0; enemy.grenades.fill(0); };
  drain();
  run(R.ammo.intervalMs + TICK_MS);
  assert.ok(mate.reserve[slot] > 0 && mate.grenades.some(n => n > 0), 'the mate in reach is resupplied');
  assert.equal(enemy.reserve[slot], 0, 'an enemy never draws from it');
  assert.equal(f.scores(s.id, 'resupply').length, 1, 'resupply award');
  drain();
  run(2 * TICK_MS);
  assert.equal(mate.reserve[slot], 0, 'one pulse per interval');
  run(R.ammo.intervalMs);
  assert.ok(mate.reserve[slot] > 0, 'the next pulse');
  assert.equal(f.scores(s.id, 'resupply').length, 1, 'award cooldown');
  f.place(mate, 80, 80);
  mate.reserve[slot] = 0;
  run(R.ammo.intervalMs + TICK_MS);
  assert.equal(mate.reserve[slot], 0, 'out of reach: nothing');

  // Snapshot rows and the client's own-team markers.
  run(TICK_MS);
  const cq = decodeConquestMatch(game.lastSnapshot.match.conquest);
  assert.deepEqual(cq.crates.map(c => [c.id, c.kind, c.team]), [[crate.id, 'ammocrate', 'alpha']], 'match.conquest.crates');
  assert.equal(crateMapItems({ cq, self: s, selfTeam: 'alpha' })[0].rel, 'self');
  assert.equal(crateMapItems({ cq, self: enemy, selfTeam: 'bravo' }).length, 0, 'no marker for the enemy team');
  const projector = { width: 1000, height: 600, project: () => ({ x: 500, y: 300, inside: true }) };
  assert.equal(crateMarkerModels({ cq, self: s, selfTeam: 'alpha', projector })[0].glyph, 'ammo');
  assert.equal(crateMarkerModels({ cq, self: enemy, selfTeam: 'bravo', projector }).length, 0);
  const view = new SupplyCrateView(new THREE.Scene());
  view.sync(game.lastSnapshot.match.conquest.crates);
  assert.equal(view.count, 1, 'the world model');
  view.sync(undefined);
  assert.equal(view.count, 0);

  // One per owner: placing again moves it.
  run(R.replaceCooldownMs);
  f.place(s, 70, 80);
  assert.equal(game.mode.conquestIntent(s, { type: 'crate' }), true);
  assert.equal(policy.supplyCrates.crates.size, 1, 'still one crate');
  const moved = policy.supplyCrates.crateOf(s.id);
  run(TICK_MS);
  assert.ok(Math.abs(moved.x - 70.5) < 1e-6 && f.crateEvents('moved').length === 1, 'moved');

  // Friendly fire never hurts it; enemy bullets destroy it and pay gadget_destroyed.
  assert.equal(policy.supplyCrates.damage(moved, 500, mate), false);
  f.place(s, 30, 30); f.place(mate, 30, 34);
  f.place(enemy, moved.x - 0.5, moved.z + 7);
  const look = { yaw: Math.atan2(-(moved.x - enemy.x), -(moved.z - enemy.z)), pitch: Math.atan2(moved.y + R.centerY - enemy.eyeY, Math.hypot(moved.x - enemy.x, moved.z - enemy.z)) };
  for (let i = 0; i < 600 && policy.supplyCrates.crates.has(moved.id); i++) {
    Object.assign(enemy, { x: moved.x, z: moved.z + 7 });
    enemy.reserve[enemy.weapon] = 999;
    game.applyInput(enemy.id, { keys: {}, ...look, wantFire: i % 2 === 0 });
    game.step(TICK_MS);
  }
  game.applyInput(enemy.id, { keys: {}, ...look, wantFire: false });
  assert.ok(!policy.supplyCrates.crates.has(moved.id), 'shot to pieces');
  assert.equal(f.crateEvents('destroyed')[0].by, enemy.id);
  assert.equal(f.scores(enemy.id, 'gadget_destroyed')[0]?.pts, SCORE_POINTS.gadget_destroyed);
  assert.equal(supplyCrateBanner(f.crateEvents('destroyed')[0], s.id).title, 'AMMO CRATE DESTROYED');

  // Melee from an enemy wears it down; a blast in reach finishes it.
  run(R.replaceCooldownMs);
  assert.equal(s.state, 'alive');
  f.place(s, 60, 80);
  game.mode.conquestIntent(s, { type: 'crate' });
  f.place(s, 30, 30);
  const third = policy.supplyCrates.crateOf(s.id);
  f.place(enemy, third.x - 0.5, third.z + 0.6);
  const down = { yaw: 0, pitch: Math.atan2(third.y + R.centerY - enemy.eyeY, 0.6) };
  for (let i = 0; i < 6; i++) {
    game.applyInput(enemy.id, { keys: {}, ...down, quickMelee: i % 2 === 0 });
    run(400);
  }
  assert.ok(third.hp < R.hp, `melee damages it (${third.hp})`);
  game.tickEvents.push({ kind: 'projectileExplode', type: 'frag', id: enemy.id, x: third.x, y: third.y + 0.3, z: third.z, radius: 5 });
  policy.supplyCrates.tick();
  assert.ok(!policy.supplyCrates.crates.has(third.id), 'a frag at its feet destroys it');

  // The owner dies: it lingers 60 s, then goes. Leaving removes it; a rematch clears it.
  run(R.replaceCooldownMs);
  f.place(s, 60, 80);
  game.mode.conquestIntent(s, { type: 'crate' });
  const fourth = policy.supplyCrates.crateOf(s.id);
  game.killPlayer(s, enemy, 'rifle', false);
  run(R.lingerMs - 1000);
  assert.ok(policy.supplyCrates.crates.has(fourth.id), 'outlives the owner');
  assert.ok(decodeConquestMatch(game.lastSnapshot.match.conquest).crates[0].lingerMs > 0, 'the linger rides the wire');
  run(1500);
  assert.ok(!policy.supplyCrates.crates.has(fourth.id) && f.crateEvents('expired').length === 1, 'gone after 60 s');
  policy.supplyCrates.crates.set('x1', { ...fourth, id: 'x1', expiresAt: null });
  policy.onPlayerRemove(s);
  assert.equal(policy.supplyCrates.crates.size, 0, 'leaving removes it');
  policy.supplyCrates.crates.set('x2', { ...fourth, id: 'x2', ownerId: mate.id });
  policy.reset();
  assert.equal(policy.supplyCrates.crates.size, 0, 'a rematch clears it');
}

// ---------------------------------------------------------------- medical crate
{
  const f = fixture();
  const { game, policy, run } = f;
  const m = f.human('p1', 'alpha'), mate = f.human('p2', 'alpha'), hurt = f.human('p4', 'alpha'), enemy = f.human('p3', 'bravo');
  run(TICK_MS);
  f.place(m, 60, 80); f.place(mate, 62, 78); f.place(hurt, 59, 78); f.place(enemy, 61, 77);
  f.kit(m, 'medic'); f.kit(mate, 'assault'); f.kit(hurt, 'assault'); f.kit(enemy, 'assault');
  for (const p of [mate, enemy]) p.medkit.remaining = 0;
  assert.equal(game.mode.conquestIntent(m, { type: 'crate' }), true, 'the Medic places his medical crate');
  assert.equal(policy.supplyCrates.crateOf(m.id).kind, 'medcrate');
  f.place(m, 30, 30); // out of his own aura's reach: only the crate serves
  run(TICK_MS);
  assert.equal(mate.medkit.remaining, 1, '+1 bandage');
  assert.equal(enemy.medkit.remaining, 0, 'never an enemy');
  run(R.med.bandageMs - 2000);
  assert.equal(mate.medkit.remaining, 1, 'one bandage per 15 s');
  run(3000);
  assert.equal(mate.medkit.remaining, 2, 'the next one, up to the cap');
  for (const p of [mate, hurt, enemy]) p.hp = 40;
  run(TICK_MS);
  // `hurt` keeps taking damage: the crate waits for him. Setting HP reads as a hit to the
  // roles tracker too: the others wait out the 3 s, then heal.
  let hits = 0;
  for (let ms = 0; ms < R.med.hurtQuietMs + 2000; ms += 250) { hurt.hp -= 1; hits++; run(250); }
  assert.ok(mate.hp >= 40 + R.med.hp && mate.hp <= 40 + 3 * R.med.hp, `+${R.med.hp} HP a second (${mate.hp})`);
  assert.equal(hurt.hp, 40 - hits, 'a mate hurt in the last 3 s is not healed');
  assert.equal(enemy.hp, 40, 'never an enemy');
  run(Math.ceil(60 / R.med.hp) * 1000 + 2000);
  assert.equal(mate.hp, 100, 'healed to full');
  assert.ok(f.scores(m.id, 'heal').length >= 1, 'heal award per healAwardHp given');
  assert.ok(f.events.some(e => e.kind === 'heal' && e.by === m.id && e.id === mate.id), 'heal events for the HUD');
  assert.equal(KIT_ROLE_RULES.healAwardHp, 50);
}

// ---------------------------------------------------------------- bots and client
{
  const f = fixture();
  const { game, policy, run } = f;
  const bots = attachBots(game, 0);
  const s = f.human('bot-sup', 'alpha'), m1 = f.human('p2', 'alpha'), m2 = f.human('p3', 'alpha');
  s.bot = true;
  run(TICK_MS);
  f.place(s, 60, 80); f.place(m1, 90, 80); f.place(m2, 92, 80);
  f.kit(s, 'support', 0);
  const goal = { kind: 'capture', stance: 'attack', target: { x: 100.5, y: 2, z: 80.5, radius: 10, owner: null } };
  assert.equal(bots.crates.use({}, s, goal, 1000), null, 'alone, away from a held flag: no crate');
  f.place(m1, 64, 80); f.place(m2, 60, 84);
  const brain = {};
  assert.ok(bots.crates.use(brain, s, goal, 1000), 'two mates within 10 m: placed');
  f.place(s, 120, 80);
  assert.equal(bots.crates.use(brain, s, goal, 10000), null, 'one placement per 20 s');
  const held = { ...goal, target: { ...goal.target, x: 120.5, owner: 'alpha' } };
  f.place(m1, 20, 20); f.place(m2, 20, 24);
  run(R.replaceCooldownMs);
  assert.ok(bots.crates.use(brain, s, held, 1000 + R.botPlaceMs), 'inside a held flag');
  bots.dispose?.();

  // Deploy card: the Medic's lone gadget shows its toggle; the Support's default is the crate.
  const cards = kitCards('medic', 0, 0, { unlocked: new Set(['medic', 'support']) });
  assert.deepEqual(cards.find(c => c.id === 'medic').gadgets.map(g => [g.weapon, g.role, g.selected]), [['medcrate', 'MED', true]]);
  assert.deepEqual(cards.find(c => c.id === 'support').gadgets.map(g => g.weapon), ['ammocrate', 'mortar']);
  const touch = d => conquestTouchFields({ active: true, deployable: d });
  assert.deepEqual([touch('ammocrate').mortarLabel, touch('medcrate').mortarLabel, touch('ammocrate').canMortar], ['AMMO', 'MED', true]);
}

console.log('conquest supply crates: ok');
