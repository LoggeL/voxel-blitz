import assert from 'node:assert/strict';
import { CAREER_CATALOG, careerView, defaultCosmeticLoadout, reconcileCareerUnlocks } from '../shared/career.js';
import { CareerShop, careerActionState } from '../public/js/ui/career-shop.js';
import { CosmeticAudition, cosmeticArtwork, cosmeticVolume } from '../public/js/ui/cosmetic-preview.js';

const profile = (extra = {}) => careerView({
  xp: 19600, credits: 0, kills: 250, pvpKills: 250, wins: 0, matches: 10,
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout() },
  mastery: { rifle: { kills: 250, headshots: 20 } }, ...extra,
});
const rifle = CAREER_CATALOG.find(item => item.id === 'rifle-overdrive');
const lowMastery = profile({ mastery: { rifle: { kills: 249 } } });
assert.equal(careerActionState(lowMastery, rifle).disabled, true, 'level alone cannot equip a mastery reward');
assert.equal(careerActionState(profile({ xp: 19599 }), rifle).disabled, true, 'mastery alone cannot bypass career level');
const unlocked = profile();
reconcileCareerUnlocks(unlocked);
assert.equal(careerActionState(unlocked, rifle).disabled, false, 'an earned reward equips with zero credits');
assert.equal(careerActionState(unlocked, rifle).label, 'EQUIP');
unlocked.equipped.weaponSkins.rifle = rifle.id;
assert.equal(careerActionState(unlocked, rifle).equipped, true, 'weapon skins use their weapon-specific slot');
assert.equal(careerActionState(unlocked, CAREER_CATALOG.find(item => item.id === 'arctic')).disabled, true, 'legacy purchases still require credits');

const saved = Object.fromEntries(['fetch', 'window', 'localStorage', 'Audio', 'document'].map(name => [name, globalThis[name]]));
const events = [];
globalThis.window = { dispatchEvent(event) { events.push(event); } };
const result = payload => ({ ok: true, json: async () => payload });
try {
  let sent;
  globalThis.fetch = async (url, options) => { sent = { url, options }; return result(unlocked); };
  const shop = { requestVersion: 0, profile: null, render() {} };
  await CareerShop.prototype.request.call(shop, 'standard', true, { slot: 'weaponSkin', weapon: 'rifle' });
  assert.equal(sent.url, '/api/career/purchase');
  assert.equal(sent.options.credentials, 'same-origin');
  assert.equal(sent.options.headers['X-VB-Career'], '1');
  assert.deepEqual(JSON.parse(sent.options.body), { item: 'standard', equipOnly: true, slot: 'weaponSkin', weapon: 'rifle' });
  assert.equal(events.at(-1).type, 'vb-career-change');
  assert.equal(events.at(-1).detail, unlocked, 'accepted authority reaches runtime');

  const pending = [];
  globalThis.fetch = () => new Promise(resolve => pending.push(resolve));
  const older = CareerShop.prototype.request.call(shop);
  const newest = CareerShop.prototype.request.call(shop, 'rifle-overdrive', true);
  pending[1](result(unlocked)); await newest;
  const acceptedEvents = events.length;
  pending[0](result(lowMastery));
  assert.equal(await older, null);
  assert.equal(shop.profile, unlocked);
  assert.equal(events.length, acceptedEvents, 'stale profile never emits a cosmetic change');
  const beforeLogout = CareerShop.prototype.request.call(shop);
  shop.requestVersion++;
  shop.profile = null;
  pending[2](result(unlocked));
  assert.equal(await beforeLogout, null);
  assert.equal(shop.profile, null, 'identity changes invalidate in-flight profile requests');
  assert.equal(events.length, acceptedEvents);
  const failed = CareerShop.prototype.request.call(shop);
  pending[3]({ ok: false, json: async () => ({ error: 'Not earned' }) });
  await assert.rejects(failed, /Not earned/);
  assert.equal(events.length, acceptedEvents, 'rejected equip never changes runtime cosmetics');
  const changed = { ...shop, accounts: { user: { id: 'old' }, async refresh() { this.user = { id: 'new' }; } } };
  await assert.rejects(CareerShop.prototype.request.call(changed, rifle.id), /session changed/);
  assert.equal(pending.length, 4, 'account switch is detected before an equip POST');

  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null };
  assert.equal(cosmeticVolume('death'), 0.35);
  storage.set('vb-cosmetic-kill-volume', '0');
  assert.equal(cosmeticVolume('kill'), 0, 'explicit mute survives reload');
  storage.set('vb-cosmetic-victory-volume', 'NaN');
  assert.equal(cosmeticVolume('victory'), 0.5, 'invalid stored volume uses its default');
  storage.set('vb-cosmetic-kill-volume', '2');
  assert.equal(cosmeticVolume('kill'), 1);

  const audioInstances = [];
  globalThis.Audio = class {
    constructor(src) { this.src = src; this.currentTime = 0; this.events = {}; audioInstances.push(this); }
    addEventListener(name, handler) { this.events[name] = handler; }
    play() { return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
    pause() { this.paused = true; }
  };
  const audition = new CosmeticAudition();
  const kit = CAREER_CATALOG.find(item => item.id === 'arcade');
  const firstPlay = audition.play(kit, 'kill');
  assert.equal(audioInstances[0].src, '/assets/audio/cosmetics/arcade/kill.ogg');
  const secondPlay = audition.play(kit, 'death');
  assert.equal(audioInstances[0].paused, true, 'switching cues stops the previous cue immediately');
  audioInstances[0].reject(new Error('interrupted'));
  await firstPlay;
  assert.equal(audition.active, 'arcade:death', 'a canceled play promise cannot clear the new cue');
  audioInstances[1].resolve(); await secondPlay;
  assert.equal(audioInstances[1].volume, 0.35, 'preview uses that cue volume');
  await audition.play(kit, 'death');
  assert.equal(audition.active, null, 'clicking the current preview toggles it off');
  assert.equal(audioInstances.length, 2);
  const thirdPlay = audition.play(kit, 'victory');
  audition.stop();
  audioInstances[2].reject(new Error('dialog closed'));
  await thirdPlay;
  assert.equal(audition.active, null, 'dialog close cancels even pending playback');

  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = { setProperty() {} }; this.events = {}; }
    append(child) { this.children.push(child); }
    setAttribute() {}
    addEventListener(name, handler) { this.events[name] = handler; }
  }
  globalThis.document = { createElement: tag => new Element(tag) };
  const container = new Element('div');
  const preview = cosmeticArtwork(container, rifle);
  assert.equal(preview.className, 'vb-cosmetic-reward-art');
  assert.equal(preview.children[0].src, '/assets/cosmetics/rifle-overdrive.png');
  preview.children[0].events.error();
  assert.equal(preview.children[0].hidden, true);
  assert.match(preview.children[1].textContent, /preview unavailable/);
  assert.equal(preview.style.backgroundPosition, undefined, 'missing new artwork never maps onto the legacy atlas');
  const veteran = cosmeticArtwork(container, CAREER_CATALOG.find(item => item.id === 'veteran'));
  assert.equal(veteran.style.backgroundPosition, '100% 100%', 'legacy atlas artwork remains attached to its original ID');
  console.log('Cosmetics UI: dual unlock gates, free earned equip, per-weapon reset, session authority, stale response isolation, volume persistence and non-overlapping audio previews passed.');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
