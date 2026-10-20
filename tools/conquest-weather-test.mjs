// Conquest dynamic weather (docs/conquest.md, *Weather*): the seeded timeline,
// phases and forecast, the `wx` tuple, wetness, the ConquestWeather stepper and
// its lightning, the policy's snapshot and `weather_strike` events, and every
// gameplay multiplier against its consumer: spotting range, STINGER lock range,
// bot sight and recognition, canopy drift. The client side reads the same tuple:
// the HUD weather tab's ranges and the ConquestWeatherView blend on a fake world.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { ConquestWeather, weatherOptionFromEnv } from '../server/modes/conquest/weather.js';
import { observeBotVehicle } from '../server/bot-vehicle-combat.js';
import { botWeather, weatherLockScale, weatherSight } from '../server/bot-weather.js';
import { observeBotTarget } from '../server/bot-perception.js';
import { PlayerEntity } from '../server/sim/player.js';
import {
  CALM_WEATHER, WEATHER_IDS, WEATHER_RULES, WEATHER_STATES, decodeConquestWeather, encodeConquestWeather,
  stepWetness, weatherMix, weatherMixAt, weatherPhaseAt, weatherTimeline, windDegAt,
} from '../shared/conquest-weather.js';
import { CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, CONQUEST_RULES } from '../shared/conquest-contract.js';
import { decodeConquestMatch } from '../shared/conquest.js';
import { LOCK_RULES } from '../shared/vehicle-defs.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { PARACHUTE, stepChuteVelocity } from '../shared/parachute.js';
import { lockerModel, weatherChipModel } from '../public/js/ui/conquest-hud-state.js';

let checks = 0;
const ok = () => { checks++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const MIN = 60_000;

// --- data tables -------------------------------------------------------------
assert.deepEqual(WEATHER_IDS, ['golden', 'overcast', 'mist', 'storm'], 'wire order (append only)');
for (const id of WEATHER_IDS) {
  const s = WEATHER_STATES[id];
  for (const key of ['spot', 'lock', 'vision', 'recognition']) assert(s[key] > 0 && s[key] <= 1, `${id}.${key} only ever shortens`);
  assert(WEATHER_RULES.holdMs[id], `${id} has a hold`);
}
assert.equal(WEATHER_STATES.golden.spot, 1); assert.equal(WEATHER_STATES.golden.lock, 1);
assert(WEATHER_STATES.mist.spot < WEATHER_STATES.storm.spot, 'fog hides more than rain');
assert(WEATHER_STATES.storm.rain === 1 && WEATHER_STATES.storm.lightning === 1, 'only the storm rains and strikes');
for (const script of WEATHER_RULES.scripts) assert.equal(script[0], 'golden', 'every forecast opens clear');
assert(WEATHER_RULES.openingMs[0] >= 180_000, 'the opening outlasts the 180 s action gate');
assert.equal(CONQUEST_CONTRACT_VERSION, 7);
assert(CONQUEST_EVENT_KINDS.indexOf('weather_strike') === CONQUEST_EVENT_KINDS.indexOf('medal') + 1, 'weather_strike is appended to the event kinds after the ribbons');
ok();

// --- timeline ----------------------------------------------------------------
const area = { minX: 100, maxX: 600, minZ: 80, maxZ: 640 };
const t1 = weatherTimeline(1234, { durationMs: 20 * MIN, area });
assert.deepEqual(weatherTimeline(1234, { durationMs: 20 * MIN, area }), t1, 'one seed, one timeline');
const seeds = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(weatherTimeline(i * 7919, { durationMs: 20 * MIN, area }).keys.map(k => k.state))));
assert(seeds.size >= 2, 'seeds draw different scripts');
assert.equal(t1.keys[0].at, 0); assert.equal(t1.keys[0].state, 'golden');
assert(t1.keys[0].until >= WEATHER_RULES.openingMs[0] && t1.keys[0].until <= WEATHER_RULES.openingMs[1], 'opening hold from openingMs');
for (let i = 1; i < t1.keys.length; i++) {
  const gap = t1.keys[i].at - t1.keys[i - 1].until;
  assert(gap >= WEATHER_RULES.transitionMs[0] - 1 && gap <= WEATHER_RULES.transitionMs[1] + 1, `transition ${i} from transitionMs (${gap})`);
  assert(t1.keys[i].until > t1.keys[i].at, 'holds move forward');
}
{
  const end = weatherPhaseAt(t1, 20 * MIN - 1);
  assert.deepEqual([end.from, end.to, end.next], [t1.keys.at(-1).state, t1.keys.at(-1).state, null], 'the last state holds to the end');
  assert(t1.keys.at(-1).at < 20 * MIN, 'no key starts after the match');
}
for (const strike of t1.strikes) {
  assert(weatherMixAt(t1, strike.at).lightning > 0, 'strikes only fall while the mix has lightning');
  const R = WEATHER_RULES.lightning.reach;
  assert(strike.x >= area.minX - R && strike.x <= area.maxX + R && strike.z >= area.minZ - R && strike.z <= area.maxZ + R, 'strikes land around the map');
}
{
  const storm = weatherTimeline(5, { durationMs: 10 * MIN, area, script: ['storm'] });
  const gaps = storm.strikes.slice(1).map((s, i) => s.at - storm.strikes[i].at);
  assert(storm.strikes.length > 30, `a held storm strikes often (${storm.strikes.length} in 10 min)`);
  assert(gaps.every(g => g >= WEATHER_RULES.lightning.everyMs[0] - 1), 'no two strikes closer than everyMs');
  const calm = weatherTimeline(5, { durationMs: 10 * MIN, area, script: ['golden', 'mist'] });
  assert.equal(calm.strikes.length, 0, 'no lightning without a storm');
}
ok();

