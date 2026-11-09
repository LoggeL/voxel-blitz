// SP-2 DOPPLER: one compact test for the weapon. Rules (two rounds per pull, the tight
// doublet, the last odd round, the Chaos triplet), authority through a real GameEngine,
// Conquest kits, the presentation curves and the delivered Blender asset contract.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import {
  FREE_WEAPON_IDS, WEAPONS, WEAPON_IDS, roundsPerShot, samplePelletDirection, shotRounds,
} from '../shared/combatmath.js';
import { chaosWeaponDef } from '../shared/chaos.js';
import { KITS } from '../shared/conquest-contract.js';
import { kitLoadout } from '../shared/conquest-kits.js';
import { GUN_GAME_WEAPON_ORDER, WEAPON_PRICES } from '../shared/modes.js';
import { MASTERY_WEAPON_IDS } from '../shared/career-mastery.js';
import { HANDS } from '../shared/avatar-hands.js';
import { SIGHT_HEIGHT } from '../shared/player-hitboxes.js';
import { TIMERS } from '../public/js/guns/defs.js';
import { DOPPLER_BUFFER_S, dopplerStroke, dopplerVisibleRounds } from '../public/js/guns/doppler-presentation.js';

const def = WEAPONS.doppler;
const slot = WEAPON_IDS.indexOf('doppler');
const file = (path) => new URL(`../${path}`, import.meta.url);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// ---------------------------------------------------------------- definition and tables
eq(slot, WEAPON_IDS.length - 1, 'appended behind the gadget block (wire slots never move)');
ok(FREE_WEAPON_IDS.includes('doppler') && !def.gadgetOnly, 'a free weapon');
eq([def.mode, def.roundsPerShot, def.pellets, roundsPerShot(def)], ['auto', 2, 2, 2], 'two rounds per pull');
ok(def.magSize % 2 === 0 && def.doublet.spreadDeg < def.spreadDeg.ads, 'even magazine; the pair is tighter than the ADS cone');
ok(def.recoil.resetMs > 60000 / def.rpm, 'recoil resets between pulls');
ok(WEAPON_PRICES.doppler > WEAPON_PRICES.rifle && GUN_GAME_WEAPON_ORDER.includes('doppler')
  && MASTERY_WEAPON_IDS.includes('doppler') && HANDS.doppler.grip && SIGHT_HEIGHT.doppler === -TIMERS.doppler.adsOffset.y,
'priced, in Gun Game, mastered, held, and the ADS offset sits on the sight height');
eq(TIMERS.doppler.doubletGap, def.doublet.gapMs / 1000, 'the rig staggers the second round by the shared gap');

// ---------------------------------------------------------------- shot rules
eq(shotRounds(def, 30), { spend: 2, pellets: 2 });
eq(shotRounds(def, 1), { spend: 1, pellets: 1 }, 'the last odd round fires alone');
eq(shotRounds(def, Infinity), { spend: 2, pellets: 2 }, 'infinite magazines still fire the pair');
eq(shotRounds(WEAPONS.shotgun, 3), { spend: 1, pellets: WEAPONS.shotgun.pellets }, 'pellet weapons are unchanged');
eq(shotRounds(chaosWeaponDef({ chaosUpgrades: { doppler: 1 } }, def), 30), { spend: 2, pellets: 3 }, 'Chaos TRIPLET');
{
  let seed = 7;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const fwd = { x: 0, y: 0, z: -1 };
  let widest = 0;
  for (let i = 0; i < 400; i++) {
    const first = samplePelletDirection(def, fwd, rng, def.spreadDeg.hip, 0);
    const second = samplePelletDirection(def, fwd, rng, def.spreadDeg.hip, 1, first);
    const dot = Math.min(1, first.x * second.x + first.y * second.y + first.z * second.z);
    widest = Math.max(widest, Math.acos(dot) * 180 / Math.PI);
  }
  ok(widest > 0 && widest <= def.doublet.spreadDeg + 1e-6, `the second round stays within ${def.doublet.spreadDeg} deg of the first even from the hip`);
}

