import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { observeBotTarget } from '../server/bot-perception.js';
import { PlayerEntity } from '../server/sim/player.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { playerHitboxes } from '../shared/player-hitboxes.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { AIR, CONCRETE, GROUND } from '../shared/worlddata.js';

const clearSmoke = { blocksSight: () => false };
const player = (id, x, y, z) => new PlayerEntity(id, id, { x, y, z });
const observer = player('observer', 20.5, 1, 30.5);
const target = player('target', 20.5, 1, 20.5);
const see = (solidAt = () => false, tracking = false) =>
  observeBotTarget(observer, target, solidAt, clearSmoke, 1000, tracking);
observer.yaw = observer.pitch = target.yaw = target.pitch = 0;

const exposed = see();
assert(exposed && exposed.exposure > 0.99, 'open body is visible ahead');
assert(exposed.recognitionMs >= 320, 'even a close open target needs reaction time');
assert.deepEqual(exposed.aimPoint, playerHitboxes(target).find(box => box.zone === 'torso').center,
  'uncovered targets are aimed at the torso');

target.z = 40.5;
assert.equal(see(), null, 'no acquisition behind the bot');
assert.equal(see(() => false, true), null, 'held targets do not grant rear vision');
target.z = -14.5;
assert(see(), 'open 45-meter sightline provides evidence on large maps');
target.z = -69.5;
const longRange = see();
assert(longRange && longRange.recognitionMs > exposed.recognitionMs * 2, '100-meter target is detectable with slower recognition');
target.z = -80;
assert.equal(see(), null, 'acquisition remains bounded beyond the configured sight range');
target.z = 0.5;
const distant = see();
assert(distant && distant.recognitionMs > exposed.recognitionMs,
  'open targets at 30 meters take longer to recognize');
target.z = 20.5;
target.x = 30.5;
const peripheral = see();
assert(peripheral && peripheral.recognitionMs > exposed.recognitionMs,
  'peripheral targets take longer to recognize');
target.x = 20.5;
target.y = 25;
assert.equal(see(), null, 'vertical field of view rejects targets far overhead');
target.y = 1;

const wall = (_x, y, z) => z === 25 && y >= 1 && y <= 4;
assert.equal(see(wall), null, 'a full wall blocks every body sample');
assert.equal(see(wall, true), null, 'tracking cannot see through a full wall');
const lowWall = (_x, y, z) => z === 21 && y === 1;
const standing = see(lowWall);
assert(standing && standing.exposure < exposed.exposure,
  'low cover hides part of an upright body');
target.crouch = true;
const crouched = see(lowWall);
assert(crouched && crouched.exposure < standing.exposure,
  'crouching behind low cover exposes only the head');
assert(crouched.recognitionMs > standing.recognitionMs,
  'crouched peeking is slower to recognize');
assert.deepEqual(crouched.aimPoint, playerHitboxes(target).find(box => box.zone === 'head').center,
  'bot aims at the exposed head instead of firing into the covered torso');
target.z = 0.5;
assert(see(), 'uncovered crouched player can be seen at 30 meters');
const distantPeek = see((_x, y, z) => z === 1 && y === 1);
assert(distantPeek && distantPeek.recognitionMs > distant.recognitionMs,
  'a distant visible head gives weak evidence instead of an arbitrary range cutoff');
target.z = 20.5;
target.proneT = 1;
assert.equal(see(lowWall), null, 'prone body is fully concealed behind a low wall');
const prone = see();
assert(prone && prone.aimPoint[1] < target.y + 0.6,
  'an exposed prone target uses the real low body position');
target.proneT = 0;
target.crouch = false;

// This short diagonal crosses a voxel near a corner between the old one-unit
// samples. Check the complete perception path, not just the DDA primitive.
observer.x = 0.9; observer.z = 0.2; observer.yaw = Math.atan2(-2, -2);
target.x = 2.9; target.z = 2.2;
assert(see(), 'corner fixture has an open sightline without the voxel');
assert.equal(see((x, _y, z) => x === 1 && z === 0), null,
  'a thin diagonal corner blocks all rays even between old sparse samples');

