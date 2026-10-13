/**
 * Snapshot-shaped Titanfall HUD fixtures (docs/titanfall.md §8.1; WP6): the
 * same rows the server sends (player `tf`, the `tfs` frame, titan `tw`/`ab`,
 * `match.titanfall`), built with the contract encoders. Pure data: used by
 * tools/titanfall-hud-state-test.mjs and the static capture page
 * public/titanfall-hud-capture.html.
 */
import { encodeTitanfallPlayer, encodeTitanfallSelf, encodeTitanRow, packTitanLoadout, TITAN_MV, TITAN_PHASE,
  TITAN_ABILITY_BITS, TITANFALL_PLAYER_FLAGS } from '../../../shared/titan-contract.js';
import { WEAPON_IDS, WEAPONS } from '../../../shared/combatmath.js';
import { titanBackAnchor, TITANFALL_SCORE_LIMIT } from '../titanfall/titan-hud-state.js';

export const FIXTURE_NOW = 1_000_000;
const GROUND = 40;

const ownedFor = ids => ids.filter(id => WEAPON_IDS.includes(id));
function inventory(owned) {
  const mag = WEAPON_IDS.map(() => 0), reserve = WEAPON_IDS.map(() => 0);
  for (const id of owned) {
    const slot = WEAPON_IDS.indexOf(id);
    mag[slot] = Math.max(1, Math.trunc(WEAPONS[id]?.magSize ?? 1));
    reserve[slot] = Math.max(1, Math.trunc(WEAPONS[id]?.spareRounds ?? WEAPONS[id]?.spareMags ?? 3));
  }
  return { mag, reserve };
}

/** One local pilot row. `tf` fields as in encodeTitanfallPlayer. */
export function pilotRow({ team = 'alpha', hp = 100, state = 'alive', vehicleId = null, x = 300, y = GROUND, z = 300, tf = {}, loadout = {},
  respawnAt = null, weapon = 'rifle' } = {}) {
  const packed = packTitanLoadout({ primary: 'rifle', at: 'chargerifle', tactical: 'grapple', titan: 'titan_ion', ...loadout });
  const at = ['chargerifle', 'archer', 'thunderbolt', 'mgl'].find(id => id === loadout.at && WEAPON_IDS.includes(id))
    ?? (WEAPON_IDS.includes(loadout.at ?? 'chargerifle') ? loadout.at ?? 'chargerifle' : 'rocket');
  const primary = WEAPON_IDS.includes(loadout.primary ?? 'rifle') ? loadout.primary ?? 'rifle' : 'sniper';
  const owned = ownedFor([primary, 'revolver', at, 'knife']);
  const { mag, reserve } = inventory(owned);
  return {
    id: 'me', name: 'Kade', team, state, hp, x, y, z, yaw: 0, pitch: 0, vehicleId, vehicleSeatId: vehicleId ? 'driver' : null,
    owned, mag, reserve, weapon: WEAPON_IDS.indexOf(weapon === 'at' ? at : primary), respawnAt,
    tf: encodeTitanfallPlayer({ mv: TITAN_MV.ground, loadout: packed, meter: 0, ...tf }),
  };
}

/** One titan vehicle row (extras through encodeTitanRow). */
export function titanRow({ id = 'T1', type = 'titan_ion', team = 'alpha', owner = 'me', x = 304, y = GROUND, z = 300, yaw = 0, hp = null,
  shield = 0, dash = 2, core = 0, doomLeft = 0, bits = 0, phase = TITAN_PHASE.auto, def = 1, tac = 1, ord = 1, smoke = 2,
  mount = null, lk = 0, sel = 0, driver = null } = {}) {
  const maxHp = { titan_ion: 2500, titan_scorch: 3200, titan_northstar: 2000, titan_ronin: 2000, titan_legion: 3200 }[type] ?? 2500;
  return {
    id, type, team, x, y, z, yaw, pitch: 0, roll: 0, speed: 0, hp: hp ?? maxHp, grounded: true, wreck: false,
    mounts: [mount ?? [yaw, 0, 22, 0, 0, 0]], sel: { driver: sel }, lk,
    seatOccupants: { driver: driver }, occupantId: driver,
    ...encodeTitanRow({ shield, dash, core, doomLeft, bits, phase, owner, def, tac, ord, smoke }),
  };
}

