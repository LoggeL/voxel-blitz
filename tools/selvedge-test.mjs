import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { aimAngles } from '../server/sim/player.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { AIR, CONCRETE } from '../shared/worlddata.js';

const slot = WEAPON_IDS.indexOf('selvedge');
assert.equal(slot, 21, 'the stitcher replaces the old primary in its network slot');
assert.equal(WEAPONS.selvedge.mode, 'semi');
const face = x => [x, 2.2, 11];
const left = face(14.5);
const right = face(26.5);

function fixture() {
  // A strip of concrete faces positive Z. Both clicks approach that face from
  // the south; the seam itself travels west to east, across the shooting ray.
  const blocks = new Set();
  const world = {
    dimensions: { sx: 80, sy: 16, sz: 80 },
    getBlock(x, y, z) { return y === 0 || blocks.has([x, y, z].join(',')) ? CONCRETE : AIR; },
    setBlock(x, y, z, type) {
      const key = [x, y, z].join(',');
      if (type === AIR) blocks.delete(key);
      else blocks.add(key);
    },
  };
  for (let x = 4; x < 58; x++) {
    for (let y = 1; y < 4; y++) world.setBlock(x, y, 10, CONCRETE);
  }
  const spawn = [{ x: 20.5, y: 1, z: 24.5, yaw: 0 }];
  const events = [];
  const game = new GameEngine({
    mode: 'tdm', structural: false, world,
    mapMeta: { id: 'foundry', dimensions: world.dimensions, spawns: { fun: spawn, tdm: { alpha: spawn, bravo: spawn } } },
    broadcast: tick => events.push(...tick.events),
  });
  function player(id, team, x, z) {
    game.addClient(id, id);
    const body = game.entities.get(id);
    assert.ok(game.mode.policy.setLobbyTeam(body, team));
    Object.assign(body, { x, y: 1, z, grounded: true, spawnProtected: false, spawnProtectedUntil: 0, hist: [] });
    return body;
  }
  const owner = player('weaver', 'alpha', 20.5, 24.5);
  // Variation in spread is tested independently. Here the selected voxel and
  // hitbox are the subject, and the authority explicitly provides this seam.
  game.contexts.combat.computeConeDeg = () => 0;
  let seq = 0;
  function input(point, wantFire, weapon = slot) {
    const aim = aimAngles([owner.eyeX, owner.eyeY, owner.eyeZ], point);
    game.applyInput(owner.id, { keys: {}, seq: ++seq, weapon, ...aim, wantAds: true, wantFire });
  }
  function advance(ms = TICK_MS) {
    const ticks = Math.ceil(ms / TICK_MS - 1e-9);
    for (let i = 0; i < ticks; i++) game.step(TICK_MS);
  }
  function tap(point) {
    input(point, false);
    advance(Math.max(TICK_MS, owner.cooldown * 1000 + TICK_MS));
    const before = events.length;
    input(point, true);
    advance();
    input(point, false);
    return events.slice(before);
  }
  input(left, false);
  advance();
  advance(owner.deployT * 1000 + TICK_MS);
  assert.equal(owner.weapon, slot, 'the server equips the selected network slot');
  assert.equal(owner.deployT, 0);
  return { game, owner, player, events, world, input, advance, tap };
}

const stitches = batch => batch.filter(e => e.kind === 'stitch');
function stitch(batch, phase) {
  const result = stitches(batch).find(e => e.phase === phase);
  assert.ok(result, `expected a ${phase} stitch in ${JSON.stringify(batch)}`);
  assert.equal(result.id, 'weaver');
  return result;
}
function shot(batch) {
  const shots = batch.filter(e => e.kind === 'shoot' && e.w === 'selvedge');
  assert.equal(shots.length, 1, 'one accepted trigger pull emits one shoot event');
  assert.ok(shots[0].end?.length === 3 && shots[0].end.every(Number.isFinite), 'accepted tap carries its contact point');
  return shots[0];
}