function fixture() {
  const y = GROUND + 1.02;
  const blocks = new Set();
  const spawn = { x: 20.5, y, z: 30.5, index: 0 };
  const world = {
    meta: { id: 'foundry', spawns: { fun: [spawn] } },
    getBlock: (x, by, z) => by <= GROUND || blocks.has(`${x},${by},${z}`) ? CONCRETE : AIR,
    heightAt: () => GROUND,
    findSpawns: () => [spawn],
    setBlock: () => false,
  };
  const engine = new GameEngine({ world, mode: 'fun' });
  engine.now = 100_000;
  const bots = attachBots(engine, 1);
  engine.addClient('human', 'Human');
  const bot = engine.entities.get('bot-0');
  const human = engine.entities.get('human');
  Object.assign(bot, { x: 20.5, y, z: 30.5, yaw: 0, pitch: 0, deployT: 0,
    spawnProtectedUntil: 0, grounded: false });
  Object.assign(human, { x: 20.5, y, z: 20.5, yaw: 0, pitch: 0, spawnProtectedUntil: 0 });
  const brain = bots.brains[0];
  function cover(height = 3) {
    for (let x = 0; x < 128; x++) {
      for (let by = GROUND + 1; by <= GROUND + height; by++) blocks.add(`${x},${by},25`);
    }
  }
  function decide(ms = 50) {
    engine.now += ms;
    const input = bots.think(brain, bot, engine.now, ms / 1000);
    // Keep positions fixed so timing is reproducible; apply the real aim and
    // input admission, then exercise the authoritative fire resolver below.
    engine.applyInput(bot.id, input);
    bot.yaw = input.yaw; bot.pitch = input.pitch;
    return input;
  }
  function acquire() {
    for (let tick = 0; tick < 40; tick++) {
      const input = decide();
      if (input.wantFire) return input;
    }
    assert.fail('exposed enemy must eventually be engaged');
  }
  return { engine, bots, brain, bot, human, blocks, cover, decide, acquire };
}

{
  const f = fixture();
  try {
    const first = f.decide();
    assert.equal(first.wantFire, false, 'first sight never requests an instant shot');
    assert.equal(f.brain.lastSeen, null, 'a fleeting glance does not create confirmed combat memory');
    const started = f.engine.now;
    f.acquire();
    assert(f.engine.now - started >= 250, 'close acquisition has a measurable reaction delay');
    assert.equal(f.brain.enemyId, f.human.id);
    const lastSeen = structuredClone(f.brain.lastSeen);
    // Resolve an actual shot before installing cover.
    resolveWeaponIntent(f.bot, 0.05, f.engine.contexts.combat);
    assert(f.bot.firing, 'visible target reaches authoritative fire');
    const mag = f.bot.mag[f.bot.weapon];

    f.cover();
    assert.equal(f.decide().wantFire, false, 'cover stops firing on the first obscured decision');
    assert.equal(f.brain.enemyId, null, 'cover clears the visible target cache');
    assert.equal(f.brain.state, 'search', 'bot searches after losing an established target');
    f.human.x = 50.5;
    for (let i = 0; i < 8; i++) {
      const input = f.decide();
      resolveWeaponIntent(f.bot, 0.05, f.engine.contexts.combat);
      assert.equal(input.wantFire, false, 'hidden lateral movement never requests fire');
      assert.deepEqual(f.brain.lastSeen, lastSeen, 'hidden target cannot update remembered coordinates or timeout');
      assert(Math.abs(input.yaw) < 0.2, 'search follows the old position, not lateral movement behind the wall');
    }
    assert.equal(f.bot.mag[f.bot.weapon], mag, 'no ammunition is fired into cover');
    f.engine.now = lastSeen.until;
    f.decide();
    assert.equal(f.brain.lastSeen, null, 'unseen target is forgotten after the search timeout');
    assert.equal(f.brain.state, 'roam', 'bot resumes roaming after an unsuccessful search');

    f.human.x = 20.5;
    f.blocks.clear();
    f.bot.yaw = 0;
    assert.equal(f.decide().wantFire, false, 'reappearance requires a fresh reaction');
    f.acquire();
    f.bot.lives++;
    assert.equal(f.decide().wantFire, false, 'respawn resets recognition and fire readiness');
    assert.equal(f.brain.lastSeen, null, 'respawn clears old search memory');
  } finally { f.bots.dispose(); f.engine.stop(); }
}

