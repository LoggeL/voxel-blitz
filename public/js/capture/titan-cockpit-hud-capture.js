/**
 * Diegetic cockpit HUD capture states (docs/titanfall.md §7.2; tools/titanfall-cockpit-capture.mjs --diegetic).
 * Each state is one titan row (the same `tw` / `ab` / mount fields the server sends, built with the fixture
 * encoders), the HUD model titan-ui would publish for a pilot seated in it (titanHudModel over a snapshot that
 * holds that row) and the stock pieces the cockpit reads (crosshair, hit marker, kill feed rows, badge). The
 * capture page renders the cockpit from the same row, so the console MFDs, the pods and the glass show one state.
 *
 *   const { stage } = await import('/js/capture/titan-cockpit-hud-capture.js');
 *   const params = stage('firing', 'titan_ion', { touch: false });   // -> titanCapture.render({ ...params, view: 'cockpit' })
 */
import { titanHudModel } from '../titanfall/titan-hud-state.js';
import { publishCockpitHud, setCockpitHudStock } from '../titanfall/titan-cockpit-hud.js';
import { titanfallHudFixtures, titanRow, FIXTURE_NOW } from './titanfall-hud-fixtures.js';
import { decodeTitanfallSelf, TITAN_PHASE, TITAN_ABILITY_BITS as B } from '../../../shared/titan-contract.js';
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { vehicleDef, VEHICLE_WEAPONS } from '../../../shared/vehicle-defs.js';
import { seatWeaponList } from '../../../shared/conquest-contract.js';

const KEYS = Object.freeze({ interact: 'T', jump: 'SPACE', callTitan: 'E', pilotTactical: 'Q', titanDash: 'SPACE', titanDefensive: 'Q',
  titanTactical: 'E', titanOrdnance: 'G', titanCore: 'V', titanSmoke: 'C', titanEject: 'X' });
const FEED = Object.freeze([
  { killer: 'JUNO', victim: 'KADE', weapon: 'SHOTGUN', marker: '' },
  { killer: 'BRASK', victim: 'NYX', weapon: 'HORNET SMG', marker: 'HEADSHOT' },
  { killer: 'KADE', victim: 'IVO', weapon: 'CHARGE RIFLE', marker: 'LONG RANGE' },
  { killer: 'VEX', victim: 'ROOK', weapon: 'KRABER', marker: '' },
  { killer: 'KADE', victim: 'LEGION', weapon: 'DESTROYED', marker: '+1 CREW', vehicle: true },
  { killer: 'ORLA', victim: 'BRASK', weapon: 'LEADWALL', marker: '' },
]);

/**
 * State table: titan row values (fractions of the frame's hull / shield / magazine), the stock hit marker
 * (0 none, 1 body, 2 head, 4 kill), kill feed rows, eject taps, match clock and spread gap.
 */
export const COCKPIT_HUD_STATES = Object.freeze({
  idle: { hp: 0.72, shield: 0.6, dash: 2, core: 0.46, def: 1, tac: 1, ord: 1, smoke: 2, ammo: 0.8, feed: 2 },
  firing: { hp: 0.64, shield: 0.25, dash: 1.5, core: 0.58, def: 1, tac: 0.4, ord: 1, smoke: 2, ammo: 0.15, heat: 0.72, charge: 0.72, hit: 1, gap: 14, feed: 3 },
  doom: { hp: 0.12, shield: 0, dash: 2, core: 0.3, def: 0.2, tac: 1, ord: 1, smoke: 1, ammo: 0.5, doomLeft: 4.2, ejectTaps: 1, feed: 3, pose: 'doom' },
  core: { hp: 0.9, shield: 1, dash: 2, core: 1, def: 1, tac: 0.4, ord: 1, smoke: 2, ammo: 1, hit: 4, feed: 3 },
  cooldown: { hp: 0.55, shield: 0.1, dash: 0.6, core: 0.62, def: 0.25, tac: 0.6, ord: 0.05, smoke: 1, smokeActive: true, defensiveUp: false, ammo: 0.4, reload: 0.35, feed: 2 },
  rodeo: { hp: 0.4, shield: 0, dash: 1, core: 0.8, def: 1, tac: 1, ord: 0.5, smoke: 0, ammo: 0.6, rider: true, batteryOut: true, lock: 2, feed: 2 },
  feed: { hp: 0.8, shield: 0.4, dash: 2, core: 0.7, def: 0.8, tac: 1, ord: 1, smoke: 2, ammo: 0.7, lock: 3, feed: 6, clock: 42, hit: 2 },
});