// ---------------------------------------------------------------- authority (real engine)
{
  const ticks = [];
  const engine = new GameEngine({ broadcast: (message) => ticks.push(message) });
  engine.addBot('d', 'Doppler');
  const shooter = engine.entities.get('d');
  shooter.botControlled = false;
  const input = { t: 'input', keys: { f: false, b: false, l: false, r: false, jump: false, sprint: false, crouch: false },
    yaw: 0, pitch: 1.2, weapon: slot, wantAds: false, reload: false, viewAge: 9999 };
  let seq = 0;
  const send = (extra) => engine.applyInput('d', { ...input, seq: ++seq, ...extra });
  send({ wantFire: false });
  for (let i = 0; i < 60 && (shooter.weapon !== slot || shooter.deployT > 0); i++) engine.step(TICK_MS);
  eq(shooter.weapon, slot, 'a free-for-all accepts the slot behind the gadget block');
  const shots = () => ticks.flatMap((tick) => tick.events || []).filter((event) => event.kind === 'shoot' && event.id === 'd');
  eq(shooter.mag[slot], def.magSize);
  send({ wantFire: true });
  engine.step(TICK_MS);
  eq(shooter.mag[slot], def.magSize - 2, 'one pull spends two rounds');
  eq(shots().length, 1, 'and is one shot event');
  eq(shots()[0].paths.length, 2, 'that carries both rounds');
  // Hold: doublets repeat at `rpm` pulls per minute.
  const before = shots().length;
  for (let elapsed = 0; elapsed < 1000; elapsed += TICK_MS) { send({ wantFire: true }); engine.step(TICK_MS); }
  const pulls = shots().length - before;
  ok(Math.abs(pulls - def.rpm / 60) <= 1, `a held trigger repeats ${pulls} doublets in a second (${def.rpm} rpm)`);
  // The last odd round.
  send({ wantFire: false });
  for (let i = 0; i < 40; i++) engine.step(TICK_MS);
  shooter.mag[slot] = 1;
  const single = shots().length;
  send({ wantFire: true });
  engine.step(TICK_MS);
  eq(shooter.mag[slot], 0, 'a single round left empties the magazine');
  eq(shots()[single].paths.length, 1, 'and flies alone');
}

// ---------------------------------------------------------------- Conquest
eq(KITS.assault.primaries, ['rifle', 'doppler']);
eq(KITS.marksman.primaries, ['lance', 'doppler']);
for (const kit of ['assault', 'marksman']) {
  const loadout = kitLoadout(kit, 1);
  eq([loadout.primary, loadout.weapon, loadout.mag[slot], loadout.reserve[slot]], ['doppler', slot, def.magSize, def.spareMags],
    `${kit} variant 2 deploys with the SP-2`);
}

// ---------------------------------------------------------------- presentation
ok(dopplerStroke(0) === 0 && dopplerStroke(-1) === 0, 'the unit rests in battery');
{
  const gap = def.doublet.gapMs / 1000;
  let previous = 0;
  for (let t = 0; t <= DOPPLER_BUFFER_S + 1e-9; t += 0.001) {
    const stroke = dopplerStroke(t, 2, gap);
    ok(stroke >= previous - 1e-9 && stroke <= 1 + 1e-9, 'the unit only travels back until it meets the buffer');
    previous = stroke;
  }
  ok(Math.abs(dopplerStroke(DOPPLER_BUFFER_S, 2, gap) - 1) < 1e-6, 'full travel at the buffer');
  ok(dopplerStroke(gap, 2, gap) < 0.7, 'the second round leaves before the buffer is reached');
  ok(dopplerStroke(0.4, 2, gap) === 0 && dopplerStroke(0.4, 1, gap) === 0, 'and it runs home');
  let peak = 0;
  for (let t = 0; t < 0.2; t += 0.001) peak = Math.max(peak, dopplerStroke(t, 1, gap));
  ok(peak > 0.4 && peak < 0.8, 'a single round stops short of the buffer');
}
eq([dopplerVisibleRounds(30, 30, 30), dopplerVisibleRounds(28, 30, 30), dopplerVisibleRounds(1, 30, 30),
  dopplerVisibleRounds(0, 30, 30), dopplerVisibleRounds(99, 30, 30), dopplerVisibleRounds(NaN, 30, 30)], [30, 28, 1, 0, 30, 0]);