function match({ sc = [142, 128], left = 8 * 60 + 41, bay = [1, 2, 6], phase = 'live', winner = undefined } = {}) {
  return { mode: 'titanfall', phase, ...(winner !== undefined ? { winner } : {}),
    titanfall: { v: 1, endsAt: FIXTURE_NOW + left * 1000, scoreLimit: TITANFALL_SCORE_LIMIT, sc, bat: [], bay } };
}
const tfs = (s = {}) => ({ t: 'tfs', s: FIXTURE_NOW, d: encodeTitanfallSelf({ jumpsLeft: 1, tacCharges: 2, tacReady: 1, ...s }) });
const F = TITANFALL_PLAYER_FLAGS, B = TITAN_ABILITY_BITS;

/**
 * Fixture list: { id, title, snapshot, self (the local row inside snapshot.players), tfs, local, expect, feed }.
 * `expect` holds the facts tools/titanfall-hud-state-test.mjs asserts; `feed` is the number of stock kill
 * feed rows the capture page adds (the career badge is always shown), so the overlap check covers them.
 */
export function titanfallHudFixtures() {
  const list = [];
  const add = (id, title, { players = [], vehicles = [], self, frame = tfs(), local = {}, m = match(), expect = {}, loadout = null, feed = 0 }) => {
    list.push({ id, title, snapshot: { serverNow: FIXTURE_NOW, match: m, players: [self, ...players], vehicles }, self, tfs: frame, local,
      expect, loadout, feed });
  };
  const enemyTitan = (extra = {}) => titanRow({ id: 'T9', type: 'titan_legion', team: 'bravo', owner: 'bot-3', x: 310, z: 290, ...extra });

  add('pilot', 'Pilot · meter 72 % · grapple 1/2 · battery', {
    self: pilotRow({ tf: { meter: 0.72, flags: F.battery } }),
    frame: tfs({ tacCharges: 1, tacReady: 0.4, lockProgress: 0 }),
    expect: { layout: 'pilot', meter: 'filling', meterPct: 72, battery: true, tactical: 'ready', pips: [1, 0.4] },
    feed: 4,
  });
  add('wallrun', 'Pilot · wall-running · double jump spent · meter 99 %', {
    self: pilotRow({ tf: { meter: 0.99 } }),
    frame: tfs({ jumpsLeft: 0, wallN: 1, wallT: 0.6 }),
    expect: { layout: 'pilot', meter: 'filling', meterPct: 99, prompt: null },
  });
  add('pilot-ready', 'Pilot · TITANFALL READY', {
    self: pilotRow({ tf: { meter: 1 }, weapon: 'at' }),
    frame: tfs({ lockProgress: 0.6 }),
    expect: { layout: 'pilot', meter: 'ready', prompt: 'CALL TITAN', atLock: 0.6 },
  });
  add('bay-full', 'Pilot · TITAN BAY FULL', {
    self: pilotRow({ tf: { meter: 1 } }), m: match({ bay: [6, 4, 6] }),
    expect: { layout: 'pilot', meter: 'bay', prompt: null },
  });
  add('embark', 'Pilot · own titan near · hold T embark', {
    self: pilotRow({ tf: { meter: 0.1, titanId: 'T1' } }),
    vehicles: [titanRow({ x: 303, z: 300, phase: TITAN_PHASE.auto })],
    local: { embarkProgress: 0.6 },
    expect: { layout: 'pilot', meter: 'owned', prompt: 'EMBARK', touchContext: 'EMBARK' },
  });
  add('rodeo-mount', 'Pilot · enemy titan back in reach', {
    self: pilotRow({ x: 310, y: GROUND + 4.6, z: 291.8, tf: { meter: 0.35 } }),
    vehicles: [enemyTitan()],
    expect: { layout: 'pilot', rodeo: 'mount' },
  });
  add('rodeo-rip', 'Pilot · riding · ripping battery', {
    self: pilotRow({ tf: { meter: 0.5, mv: TITAN_MV.rodeo ?? 0, rodeoVehicleId: 'T9' } }),
    vehicles: [enemyTitan({ bits: B.rider })],
    local: { ripStartedAt: FIXTURE_NOW - 700 },
    expect: { layout: 'pilot', rodeo: 'ripping' },
  });
  add('rodeo-doomed', 'Pilot · riding a doomed titan · no rip', {
    self: pilotRow({ tf: { meter: 0.5, mv: TITAN_MV.rodeo ?? 0, rodeoVehicleId: 'T9' } }),
    vehicles: [enemyTitan({ bits: B.rider, hp: 400, doomLeft: 4.2, phase: TITAN_PHASE.doomed })],
    expect: { layout: 'pilot', rodeo: 'riding' },
  });
  {
    // A battery carrier 2.5 m from a friendly titan's back: past the 2.2 m insert reach.
    const friend = titanRow({ id: 'T4', owner: 'mate', x: 304, z: 296, shield: 0 });
    const anchor = titanBackAnchor(friend);
    add('battery-far', 'Pilot · battery · friendly titan just out of reach', {
      self: pilotRow({ x: anchor[0], y: anchor[1] - 1.2, z: anchor[2] + 2.5, tf: { meter: 0.3, flags: F.battery } }),
      vehicles: [friend],
      expect: { layout: 'pilot', rodeo: 'insert', battery: true, touchContext: null },
    });
  }
  add('loadout-live', 'Pilot · loadout while alive · applies next deploy', {
    self: pilotRow({ tf: { meter: 0.6 } }),
    loadout: { dead: false, packed: packTitanLoadout({ primary: 'smg', at: 'thunderbolt', tactical: 'cloak', titan: 'titan_ronin' }) },
    expect: { layout: 'pilot' },
  });
  add('oob', 'Pilot · out of bounds', {
    self: pilotRow({ tf: { meter: 0.2, flags: F.oob } }),
    expect: { layout: 'pilot', banner: 'RETURN TO THE BATTLEFIELD' },
  });
  add('titan', 'Titan · ION · core 86 %', {
    self: pilotRow({ vehicleId: 'T1', tf: { titanId: 'T1', mv: TITAN_MV.ground } }),
    vehicles: [titanRow({ hp: 1800, shield: 600, dash: 1.5, core: 0.86, tac: 0.4, phase: TITAN_PHASE.auto, driver: 'me', mount: [0, 0, 14, 0, 0, 0] })],
    expect: { layout: 'titan', corePct: 86, dashPips: 1.5, weapon: 'SPLITTER RIFLE', ammo: '14', touchContext: 'EXIT' },
    feed: 4,
  });
  add('titan-doomed', 'Titan · DOOMED · eject', {
    self: pilotRow({ vehicleId: 'T1', tf: { titanId: 'T1' } }),
    vehicles: [titanRow({ hp: 380, doomLeft: 4.8, phase: TITAN_PHASE.doomed, dash: 2, core: 0.3, def: 0.2, driver: 'me' })],
    local: { ejectTaps: 1 },
    expect: { layout: 'titan', doomed: true, ejectTaps: 1, touchContext: null },
    feed: 4,
  });
  add('titan-rider', 'Titan · enemy pilot on board · lock', {
    self: pilotRow({ vehicleId: 'T1', tf: { titanId: 'T1' } }),
    vehicles: [titanRow({ type: 'titan_legion', hp: 2900, shield: 0, core: 1, bits: B.rider, lk: 2, driver: 'me', mount: [0, 0, 64, 0, 0, 0] })],
    expect: { layout: 'titan', banner: 'ENEMY PILOT ON BOARD', coreReady: true },
  });
  add('dead', 'Dead · loadout · respawn 3.0', {
    self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW + 3000, tf: { meter: 0.4 } }),
    loadout: { dead: true, packed: packTitanLoadout({ primary: 'rifle', at: 'chargerifle', tactical: 'stim', titan: 'titan_ion' }) },
    expect: { layout: 'dead', respawnIn: 3 },
  });
  // §3.4: the respawn timer ran out 6 s ago and DEPLOY was not pressed: the idle fallback counts down.
  add('deploy-idle', 'Dead · loadout · auto-deploy countdown', {
    self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW - 6000, tf: { meter: 0.4, flags: F.deploy } }),
    loadout: { dead: true, packed: packTitanLoadout({ primary: 'lmg', at: 'archer', tactical: 'grapple', titan: 'titan_northstar' }) },
    expect: { layout: 'dead', respawnIn: 0 },
  });
  return list;
}
