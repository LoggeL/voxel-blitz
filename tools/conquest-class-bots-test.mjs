// Conquest class bots on the authoritative Frontier v2 map (GameEngine +
// attachBots, real ConquestPolicy, no sockets): a Medic bot in a fight walks
// the last metres to a downed mate and finishes the revive even at panic HP,
// a Pyro bot burns a close enemy with the flamethrower (and draws it again
// from the revolver), a Medic bot walks to a hurt mate and the heal aura
// tops it up, and the bot squad table keeps one Medic per squad.
//
//   node tools/conquest-class-bots-test.mjs
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots, FLAME_DRAW_RANGE, FLAME_FIRE_RANGE } from '../server/bots.js';
import { HEAL_SEEK_BELOW, HEAL_SEEK_RANGE, HEAL_ZONE_RANGE } from '../server/bot-commander.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { mulberry32 } from '../shared/noise.js';
import { raycastVoxels } from '../shared/raycast.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { KIT_ROLE_RULES, botSquadKit } from '../shared/conquest-kits.js';

const meta = getMapMeta('frontier');
const world = createMapState('frontier');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const FLAME = WEAPON_IDS.indexOf('flamethrower');
const REVOLVER = WEAPON_IDS.indexOf('revolver');
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };

/** Clear eye-to-chest line between two standing spots. */
function clearLine(game, a, b) {
  const dir = [b.x - a.x, b.y + 1.1 - (a.y + 1.6), b.z - a.z], len = Math.hypot(...dir);
  return !raycastVoxels(game.solidAt, a.x, a.y + 1.6, a.z, dir[0] / len, dir[1] / len, dir[2] / len, len);
}

/**
 * `n` bots on alpha plus one idle human enemy on bravo (it never shoots back).
 * No hulls, so no bot is handed a crew seat. Returns helpers to place bodies.
 */
function fixture(n, seed = 7) {
  Math.random = mulberry32(seed);
  const events = [];
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: snap => events.push(...(snap.events ?? [])) });
  game.vehicles.vehicles.clear();
  const bots = attachBots(game, n);
  const policy = game.mode.policy;
  const list = bots.brains.map(br => game.entities.get(br.id));
  for (const p of list) policy.setLobbyTeam?.(p, 'alpha');
  game.addClient('enemy', 'ENEMY');
  const enemy = game.entities.get('enemy');
  policy.setLobbyTeam?.(enemy, 'bravo');
  for (let i = 0; i < 3; i++) game.step(TICK_MS);
  const place = (p, s, extra = {}) => Object.assign(p, { x: s.x, y: s.y, z: s.z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0, ...extra });
  const kit = (p, id, variant = 0) => { policy.roles.applyLoadout(p, id, variant, 0); p.hp = p.maxHp || 100; };
  return { game, bots, policy, list, enemy, events, place, kit };
}

const flagC = meta.conquest.flags.find(f => f.id === 'C');
const spots = flagC.spawns;

// ------------------------------------------- Medic revive inside a fight --
// The body lies a few metres off while an enemy is in plain view: the Medic walks
// in shooting (no standing still short of the body) and holds the revive.
for (const panic of [false, true]) {
  const f = fixture(2);
  const [medic, mate] = f.list;
  let setup = null;
  for (const a of spots) {
    const body = spots.find(b => b !== a && flat(a, b) >= 4 && flat(a, b) <= 7 && Math.abs(a.y - b.y) < 0.6);
    if (!body) continue;
    const far = spots.find(c => c !== a && c !== body && flat(a, c) >= 14 && flat(a, c) <= 30 && clearLine(f.game, a, c));
    if (far) { setup = { a, body, far }; break; }
  }
  assert(setup, 'flag C offers a medic spot, a body 4-7 m off and an enemy in view');
  f.kit(medic, 'medic'); f.kit(mate, 'assault');
  f.place(medic, setup.a); f.place(mate, setup.body);
  f.place(f.enemy, setup.far, { hp: 100000 });
  medic.yaw = Math.atan2(-(setup.far.x - medic.x), -(setup.far.z - medic.z));
  f.game.step(TICK_MS);
  mate.takeDamage(500, false, f.enemy, 'rifle');
  f.game.killPlayer(mate, f.enemy, 'rifle', false);
  ok(f.policy.roles.downedBodies('alpha').some(b => b.id === mate.id), 'the mate is down and revivable');
  // A Medic at panic HP (it would otherwise fall back to cover mid-revive).
  if (panic) medic.hp = 12;
  let revived = false, sawFight = false;
  for (let t = 0; t < 6000 && !revived; t += TICK_MS) {
    f.enemy.hp = Math.max(f.enemy.hp, 1000);
    if (panic) medic.hp = Math.min(medic.hp, 12);
    f.game.step(TICK_MS);
    const br = f.bots.brains.find(b => b.id === medic.id);
    if (br.state === 'fight') sawFight = true;
    revived = f.events.some(e => e.kind === 'revive' && e.id === mate.id && e.by === medic.id);
  }
  ok(sawFight, 'the Medic has the enemy in a fight while it revives');
  ok(revived, `a Medic bot ${panic ? 'at panic HP ' : ''}in a fight walks in and revives a mate 4-7 m away`);
  ok(medic.state === 'alive' && mate.state === 'alive', 'both are up after the revive');
  f.bots.dispose(); f.game.stop?.();
}

