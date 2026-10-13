/**
 * Pilot wrist display fixtures (docs/titanfall.md §8.7 "Wrist display"): the
 * tactical states the forearm screen shows, as the rows the server sends (the
 * own player row's `tf` flags and the `tfs` tactical fields), built with the
 * contract encoders. Pure data: used by tools/titanfall-wrist-test.mjs and
 * the capture page public/titanfall-wrist-capture.html.
 */
import { encodeTitanfallSelf, TITAN_MV, TITANFALL_PLAYER_FLAGS } from '../../../shared/titan-contract.js';
import { pilotRow, FIXTURE_NOW } from './titanfall-hud-fixtures.js';

const F = TITANFALL_PLAYER_FLAGS;

/**
 * { id, title, tactical, flags, mv, tfs: { tacCharges, tacReady }, inRange, expect }. `expect` holds the
 * wrist model facts the hud-state test asserts (state, charges, timers in whole seconds where they apply).
 */
export const WRIST_STATES = Object.freeze([
  { id: 'grapple-2', title: 'Grapple · 2 charges', tactical: 'grapple', tfs: { tacCharges: 2, tacReady: 1 },
    expect: { state: 'ready', charges: 2, cooldownLeft: null } },
  { id: 'grapple-1', title: 'Grapple · 1 charge · recharging', tactical: 'grapple', tfs: { tacCharges: 1, tacReady: 0.45 },
    expect: { state: 'ready', charges: 1, cooldownLeft: 3.3 } },
  { id: 'grapple-0', title: 'Grapple · empty · recharging', tactical: 'grapple', tfs: { tacCharges: 0, tacReady: 0.2 },
    expect: { state: 'cooling', charges: 0, cooldownLeft: 4.8 } },
  { id: 'grapple-reel', title: 'Grapple · reeling in', tactical: 'grapple', flags: F.grappling, mv: TITAN_MV.grapple,
    tfs: { tacCharges: 1, tacReady: 0.08 }, expect: { state: 'active', charges: 1, reeling: true } },
  { id: 'grapple-range', title: 'Grapple · 2 charges · surface in range', tactical: 'grapple', tfs: { tacCharges: 2, tacReady: 1 }, inRange: true,
    expect: { state: 'ready', charges: 2, inRange: true } },
  { id: 'stim-active', title: 'Stim · active', tactical: 'stim', flags: F.stimmed, tfs: { tacCharges: 0, tacReady: 0.1 },
    expect: { state: 'active', activeLeft: 2.8 } },
  { id: 'stim-ready', title: 'Stim · ready', tactical: 'stim', tfs: { tacCharges: 1, tacReady: 1 }, expect: { state: 'ready' } },
  { id: 'cloak-active', title: 'Cloak · active', tactical: 'cloak', flags: F.cloaked, tfs: { tacCharges: 0, tacReady: 0.2 },
    expect: { state: 'active', activeLeft: 2 } },
  { id: 'cloak-cooldown', title: 'Cloak · cooldown', tactical: 'cloak', tfs: { tacCharges: 0, tacReady: 0.55 },
    expect: { state: 'cooling', cooldownLeft: 6.75 } },
]);

/** The snapshot-shaped inputs of one wrist state: { snapshot, self, tfs, now }, `weapon` the held weapon id. */
export function wristFixture(id, { weapon = 'rifle' } = {}) {
  const state = WRIST_STATES.find(item => item.id === id);
  if (!state) throw new Error(`unknown wrist state ${id}`);
  const primary = ['rifle', 'smg', 'shotgun', 'lmg', 'kraber'].includes(weapon) ? weapon : 'rifle';
  const at = ['chargerifle', 'archer', 'thunderbolt', 'mgl'].includes(weapon) ? weapon : 'chargerifle';
  const self = pilotRow({ loadout: { primary, at, tactical: state.tactical }, weapon: weapon === at ? 'at' : 'primary',
    tf: { meter: 0.42, mv: state.mv ?? TITAN_MV.ground, flags: state.flags ?? 0 } });
  const frame = { t: 'tfs', s: FIXTURE_NOW, d: encodeTitanfallSelf({ jumpsLeft: 1, tacKind: state.tactical, ...state.tfs }) };
  const snapshot = { serverNow: FIXTURE_NOW, match: { mode: 'titanfall', phase: 'live',
    titanfall: { v: 1, endsAt: FIXTURE_NOW + 521_000, scoreLimit: 300, sc: [142, 128], bat: [], bay: [1, 2, 6] } }, players: [self], vehicles: [] };
  return { state, snapshot, self, tfs: frame, now: FIXTURE_NOW };
}