// --- phases, mix, forecast ---------------------------------------------------
{
  const tl = weatherTimeline(9, { durationMs: 20 * MIN, area, script: ['golden', 'storm', 'overcast'] });
  const [a, b] = tl.keys;
  const hold = weatherPhaseAt(tl, 1000);
  assert.deepEqual([hold.from, hold.to, hold.blend, hold.next], ['golden', 'golden', 0, 'storm']);
  assert.equal(hold.etaS, Math.ceil((a.until - 1000) / 1000), 'etaS counts down to the end of the hold');
  const mid = weatherPhaseAt(tl, (a.until + b.at) / 2);
  assert.deepEqual([mid.from, mid.to, mid.next], ['golden', 'storm', 'storm']);
  assert(near(mid.blend, 0.5, 0.01), 'half way through the transition');
  assert.equal(mid.etaS, Math.ceil((b.at - (a.until + b.at) / 2) / 1000), 'etaS counts down to the end of the transition');
  const half = weatherMix('golden', 'storm', 0.5);
  assert(near(half.spot, (WEATHER_STATES.golden.spot + WEATHER_STATES.storm.spot) / 2), 'smoothstep is symmetric at 0.5');
  assert(weatherMix('golden', 'storm', 0.2).spot > 1 - 0.2 * 0.3, 'smoothstep eases in');
  const last = weatherPhaseAt(tl, 19 * MIN);
  assert.equal(last.next, null, 'the last hold has no forecast');
  const w0 = windDegAt(tl, 0), w1 = windDegAt(tl, WEATHER_RULES.windVeerMs / 4);
  const veer = Math.abs(((w1 - w0 + 540) % 360) - 180);
  assert(veer <= WEATHER_RULES.windVeerDeg + 1, `the wind veers at most windVeerDeg (${veer})`);
}
ok();

// --- the wx tuple ------------------------------------------------------------
{
  const wx = encodeConquestWeather({ from: 'golden', to: 'storm', blend: 0.4, etaS: 31.2, windDeg: -30, wet: 0.257, next: 'storm' });
  assert.deepEqual(wx, [0, 3, 40, 31, 330, 26, 3]);
  assert(JSON.stringify(wx).length <= 24, 'the tuple stays tiny');
  const d = decodeConquestWeather(wx);
  assert.deepEqual([d.from, d.to, d.next, d.etaS, d.windDeg], ['golden', 'storm', 'storm', 31, 330]);
  const mix = weatherMix('golden', 'storm', 0.4);
  for (const key of ['spot', 'lock', 'vision', 'recognition', 'rain']) assert(near(d[key], mix[key]), `decode carries ${key}`);
  assert(near(Math.hypot(d.drift.x, d.drift.z), mix.driftSpeed), 'drift is the blended drift speed');
  assert(near(Math.atan2(d.drift.z, d.drift.x), 330 * Math.PI / 180 - 2 * Math.PI, 1e-9), 'drift points along windDeg');
  assert.equal(decodeConquestWeather(null), null);
  assert.equal(decodeConquestWeather([3, 3, 0, 0, 0, 100, -1]).next, null, '-1 is no forecast');
  const full = decodeConquestWeather([3, 3, 0, 0, 0, 100, -1]);
  for (const key of ['spot', 'lock', 'vision', 'recognition']) assert.equal(full[key], WEATHER_STATES.storm[key]);
  const cq = decodeConquestMatch({ v: 2, tickets: { alpha: 1, bravo: 1 }, flags: [], squads: [], wx }, null);
  assert.equal(cq.weather.to, 'storm', 'decodeConquestMatch exposes the weather');
  assert.equal(decodeConquestMatch({ v: 2, tickets: { alpha: 1, bravo: 1 }, flags: [], squads: [] }, null).weather, null, 'no wx, no weather');
}
ok();

