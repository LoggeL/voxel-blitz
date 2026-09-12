import assert from 'node:assert/strict';
import { MusicVolumePreference, MUSIC_VOLUME_KEY } from '../public/js/audio/music-volume.js';

const storage = (initial = {}) => {
  const items = new Map(Object.entries(initial));
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
};

for (const legacy of ['0', 'false']) {
  const saved = storage({ 'vb-menu-music': legacy });
  assert.equal(new MusicVolumePreference(saved).value, 0, 'legacy mute survives migration');
  assert.equal(saved.getItem(MUSIC_VOLUME_KEY), '0');
}
assert.equal(new MusicVolumePreference(storage({ 'vb-menu-music': '1' })).value, 80);
assert.equal(new MusicVolumePreference(storage()).value, 80);
assert.equal(new MusicVolumePreference(storage({ [MUSIC_VOLUME_KEY]: '43', 'vb-menu-music': '0' })).value, 43,
  'a saved percentage takes precedence over the legacy flag');
assert.equal(new MusicVolumePreference(storage({ [MUSIC_VOLUME_KEY]: 'corrupt', 'vb-menu-music': '0' })).value, 0);

const saved = storage();
const preference = new MusicVolumePreference(saved);
const changes = [];
const unsubscribe = preference.subscribe((value, context) => changes.push({ value, ...context }));
preference.set(37, { gesture: true });
assert.deepEqual(changes, [{ value: 37, gesture: true }]);
assert.equal(new MusicVolumePreference(saved).value, 37, 'percentage survives a fresh instance');
preference.set(0);
assert.equal(saved.getItem('vb-menu-music'), '0');
preference.set(125);
assert.equal(preference.value, 100);
assert.equal(saved.getItem('vb-menu-music'), '1');
preference.set(-1);
assert.equal(preference.value, 0);
preference.set('invalid');
assert.equal(preference.value, 0);
unsubscribe();
const count = changes.length;
preference.set(20);
assert.equal(changes.length, count, 'released listeners do not receive updates');

const unavailable = new MusicVolumePreference({
  getItem() { throw new Error('storage unavailable'); },
  setItem() { throw new Error('storage unavailable'); },
});
assert.equal(unavailable.value, 80);
unavailable.set(23);
assert.equal(unavailable.value, 23, 'music remains adjustable when persistence is unavailable');
console.log('Music volume: migration, persistence, bounds, shared changes and unavailable storage passed.');
