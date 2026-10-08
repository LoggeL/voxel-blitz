// Conquest-only sound banks (public/assets/audio/conquest/<bank>/, provenance in
// each bank's sources.json and docs/audio/conquest-sfx.md). The menu and the other
// modes never fetch these: main.js hands CONQUEST_SAMPLE_MANIFEST to
// sfx.loadConquestBank() when a Conquest match boots, and the long stereo beds in
// CONQUEST_STREAMS are streamed by the soundscape instead of decoded to PCM.
//
// Slots are `<group>.<n>` (n from 1). sfx and the soundscape pick a random
// variant of a group among the slots that have decoded; a group that is not
// loaded yet falls back to the procedural voice of the same cue.

const ROOT = '/assets/audio/conquest';

/** Decoded one-shots and short loops: group -> files (bank-relative). */
export const CONQUEST_SAMPLE_GROUPS = Object.freeze({
  // Tank: diesel idle/rev crossfaded by speed, tracks by track speed, pivot squeal, turret servo.
  'cq.tank.idle': ['vehicles/tank-engine-idle.ogg'],
  'cq.tank.rev': ['vehicles/tank-engine-rev.ogg'],
  'cq.tank.tracks': ['vehicles/tank-tracks.ogg'],
  'cq.tank.pivot': ['vehicles/tank-tracks-pivot.ogg'],
  'cq.tank.turret': ['vehicles/tank-turret-traverse.ogg'],
  'cq.tank.turretStop': ['vehicles/tank-turret-stop.ogg'],
  'cq.cannon.near': ['vehicles/tank-cannon-near-1.ogg', 'vehicles/tank-cannon-near-2.ogg', 'vehicles/tank-cannon-near-3.ogg'],
  'cq.cannon.distant': ['vehicles/tank-cannon-distant.ogg'],
  'cq.cannon.interior': ['vehicles/tank-cannon-interior.ogg'],
  'cq.reload.heavy': ['vehicles/breech-heavy-1.ogg', 'vehicles/breech-heavy-2.ogg'],
  'cq.reload.light': ['vehicles/feed-tray-clack.ogg'],
  // Mounted guns: single-shot round robin for coax/HMG, loops for the rotary guns.
  'cq.gun.coaxMG': ['vehicles/coax762-shot-1.ogg', 'vehicles/coax762-shot-2.ogg', 'vehicles/coax762-shot-3.ogg'],
  'cq.gun.hmg': ['vehicles/hmg50-shot-1.ogg', 'vehicles/hmg50-shot-2.ogg', 'vehicles/hmg50-shot-3.ogg'],
  'cq.gun.doorMinigun': ['vehicles/door-minigun-loop.ogg'],
  'cq.gun.doorMinigunStop': ['vehicles/door-minigun-spindown.ogg'],
  'cq.gun.planeCannon': ['vehicles/jet-cannon-burst.ogg'],
  'cq.gun.planeCannonFar': ['vehicles/jet-cannon-ground.ogg'],
  'cq.chin': ['vehicles/chin-cannon-1.ogg', 'vehicles/chin-cannon-2.ogg', 'vehicles/chin-cannon-3.ogg'],
  'cq.shell.ap': ['vehicles/shell-flyby-ap.ogg'],
  'cq.shell.he': ['vehicles/shell-incoming-he.ogg'],
  // Jeep.
  'cq.jeep.idle': ['vehicles/jeep-engine-idle.ogg'],
  'cq.jeep.drive': ['vehicles/jeep-engine-drive.ogg'],
  'cq.jeep.tyres': ['vehicles/jeep-tyres-gravel.ogg'],
  'cq.jeep.rattle': ['vehicles/jeep-suspension-rattle.ogg'],
  'cq.jeep.skid': ['vehicles/jeep-skid-gravel.ogg'],
  // Rotorcraft and the jet.
  'cq.heli.ext': ['vehicles/heli-rotor-ext.ogg'],
  'cq.heli.distant': ['vehicles/heli-rotor-distant.ogg'],
  'cq.heli.cockpit': ['vehicles/heli-cockpit.ogg'],
  'cq.transport.ext': ['vehicles/transport-rotor-ext.ogg'],
  'cq.transport.cabin': ['vehicles/transport-cabin.ogg'],
  'cq.rotor.spoolUp': ['vehicles/rotor-spool-up.ogg'],
  'cq.rotor.spoolDown': ['vehicles/rotor-spool-down.ogg'],
  'cq.jet.ext': ['vehicles/jet-engine-ext.ogg'],
  'cq.jet.low': ['vehicles/jet-engine-ext-low.ogg'],
  'cq.jet.burnerOn': ['vehicles/jet-afterburner-lightoff.ogg'],
  'cq.jet.burner': ['vehicles/jet-afterburner-loop.ogg'],
  'cq.jet.flyby': ['vehicles/jet-flyby-1.ogg', 'vehicles/jet-flyby-2.ogg', 'vehicles/jet-flyby-3.ogg'],
  'cq.pod': ['vehicles/rocket-pod-1.ogg', 'vehicles/rocket-pod-2.ogg', 'vehicles/rocket-pod-3.ogg'],
  'cq.aa.launch': ['vehicles/aa-missile-launch-1.ogg', 'vehicles/aa-missile-launch-2.ogg'],
  'cq.aa.flight': ['vehicles/aa-missile-flight.ogg'],
  // Cockpit cues (project-original synthesis) keyed by sfx.vehicleLockTone / vehicleAlarm modes.
  'cq.cue.locking': ['vehicles/lock-hull-locking.ogg'],
  'cq.cue.locked': ['vehicles/lock-hull-locked.ogg'],
  'cq.cue.inbound': ['vehicles/lock-missile-inbound.ogg'],
  'cq.cue.acquire': ['vehicles/lock-seeker-growl.ogg'],
  'cq.cue.lock': ['vehicles/lock-seeker-locked.ogg'],
  'cq.cue.alarm': ['vehicles/alarm-ground-klaxon.ogg'],
  'cq.cue.alarmAir': ['vehicles/alarm-air-caution.ogg'],
  'cq.flares': ['vehicles/flares-salvo-1.ogg', 'vehicles/flares-salvo-2.ogg'],
  'cq.smoke': ['vehicles/smoke-launcher-1.ogg', 'vehicles/smoke-launcher-2.ogg'],
  'cq.eject': ['vehicles/ejection-seat-1.ogg', 'vehicles/ejection-seat-2.ogg'],
  'cq.chute.open': ['vehicles/parachute-open-1.ogg', 'vehicles/parachute-open-2.ogg'],
  'cq.chute.descent': ['vehicles/parachute-descent.ogg'],
  'cq.hatch.tankEnter': ['vehicles/hatch-tank-close.ogg'],
  'cq.hatch.tankExit': ['vehicles/hatch-tank-open.ogg'],
  'cq.hatch.jeepEnter': ['vehicles/hatch-jeep-close.ogg'],
  'cq.hatch.jeepExit': ['vehicles/hatch-jeep-open.ogg'],
  'cq.hatch.cabin': ['vehicles/hatch-heli-door.ogg'],
  'cq.hatch.canopy': ['vehicles/hatch-canopy-close.ogg'],
  'cq.burning': ['vehicles/vehicle-burning-1.ogg', 'vehicles/vehicle-burning-2.ogg'],
  'cq.wade.loop': ['vehicles/vehicle-wade-loop.ogg'],
  'cq.wade.splash': ['vehicles/vehicle-wade-splash.ogg'],
  // Blasts and impacts.
  'cq.blast.frag': ['explosions/frag-1.ogg', 'explosions/frag-2.ogg', 'explosions/frag-3.ogg'],
  'cq.blast.he': ['explosions/tank-he-1.ogg', 'explosions/tank-he-2.ogg', 'explosions/tank-he-3.ogg'],
  'cq.blast.ap': ['explosions/tank-ap-1.ogg', 'explosions/tank-ap-2.ogg'],
  'cq.blast.rocket': ['explosions/rocket-1.ogg', 'explosions/rocket-2.ogg'],
  'cq.blast.airburst': ['explosions/rocket-airburst-1.ogg', 'explosions/rocket-airburst-2.ogg'],
  'cq.blast.autocannon': ['explosions/autocannon-impact-1.ogg', 'explosions/autocannon-impact-2.ogg', 'explosions/autocannon-impact-3.ogg'],
  'cq.blast.limpet': ['explosions/limpet-1.ogg', 'explosions/limpet-2.ogg'],
  'cq.blast.water': ['explosions/explosion-water-1.ogg', 'explosions/explosion-water-2.ogg'],
  'cq.destroy.tank': ['explosions/vehicle-destruction-tank.ogg'],
  'cq.destroy.jeep': ['explosions/vehicle-destruction-jeep.ogg'],
  'cq.destroy.heli': ['explosions/vehicle-destruction-heli.ogg'],
  'cq.destroy.jet': ['explosions/vehicle-destruction-jet.ogg'],
  'cq.cookoff': ['explosions/cookoff-1.ogg', 'explosions/cookoff-2.ogg', 'explosions/cookoff-3.ogg'],
  'cq.distant': ['explosions/distant-boom-1.ogg', 'explosions/distant-boom-2.ogg', 'explosions/distant-boom-3.ogg', 'explosions/distant-boom-4.ogg'],
  'cq.debris.stone': ['explosions/debris-stone-1.ogg', 'explosions/debris-stone-2.ogg'],
  'cq.debris.wood': ['explosions/debris-wood-1.ogg', 'explosions/debris-wood-2.ogg'],
  'cq.debris.metal': ['explosions/debris-metal-1.ogg', 'explosions/debris-metal-2.ogg'],
  'cq.debris.glass': ['explosions/debris-glass-1.ogg', 'explosions/debris-glass-2.ogg'],
  'cq.bullet.dirt': ['explosions/bullet-dirt-1.ogg', 'explosions/bullet-dirt-2.ogg', 'explosions/bullet-dirt-3.ogg', 'explosions/bullet-dirt-4.ogg'],
  'cq.bullet.stone': ['explosions/bullet-stone-1.ogg', 'explosions/bullet-stone-2.ogg', 'explosions/bullet-stone-3.ogg', 'explosions/bullet-stone-4.ogg'],
  'cq.bullet.metal': ['explosions/bullet-metal-1.ogg', 'explosions/bullet-metal-2.ogg', 'explosions/bullet-metal-3.ogg', 'explosions/bullet-metal-4.ogg'],
  'cq.bullet.wood': ['explosions/bullet-wood-1.ogg', 'explosions/bullet-wood-2.ogg', 'explosions/bullet-wood-3.ogg'],
  'cq.bullet.water': ['explosions/bullet-water-1.ogg', 'explosions/bullet-water-2.ogg', 'explosions/bullet-water-3.ogg'],
  'cq.ricochet': ['explosions/ricochet-1.ogg', 'explosions/ricochet-2.ogg', 'explosions/ricochet-3.ogg'],
  'cq.hull.heavy': ['explosions/hull-hit-heavy-1.ogg', 'explosions/hull-hit-heavy-2.ogg'],
  'cq.hull.heavyIn': ['explosions/hull-hit-heavy-int-1.ogg', 'explosions/hull-hit-heavy-int-2.ogg'],
  'cq.hull.small': ['explosions/hull-hit-small-1.ogg', 'explosions/hull-hit-small-2.ogg', 'explosions/hull-hit-small-3.ogg'],
  'cq.hull.light': ['explosions/hull-hit-small-4.ogg', 'explosions/hull-hit-small-5.ogg'],
  // Atmosphere one-shots and the objective cues.
  'cq.amb.artillery': ['atmosphere/artillery-distant-1.ogg', 'atmosphere/artillery-distant-2.ogg', 'atmosphere/artillery-distant-3.ogg',
    'atmosphere/artillery-distant-4.ogg', 'atmosphere/artillery-distant-5.ogg'],
  'cq.amb.gust': ['atmosphere/wind-gust-swell.ogg'],
  'cq.amb.crow': ['atmosphere/crow-caw-1.ogg', 'atmosphere/crow-caw-2.ogg'],
  'cq.amb.scatter': ['atmosphere/birds-scatter.ogg'],
  'cq.amb.bell': ['atmosphere/church-bell-toll.ogg'],
  'cq.amb.creak': ['atmosphere/industrial-creak-clank.ogg'],
  'cq.amb.steam': ['atmosphere/industrial-steam-release.ogg'],
  'cq.amb.radio': ['atmosphere/radio-chatter-1.ogg', 'atmosphere/radio-chatter-2.ogg', 'atmosphere/radio-chatter-3.ogg', 'atmosphere/radio-chatter-4.ogg'],
  'cq.amb.squelch': ['atmosphere/radio-squelch-1.ogg', 'atmosphere/radio-squelch-2.ogg'],
  'cq.flag.progress': ['atmosphere/flag-capture-progress-loop.ogg'],
  'cq.flag.start': ['atmosphere/flag-capture-start.ogg'],
  'cq.flag.captured': ['atmosphere/flag-captured.ogg'],
  'cq.flag.lost': ['atmosphere/flag-lost.ogg'],
  'cq.flag.neutralized': ['atmosphere/flag-neutralized.ogg'],
  'cq.flag.ticketsLow': ['atmosphere/tickets-low-urgency.ogg'],
});