// --- wetness -----------------------------------------------------------------
{
  let wet = 0;
  for (let i = 0; i < 45; i++) wet = stepWetness(wet, 1, 1);
  assert(near(wet, 1, 1e-9), 'full rain soaks the ground in 45 s');
  for (let i = 0; i < 75; i++) wet = stepWetness(wet, 0, 1);
  assert(near(wet, 0.5, 1e-9), 'it dries at half the speed it took... per 75 s of dry weather');
  for (let i = 0; i < 100; i++) wet = stepWetness(wet, 0, 1);
  assert.equal(wet, 0);
}
ok();

// --- ConquestWeather stepper ---------------------------------------------------
{
  const off = new ConquestWeather({ option: 'off' });
  assert.equal(off.snapshot(), null); assert.equal(off.effects, CALM_WEATHER); assert.deepEqual(off.step(10_000), []);
  const pinned = new ConquestWeather({ option: 'storm', area, durationMs: 10 * MIN });
  pinned.reset(50_000, 77);
  assert.equal(pinned.effects.spot, WEATHER_STATES.storm.spot, 'a pinned state applies from the first tick');
  assert.equal(pinned.effects.wet, 1, 'a pinned storm starts soaked');
  const first = pinned.effects;
  pinned.step(50_000 + 16);
  assert.equal(pinned.effects, first, 'effects keep their identity while the tuple holds');
  let strikes = 0;
  for (let t = 0; t <= 2 * MIN; t += 100) strikes += pinned.step(50_000 + t).length;
  assert(strikes >= 6, `a held storm strikes several times in 2 min (${strikes})`);
  const stall = new ConquestWeather({ option: 'storm', area, durationMs: 10 * MIN });
  stall.reset(0, 77);
  const due = stall.step(9 * MIN);
  assert(due.length <= 1, 'a stall never fires the lightning backlog');
  const seeded = new ConquestWeather({ option: { seed: 42 }, area });
  const again = new ConquestWeather({ option: { seed: 42 }, area });
  assert.deepEqual(seeded.timeline, again.timeline, 'an object option fixes the seed');
  const live = new ConquestWeather({ option: { seed: 42, script: ['golden', 'storm'] }, area, durationMs: 20 * MIN });
  live.reset(0);
  let wetSeen = 0;
  for (let t = 0; t <= 20 * MIN; t += 1000) { live.step(t); wetSeen = Math.max(wetSeen, live.effects.wet); }
  assert(wetSeen > 0.95, 'rain soaks the ground over the storm');
  assert.equal(live.snapshot().length, 7);
}
ok();

