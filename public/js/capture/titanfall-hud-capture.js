/**
 * Static Titanfall HUD capture page (docs/titanfall.md §8.1; WP6): renders
 * the snapshot-shaped fixtures (titanfall-hud-fixtures.js) through the real
 * stock HUD, TitanHud, TitanLoadout (with live WebGL portraits of the titan
 * models) and TouchControls. No audio, no server. Driven by
 * tools/titanfall-hud-capture.mjs through window.__tf: the tool passes each
 * size's backdrop (WP5's cockpit view for the titan layout, a field with an
 * enemy titan for the pilot layout, both rendered at the exact viewport) as
 * a data URL, so the HUD is judged over what a player sees behind it.
 * Every fixture also shows the stock career badge and, where the fixture
 * asks, stock kill feed rows (the overlap check covers both).
 */
import * as THREE from '../vendor/three.module.js';
import { HUD } from '../ui/hud.js';
import { TouchControls, setTitanfallTouchSource } from '../engine/touch-controls.js';
import { TitanHud } from '../titanfall/titan-hud.js';
import { titanHudModel, titanfallTouchModel } from '../titanfall/titan-hud-state.js';
import { TitanLoadout, renderTitanPortraits } from '../titanfall/titan-loadout.js';
import { decodeTitanfallSelf } from '../../../shared/titan-contract.js';
import { WEAPON_IDS, WEAPONS } from '../../../shared/combatmath.js';
import { titanfallHudFixtures, FIXTURE_NOW } from './titanfall-hud-fixtures.js';

const fixtures = titanfallHudFixtures();
const label = document.getElementById('capture-label');
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const KEYS = { interact: 'T', jump: 'SPACE', callTitan: 'E', pilotTactical: 'Q', titanDash: 'SPACE', titanDefensive: 'Q',
  titanTactical: 'E', titanOrdnance: 'G', titanCore: 'V', titanSmoke: 'C', titanEject: 'X' };
let hud = null, titanHud = null, loadout = null, touch = null, renderer = null, model = null, touchOn = false;
const portraitCache = new Map();

function ensureHud() {
  if (hud) return hud;
  hud = new HUD();
  hud.buildHUD();
  hud.menuDone?.();
  titanHud = new TitanHud(document.getElementById('hud') ?? document.body);
  return hud;
}

async function portraits(team, size) {
  const key = `${team}:${size?.width}x${size?.height}`;
  if (portraitCache.has(key)) return portraitCache.get(key);
  renderer ??= new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: false });
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setSize(8, 8);
  const result = await renderTitanPortraits(renderer, { team, ...(size ? { size } : {}) });
  portraitCache.set(key, result);
  return result;
}

function localHudState(self) {
  const id = WEAPON_IDS[self.weapon] ?? 'rifle';
  const weapon = WEAPONS[id] ?? WEAPONS.rifle;
  const alive = self.state === 'alive';
  return {
    // The spawn state: one medkit carried (the stock HP card would otherwise read MEDKIT USED).
    alive, hp: alive ? self.hp : 0, medkit: { remaining: 1, active: false, progress: 0 }, armor: 0,
    wid: weapon.id, wname: weapon.name, mag: self.mag?.[self.weapon] ?? weapon.magSize, reserve: self.reserve?.[self.weapon] ?? 60, infiniteMagazines: false,
    grenades: [2, 0, 0, 0, 1], grenadeType: 0, grenadeReady: 0, grenadeCharge: 0, grenadeCharging: false, grenadePouchOpen: false, grenadePouchHover: -1,
    reloading01: null, reloadStaged: false, adsT01: 0, scopeActive: false, yawDeg: 0,
  };
}

function touchContext(fixture, m) {
  const seated = m.layout === 'titan';
  const base = fixture.self.state !== 'alive' ? { alive: false } : {
    // canInteract as main.js computes it for titanfall (no S&D objective, no Bastion repair): false. Embark is the
    // titanfall context chip (EMBARK), which the model supplies through setTitanfallTouchSource.
    alive: true, canFire: true, canReload: true, weaponCount: 4, canThrow: true, grenadeTotal: 3, canInteract: false, grenadeReady: 0,
    grenadeCounts: [2, 0, 0, 0, 1],
    ...(seated ? { vehicleSeated: true, vehicleType: fixture.snapshot.vehicles[0].type, vehicleId: 'T1', vehicleSeatId: 'driver', vehicleRole: 'driver',
      vehicleCanDrive: true, vehicleCanFire: true } : {}),
  };
  return { ...base, conquest: false, deployOpen: false, deployValid: true, deployLabel: 'DEPLOY', vehicleSeatCount: 0, vehicleCountermeasure: null,
    vehicleCountermeasureReady: false };
}

const titanfallTouch = () => titanfallTouchModel(model);