/** Long seamless beds (20-96 s) played through streamed media elements, never decoded. */
export const CONQUEST_STREAMS = Object.freeze({
  battleLow: `${ROOT}/atmosphere/battle-bed-low.ogg`,
  battleHigh: `${ROOT}/atmosphere/battle-bed-high.ogg`,
  windBed: `${ROOT}/atmosphere/wind-valley-bed.ogg`,
  windGusty: `${ROOT}/atmosphere/wind-valley-gusty.ogg`,
  windRidge: `${ROOT}/atmosphere/wind-ridge-whistle.ogg`,
  river: `${ROOT}/atmosphere/river-flow.ogg`,
  rapids: `${ROOT}/atmosphere/river-ford-rapids.ogg`,
  birdsFarm: `${ROOT}/atmosphere/birds-countryside-bed.ogg`,
  birdsVillage: `${ROOT}/atmosphere/birds-meadow-bed.ogg`,
  industrial: `${ROOT}/atmosphere/industrial-drone.ogg`,
  wreckFire: `${ROOT}/atmosphere/wreck-fire-crackle.ogg`,
});

/** slot (`<group>.<n>`) -> URL for LocalSampleBank.load(). */
export const CONQUEST_SAMPLE_MANIFEST = Object.freeze(Object.fromEntries(
  Object.entries(CONQUEST_SAMPLE_GROUPS).flatMap(([group, files]) =>
    files.map((file, index) => [`${group}.${index + 1}`, `${ROOT}/${file}`]))));

/**
 * Reduced bank for the low graphics tier: the first take of every group only
 * (about 58 instead of 85 MB of decoded PCM). Every cue still has a take;
 * groups just lose their variety.
 */
export const CONQUEST_SAMPLE_MANIFEST_LITE = Object.freeze(Object.fromEntries(
  Object.entries(CONQUEST_SAMPLE_GROUPS).map(([group, files]) => [`${group}.1`, `${ROOT}/${files[0]}`])));

/** Every Conquest asset URL (decoded and streamed), for tests and the static contract. */
export const CONQUEST_AUDIO_URLS = Object.freeze([
  ...Object.values(CONQUEST_SAMPLE_MANIFEST), ...Object.values(CONQUEST_STREAMS)]);