// --- policy: snapshot, events, multipliers -----------------------------------
function fixture(weather = 'storm') {
  const dimensions = { sx: 640, sy: 64, sz: 640 }, frames = [];
  const world = { dimensions, getBlock: (x, y) => y === 0 ? 3 : 0, setBlock: () => true, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'heli', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }],
        combatArea: { minX: 0, maxX: 640, minZ: 0, maxZ: 640 } } } });
  const policy = game.mode.policy;
  policy.weather.option = weather;
  policy.weather.reset(policy.ledger.startedAt);
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    policy.setLobbyTeam(p, team);
    Object.assign(p, { hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true, input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    return p;
  };
  return { game, policy, frames, player };
}
{
  const f = fixture('storm');
  f.player('a1', 'alpha', { x: 20, y: 1, z: 20 });
  f.game.step(1000 / 60);
  const match = f.frames.at(-1)?.match;
  assert(Array.isArray(match?.conquest?.wx), 'the snapshot carries match.conquest.wx');
  assert.deepEqual(match.conquest.wx.slice(0, 3), [3, 3, 0]);
  assert.equal(f.game.mode.weatherEffects().spot, WEATHER_STATES.storm.spot, 'ModeController passes the effects through');
  const emitted = [];
  const emit = f.policy._emit.bind(f.policy);
  f.policy._emit = (kind, payload) => { if (kind === 'weather_strike') emitted.push(payload); return emit(kind, payload); };
  const start = f.policy.weather.startedAt;
  for (let t = 0; t <= 2 * MIN; t += 100) f.policy._stepWeather(start + t);
  assert(emitted.length > 0, 'strikes become weather_strike events');
  assert(emitted.every(e => Number.isFinite(e.x) && e.y === 1 && Number.isFinite(e.z)), 'a strike stands on the ground under it');
  const off = fixture('off');
  off.player('a1', 'alpha', { x: 20, y: 1, z: 20 });
  off.game.step(1000 / 60);
  assert.equal(off.frames.at(-1).match.conquest.wx, undefined, "weather 'off' sends no wx");
  assert.equal(off.game.mode.weatherEffects(), CALM_WEATHER);
}
ok();

// Spotting range (CONQUEST_RULES.spotRange × spot).
{
  const f = fixture('storm');
  const p = f.player('a1', 'alpha', { x: 20, y: 1, z: 20 });
  const spotting = f.policy.roles.spotting;
  assert(near(spotting.rangeFor(p), CONQUEST_RULES.spotRange * WEATHER_STATES.storm.spot), 'a storm shortens the spot range');
  f.policy.weather.option = 'golden'; f.policy.weather.reset(0);
  assert.equal(spotting.rangeFor(p), CONQUEST_RULES.spotRange, 'clear weather keeps the kit range');
  f.policy.weather.option = 'mist'; f.policy.weather.reset(0);
  const chip = weatherChipModel({ weather: decodeConquestWeather(f.policy.weather.snapshot()) }, { kit: 'assault' });
  assert.equal(chip.spot, Math.round(spotting.rangeFor(p)), 'the HUD tab shows the server range');
  assert.equal(chip.label, 'FOG');
  // Thermal optics (vehicle upgrades) see through the weather as they see through smoke.
  spotting.hullSpot = () => ({ range: 450, ms: 8000, smoke: true });
  assert.equal(spotting.rangeFor(p), 450, 'thermal optics keep their range in fog');
  const thermal = weatherChipModel({ weather: decodeConquestWeather(f.policy.weather.snapshot()) }, { kit: 'assault', hullSpot: 450 });
  assert.equal(thermal.spot, 450, 'the HUD tab shows the thermal range');
  assert.equal(thermal.spotReduced, false, 'thermal spotting is not shortened');
}
ok();

// STINGER lock range (LOCK_RULES.stinger.range × lock): a helicopter at 280 m locks in clear weather, not in fog.
function stingerLock(weather) {
  const f = fixture(weather);
  const heli = f.game.vehicles.vehicles.get('heli');
  const p = f.player('eng', 'alpha', { x: 300, y: 1, z: 300 });
  const slot = WEAPON_IDS.indexOf('stinger');
  if (Array.isArray(p.owned)) p.owned = [...p.owned, 'stinger'];
  p.mag[slot] = 1; p.reserve[slot] = 2;
  Object.assign(p, { weapon: slot, deployT: 0, cooldown: 0 });
  const at = { x: 300, y: 30, z: 300 - 280 };
  const pin = () => Object.assign(heli, { ...at, vx: 0, vy: 0, vz: 0, speed: 0, grounded: false, rotorSpeed: 1, pitch: 0, roll: 0 });
  let best = 0;
  for (let i = 0; i < 150; i++) {
    const dx = at.x - p.eyeX, dy = at.y + 1.6 - p.eyeY, dz = at.z - p.eyeZ;
    f.game.applyInput(p.id, { keys: {}, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), wantAds: true });
    pin(); f.game.step(1000 / 60);
    best = Math.max(best, p.lockProgress ?? 0);
  }
  return best;
}
{
  assert.equal(stingerLock('golden'), 1, 'clear weather: the STINGER locks at 280 m');
  assert(LOCK_RULES.stinger.range * WEATHER_STATES.mist.lock < 280, 'fog puts 280 m out of lock range');
  assert.equal(stingerLock('mist'), 0, 'fog: no lock at 280 m');
}
ok();