// ------------------------------------------------- Pyro burns close range --
{
  const f = fixture(1, 11);
  const [pyro] = f.list;
  let pair = null;
  for (const a of spots) for (const b of spots) {
    const d = flat(a, b);
    if (a === b || d < 8 || d > Math.min(FLAME_DRAW_RANGE, 20) || !clearLine(f.game, a, b)) continue;
    if (!pair || d < flat(pair[0], pair[1])) pair = [a, b];
  }
  assert(pair, 'flag C offers a pair 8-20 m apart with a clear line');
  f.kit(pyro, 'pyro');
  ok(pyro.owned.includes('flamethrower') && pyro.owned.includes('revolver'), 'the Pyro carries the flamethrower and the revolver');
  // Start on the revolver: a contact inside the stream's reach brings the flamethrower out.
  pyro.weapon = REVOLVER;
  f.place(pyro, pair[0]); f.place(f.enemy, pair[1], { hp: 100000 });
  pyro.yaw = Math.atan2(-(pair[1].x - pyro.x), -(pair[1].z - pyro.z));
  let flameShots = 0, lastSeq = pyro.shotSeq, burnt = 0;
  const hp0 = () => f.enemy.hp;
  for (let t = 0; t < 6000; t += TICK_MS) {
    const before = Math.max(hp0(), 1000);
    f.enemy.hp = before;
    f.game.step(TICK_MS);
    if (pyro.weapon === FLAME && pyro.shotSeq > lastSeq) flameShots += pyro.shotSeq - lastSeq;
    lastSeq = pyro.shotSeq;
    burnt += Math.max(0, before - f.enemy.hp);
  }
  ok(pyro.weapon === FLAME, 'the Pyro bot draws the flamethrower for a contact inside its reach');
  ok(flameShots >= 20, `the Pyro bot burns a close enemy with the stream (${flameShots} packets)`);
  ok(burnt > 0, `the stream hurts the enemy (${burnt.toFixed(0)} HP)`);
  ok(FLAME_FIRE_RANGE < 32 && FLAME_DRAW_RANGE < FLAME_FIRE_RANGE, 'fire and draw bands sit inside the 32 m stream reach');
  f.bots.dispose(); f.game.stop?.();
}