{
  const f = fixture();
  const foe = f.player('runner', 'bravo', 22.5, 11.52);
  const ally = f.player('ally', 'alpha', 18.5, 11.52);
  const protectedFoe = f.player('protected', 'bravo', 19.5, 11.52);
  protectedFoe.spawnProtectedUntil = f.game.now + 10000;
  const wounded = f.player('wounded', 'bravo', 24.5, 11.52);
  wounded.hp = 10;
  const before = f.owner.mag[slot];
  const first = f.tap(left);
  shot(first);
  const pin = stitch(first, 'pin');
  assert.deepEqual(pin.n, [0, 0, 1], 'pin carries the struck voxel face normal');
  assert.equal(pin.ms, 6000);
  assert.equal(Object.hasOwn(pin, 'reason'), false, 'a first pin has no pairing feedback');
  assert.equal(f.owner.mag[slot], before - 1);
  assert.ok(!first.some(e => e.kind === 'block' || e.kind === 'blockDamage'));
  assert.equal(f.game.blockHp.size, 0, 'placing pins never weakens terrain');
  const second = f.tap(right);
  shot(second);
  const seam = stitch(second, 'sew');
  assert.deepEqual(seam.a, pin.a, 'the pulse starts at the first pin');
  assert.ok(Math.abs(seam.b[0] - right[0]) < 0.1);
  assert.ok(Math.abs(seam.ms - 750) <= 5, 'the 12 m seam takes 750 ms at 16 m/s');
  assert.equal(f.owner.mag[slot], before - 2);
  assert.equal(foe.hp, 100, 'the second click does not hit the crossing target');
  f.advance(160);
  assert.equal(foe.hp, 100, 'a runner ahead of the approaching pulse is still unharmed');
  f.advance(650);
  assert.ok(foe.hp < 100, 'the advancing pulse reaches the runner off the original firing ray');
  assert.equal(ally.hp, 100, 'a teammate standing on the seam is unharmed');
  assert.equal(protectedFoe.hp, 100, 'the pulse respects spawn protection');
  assert.equal(wounded.state, 'dead', 'a pulse may hit another body farther down the seam');
  assert.ok(f.events.some(e => e.kind === 'kill' && e.killer === f.owner.id && e.victim === wounded.id && e.w === 'selvedge'),
    'the kill feed credits the stitcher and its owner');
  const hits = f.events.filter(e => e.kind === 'hit' && e.victim === foe.id);
  assert.equal(hits.length, 1, 'one pulse cannot repeatedly damage a target on successive ticks');
  assert.equal(f.world.getBlock(14, 2, 10), CONCRETE);
}

{
  const f = fixture();
  const foe = f.player('direct', 'bravo', 20.5, 17.5);
  const batch = f.tap([foe.x, foe.y + 1.16, foe.z]);
  const click = shot(batch);
  assert.ok(foe.hp < 100 && foe.hp > 50, 'direct torso tap deals modest damage');
  assert.ok(Math.abs(click.end[2] - foe.z) < 0.7, 'the contact stops at the target');
  assert.equal(stitches(batch).length, 0, 'a direct hit does not pin the wall beyond it');
  f.advance(600);
  f.input(left, true);
  f.advance(1050);
  assert.equal(f.events.filter(e => e.kind === 'shoot').length, 2, 'a held trigger never repeats its initial shot');
}

{
  const f = fixture();
  stitch(f.tap(left), 'pin');
  assert.equal(stitch(f.tap(face(15.5)), 'pin').reason, 'short');
  const far = stitch(f.tap(face(42.5)), 'pin');
  assert.equal(far.reason, 'long');
  assert.equal(Object.hasOwn(f.game.selvedge.activeEvents(f.game.now)[0], 'reason'), false, 'joining does not replay a prior refusal');
  const sewn = stitch(f.tap(face(48.5)), 'sew');
  assert.deepEqual(sewn.a, far.a, 'an overlong pair replaces the old pin with the new contact');
}

{
  const f = fixture();
  const foe = f.player('behind', 'bravo', 24.5, 11.52);
  stitch(f.tap(left), 'pin');
  for (let y = 1; y <= 3; y++) f.world.setBlock(20, y, 11, CONCRETE);
  const blocked = f.tap(right);
  assert.equal(stitch(blocked, 'pin').reason, 'blocked');
  assert.ok(!stitches(blocked).some(e => e.phase === 'sew'), 'a wall between pins prevents sewing through cover');
  f.advance(1000);
  assert.equal(foe.hp, 100);
}

// The map can change after both pins have passed their initial visibility check.
{
  const f = fixture();
  const foe = f.player('behind', 'bravo', 23.5, 11.52);
  stitch(f.tap(left), 'pin');
  stitch(f.tap(right), 'sew');
  f.advance(80);
  for (let y = 1; y <= 3; y++) f.world.setBlock(20, y, 11, CONCRETE);
  f.advance(900);
  assert.ok(stitches(f.events).some(e => e.phase === 'clear' && e.part === 'seam'), 'new cover interrupts the moving pulse');
  assert.equal(foe.hp, 100, 'the pulse cannot pass through newly placed cover');
}