// Bots: sight range and recognition through weatherSight.
{
  const f = fixture('storm');
  assert.equal(botWeather(f.game).vision, WEATHER_STATES.storm.vision);
  const sight = weatherSight(f.game);
  assert.deepEqual({ ...sight }, { visionScale: WEATHER_STATES.storm.vision, recognitionScale: WEATHER_STATES.storm.recognition });
  assert.equal(weatherSight(f.game), sight, 'the option bag is cached per weather');
  assert.deepEqual(weatherSight(f.game, { sightRange: 300 }), { sightRange: 300, ...sight }, 'existing options are kept');
  assert.equal(weatherLockScale(f.game), WEATHER_STATES.storm.lock);
  const calm = fixture('off');
  assert.equal(weatherSight(calm.game, null), null, 'calm weather passes the options through');
  assert.equal(weatherLockScale(calm.game), 1);
  assert.equal(weatherSight({ mode: {} }), null, 'other modes have no weather');
  const clearSmoke = { blocksSight: () => false };
  const observer = new PlayerEntity('o', 'o', { x: 20.5, y: 1, z: 120.5 });
  const target = new PlayerEntity('t', 't', { x: 20.5, y: 1, z: 20.5 });
  observer.yaw = observer.pitch = target.yaw = target.pitch = 0;
  const clear = observeBotTarget(observer, target, () => false, clearSmoke, 1000, false, undefined, null);
  assert(clear, 'a 100 m open target is seen in clear weather');
  assert.equal(observeBotTarget(observer, target, () => false, clearSmoke, 1000, false, undefined, sight), null, 'a storm hides it');
  target.z = 70.5;
  const near50 = observeBotTarget(observer, target, () => false, clearSmoke, 1000, false, undefined, null);
  const stormy = observeBotTarget(observer, target, () => false, clearSmoke, 1000, false, undefined, sight);
  assert(stormy && stormy.recognitionMs > near50.recognitionMs, 'rain slows recognition');
}
ok();

// Canopy drift: an open canopy settles at glide + steer + drift.
{
  const vel = { x: 0, y: 0, z: 0 };
  const drift = decodeConquestWeather([3, 3, 0, 0, 0, 100, -1]).drift;
  for (let i = 0; i < 600; i++) stepChuteVelocity(vel, 0, 0, 0, 1 / 60, drift);
  assert(near(vel.x, WEATHER_STATES.storm.drift, 1e-3), `the storm wind carries the canopy east (${vel.x})`);
  assert(near(vel.z, -PARACHUTE.glide, 1e-3), 'the glide stays along the look yaw');
  const still = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 600; i++) stepChuteVelocity(still, 0, 0, 0, 1 / 60);
  assert(near(still.x, 0, 1e-9), 'no drift without weather');
  const f = fixture('storm');
  assert.equal(f.game.contexts.movement.chuteDrift, f.policy.weatherEffects().drift, 'server movement reads the weather drift');
  assert(Math.hypot(f.game.contexts.movement.chuteDrift.x, f.game.contexts.movement.chuteDrift.z) > 1);
  assert.equal(fixture('off').game.contexts.movement.chuteDrift.x, 0, 'calm weather has no drift');
}
ok();

// HUD tab model: forecast wording and the jet's AA range.
{
  const chip = wx => weatherChipModel({ weather: decodeConquestWeather(wx) }, { kit: 'assault' });
  const storm = chip([3, 3, 0, 130, 40, 82, 1]);
  assert.deepEqual([storm.label, storm.spotText, storm.lockText, storm.forecast, storm.severity],
    ['STORM', 'SPOT 210 M', 'LOCK 240 M', 'CLEARING 2:10', 'bad']);
  assert.equal(chip([0, 0, 0, 200, 0, 0, 3]).forecast, 'STORM IN 3:20');
  assert.equal(chip([0, 3, 30, 25, 0, 0, 3]).forecast, '→ STORM 0:25');
  assert.equal(chip([0, 3, 30, 25, 0, 0, 3]).trend, 'worse');
  assert.equal(chip([0, 0, 0, 0, 0, 0, -1]).forecast, '', 'no forecast on the last hold');
  const jet = weatherChipModel({ weather: decodeConquestWeather([3, 3, 0, 0, 0, 0, -1]) }, { seatedType: 'plane' });
  assert.equal(jet.lock, Math.round(LOCK_RULES.aaMissile.range * WEATHER_STATES.storm.lock), 'the jet shows its AA missile range');
  assert.equal(weatherChipModel({ weather: null }), null);
}
ok();