{
  const f = fixture();
  try {
    f.human.z = 40.5;
    assert.equal(f.bots.pickTarget(f.bot, f.brain), null, 'manager rejects an enemy behind it');
    f.bot.yaw = Math.PI;
    assert.equal(f.bots.pickTarget(f.bot, f.brain), f.human, 'turning toward the enemy permits detection');
    f.human.z = -100;
    f.bot.yaw = 0;
    assert.equal(f.bots.pickTarget(f.bot, f.brain), null, 'manager drops a distant held target');
    f.human.z = 20.5;
    f.acquire();
    f.engine.projectiles.smoke.deploy({ id: 'cover', x: 20.5, y: f.bot.y, z: 25.5 },
      f.engine.contexts.projectiles);
    f.engine.now += 1000;
    assert.equal(f.decide().wantFire, false, 'real smoke interrupts established combat');
    assert.equal(f.brain.enemyId, null, 'smoke clears the visible target');
    assert.equal(f.brain.state, 'search', 'smoke leaves only the last observed position');
  } finally { f.bots.dispose(); f.engine.stop(); }
}

{
  const f = fixture();
  try {
    f.acquire();
    f.human.x += 9;
    const turning = f.decide();
    assert.equal(f.brain.enemyId, f.human.id, 'moving target stays inside the tracking field of view');
    assert.equal(turning.wantFire, false, 'recognized target still requires the weapon to turn into alignment');
    assert(Math.abs(turning.yaw) < 0.2, 'turning stays limited to human-scale angular speed');
    f.acquire();

    f.cover();
    f.decide();
    const oldPosition = structuredClone(f.brain.lastSeen.position);
    f.bot.x = oldPosition.x; f.bot.y = oldPosition.y; f.bot.z = oldPosition.z + 1;
    // Keep the enemy hidden behind the same wall while the bot checks its old spot.
    f.human.z = 30.5;
    f.bot.yaw = 0;
    const search = f.decide();
    assert.equal(f.brain.state, 'search');
    assert.equal(search.wantFire, false);
    assert.equal(search.keys.f || search.keys.b || search.keys.l || search.keys.r, false,
      'bot stops and looks around when it reaches the remembered spot');
  } finally { f.bots.dispose(); f.engine.stop(); }
}

{
  const f = fixture();
  try {
    f.acquire();
    f.bot.weapon = WEAPON_IDS.indexOf('lance');
    f.bot.charging = true; f.bot.chargeT = 1000; f.bot.charge = 0.4;
    f.bot.triggerPrev = true;
    f.bot.fireEdgeQueued = false;
    const mag = f.bot.mag[f.bot.weapon];
    f.cover();
    assert.equal(f.decide().wantFire, false, 'a charged weapon loses fire permission behind cover');
    resolveWeaponIntent(f.bot, 0.05, f.engine.contexts.combat);
    assert.equal(f.bot.charging, false, 'lost sight cancels the capacitor');
    assert.equal(f.bot.chargeT, 0);
    assert.equal(f.bot.mag[f.bot.weapon], mag, 'charge cancellation cannot release a shot through cover');
  } finally { f.bots.dispose(); f.engine.stop(); }
}

console.log('Bot perception: view cone, range, body exposure, stance, diagonal cover, reaction, search, smoke, respawn and charge cancellation passed.');