{
  const f = fixture();
  const beyond = f.player('distant', 'bravo', 20.5, 78);
  const pin = stitch(f.tap(left), 'pin');
  const outOfRange = f.tap([beyond.x, beyond.y + 1.2, beyond.z]);
  const end = shot(outOfRange).end;
  const range = Math.hypot(end[0] - f.owner.eyeX, end[1] - f.owner.eyeY, end[2] - f.owner.eyeZ);
  assert.ok(Math.abs(range - WEAPONS.selvedge.stitch.range) < 0.02, 'an empty tap ends at the placement range');
  assert.equal(beyond.hp, 100, 'bodies beyond the range are unharmed');
  assert.equal(stitches(outOfRange).length, 0, 'empty air preserves the existing pin');
  assert.deepEqual(stitch(f.tap(right), 'sew').a, pin.a);
}

{
  const f = fixture();
  stitch(f.tap(left), 'pin');
  const launch = stitch(f.tap(right), 'sew');
  const launchedAt = f.game.now;
  const nextPin = stitch(f.tap(face(32.5)), 'pin');
  const pinnedAt = f.game.now;
  f.advance(100);

  const replay = () => f.game.selvedge.activeEvents(f.game.now);
  const active = replay();
  assert.deepEqual(active.map(e => e.restore), [true, true], 'active fields are marked for silent restoration');
  assert.ok([launch, nextPin].every(e => !Object.hasOwn(e, 'restore')), 'normal placements retain their launch cues');
  assert.deepEqual(active.map(e => e.phase), ['sew', 'pin'], 'replaying the older seam first leaves the new pin visible');
  const seam = stitch(active, 'sew');
  const pin = stitch(active, 'pin');
  const elapsed = f.game.now - launchedAt;
  assert.deepEqual(seam.b, launch.b);
  assert.equal(seam.radius, launch.radius);
  assert.ok(Math.abs(seam.ms - (launch.ms - elapsed)) < 1, 'a joining client sees the remaining travel time');
  const expectedFront = launch.a.map((value, i) => value + (launch.b[i] - value) * elapsed / launch.ms);
  assert.ok(seam.a.every((value, i) => Math.abs(value - expectedFront[i]) < 0.02),
    'the pulse starts at its current front, partway between its original contacts');
  assert.deepEqual([pin.a, pin.n], [nextPin.a, nextPin.n]);
  assert.ok(Math.abs(pin.ms - (nextPin.ms - (f.game.now - pinnedAt))) < 1, 'joining does not reset the pin lifetime');
  assert.deepEqual(replay(), active, 'one client joining does not consume effects needed by the next');

  f.advance(seam.ms + TICK_MS);
  assert.deepEqual(replay().map(e => e.phase), ['pin'], 'completed pulses are absent from later joins');
  f.advance(nextPin.ms);
  assert.deepEqual(replay(), [], 'expired pins are absent from later joins');
}

for (const reason of ['expiry', 'weapon switch', 'lost support', 'death', 'round end']) {
  const f = fixture();
  const pin = stitch(f.tap(left), 'pin');
  if (reason === 'expiry') f.advance(pin.ms + TICK_MS);
  if (reason === 'weapon switch') f.input(left, false, WEAPON_IDS.indexOf('rifle'));
  if (reason === 'lost support') f.world.setBlock(14, 2, 10, AIR);
  if (reason === 'death') f.game.killPlayer(f.owner, null, 'world', false);
  if (reason === 'round end') f.game.mode.policy.phase = 'post';
  f.advance(2 * TICK_MS);
  assert.ok(stitches(f.events).some(e => e.phase === 'clear'), `${reason} clears the visible pin`);
  if (reason === 'expiry' || reason === 'lost support') {
    const next = f.tap(right);
    assert.equal(Object.hasOwn(stitch(next, 'pin'), 'reason'), false);
    assert.ok(!stitches(next).some(e => e.phase === 'sew'), `${reason} invalidates the server's old pin`);
  }
}

console.log('SL-2 SELVEDGE passed input, pulse travel, damage, cover, team, range, late join and lifecycle checks.');