// Review fixes: the env switch, open-ended matches, hull recognition, the lock box.
{
  for (const text of ['off', 'false', 'FALSE', '0', 'no', 'none', ' off ']) {
    assert.equal(weatherOptionFromEnv(text), 'off', `VB_CONQUEST_WEATHER=${text} turns weather off`);
    assert.equal(new ConquestWeather({ option: weatherOptionFromEnv(text) }).enabled, false);
  }
  assert.equal(weatherOptionFromEnv(undefined), undefined); assert.equal(weatherOptionFromEnv(''), undefined, 'unset keeps the default');
  assert.equal(weatherOptionFromEnv('Storm'), 'storm', 'a state id pins the state');
  // A match without a finite time limit still gets a finite strike schedule (no endless loop).
  const open = weatherTimeline(3, { durationMs: Infinity, area, script: ['storm'] });
  assert(open.durationMs === 60 * MIN && open.strikes.length > 100, 'an open-ended storm gets an hour of lightning');
  assert.equal(new ConquestWeather({ option: 'storm', durationMs: Infinity }).durationMs, 60 * MIN);
  // Hull sightings slow down in a storm like body sightings (observeBotVehicle recognitionScale).
  const f = fixture('storm');
  const sight = weatherSight(f.game);
  const observer = new PlayerEntity('o', 'o', { x: 20.5, y: 1, z: 120.5 });
  observer.yaw = observer.pitch = 0;
  const jeep = { id: 'j', type: 'jeep', x: 20.5, y: 1, z: 60.5, yaw: 0, hp: 300 };
  const seenClear = observeBotVehicle(observer, jeep, () => false, { blocksSight: () => false }, 1000, false, undefined, null);
  const seenStorm = observeBotVehicle(observer, jeep, () => false, { blocksSight: () => false }, 1000, false, undefined, sight);
  assert(seenClear && seenStorm, 'a jeep at 60 m is seen either way');
  assert(near(seenStorm.detectionRate, seenClear.detectionRate * WEATHER_STATES.storm.recognition, 1e-9), 'rain slows hull recognition too');
  // The STINGER lock box never marks an aircraft beyond the server's weather-scaled lock range.
  const { conquestHudFixtures } = await import('../public/js/capture/conquest-hud-fixtures.js');
  const { cameraPose, createProjector } = await import('../public/js/ui/conquest/projection.js');
  const fix = conquestHudFixtures().find(x => x.id === 'stinger-lock');
  const cam = fix.camera, heli = fix.vehicles.find(v => v.id === 'bravo-helicopter');
  const d = [heli.x - cam.x, heli.y - cam.y, heli.z - cam.z], len = Math.hypot(...d);
  const far = { ...heli, x: cam.x + d[0] / len * 280, y: cam.y + d[1] / len * 280, z: cam.z + d[2] / len * 280 };
  const projector = createProjector(cameraPose({ ...cam, aspect: 1440 / 900 }), 1440, 900);
  const box = scale => lockerModel(fix.self, { projector, vehicles: [far], selfTeam: 'alpha', camera: cam, lockScale: scale }).targetId;
  assert.equal(box(1), 'bravo-helicopter', 'clear weather: the box marks the helicopter at 280 m');
  assert.equal(box(WEATHER_STATES.mist.lock), null, 'fog: 280 m is past the lock range, no box');
}
ok();