/** Stage one state for `type`: publishes the HUD model and the stock source; returns titanCapture.render params. */
export function stage(stateId, type, { touch = false } = {}) {
  const s = COCKPIT_HUD_STATES[stateId];
  if (!s) throw new Error(`unknown cockpit HUD state ${stateId}`);
  const def = vehicleDef(type), maxHp = def.hp, shieldMax = TITAN_RULES.shieldMaxFrac * maxHp;
  const weapon = VEHICLE_WEAPONS[seatWeaponList(type, 'driver')[0]?.weapon] ?? {};
  const magazine = Number.isFinite(weapon.magazine) ? weapon.magazine : 20;
  const ammo = s.reload ? 0 : Math.max(1, Math.round(magazine * s.ammo));
  const doomed = (s.doomLeft ?? 0) > 0, heats = ['titan_scorch', 'titan_legion'], charges = ['titan_northstar'];
  const bits = (s.rider ? B.rider : 0) | (s.batteryOut ? B.batteryOut : 0) | (s.smokeActive ? B.smoke : 0) | (s.defensiveUp ? B.defensive : 0);
  const fixture = titanRow({ type, hp: Math.round(maxHp * s.hp), shield: Math.round(shieldMax * s.shield), dash: s.dash, core: s.core,
    doomLeft: s.doomLeft ?? 0, bits, phase: doomed ? TITAN_PHASE.doomed : TITAN_PHASE.idle, def: s.def, tac: s.tac, ord: s.ord, smoke: s.smoke,
    // Charge reads on the railgun (and the predator's spin-up), heat on the thermal and minigun mounts.
    mount: [0, 0.04, ammo, heats.includes(type) ? Math.round((s.heat ?? 0) * 100) : 0, Math.round((s.reload ?? 0) * 100),
      charges.includes(type) ? Math.round((s.charge ?? 0) * 100) : 0],
    lk: s.lock ?? 0, driver: 'me' });
  const row = { hp: fixture.hp, tw: fixture.tw, ab: fixture.ab, mounts: fixture.mounts, lk: fixture.lk, sel: fixture.sel };
  // The seated-pilot snapshot of the stock 'titan' fixture with this row as the own titan.
  const base = titanfallHudFixtures().find(f => f.id === 'titan');
  const match = s.clock != null ? { ...base.snapshot.match, titanfall: { ...base.snapshot.match.titanfall, endsAt: FIXTURE_NOW + s.clock * 1000 } } : base.snapshot.match;
  const snapshot = { ...base.snapshot, match, vehicles: [{ ...fixture, id: 'T1' }] };
  const model = titanHudModel({ snapshot, selfRow: base.self, tfs: decodeTitanfallSelf(base.tfs), now: FIXTURE_NOW, keys: touch ? {} : KEYS,
    local: { ejectTaps: s.ejectTaps ?? 0, touch } });
  // Fresh for the whole capture (the cockpit falls back to its own row once a model is older than COCKPIT_HUD.modelMs).
  publishCockpitHud(model, touch ? {} : KEYS, (globalThis.performance?.now?.() ?? Date.now()) + 3_600_000);
  let feedKey = 0;
  setCockpitHudStock({
    aim(out) { out.x = 0.5; out.y = 0.5; out.gap = s.gap ?? 6; out.hidden = false; return out; },
    hit: () => s.hit ?? 0,
    feedKey: () => feedKey,
    feed(rows) { rows.length = 0; rows.push(...FEED.slice(0, s.feed ?? 0)); return rows; },
    badge: () => 'LV 14 · KADE',
  });
  feedKey = Math.round(Math.random() * 1e9);
  return { pose: s.pose ?? 'idle', core: s.core, hp: s.hp, lock: s.lock ?? 0, row, model: { layout: model.layout, titan: model.titan, top: model.top, rider: model.rider } };
}