// ---------------------------------------------------------------- delivered asset
{
  const gltf = JSON.parse(readFileSync(file('public/assets/blender/doppler.gltf'), 'utf8'));
  const names = gltf.nodes.map((node) => node.name);
  for (const part of ['body', 'unit', 'bolt', 'trigger', 'mag', 'rounds', 'follower', 'pulley', 'spring', 'factory-optic']) {
    ok(names.includes(part) && Number.isInteger(gltf.nodes[names.indexOf(part)].mesh), `part node ${part}`);
  }
  const contract = gltf.asset.extras.contract;
  eq(contract.markers.muzzle, TIMERS.doppler.muzzle, 'the authored muzzle is the rig muzzle');
  ok(Math.abs(contract.sightHeight - SIGHT_HEIGHT.doppler) < 1e-6, 'sight height');
  eq(contract.unitTravel, TIMERS.doppler.unitTravel);
  eq([contract.roundCount, contract.roundMatrices.length, contract.followerPath.length], [def.magSize, def.magSize, def.magSize + 1],
    'one instanced cartridge per round and a follower stop per load');
  ok(contract.roundMatrices[0].every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-6), 'the baked cartridge is the top of the stack');
  ok(contract.followerPath[def.magSize].every((value) => Math.abs(value) < 1e-6) && contract.followerPath[0][1] > 0.1,
    'the follower is authored under a full stack and rises as it empties');
  const atlas = gltf.materials.find((material) => material.extras?.bakedAtlas);
  ok(atlas?.normalTexture && atlas.occlusionTexture && atlas.pbrMetallicRoughness.metallicRoughnessTexture, 'one baked PBR atlas material');
  for (const image of gltf.images) ok(statSync(file(`public/assets/blender/${image.uri}`)).size > 10000, `${image.uri} delivered`);
  eq(gltf.buffers[0].byteLength, statSync(file(`public/assets/blender/${gltf.buffers[0].uri}`)).size, 'geometry buffer size');
  const manifest = JSON.parse(readFileSync(file('public/assets/blender/manifest.json'), 'utf8')).assets.find((entry) => entry.asset === 'doppler');
  ok(manifest && manifest.triangles <= 52000 && manifest.draws <= 16, `budget: ${manifest?.triangles} triangles in ${manifest?.draws} draws`);
  const blend = gltf.materials.filter((material) => material.alphaMode === 'BLEND');
  ok(blend.length === 3 && blend.every((material) => material.extras.glass === true), 'smoke magazine, port glass and lenses blend without depth writes');
}
{
  // Remote players carry the reduced world mesh: same parts (the buffer spring aside), contract and maps.
  const full = JSON.parse(readFileSync(file('public/assets/blender/doppler.gltf'), 'utf8'));
  const world = JSON.parse(readFileSync(file('public/assets/blender/doppler-world.gltf'), 'utf8'));
  const names = world.nodes.filter((node) => Number.isInteger(node.mesh)).map((node) => node.name);
  for (const part of ['body', 'unit', 'bolt', 'trigger', 'mag', 'rounds', 'follower', 'pulley', 'factory-optic']) ok(names.includes(part), `world part ${part}`);
  eq(world.asset.extras.contract, full.asset.extras.contract, 'the world model keeps the authoring contract');
  eq(world.images.map((image) => image.uri), full.images.map((image) => image.uri), 'and the same three maps');
  const assets = JSON.parse(readFileSync(file('public/assets/blender/manifest.json'), 'utf8')).assets;
  const entry = assets.find((item) => item.asset === 'doppler-world');
  const manifest = assets.find((item) => item.asset === 'doppler');
  ok(entry && entry.triangles <= 19000 && entry.triangles * 2.4 < manifest.triangles, `world budget: ${entry?.triangles} triangles`);
}
for (const sound of ['fire.ogg', 'fire-single.ogg']) ok(existsSync(file(`public/assets/audio/weapons/doppler/${sound}`)), sound);
ok(existsSync(file('public/assets/weapons/hud/doppler.png')), 'HUD icon');

console.log(`SP-2 DOPPLER: ${checks} checks passed (rules, authority, Conquest kits, presentation, asset contract).`);
process.exit(0);