// --- client view on a fake world -----------------------------------------------
{
  const THREE = await import('../public/js/vendor/three.module.js');
  const { ConquestWeatherView, flashCurve, WEATHER_VIEW } = await import('../public/js/engine/conquest-weather-view.js');
  const { mapAtmosphere } = await import('../public/js/engine/map-atmosphere.js');
  const { TERRAIN_WET } = await import('../public/js/engine/chunks.js');
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1); hemi.name = 'hemi'; scene.add(hemi);
  scene.fog = new THREE.FogExp2(0xffffff, 0.002);
  const palette = mapAtmosphere('frontier', { weather: 'golden' });
  const worldview = { scene, palette, weather: 'golden', sun: new THREE.DirectionalLight(0xffffff, 1), lightUniforms: null };
  const thunder = [];
  const view = new ConquestWeatherView({ worldview, graphics: { tier: 'high', ambientParticles: 1 }, onThunder: s => thunder.push(s), random: () => 0.5 });
  assert.equal(view.stats.rainDrawn, 0, 'no rain at load');
  view.set(decodeConquestWeather([3, 3, 0, 0, 90, 100, -1]));
  view.update(1 / 60, null);
  assert.equal(view.stats.weights.storm, 1, 'the first mix snaps (a mid-match join)');
  assert(view.stats.rain === 1 && view.stats.rainDrawn > 0, 'storm rain draws the rain field');
  assert.equal(TERRAIN_WET.value, 1, 'wet ground from the server wetness');
  assert(view.fogScale(false) > 1, 'storm fog is denser than the load mood');
  view.set(decodeConquestWeather([0, 0, 0, 0, 90, 0, -1]));
  view.update(1 / 60, null);
  assert(view.stats.weights.storm > 0.9, 'later changes ease instead of snapping');
  for (let i = 0; i < 60 * 20; i++) view.update(1 / 60, null);
  assert(view.stats.weights.golden > 0.99 && view.stats.rainDrawn === 0, 'eased back to clear, rain stopped');
  assert(view.strike({ x: 10, y: 20, z: 10 }, { x: 0, y: 20, z: 0 }), 'a strike is drawn');
  assert.equal(thunder.length, 1); assert(near(thunder[0].distance, Math.hypot(10, 10)), 'thunder gets the distance');
  view.update(0.01, null);
  assert(view.flash > 0.9, 'a close strike flashes at full level');
  assert.equal(flashCurve(WEATHER_VIEW.flash.seconds + 0.01), 0);
  view.dispose();
  assert.equal(view.strike({ x: 0, z: 0 }), false, 'a disposed view ignores strikes');
}
ok();

// --- client view on Redrock Canyon: its own clear mood, Frontier's overcast/mist/storm ---
{
  const THREE = await import('../public/js/vendor/three.module.js');
  const { ConquestWeatherView, weatherLook } = await import('../public/js/engine/conquest-weather-view.js');
  const { mapAtmosphere } = await import('../public/js/engine/map-atmosphere.js');
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1); hemi.name = 'hemi'; scene.add(hemi);
  scene.fog = new THREE.FogExp2(0xffffff, 0.002);
  const palette = mapAtmosphere('redrock', { weather: 'desert' });
  const worldview = { scene, palette, weather: 'desert', sun: new THREE.DirectionalLight(0xffffff, 1), lightUniforms: null };
  const view = new ConquestWeatherView({ worldview, graphics: { tier: 'high', ambientParticles: 1 }, random: () => 0.5 });
  const desert = weatherLook(palette), frontierGolden = weatherLook(mapAtmosphere('frontier', { weather: 'golden' }));
  view.set(decodeConquestWeather([0, 0, 0, 0, 90, 0, -1]));
  view.update(1 / 60, null);
  assert(view.current.skyTop.equals(desert.skyTop) && view.current.fog.equals(desert.fog), 'clear weather keeps the desert mood');
  assert(!view.current.skyTop.equals(frontierGolden.skyTop), 'not Frontier\'s golden sky');
  assert(view.current.skyHorizon.equals(desert.skyHorizon) && view.current.water.skyTop.equals(desert.water.skyTop), 'sky and water colours blend once each');
  view.set(decodeConquestWeather([3, 3, 0, 0, 90, 100, -1]));
  for (let i = 0; i < 60 * 20; i++) view.update(1 / 60, null);
  assert(view.stats.weights.storm > 0.99 && view.stats.rain === 1, 'a storm still rolls over the canyon');
  view.dispose();
}
ok();

console.log(`Conquest weather: ${checks} groups passed (timeline, phases, wx tuple, wetness, stepper, policy, spotting, locks, bots, canopy drift, HUD tab, client view, Redrock view)`);