// ------------------------------------------- Medic walks to a hurt mate --
// A mate at 80 % HP (above the old 75 % seek line) a squad length away, out of any
// fight: the Medic bot walks over and the heal aura tops the mate up.
{
  const f = fixture(1, 5);
  const [medic] = f.list;
  f.game.addClient('mate', 'MATE');
  const mate = f.game.entities.get('mate');
  f.policy.setLobbyTeam?.(mate, 'alpha');
  f.game.step(TICK_MS);
  // West HQ spawn row: open, level ground well away from the fight.
  const row = meta.conquest.bases.alpha.spawns;
  let pair = null;
  for (const a of row) for (const b of row) {
    const d = flat(a, b);
    if (a !== b && d >= 15 && Math.abs(a.y - b.y) < 1 && (!pair || d > flat(pair[0], pair[1]))) pair = [a, b];
  }
  assert(pair, 'West HQ offers two spawn cells 15+ m apart');
  f.kit(medic, 'medic');
  f.place(medic, pair[0]); f.place(mate, pair[1]);
  f.place(f.enemy, meta.conquest.bases.bravo.spawns[0], { hp: 100000 });
  ok(HEAL_SEEK_BELOW > 0.8 && HEAL_SEEK_RANGE >= flat(pair[0], pair[1]), 'the mate is inside the Medic seek line and range');
  mate.hp = 80;
  const st = f.policy.roles.states.get(String(mate.id));
  if (st) { st.lastHp = 80; st.lastDamagedAt = -Infinity; }
  let sought = false, closest = Infinity;
  for (let t = 0; t < 12000; t += TICK_MS) {
    f.game.step(TICK_MS);
    if (f.bots.commander.goalFor(medic).kind === 'heal') sought = true;
    closest = Math.min(closest, flat(medic, mate));
  }
  const healed = f.events.filter(e => e.kind === 'heal' && e.id === mate.id && e.by === medic.id).reduce((sum, e) => sum + e.hp, 0);
  ok(sought, 'the Medic bot takes the heal goal for a mate at 80 % HP');
  ok(closest <= KIT_ROLE_RULES.healRadius, `the Medic walks into heal-aura reach (closest ${closest.toFixed(1)} m)`);
  ok(healed >= 15, `the heal aura tops the mate up (${healed} HP)`);
  f.bots.dispose(); f.game.stop?.();
}

// ------------------------------- a Medic on a capture stays on the flag --
{
  const f = fixture(1, 9);
  const [medic] = f.list;
  f.game.addClient('mate', 'MATE');
  const mate = f.game.entities.get('mate');
  f.policy.setLobbyTeam?.(mate, 'alpha');
  f.game.step(TICK_MS);
  f.kit(medic, 'medic');
  const flag = f.policy.capture.flags.find(fl => fl.id === 'C');
  Object.assign(flag, { owner: 'bravo', control: -1, state: 'idle' });
  const inside = spots.find(sp => flat(sp, flagC) <= flagC.radius - 2);
  f.place(medic, inside);
  const mates = spots.filter(sp => Math.abs(sp.y - inside.y) < 3);
  const near = mates.find(sp => flat(sp, inside) > 3 && flat(sp, inside) < HEAL_ZONE_RANGE - 1);
  const far = mates.find(sp => flat(sp, inside) > HEAL_ZONE_RANGE + 2 && flat(sp, inside) < HEAL_SEEK_RANGE);
  assert(near && far, 'flag C offers mate spots inside and outside the zone seek range');
  const ts = f.bots.commander.teams.get('alpha');
  mate.hp = 50;
  f.policy._view = null; f.bots.commander.readView(f.game.now + 1);
  f.place(mate, far);
  ok(f.bots.commander.hurtMate(medic, ts, f.game.now) === null, 'a Medic taking an enemy flag does not leave it for a hurt mate outside the zone range');
  f.place(mate, near);
  ok(f.bots.commander.hurtMate(medic, ts, f.game.now) === mate, 'a hurt mate next to it on the flag is still healed');
  Object.assign(flag, { owner: 'alpha', control: 1, state: 'idle' });
  f.policy._view = null; f.bots.commander.readView(f.game.now + 2);
  f.place(mate, far);
  ok(f.bots.commander.hurtMate(medic, ts, f.game.now) === mate, 'on a quiet owned flag the full seek range applies');
  f.bots.dispose(); f.game.stop?.();
}

// ----------------------------------------------------------- squad mix --
{
  // Eight bots per team in two squads of four: two Medics per team, one per squad.
  let medics = 0;
  for (const squadId of [1, 2]) for (let slot = 0; slot < 4; slot++) if (botSquadKit(slot, { team: 'alpha', squadId, seed: 3 }) === 'medic') medics++;
  ok(medics === 2, `every bot squad fields its Medic (${medics} per team of eight)`);
}

console.log(`Conquest class bots: ${checks} checks passed (Medic revive in a fight and at panic HP, Pyro flamethrower draw and burn, Medic heal seek and zone range, squad Medics).`);
process.exit(0);
