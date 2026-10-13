// Titan primary weapon sound bank (public/assets/audio/titan/, provenance in
// sources.json there and docs/audio/titan-sfx.md). Only the titanfall client
// loads it: titan-presentation.js init() hands TITAN_SAMPLE_MANIFEST to
// VehicleAudio.loadTitanBank(), dispose() unloads it. Nothing here is in
// BUILTIN_SAMPLE_MANIFEST, so the menu and the other modes never fetch it.
//
// Slots are `<group>.<n>` (n from 1). TitanSynth picks a random variant of a
// group among the slots that have decoded (never the same take twice in a row);
// a group that has not decoded falls back to the synthesized voice of its cue.

const ROOT = '/assets/audio/titan';

const takes = (dir, name, count) => Array.from({ length: count }, (_, i) => `${dir}/${name}-${i + 1}.ogg`);

/** Decoded one-shots and short loops: group -> files (bank-relative). */
export const TITAN_SAMPLE_GROUPS = Object.freeze({
  // ION Splitter Rifle: a snappy energy crack, the heavier triple-beam split shot, a short outdoor tail.
  'tf.splitter.fire': takes('splitter', 'fire', 4),
  'tf.splitter.split': takes('splitter', 'split', 2),
  'tf.splitter.tail': takes('splitter', 'tail', 2),
  'tf.splitter.impact': takes('splitter', 'impact', 3),
  'tf.splitter.reload': takes('splitter', 'reload', 1),
  // SCORCH T-203: the launch thump, its tail, the breech cycling a new shell, the thermite burst and its sizzle.
  'tf.t203.fire': takes('t203', 'fire', 3),
  'tf.t203.tail': takes('t203', 'tail', 1),
  'tf.t203.mech': takes('t203', 'mech', 2),
  'tf.t203.impact': takes('t203', 'impact', 3),
  'tf.t203.burn': takes('t203', 'burn', 1),
  // NORTHSTAR Plasma Railgun: the charge whine (1.6 s, the server charge time), the full-charge hold loop
  // and ready cue, the crack, a rolling tail and the impact.
  'tf.railgun.charge': takes('railgun', 'charge', 1),
  'tf.railgun.hold': takes('railgun', 'hold', 1),
  'tf.railgun.ready': takes('railgun', 'ready', 1),
  'tf.railgun.fire': takes('railgun', 'fire', 3),
  'tf.railgun.tail': takes('railgun', 'tail', 2),
  'tf.railgun.impact': takes('railgun', 'impact', 2),
  // RONIN Leadwall: the boom, its tail, the heavy rack after each shot, pellet ricochets and hits, the reload.
  'tf.leadwall.fire': takes('leadwall', 'fire', 3),
  'tf.leadwall.tail': takes('leadwall', 'tail', 2),
  'tf.leadwall.pump': takes('leadwall', 'pump', 2),
  'tf.leadwall.ricochet': takes('leadwall', 'ricochet', 4),
  'tf.leadwall.impact': takes('leadwall', 'impact', 3),
  'tf.leadwall.reload': takes('leadwall', 'reload', 1),
  // LEGION Predator Cannon: one heavy round per shot, the barrel spin-up, spin loop and spin-down,
  // brass casings, the burst tail and the drum reload.
  'tf.predator.fire': takes('predator', 'fire', 4),
  'tf.predator.spinUp': takes('predator', 'spin-up', 1),
  'tf.predator.spin': takes('predator', 'spin', 1),
  'tf.predator.spinDown': takes('predator', 'spin-down', 1),
  'tf.predator.casings': takes('predator', 'casings', 3),
  'tf.predator.impact': takes('predator', 'impact', 3),
  'tf.predator.tail': takes('predator', 'tail', 2),
  'tf.predator.reload': takes('predator', 'reload', 1),
  // Every titan: the armour hit confirm of an own round and the doom confirm.
  'tf.hit.confirm': takes('common', 'hit-confirm', 3),
  'tf.hit.doom': takes('common', 'doom-confirm', 1),
  'tf.hit.kill': takes('common', 'kill-confirm', 1),
});

/** Groups that loop (BufferSource.loop) while their state holds. */
export const TITAN_LOOP_GROUPS = Object.freeze(['tf.railgun.hold', 'tf.predator.spin']);

/** slot (`<group>.<n>`) -> URL for LocalSampleBank.load(). */
export const TITAN_SAMPLE_MANIFEST = Object.freeze(Object.fromEntries(
  Object.entries(TITAN_SAMPLE_GROUPS).flatMap(([group, files]) =>
    files.map((file, index) => [`${group}.${index + 1}`, `${ROOT}/${file}`]))));

/** Every titan bank URL, for tests and the static contract. */
export const TITAN_AUDIO_URLS = Object.freeze(Object.values(TITAN_SAMPLE_MANIFEST));
