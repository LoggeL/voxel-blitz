import assert from 'node:assert/strict';
import { PanicBreathCadence } from '../public/js/audio/panic-breath.js';
import { GameplayHud } from '../public/js/ui/gameplay-hud.js';
import { normalizePostProcessState } from '../public/js/engine/combat-post-process.js';

const cadence = new PanicBreathCadence();
assert.equal(cadence.update(1, 0), null);
assert.equal(cadence.update(1, 299), null);
assert.equal(cadence.update(1, 300).event, 'inhale');
assert.equal(cadence.update(1, 899), null);
assert.equal(cadence.update(1, 900).event, 'exhale');
assert.equal(cadence.update(1, 1500, { holding: true }), null);
assert.equal(cadence.update(1, 5000), null, 'release restarts without an immediate competing cue');
assert.equal(cadence.update(1, 5300).event, 'inhale');
assert.equal(cadence.update(1, 6000, { active: false }), null);
assert.equal(cadence.update(1, 100000), null, 'pauses cannot accumulate audio catch-up');
assert.equal(cadence.update(0, 100400), null);
assert.equal(cadence.update(0.2, 101000), null);
assert.equal(cadence.update(0.2, 101300).event, 'inhale');
assert.equal(cadence.update(0.2, 102000), null, 'mild panic has a slower cadence');
assert.equal(cadence.update(0.2, 102420).event, 'exhale');
cadence.reset();
assert.equal(cadence.update(1, 103000), null);

const style = new Map();
GameplayHud.prototype.updateCrosshairStress.call({
  dom: { ch: { style: { setProperty: (key, value) => style.set(key, value) } } },
  readModel: { painImpulse: 1 }, _painted: {},
}, 1, 1, true);
assert.equal(style.get('--ch-jx'), '0px');
assert.equal(style.get('--ch-jy'), '0px');
assert.equal(style.get('--ch-rot'), '0deg');
assert.equal(style.get('--ch-arm-opacity'), '1');
assert.equal(normalizePostProcessState({ reducedMotion: true, panic: 1 }).motion, 0);

// Browser preference bootstrap and OS updates, followed by an explicit override.
let onMotionChange;
const stored = new Map();
let attribute;
globalThis.matchMedia = () => ({ matches: true, addEventListener: (_, fn) => { onMotionChange = fn; } });
globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
globalThis.document = { documentElement: { setAttribute: (_, value) => { attribute = value; } } };
const settings = await import('../public/js/ui/display-settings.js?motion-test');
assert.equal(settings.displaySettings().reducedMotion, true);
assert.equal(attribute, 'true');
onMotionChange({ matches: false });
assert.equal(settings.displaySettings().reducedMotion, false);
settings.setDisplaySetting('reducedMotion', true);
assert.equal(stored.get('vb-display-reducedMotion'), '1');
onMotionChange({ matches: false });
assert.equal(settings.displaySettings().reducedMotion, true, 'explicit preference wins over OS');
const restored = await import('../public/js/ui/display-settings.js?motion-reload');
assert.equal(restored.displaySettings().reducedMotion, true);
console.log('ok - panic breathing cadence and pause/hold cleanup, accurate reticle, persisted reduced motion');