/** Stock kill feed rows (newest last) and the career badge, as a live match shows them. */
const FEED = Object.freeze([
  { killer: 'Vex', victim: 'Rook', w: 'kraber' }, { killer: 'Kade', victim: 'Ivo', w: 'chargerifle', lr: true },
  { killer: 'Brask', victim: 'Nyx', w: 'smg', hs: true }, { killer: 'Juno', victim: 'Kade', w: 'shotgun' },
]);
function stockExtras(fixture, h) {
  const feed = document.getElementById('killfeed');
  if (feed) feed.textContent = '';
  for (const row of FEED.slice(0, fixture.feed ?? 0)) h.killfeed?.(row);
  let badge = document.getElementById('career-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'vb-career-badge';
    badge.id = 'career-badge';
    badge.textContent = 'LV 14 · KADE';
    document.body.appendChild(badge);
  }
}

/** Page backdrop: a data URL rendered at this viewport (tools/titanfall-hud-capture.mjs) or the static map still. */
function setBackdrop(url) {
  document.body.style.background = url ? `#1d2a30 url("${url}") center / cover no-repeat` : '';
  document.body.classList.toggle('has-live-backdrop', !!url);
  return frame();
}

async function render(id, { touch: touchMode = false } = {}) {
  const fixture = fixtures.find(f => f.id === id);
  if (!fixture) throw new Error(`unknown fixture ${id}`);
  const h = ensureHud();
  document.documentElement.classList.toggle('vb-touch-mode', !!touchMode);
  touchOn = !!touchMode;
  if (touchMode && !touch) {
    touch = new TouchControls({ documentRef: document });
    touch.mount(document.body);
    touch.setEnabled(true);
    setTitanfallTouchSource(titanfallTouch);
  }
  h.gameplay?.setDeviceLabels?.({ touch: touchMode });
  h.setMatchState(fixture.snapshot.match, fixture.self, fixture.snapshot.players, FIXTURE_NOW);
  h.setState(localHudState(fixture.self));
  model = titanHudModel({ snapshot: fixture.snapshot, selfRow: fixture.self, tfs: decodeTitanfallSelf(fixture.tfs), now: FIXTURE_NOW,
    keys: touchMode ? {} : KEYS, local: { ...fixture.local, touch: !!touchMode } });
  stockExtras(fixture, h);
  titanHud.render(model);
  document.body.dataset.titanfall = model.layout;
  document.body.dataset.vehicleSeated = String(model.layout === 'titan');
  if (touch) touch.setContext(touchMode ? touchContext(fixture, model) : null);
  if (fixture.loadout) {
    loadout ??= new TitanLoadout(document.body, { portraits });
    loadout.packed = fixture.loadout.packed;
    loadout.portraitTeam = null;   // re-measure the card slot at this size (the portraits() cache is per size)
    loadout.open({ team: fixture.self.team, dead: !!fixture.loadout.dead, respawnIn: model.respawnIn, autoDeployIn: model.autoDeployIn ?? null });
    await loadout.portraitsReady();
  } else loadout?.close();
  label.textContent = `${fixture.id} · ${fixture.title} · ${innerWidth}×${innerHeight}`;
  await frame();
  return { id, title: fixture.title, layout: model.layout, portraits: loadout?.isOpen ? loadout.portraitCanvases.size : null };
}

const rect = el => {
  if (!el || el.hidden || el.closest?.('[hidden]')) return null;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
};

/** Fixed HUD boxes for the overlap check (the loadout covers everything, so only its own parts count). */
function boxes() {
  const one = selector => rect(document.querySelector(selector));
  const buttons = [...document.querySelectorAll('.vb-touch-button')].map(b => ({ action: b.dataset.action, box: rect(b) })).filter(b => b.box);
  // The loadout covers the HUD and the touch controls (it sits above them): only its own parts count.
  if (one('.tf-loadout')) return { 'lo-head': one('.tf-lo-head'), 'lo-deploy': one('.tf-lo-deploy'), buttons: [] };
  return {
    top: one('.tf-top'), banner: one('.tf-banner'), tactical: one('.tf-tactical'), rodeo: one('.tf-rodeo'), meter: one('.tf-meter'),
    call: one('.tf-call'), battery: one('.tf-battery'), at: one('.tf-at'), weapon: one('.tf-weapon'), core: one('.tf-core'), doom: one('.tf-doom'),
    dash: one('.tf-dash'), health: one('.tf-health'), abilities: one('.tf-abilities'), smoke: one('.tf-smoke'), lock: one('.tf-lock'),
    healthbar: one('#healthbar'), ammo: one('#ammo'), grenades: one('#grenade-count'), killfeed: one('#killfeed'), compass: one('#compass'),
    career: one('.vb-career-badge'),
    // The movement stick at rest (touch): no HUD panel or button may sit on it.
    stick: touchOn ? one('.vb-touch-stick-base') : null,
    buttons, viewport: { width: innerWidth, height: innerHeight },
  };
}

window.__tf = { ids: fixtures.map(f => f.id), titles: Object.fromEntries(fixtures.map(f => [f.id, f.title])), render, boxes, setBackdrop, ready: true };
