// Titanfall client UI (docs/titanfall.md §8, §6.2, §11.1; WP6): the pure HUD
// model over snapshot-shaped fixtures (pilot, titan, doomed, rodeo, meter full,
// bay full, OOB, dead), key contexts, kit digits and the wheel, the loadout
// pack and storage, announcer mapping, touch buttons, the titan-ui intents
// (call, tactical, dash send order, abilities, eject triple-tap, titanHold)
// and the dispose contract: no titanfall listener stays and Q is lean again.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

const dom = installFakeDom({ width: 1920, height: 1080 });
const { window, document } = dom;
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const acheck = async (name, fn) => { await fn(); checks.push(name); };

const contract = await import('../shared/titan-contract.js');
const state = await import('../public/js/titanfall/titan-hud-state.js');
const { titanfallHudFixtures, FIXTURE_NOW, pilotRow, titanRow } = await import('../public/js/capture/titanfall-hud-fixtures.js');
const { insertDistance } = await import('../server/sim/titanfall/rodeo.js');
const keybindings = await import('../public/js/keybindings.js');
const { defaultKeybindings } = keybindings;
const { titanfallOwned } = await import('../server/sim/titanfall/loadout.js');
const combat = await import('../shared/combatmath.js');
const { WEAPON_IDS } = combat;
const announcerMod = await import('../public/js/titanfall/titanfall-announcer.js');
const { TITANFALL_CUES, titanfallCueUrl, announcerCueInfo } = await import('../shared/announcer.js');
const touchMod = await import('../public/js/engine/touch-controls.js');
const loadoutMod = await import('../public/js/titanfall/titan-loadout.js');
const controllerMod = await import('../public/js/titanfall/titan-controller.js');
const ui = await import('../public/js/titanfall/titan-ui.js');
const cockpitHud = await import('../public/js/titanfall/titan-cockpit-hud.js');
const THREE = await import('../public/js/vendor/three.module.js');
const fs = await import('node:fs');

// ---- HUD model over the fixtures --------------------------------------------------------------
const fixtures = titanfallHudFixtures();
const modelOf = (f, extra = {}) => state.titanHudModel({ snapshot: f.snapshot, selfRow: f.self, tfs: contract.decodeTitanfallSelf(f.tfs),
  now: FIXTURE_NOW, keys: { interact: 'T', callTitan: 'E', titanEject: 'X' }, local: f.local, ...extra });
check('fixtures cover pilot, titan, doomed, rodeo, meter full, bay full, OOB, dead', () => {
  const ids = fixtures.map(f => f.id);
  for (const id of ['pilot', 'wallrun', 'pilot-ready', 'bay-full', 'embark', 'rodeo-mount', 'rodeo-rip', 'oob', 'titan', 'titan-doomed', 'titan-rider', 'dead']) assert.ok(ids.includes(id), id);
});
for (const f of fixtures) {
  check(`model ${f.id}`, () => {
    const m = modelOf(f), e = f.expect;
    assert.equal(m.layout, e.layout, 'layout');
    assert.equal(m.top.own.score, 142); assert.equal(m.top.enemy.score, 128); assert.equal(m.top.clock, '08:41'); assert.equal(m.top.limit, state.TITANFALL_SCORE_LIMIT);
    assert.equal(m.top.own.label, 'MILITIA'); assert.equal(m.top.enemy.label, 'IMC');
    if (e.meter) assert.equal(m.pilot.meter.state, e.meter);
    if (e.meterPct != null) assert.equal(m.pilot.meter.pct, e.meterPct);
    if ('prompt' in e) assert.equal(m.pilot.meter.prompt?.label ?? null, e.prompt);
    if (e.battery) assert.equal(m.pilot.battery, true);
    if (e.tactical) assert.equal(m.pilot.tactical.state, e.tactical);
    if (e.pips) assert.deepEqual(m.pilot.tactical.pips, e.pips);
    if (e.atLock != null) { assert.equal(m.pilot.at.lock, e.atLock); assert.equal(m.pilot.at.equipped, true); }
    if (e.rodeo) assert.equal(m.pilot.rodeo?.kind, e.rodeo);
    if (e.banner) assert.equal(m.rider ?? m.oob?.label, e.banner);
    if (e.corePct != null) assert.equal(m.titan.core.pct, e.corePct);
    if (e.dashPips != null) assert.equal(m.titan.dash.pips, e.dashPips);
    if (e.weapon) assert.equal(m.titan.weapon.label, e.weapon);
    if (e.ammo) assert.equal(m.titan.weapon.ammoText, e.ammo);
    if (e.doomed) { assert.equal(m.titan.doomed, true); assert.equal(m.titan.hpFrac, 0); assert.equal(m.titan.eject.taps, e.ejectTaps); assert.equal(m.titan.eject.key, 'X'); }
    if (e.coreReady) assert.equal(m.titan.core.ready, true);
    if (e.respawnIn != null) assert.equal(m.respawnIn, e.respawnIn);
    if (m.pilot) assert.equal('jumps' in m.pilot, false, 'no double-jump/wall-run HUD (TF2 has none; movement reads from the camera)');
    if ('touchContext' in e) assert.equal(state.titanfallTouchModel(m).context, e.touchContext);
  });
}
check('titan model: eject only while doomed, shield and hull from the row', () => {
  const m = modelOf(fixtures.find(f => f.id === 'titan'));
  assert.equal(m.titan.eject, null);
  assert.equal(m.titan.shield, 600); assert.equal(m.titan.hp, 1800); assert.equal(m.titan.maxHp, 2500); assert.equal(m.titan.healthText, '1800 / 2500');
  assert.deepEqual(m.titan.abilities.map(a => a.state), ['ready', 'cooling', 'ready']);
  assert.deepEqual(m.titan.abilities.map(a => a.label), ['VORTEX SHIELD', 'LASER TRIPWIRE', 'LASER SHOT']);
  const rider = modelOf(fixtures.find(f => f.id === 'titan-rider'));
  assert.equal(rider.titan.lock.label, 'LOCKED');
});
check('rodeo: rip progress from the local rip clock, embark progress from the hold', () => {
  const rip = modelOf(fixtures.find(f => f.id === 'rodeo-rip')).pilot.rodeo;
  assert.equal(rip.label, 'RIPPING BATTERY'); assert.ok(Math.abs(rip.progress - 0.5) < 1e-9);
  const embark = modelOf(fixtures.find(f => f.id === 'embark')).pilot.meter.prompt;
  assert.equal(embark.hold, true); assert.equal(embark.progress, 0.6);
});
check('score bar flips for bravo and turns urgent in the last minute', () => {
  const f = fixtures.find(x => x.id === 'pilot');
  const bar = state.scoreBar({ ...f.snapshot.match, titanfall: { ...f.snapshot.match.titanfall, endsAt: FIXTURE_NOW + 45_000 } }, 'bravo', FIXTURE_NOW);
  assert.equal(bar.own.label, 'IMC'); assert.equal(bar.own.score, 128); assert.equal(bar.urgent, true); assert.equal(bar.clock, '00:45');
  assert.equal(state.titanHudModel({ snapshot: { match: { mode: 'conquest' } } }).layout, 'hidden');
});
check('touch model: pilot context chip and titan readiness', () => {
  assert.equal(state.titanfallTouchModel(modelOf(fixtures.find(f => f.id === 'pilot-ready'))).context, 'TITAN');
  assert.equal(state.titanfallTouchModel(modelOf(fixtures.find(f => f.id === 'rodeo-mount'))).context, 'RODEO');
  const titan = state.titanfallTouchModel(modelOf(fixtures.find(f => f.id === 'titan-doomed')));
  assert.equal(titan.layout, 'titan'); assert.equal(titan.doomed, true); assert.equal(titan.ready.titanDefensive, 0.2);
  assert.ok(titan.labels.titanDefensive && titan.labels.titanDefensive.length <= 8);
  assert.equal(state.touchLabel('VORTEX SHIELD'), 'VORTEX'); assert.equal(state.touchLabel('LASER TRIPWIRE'), 'TRIPWIRE');
  assert.equal(state.titanfallTouchModel(modelOf(fixtures.find(f => f.id === 'dead'))), null);
});

check('gauges floor: 100 % only once the authoritative fraction is full', () => {
  const filling = state.titanMeterModel({ tf: { meter: 0.995 }, match: null, team: 'alpha' });
  assert.equal(filling.state, 'filling'); assert.equal(filling.pct, 99); assert.equal(filling.prompt, null);
  assert.equal(state.titanMeterModel({ tf: { meter: 1 }, match: null, team: 'alpha' }).pct, 100);
  const tac = state.tacticalModel({ loadout: { tactical: 'stim' } }, { tacCharges: 0, tacReady: 0.999 }, {}, 'stim');
  assert.equal(tac.readyPct, 99); assert.equal(tac.state, 'cooling');
  const titan = modelOf(fixtures.find(f => f.id === 'titan')).titan;
  assert.equal(titan.core.pct, 86); assert.equal(titan.core.ready, false);
  const row = fixtures.find(f => f.id === 'titan').snapshot.vehicles[0];
  const nearly = state.titanModel({ ...row, tw: [row.tw[0], row.tw[1], 99, ...row.tw.slice(3)] });
  assert.equal(nearly.core.pct, 99); assert.equal(nearly.core.ready, false);
});
check('touch model: EMBARK hold ring, EXIT while seated, none while doomed', () => {
  const embark = state.titanfallTouchModel(modelOf(fixtures.find(f => f.id === 'embark')));
  assert.equal(embark.context, 'EMBARK'); assert.equal(embark.ready.callTitan, 0.6);
  const seated = state.titanfallTouchModel(modelOf(fixtures.find(f => f.id === 'titan')));
  assert.equal(seated.context, 'EXIT'); assert.equal(seated.ready.callTitan, 1);
  const seat = { alive: true, canFire: true, vehicleSeated: true, vehicleType: 'titan_ion', vehicleCanDrive: true, vehicleCanFire: true };
  assert.ok(touchMod.visibleTouchActions({ ...seat, titanfall: { layout: 'titan', doomed: false, context: 'EXIT' } }).has('callTitan'));
  assert.ok(!touchMod.visibleTouchActions({ ...seat, titanfall: { layout: 'titan', doomed: true, context: null } }).has('callTitan'));
});
check('names: the AT chip and the loadout use the weapon def names (as the stock ammo card)', () => {
  const at = modelOf(fixtures.find(f => f.id === 'pilot-ready')).pilot.at;
  const { WEAPONS } = combat;
  assert.equal(at.label, WEAPONS[at.id].name.toUpperCase());
  const lo = state.loadoutModel(contract.TITAN_LOADOUT_DEFAULT_PACKED);
  for (const item of [...lo.primary, ...lo.at]) assert.equal(item.label, WEAPONS[item.id].name.toUpperCase(), item.id);
  assert.deepEqual(lo.tactical.map(t => t.label), ['GRAPPLE', 'STIM', 'CLOAK']);
  assert.equal(lo.primaryName, WEAPONS[lo.selection.primary].name.toUpperCase());
  for (const key of ['damage', 'rate', 'mag']) assert.ok(lo.primaryStats[key] >= 0.2 && lo.primaryStats[key] <= 1, key);
  assert.equal(state.primaryStats('kraber').damage, 1);
});
check('owned titan gauge reads HULL, not the meter', () => {
  const m = modelOf(fixtures.find(f => f.id === 'embark')).pilot.meter;
  assert.equal(m.state, 'owned'); assert.equal(m.title, 'ION · HULL'); assert.equal(m.label, 'AUTO-TITAN');
});

// ---- keys, digits, wheel ---------------------------------------------------------------------------------
check('pilot and titan key contexts: defaults unique within each context', () => {
  const b = defaultKeybindings();
  const unique = actions => new Set(actions.map(a => b[a]?.[0])).size === actions.length && actions.every(a => b[a]?.length);
  assert.ok(unique(['pilotTactical', 'callTitan']));
  assert.ok(unique(controllerMod.TITAN_KEY_ACTIONS));
  assert.deepEqual([b.pilotTactical[0], b.callTitan[0], b.titanDash[0], b.titanEject[0], b.titanCore[0]], ['KeyQ', 'KeyE', 'Space', 'KeyX', 'KeyV']);
  assert.deepEqual(keybindings.normalizeKeybindings({ titanDash: ['KeyZ'], bogus: ['KeyY'] }).titanDash, ['KeyZ']);
});
check('keys: titanfall keys yield to the gameplay keys live at the same time (pilot: all but lean; titan: walker keys)', () => {
  // A save from before titanfall: lean moved off Q/E, grenade on Q, interact on E.
  const n = keybindings.normalizeKeybindings({ leanLeft: [], leanRight: [], grenade: ['KeyQ'], interact: ['KeyE'] });
  assert.deepEqual([n.grenade, n.interact, n.pilotTactical, n.callTitan, n.titanTactical], [['KeyQ'], ['KeyE'], [], [], []]);
  assert.deepEqual(keybindings.normalizeKeybindings(null), defaultKeybindings(), 'the defaults never clash');
  assert.deepEqual([keybindings.normalizeKeybindings({ pilotTactical: ['KeyG'] }).grenade, keybindings.normalizeKeybindings({ titanCore: ['KeyR'] }).reload], [['KeyG'], ['KeyR']], 'a titanfall key never takes another mode\'s key');
  keybindings.resetKeybindings();
  assert.equal(keybindings.setKeybinding('pilotTactical', 'KeyR').conflict, 'reload');
  assert.equal(keybindings.setKeybinding('titanTactical', 'KeyT').conflict, 'interact');
  assert.equal(keybindings.setKeybinding('titanDefensive', 'Digit1').conflict, 'slot1');
  assert.equal(keybindings.setKeybinding('titanDash', 'KeyW').conflict, 'forward');
  assert.equal(keybindings.setKeybinding('leanLeft', null).ok, true);
  // Other modes' rebinding is never blocked by a titanfall key (R1): the titanfall action yields and is left unbound.
  assert.equal(keybindings.setKeybinding('grenade', 'KeyQ').ok, true, 'grenade takes Q from the pilot tactical');
  assert.deepEqual([keybindings.readKeybindings().grenade, keybindings.readKeybindings().pilotTactical], [['KeyQ'], []]);
  assert.equal(keybindings.setKeybinding('leanRight', null).ok && keybindings.setKeybinding('interact', 'KeyE').ok, true, 'interact on E');
  assert.deepEqual(keybindings.readKeybindings().callTitan, [], 'call titan yields E');
  assert.equal(keybindings.setKeybinding('quickMelee', null).ok && keybindings.setKeybinding('prone', null).ok, true);
  assert.equal(keybindings.setKeybinding('reload', 'KeyV').ok && keybindings.setKeybinding('slot1', 'KeyX').ok, true, 'reload on V, slot1 on X');
  assert.deepEqual([keybindings.readKeybindings().titanCore, keybindings.readKeybindings().titanEject], [[], []]);
  assert.equal(keybindings.setKeybinding('pilotTactical', 'KeyQ').conflict, 'grenade', 'binding a titanfall key still reports the clash');
  assert.equal(keybindings.setKeybinding('titanSmoke', 'KeyZ').ok, true, 'a key no seat uses stays free');
  keybindings.resetKeybindings();
});
check('pilot tactical chip: the equipped kit, not the selection', () => {
  const L = state.equippedTacticalLatch, F = contract.TITANFALL_PLAYER_FLAGS;
  // tacKind null: a frame without the equipped index (the HUD then latches from the rows).
  const frame = { ...contract.decodeTitanfallSelf(contract.encodeTitanfallSelf({ tacCharges: 1, tacReady: 1 })), tacKind: null };
  const stim = pilotRow({ loadout: { tactical: 'stim' } });
  let latch = L(null, { selfRow: stim, tfs: frame });
  assert.equal(latch.id, 'grapple', 'the first life runs the default kit');
  const pilot = fixtures.find(f => f.id === 'pilot');
  assert.equal(modelOf(pilot, { selfRow: stim, tfs: frame, local: { equippedTactical: latch.id } }).pilot.tactical.id, 'grapple');
  latch = L(latch, { selfRow: pilotRow({ state: 'dead', loadout: { tactical: 'stim' } }), tfs: frame });
  latch = L(latch, { selfRow: stim, tfs: frame });
  assert.equal(latch.id, 'stim', 'a respawn equips the selection');
  latch = L(latch, { selfRow: pilotRow({ loadout: { tactical: 'cloak' } }), tfs: frame });
  assert.equal(latch.id, 'stim', 'a pick while alive waits for the next deploy');
  assert.equal(L(latch, { selfRow: pilotRow({ loadout: { tactical: 'cloak' }, tf: { flags: F.grappling } }), tfs: frame }).id, 'grapple', 'an active grapple names the kit');
  assert.equal(L(latch, { selfRow: stim, tfs: { ...frame, tacCharges: 2 } }).id, 'grapple', 'two charges are a grapple');
  assert.equal(L(latch, { selfRow: stim, tfs: { ...frame, tacKind: 'cloak' } }).id, 'cloak', 'an equipped index on the wire wins');
  assert.equal(state.tacticalModel(contract.decodeTitanfallPlayer(stim), frame).id, 'grapple', 'without a latch only the default kit is trusted');
  assert.match(state.loadoutModel(0, { dead: false }).subtitle, /NEXT DEPLOY/);
});
check('rodeo: no rip prompt on a doomed hull; insert only within the server reach', () => {
  const rip = fixtures.find(f => f.id === 'rodeo-rip');
  const live = rip.snapshot.vehicles[0], doomed = { ...live, tw: [...live.tw] };
  doomed.tw[3] = 40;
  assert.equal(modelOf(rip, { local: {} }).pilot.rodeo.kind, 'rip');
  const prompt = modelOf(rip, { local: {}, snapshot: { ...rip.snapshot, vehicles: [doomed] } }).pilot.rodeo;
  assert.equal(prompt.kind, 'riding'); assert.equal(prompt.label, 'TITAN DOOMED');
  assert.equal(modelOf(rip, { snapshot: { ...rip.snapshot, vehicles: [doomed] } }).pilot.rodeo.label, 'TITAN DOOMED', 'no rip progress on a doomed hull');
  const friend = titanRow({ id: 'T2', owner: 'mate', shield: 0 }), reach = 2.2;
  let near = 0, far = 0;
  for (let dx = -5; dx <= 5; dx += 0.25) for (let dz = -5; dz <= 5; dz += 0.25) for (const dy of [0, 1.5, 3]) {
    const self = pilotRow({ x: friend.x + dx, y: friend.y + dy, z: friend.z + dz, tf: { flags: contract.TITANFALL_PLAYER_FLAGS.battery } });
    const r = state.rodeoPrompt({ self, tf: contract.decodeTitanfallPlayer(self), vehicles: [friend], now: FIXTURE_NOW, keys: {} });
    if (r?.kind !== 'insert') continue;
    const d = insertDistance(self, friend);   // the server's insert reach (the ground behind the hull counts)
    if (r.inReach) { near++; assert.equal(r.label, 'INSERT BATTERY'); assert.ok(d <= reach + 1e-9, `insert offered at ${d}`); }
    else { far++; assert.equal(r.label, 'MOVE CLOSER'); assert.ok(d > reach - 1e-9); }
  }
  assert.ok(near > 0 && far > 0, `${near} near, ${far} far`);
});
check('rodeo: RODEO when a jump would mount (rodeo.js contact rule), never at the front or onto a ridden hull', () => {
  // Enemy Atlas at (304, 40, 300), yaw 0: the rear is +Z, the cockpit -Z.
  const enemy = titanRow({ id: 'T5', team: 'bravo', owner: 'bot-1' });
  const self = pilotRow({ x: enemy.x, y: enemy.y, z: enemy.z + 4.5 });
  const tf = contract.decodeTitanfallPlayer(self), keys = { interact: 'T', jump: 'SPACE' };
  const prompt = (body, vehicles = [enemy], titanVel = {}) => state.rodeoPrompt({ self, tf, vehicles, now: FIXTURE_NOW, keys, local: { body, titanVel } });
  const at = (dz, extra = {}) => ({ x: enemy.x, y: enemy.y, z: enemy.z + dz, vx: 0, vy: 0, vz: 0, grounded: true, jumpsLeft: 1, ...extra });
  assert.equal(prompt(at(4.5)), null, 'standing 3.4 m behind: a jump does not reach');
  assert.equal(prompt(at(6.5, { vz: -8.5 }), [enemy], { T5: [0, 0] })?.kind, 'mount', 'sprinting 5.4 m behind a parked hull: a jump reaches');
  const run = prompt(at(6.5, { vz: -8.5 }));
  assert.equal(run?.kind, 'mount'); assert.equal(run.label, 'RODEO'); assert.equal(run.key, 'SPACE'); assert.equal(run.inReach, false);
  assert.equal(prompt(at(6.5, { vz: -8.5 }), [enemy], { T5: [0, -4.6] }), null, 'a titan walking away at 4.6 m/s keeps out of that arc');
  assert.equal(prompt(at(2.4))?.inReach, true, 'in contact behind: inReach (T works too)');
  assert.equal(prompt(at(-4, { vz: 8.5 })), null, 'never a rodeo from the front');
  const ridden = titanRow({ id: 'T5', team: 'bravo', owner: 'bot-1', bits: contract.TITAN_ABILITY_BITS.rider });
  assert.ok(contract.decodeTitanRow(ridden).rider);
  assert.equal(prompt(at(2.4), [ridden]), null, 'a ridden hull offers no rodeo');
  const falling = prompt(at(2.4, { grounded: false, y: enemy.y + 3, vy: -2 }));
  assert.equal(falling?.inReach, true, 'airborne in contact');
  const model = { layout: 'pilot', pilot: { rodeo: run, meter: { state: 'charging', prompt: null }, tactical: { state: 'ready', label: 'GRAPPLE' } } };
  assert.notEqual(state.titanfallTouchModel(model).context, 'RODEO', 'the touch RODEO chip waits for contact');
  assert.equal(state.titanfallTouchModel({ ...model, pilot: { ...model.pilot, rodeo: falling } }).context, 'RODEO');
});
const { WeaponState } = await import('../public/js/guns/weapon-state.js');
for (const kit of [{ primary: 'kraber', at: 'mgl' }, { primary: 'kraber', at: 'archer' }, { primary: 'rifle', at: 'mgl' }]) {
  check(`digits ${kit.primary}/${kit.at}`, () => {
    const owned = titanfallOwned(contract.packTitanLoadout(kit));
    // WP0 stand-ins while WP4's ids are absent: kraber -> sniper, AT -> rocket.
    const primary = WEAPON_IDS.includes(kit.primary) ? kit.primary : 'sniper', at = WEAPON_IDS.includes(kit.at) ? kit.at : 'rocket';
    const expected = [primary, 'revolver', at, 'knife'];
    assert.deepEqual([0, 1, 2, 3].map(i => state.titanfallDigitWeapon(owned, i)), expected);
    const ws = { _mode: 'titanfall', _owned: owned };
    assert.deepEqual([0, 1, 2, 3].map(i => WEAPON_IDS[WeaponState.prototype._directSlot.call(ws, i)]), expected);
    assert.equal(WeaponState.prototype._directSlot.call(ws, 4), null);
  });
}
const { WeaponWheelController } = await import('../public/js/session/weapon-wheel-controller.js');
check('wheel: titanfall kit roles with an AT label; suppressed while seated', () => {
  const owned = titanfallOwned(contract.packTitanLoadout({ primary: 'kraber', at: 'archer' }));
  const context = { match: { mode: 'titanfall' }, self: { owned, state: 'alive', vehicleId: null }, enabled: true, alive: true, spectating: false,
    weapon: { slot: WEAPON_IDS.indexOf(owned[0]), ammoOf: () => ({ mag: 1, reserve: 1 }) } };
  const wheel = new WeaponWheelController({ input: { setWeaponWheelOpen() {}, isWeaponWheelClosing: () => false },
    hud: { isBuyMenuOpen: () => false, settingsOpen: false, setWeaponWheelState() {} }, getContext: () => context });
  const entries = wheel.entries();
  assert.deepEqual(entries.map(e => e.role), ['PRIMARY', 'AT', 'SIDEARM', 'MELEE']);
  assert.deepEqual([0, 1, 2, 3].map(d => entries[wheel.directIndex(d, entries)]?.id), [owned[0], 'revolver', owned[2], 'knife']);
});

// ---- loadout --------------------------------------------------------------------------------------------
check('loadout pack, storage (try/catch) and the loadout model', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const packed = contract.packTitanLoadout({ primary: 'lmg', at: 'thunderbolt', tactical: 'cloak', titan: 'titan_ronin' });
  assert.equal(loadoutMod.readStoredLoadout(storage), null);
  assert.equal(loadoutMod.writeStoredLoadout(packed, storage), true);
  assert.equal(loadoutMod.readStoredLoadout(storage), packed);
  store.set(loadoutMod.LOADOUT_STORAGE_KEY, '{garbage');
  assert.equal(loadoutMod.readStoredLoadout(storage), null);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadoutMod.readStoredLoadout(throwing), null);
  assert.equal(loadoutMod.writeStoredLoadout(packed, throwing), false);
  const m = state.loadoutModel(packed, { team: 'bravo', dead: true, respawnIn: 2.5 });
  assert.equal(m.subtitle, 'IMC · ATTRITION'); assert.equal(m.deployLabel, 'DEPLOY · 2.5');
  assert.deepEqual([m.primary.length, m.at.length, m.tactical.length, m.titans.length], [5, 4, 3, 5]);
  assert.equal(m.titans.find(t => t.selected).type, 'titan_ronin');
  assert.equal(state.titanCard('titan_ion').frame, 'ATLAS · BALANCED FRAME');
  assert.equal(state.titanCard('titan_northstar').kit[0], 'PLASMA RAILGUN');
});
check('final fixer: auto-deploy countdown, OOB seconds, shared short names, score limit, cloak hint', () => {
  // §3.4: RESPAWN IN while the timer runs, then the idle fallback counts down (no frozen 0.0 chip).
  const running = state.loadoutModel(0, { dead: true, respawnIn: 2.5, autoDeployIn: 22.5 });
  assert.equal(running.respawn, 2.5); assert.equal(running.autoDeploy, null);
  const idle = state.loadoutModel(0, { dead: true, respawnIn: 0, autoDeployIn: 18.2 });
  assert.equal(idle.respawn, null); assert.equal(idle.autoDeploy, 19); assert.equal(idle.deployLabel, 'DEPLOY');
  const screen = new loadoutMod.TitanLoadout(document.body, {});
  screen.open({ team: 'alpha', dead: true, respawnIn: 0, autoDeployIn: 14.1 });
  assert.equal(screen.respawn.hidden, false);
  assert.equal(screen.respawnLabel.textContent, 'AUTO-DEPLOY IN'); assert.equal(screen.respawnValue.textContent, '15 S');
  screen.update({ respawnIn: 1.2 });
  assert.equal(screen.respawnLabel.textContent, 'RESPAWN IN'); assert.equal(screen.respawnValue.textContent, '1.2');
  screen.dispose();
  // The dead model carries the fallback deadline from the row's respawnAt.
  const deadFixture = fixtures.find(f => f.id === 'dead');
  const waiting = pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW + 3000, tf: { meter: 0.4, flags: contract.TITANFALL_PLAYER_FLAGS.deploy } });
  const dead = state.titanHudModel({ snapshot: { ...deadFixture.snapshot, players: [waiting] }, selfRow: waiting, tfs: null, now: FIXTURE_NOW });
  assert.equal(dead.respawnIn, 3);
  assert.equal(dead.autoDeployIn, 3 + contract.TITANFALL_DEPLOY_TIMEOUT_MS / 1000);
  assert.equal(modelOf(deadFixture).autoDeployIn, null, 'not waiting for DEPLOY: no fallback countdown');
  // OOB: the banner counts down from the oob_warning deadline.
  const oobFixture = fixtures.find(f => f.id === 'oob');
  const oob = state.titanHudModel({ snapshot: oobFixture.snapshot, selfRow: oobFixture.self, tfs: contract.decodeTitanfallSelf(oobFixture.tfs),
    now: FIXTURE_NOW, local: { ...oobFixture.local, oobUntil: FIXTURE_NOW + 2100 } }).oob;
  assert.deepEqual(modelOf(oobFixture).oob, { label: 'RETURN TO THE BATTLEFIELD', seconds: null }, 'no deadline: no seconds');
  assert.deepEqual(oob, { label: 'RETURN TO THE BATTLEFIELD · 3 S', seconds: 3 });
  // One short name per ability, shared by touch faces and cockpit MFD tiles.
  for (const abilities of Object.values(contract.TITAN_ABILITIES)) {
    for (const slot of ['defensive', 'tactical', 'ordnance', 'core']) {
      const label = abilities[slot].label;
      assert.ok(state.TITAN_ABILITY_SHORT[label], `${label}: short name`);
      assert.ok(state.touchLabel(label).length <= 8, `${label}: fits a touch face`);
    }
  }
  assert.equal(state.touchLabel('LASER SHOT'), 'SHOT'); assert.equal(state.touchLabel('INCENDIARY TRAP'), 'TRAP');
  assert.equal(state.TITANFALL_SCORE_LIMIT, 750);
  assert.match(state.TITANFALL_TACTICAL_HINTS.cloak, /12 M/);
});
check('loadout screen: picks repaint and report the packed value', () => {
  const changes = [];
  const screen = new loadoutMod.TitanLoadout(document.body, { onChange: p => changes.push(p) });
  screen.open({ team: 'alpha', dead: true, respawnIn: 3 });
  assert.equal(screen.isOpen, true);
  assert.equal(screen.select('titan', 'titan_scorch'), true);
  assert.equal(contract.unpackTitanLoadout(changes.at(-1)).titan, 'titan_scorch');
  const card = screen.root.querySelector('.tf-lo-card.is-selected');
  assert.equal(card.dataset.pick, 'titan_scorch');
  assert.equal(screen.root.querySelector('.tf-lo-kit-head b').textContent, 'SCORCH');
  screen.dispose();
  assert.equal(document.querySelector('.tf-loadout'), null);
});
check('loadout screen: a click right after it opens (death under the crosshair) picks nothing (playtest)', () => {
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    const changes = [];
    const screen = new loadoutMod.TitanLoadout(document.body, { onChange: p => changes.push(p) });
    screen.open({ team: 'alpha', dead: true, respawnIn: 3 });
    const card = [...screen.root.querySelectorAll('[data-pick]')].find(node => node.dataset.pick === 'titan_legion');
    screen.root.dispatchEvent({ type: 'click', target: card });
    assert.equal(changes.length, 0, 'no pick inside the arm window');
    t += loadoutMod.LOADOUT_PICK_GUARD.armMs + 1;
    screen.root.dispatchEvent({ type: 'click', target: card });
    assert.equal(contract.unpackTitanLoadout(changes.at(-1)).titan, 'titan_legion', 'a later click picks');
    screen.close();
    // Fire held through the death: presses inside the arm window, then the same spot keeps clicking.
    screen.open({ team: 'alpha', dead: true, respawnIn: 3 });
    const ion = [...screen.root.querySelectorAll('[data-pick]')].find(node => node.dataset.pick === 'titan_ion');
    const press = (x, y) => screen.root.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', clientX: x, clientY: y, target: ion });
    const click = () => screen.root.dispatchEvent({ type: 'click', isTrusted: true, detail: 1, target: ion });
    const n = changes.length;
    press(640, 360); click();
    t += loadoutMod.LOADOUT_PICK_GUARD.armMs + 200;
    press(640, 360); click();
    assert.equal(changes.length, n, 'a mouse still clicking from the fight picks nothing until it moves');
    screen.root.dispatchEvent({ type: 'pointermove', pointerType: 'mouse', clientX: 660, clientY: 372, target: ion });
    press(660, 372); click();
    assert.equal(contract.unpackTitanLoadout(changes.at(-1)).titan, 'titan_ion', 'after a move the pick counts');
    screen.dispose();
  } finally { Date.now = realNow; }
});
check('pilot meter: a full bay names the count and when it frees (playtest)', () => {
  const m = state.titanMeterModel({ tf: { meter: 1 }, match: { titanfall: { bay: [4, 2, 4] } }, team: 'alpha' });
  assert.equal(m.state, 'bay');
  assert.equal(m.label, 'BAY FULL 4/4 · NEXT TITAN DOWN');
  assert.equal(m.prompt, null);
});
check('embark animation: no pilot readouts (layout embark, playtest)', () => {
  const f = fixtures.find(item => item.id === 'embark');
  const self = { ...f.self, tf: [...f.self.tf] };
  self.tf[0] = contract.TITAN_MV.embarking;
  const m = state.titanHudModel({ snapshot: f.snapshot, selfRow: self, tfs: contract.decodeTitanfallSelf(f.tfs), now: FIXTURE_NOW, keys: {}, local: f.local });
  assert.equal(m.layout, 'embark');
  assert.equal(m.pilot, undefined);
});

// ---- announcer ------------------------------------------------------------------------------------------
check('announcer: 13 cues with files, event and state mapping, repeat gaps', () => {
  assert.equal(Object.keys(TITANFALL_CUES).length, 13);
  for (const cue of Object.keys(TITANFALL_CUES)) { assert.ok(titanfallCueUrl(cue).endsWith(`/titanfall/${cue}.wav`)); assert.ok(announcerCueInfo(cue)); }
  const ctx = { selfId: 'me', selfTeam: 'alpha', ownTitanId: 'T1', teamOf: id => (id === 'bot-3' ? 'bravo' : 'alpha') };
  const E = announcerMod.titanfallEventCue;
  assert.equal(E({ kind: 'titanfall_drop', owner: 'me' }, ctx), 'prepare_titanfall');
  assert.equal(E({ kind: 'titanfall_drop', owner: 'bot-3' }, ctx), 'enemy_titan');
  assert.equal(E({ kind: 'titanfall_drop', owner: 'mate' }, ctx), null);
  assert.equal(E({ kind: 'core_ready', vehicleId: 'T1' }, ctx), 'core_online');
  assert.equal(E({ kind: 'titan_doomed', vehicleId: 'T1' }, ctx), 'titan_doomed');
  assert.equal(E({ kind: 'rodeo_mount', vehicleId: 'T1', id: 'bot-3' }, ctx), 'rodeo_warning');
  assert.equal(E({ kind: 'rodeo_rip', id: 'me' }, ctx), 'battery_acquired');
  const pilot = modelOf(fixtures.find(f => f.id === 'pilot')), ready = modelOf(fixtures.find(f => f.id === 'pilot-ready'));
  assert.deepEqual(announcerMod.titanfallStateCues(pilot, ready), ['titanfall_ready']);
  // A full bay freeing up (bay -> ready) calls it too.
  const bay = modelOf(fixtures.find(f => f.id === 'bay-full'));
  assert.equal(bay.pilot.meter.state, 'bay');
  assert.deepEqual(announcerMod.titanfallStateCues(bay, ready), ['titanfall_ready']);
  assert.deepEqual(announcerMod.titanfallStateCues(null, {}, { winner: 'alpha', selfTeam: 'alpha' }), ['match_win']);
  let t = 0;
  const played = [];
  const voice = announcerMod.createTitanfallAnnouncer({ audio: { engine: null, announcer: { play: cue => { played.push(cue); return true; } } }, now: () => t });
  assert.equal(voice.play('enemy_titan'), true); t += 5000;
  assert.equal(voice.play('enemy_titan'), false); t += 20000;
  assert.equal(voice.play('enemy_titan'), true);
  assert.equal(voice.play('not_a_cue'), false);
  assert.deepEqual(played, ['enemy_titan', 'enemy_titan']);
});

// ---- touch ------------------------------------------------------------------------------------------------
check('touch: at most 31 unique actions; titanfall buttons by layout', () => {
  const { TOUCH_ACTIONS, visibleTouchActions, TITANFALL_TOUCH_ACTIONS } = touchMod;
  assert.ok(TOUCH_ACTIONS.length <= 31); assert.equal(new Set(TOUCH_ACTIONS).size, TOUCH_ACTIONS.length);
  for (const action of TITANFALL_TOUCH_ACTIONS) assert.ok(TOUCH_ACTIONS.includes(action));
  const foot = { alive: true, canFire: true, weaponCount: 4 };
  assert.ok(!visibleTouchActions(foot).has('pilotTactical'), 'no titanfall buttons outside titanfall');
  const pilot = visibleTouchActions({ ...foot, titanfall: { layout: 'pilot', context: 'TITAN' } });
  assert.ok(pilot.has('pilotTactical') && pilot.has('callTitan') && pilot.has('fire') && !pilot.has('titanDash'));
  assert.ok(!visibleTouchActions({ ...foot, titanfall: { layout: 'pilot', context: null } }).has('callTitan'));
  const seat = { ...foot, vehicleSeated: true, vehicleType: 'titan_ion', vehicleCanDrive: true, vehicleCanFire: true };
  const titan = visibleTouchActions({ ...seat, titanfall: { layout: 'titan', doomed: false } });
  assert.deepEqual([...titan].sort(), ['fire', 'titanCore', 'titanDash', 'titanDefensive', 'titanOrdnance', 'titanSmoke', 'titanTactical']);
  assert.ok(visibleTouchActions({ ...seat, titanfall: { layout: 'titan', doomed: true } }).has('titanEject'));
});

// ---- titan-ui: intents, send order, titanHold, dispose ----------------------------------------------------------
await acheck('announcer: a call made while the WAVs decode is spoken once they are, and only spoken calls count', async () => {
  let t = 0, open;
  const gate = new Promise(resolve => { open = resolve; });
  const buffers = new Map(), started = [];
  const audio = { engine: { ctx: { decodeAudioData: async data => ({ data }) } },
    announcer: { registerBuffer: (cue, buffer) => { buffers.set(cue, buffer); return true; }, play: cue => buffers.has(cue) && started.push(cue) > 0 } };
  const voice = announcerMod.createTitanfallAnnouncer({ audio, now: () => t,
    fetchImpl: () => gate.then(() => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })) });
  assert.equal(voice.play('enemy_titan'), false, 'no buffer yet');
  assert.deepEqual(voice.played, [], 'an unspoken call is not logged');
  t += 400; open(); await voice.load();
  assert.deepEqual(started, ['enemy_titan'], 'spoken once decoded');
  assert.deepEqual(voice.played, ['enemy_titan']);
  t += 1000;
  assert.equal(voice.play('enemy_titan'), false, 'the gap runs from the spoken call');
  assert.equal(voice.play('titanfall_ready'), true);
});
await acheck('titan-ui: pilot keys, titan keys, dash send order, eject triple-tap, titanHold and dispose', async () => {
  const pilotF = fixtures.find(f => f.id === 'pilot-ready'), titanF = fixtures.find(f => f.id === 'titan-doomed');
  let current = pilotF;
  const sent = [];
  const net = { sendTitanfall: fields => { sent.push(['tf', fields]); return true; }, sendInput: msg => { sent.push(['input', msg]); return true; },
    on: () => () => {} };
  const vc = {
    active: false, titan: false, seatId: null, vehicle: null, walker: null, yaw: 0, pitch: 0, opticHeld: false, interactClaim: null,
    holdInteract: () => 0, cycleView() { this.views = (this.views ?? 0) + 1; },
  };
  const blocks = [], focus = [];
  const app = { myId: 'me', net, vehicleController: vc, input: { exit() {}, requestLock() {}, wantFireHeld: false },
    session: { gameplayInputEnabled: true, setOverlayBlock: (k, on) => blocks.push([k, on]), restoreGameplayFocus: () => focus.push(1) },
    weapon: { slot: 0 }, matchState: { phase: 'live' } };
  // §3.4 deploy: the join arrives held off the field (dead, tf deploy + staged) until DEPLOY.
  const DF = contract.TITANFALL_PLAYER_FLAGS;
  const staged = { ...pilotF, self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW - 50, tf: { flags: DF.deploy | DF.staged } }) };
  current = staged;
  const client = { snapshot: () => current.snapshot, selfRow: () => current.self, selfTf: () => contract.decodeTitanfallPlayer(current.self),
    selfFrame: () => contract.decodeTitanfallSelf(current.tfs) };
  const baseline = ['keydown', 'keyup', 'blur', touchMod.TITANFALL_TOUCH_EVENT].map(type => window.listenerCount(type));
  ui.init(app, client);
  ui.tick(current.snapshot, 0);
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(document.body.dataset.titanfall, 'dead');
  assert.ok(document.querySelector('#titanfall-hud'), 'HUD mounted');
  assert.equal(ui.debugState().loadoutOpen, true, 'deploy: the loadout opens before the first spawn');
  assert.deepEqual(blocks.at(-1), ['titanLoadout', true], 'deploy: the screen takes the cursor');
  // No respawn timer before the first spawn: the chip shows the server's idle fallback instead (§3.4).
  assert.equal(document.querySelector('.tf-lo-respawn').hidden, false, 'deploy: the auto-deploy chip shows at join');
  assert.equal(document.querySelector('.tf-lo-respawn span').textContent, 'AUTO-DEPLOY IN', 'deploy: no respawn countdown before the first spawn');
  assert.match(document.querySelector('.tf-lo-respawn b').textContent, /^(19|20) S$/, 'deploy: idle fallback seconds');
  assert.equal(document.querySelector('.tf-lo-deploy').textContent, 'DEPLOY', 'deploy: DEPLOY ready at once');
  const key = (code, type = 'keydown') => {
    const event = { type, code, repeat: false, target: window, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    window.dispatchEvent(event);
    return event;
  };
  // Loadout open: pilot keys stay free.
  assert.equal(key('KeyE').defaultPrevented, false);
  // The fake DOM does not bubble: deliver the click to the screen's delegated listener.
  sent.length = 0;
  document.querySelector('.tf-loadout').dispatchEvent({ type: 'click', target: document.querySelector('.tf-lo-deploy') });
  assert.equal(ui.debugState().loadoutOpen, false);
  const pickPacked = contract.decodeTitanfallPlayer(staged.self).loadoutPacked;
  assert.deepEqual(sent.map(s => s[1]), [{ deploy: ui.debugState().sent.at(-1).value }], 'deploy: DEPLOY sends the deploy intent with the pick');
  assert.ok(Number.isInteger(sent[0][1].deploy) && pickPacked >= 0, 'deploy: packed loadout');
  assert.deepEqual(blocks.at(-1), ['titanLoadout', false], 'deploy: the cursor goes back');
  assert.equal(focus.length, 1, 'deploy: focus (pointer lock) restored inside the click');
  // Until the server acknowledges (deployQueued) or spawns, the screen stays shut.
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(ui.debugState().loadoutOpen, false, 'deploy: no reopen while the request is in flight');
  current = pilotF;
  ui.tick(current.snapshot, 0);
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(ui.debugState().loadoutOpen, false, 'deploy: spawned, the screen stays closed');
  sent.length = 0;
  assert.equal(key('KeyE').defaultPrevented, true, 'E consumed in the pilot context');
  assert.equal(key('KeyQ').defaultPrevented, true, 'Q consumed (no lean)');
  assert.deepEqual(sent.map(s => s[1]), [{ call: 1 }, { tac: 1 }]);
  // A refusal toast does not outlive the accepted re-call (final fixer).
  ui.onEvent({ kind: 'titanfall_refused', owner: 'me', reason: 'sky' });
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(ui.debugState().model.toast, 'NO SKY ABOVE · MOVE INTO THE OPEN');
  ui.onEvent({ kind: 'titanfall_drop', owner: 'bot-3' });
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(ui.debugState().model.toast, 'NO SKY ABOVE · MOVE INTO THE OPEN', 'another pilot\'s drop keeps it');
  ui.onEvent({ kind: 'titanfall_drop', owner: 'me' });
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(ui.debugState().model.toast, null, 'the own accepted drop clears it');
  // Touch EMBARK: holding the context chip for TITAN_RULES.embark.holdMs queues the enter for the own titan, once.
  const embarkF = fixtures.find(f => f.id === 'embark');
  current = embarkF;
  const queued = [];
  Object.assign(vc, { nearest: embarkF.snapshot.vehicles[0], queueInteract: () => { queued.push(vc.active ? 'exit' : 'enter'); return true; } });
  ui.tick(current.snapshot, 0);
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  const touch = (action, down) => window.dispatchEvent({ type: touchMod.TITANFALL_TOUCH_EVENT, detail: { action, down } });
  touch('callTitan', true);
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(queued.length, 0, 'no enter before the hold completes');
  assert.ok(ui.debugState().model.pilot.meter.prompt.progress < 1);
  for (const until = Date.now() + 320; Date.now() < until;) { /* hold */ }
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.deepEqual(queued, ['enter'], 'one enter after the hold');
  touch('callTitan', false);
  // Touch EXIT: seated in a live titan, a tap on the context chip disembarks.
  const titanLive = fixtures.find(f => f.id === 'titan');
  current = titanLive;
  Object.assign(vc, { active: true, titan: true, seatId: 'driver', vehicle: titanLive.snapshot.vehicles[0], nearest: null });
  ui.tick(current.snapshot, 0);
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  touch('callTitan', true); touch('callTitan', false);
  assert.deepEqual(queued, ['enter', 'exit'], 'EXIT tap queues the exit');
  // Seat the pilot in the doomed titan.
  current = titanF;
  Object.assign(vc, { active: true, titan: true, seatId: 'driver', vehicle: titanF.snapshot.vehicles[0],
    walker: { fwd: 1, side: -1, aimYaw: 0.5, aimPitch: 0.1, sprint: true, reload: false } });
  ui.tick(current.snapshot, 0);
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(document.body.dataset.titanfall, 'titan');
  // Diegetic cockpit HUD (titan-cockpit-hud.js): the DOM titan HUD hides only while the cockpit glass draws for the own titan
  // in the first-person view; chase, sight, another hull and dispose bring it back.
  {
    const cockpitShown = () => 'titanfallCockpit' in document.body.dataset;
    const ownTitan = String(contract.decodeTitanfallPlayer(current.self).titanId);
    const glassAt = (x = 0) => { const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 400); camera.position.set(x, 0, 0); camera.updateMatrixWorld(true); return camera; };
    const hud = cockpitHud.createCockpitHud({ type: titanF.snapshot.vehicles[0].type, group: new THREE.Group(), eye: [0, 0, 0], eyeTolerance: 0.5 });
    const renderer = { getRenderTarget: () => null, getDrawingBufferSize: v => v.set(1920, 1080) };
    assert.equal(cockpitShown(), false, 'cockpit: no first-person view, DOM HUD shown');
    app.vehicleView = { localView: { id: ownTitan, sight: false } };
    cockpitHud.resetCockpitHud();
    ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
    assert.equal(cockpitShown(), false, 'cockpit: first person, glass not drawn yet, DOM HUD kept');
    hud.glass.onBeforeRender(renderer, null, glassAt());
    ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
    assert.equal(cockpitShown(), true, 'cockpit: glass drawing, DOM titan HUD hidden');
    // The cockpit draws the model titan-ui computed (same object), with its rebinding-aware keys.
    hud.update(null, 1, null);
    assert.equal(hud.debug().view.titan, ui.debugState().model.titan, 'cockpit: the published HUD model');
    assert.equal(hud.debug().view.top, ui.debugState().model.top, 'cockpit: the published score bar');
    assert.equal(cockpitHud.cockpitHudKeys().titanEject, ui.debugState().model.titan.eject.key, 'cockpit: the published key labels');
    for (const [view, label] of [[{ id: ownTitan, sight: true }, 'sight'], [null, 'chase / on foot'], [{ id: 'not-mine', sight: false }, 'another hull']]) {
      app.vehicleView.localView = view;
      ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
      assert.equal(cockpitShown(), false, `cockpit: ${label}, DOM HUD back`);
    }
    app.vehicleView.localView = { id: ownTitan, sight: false };
    ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
    assert.equal(cockpitShown(), true, 'cockpit: back in first person');
    hud.glass.onBeforeRender(renderer, null, glassAt(5));
    cockpitHud.resetCockpitHud();
    ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
    assert.equal(cockpitShown(), false, 'cockpit: glass stopped drawing (camera away from the seat), DOM HUD back');
    hud.glass.onBeforeRender(renderer, null, glassAt());
    ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
    assert.equal(cockpitShown(), true);
    hud.dispose();
    // CSS: only the cockpit flag hides the titan HUD and the stock crosshair / hit marker / feed / badge.
    const css = fs.readFileSync(new URL('../public/styles/titanfall.css', import.meta.url), 'utf8');
    assert.match(css, /body\[data-titanfall-cockpit\] \.tf-hud :is\(\.tf-titan,\s*\.tf-top,\s*\.tf-banner\)\s*\{\s*display:\s*none\s*!important/);
    assert.match(css, /body\[data-titanfall-cockpit\] :is\(#crosshair,\s*#hitmarker,\s*#killfeed,\s*\.vb-career-badge\)\s*\{\s*visibility:\s*hidden\s*!important/);
    assert.ok(!/data-titanfall-cockpit[^{]*(\.tf-touch|#touch|\.tf-scoreboard|#escape|#settings)/.test(css), 'cockpit: touch, escape, settings and scoreboard stay DOM');
  }
  sent.length = 0;
  assert.equal(key('Space').defaultPrevented, true);
  assert.equal(sent[0][0], 'input', 'seated input goes out before the dash intent');
  assert.deepEqual([sent[0][1].vehicleThrottle, sent[0][1].vehicleSteer, sent[0][1].yaw, sent[0][1].vehicleControlId], [1, -1, 0.5, 'T1']);
  assert.ok(app._vehicleSendAt > 0);
  assert.deepEqual(sent[1], ['tf', { ability: 'dash' }]);
  key('KeyQ');
  assert.equal(ui.titanHold() & (controllerMod.TITAN_HOLD.defensive | controllerMod.TITAN_HOLD.sprint), 3, 'defensive held + sprint');
  key('KeyQ', 'keyup');
  assert.equal(ui.titanHold() & controllerMod.TITAN_HOLD.defensive, 0);
  vc.walker = { ...vc.walker, reload: true };
  ui.frame(1 / 60, { nowMs: FIXTURE_NOW });
  assert.equal(ui.titanHold() & controllerMod.TITAN_HOLD.reload, 8, 'reload press rides the next send');
  assert.equal(ui.titanHold() & controllerMod.TITAN_HOLD.reload, 0, 'once');
  sent.length = 0;
  key('KeyX'); key('KeyX');
  assert.equal(sent.some(s => s[1].eject), false);
  key('KeyX');
  assert.deepEqual(sent.filter(s => s[1].eject).map(s => s[1]), [{ eject: 1 }], 'third tap ejects');
  key('KeyH');
  assert.equal(vc.views, 1, 'H cycles the titan view');
  // Touch: the defensive button holds like Q.
  window.dispatchEvent({ type: touchMod.TITANFALL_TOUCH_EVENT, detail: { action: 'titanDefensive', down: true } });
  assert.equal(ui.titanHold() & controllerMod.TITAN_HOLD.defensive, 2);
  window.dispatchEvent({ type: touchMod.TITANFALL_TOUCH_EVENT, detail: { action: 'titanDefensive', down: false } });
  assert.equal(vc.interactClaim != null, true);
  ui.dispose();
  assert.deepEqual(['keydown', 'keyup', 'blur', touchMod.TITANFALL_TOUCH_EVENT].map(type => window.listenerCount(type)), baseline, 'no titanfall listener left');
  assert.equal(vc.interactClaim, null);
  assert.equal(document.querySelector('#titanfall-hud'), null);
  assert.equal(document.body.dataset.titanfall, undefined);
  assert.equal(document.body.dataset.titanfallCockpit, undefined, 'dispose clears the cockpit flag');
  assert.equal(ui.titanHold(), 0);
  vc.active = false; current = pilotF;
  assert.equal(key('KeyQ').defaultPrevented, false, 'Q reaches Input again');
  const { Input } = await import('../public/js/engine/input.js');
  assert.equal(Input.prototype._keyboardAction.call({ _bindings: keybindings.readKeybindings() }, 'KeyQ'), 'leanLeft', 'Q resolves to lean');
});

await acheck('titan-ui: death opens the loadout with the countdown, early DEPLOY queues, match end closes it', async () => {
  const DF = contract.TITANFALL_PLAYER_FLAGS, base = fixtures.find(f => f.id === 'pilot-ready');
  const sent = [];
  const app = { myId: 'me', net: { sendTitanfall: fields => { sent.push(fields); return true; }, on: () => () => {} }, vehicleController: null,
    input: { exit() {}, requestLock() {} }, session: { gameplayInputEnabled: true, setOverlayBlock() {}, restoreGameplayFocus() {} }, matchState: { phase: 'live' } };
  let current = base;
  const client = { snapshot: () => current.snapshot, selfRow: () => current.self, selfTf: () => contract.decodeTitanfallPlayer(current.self),
    selfFrame: () => contract.decodeTitanfallSelf(current.tfs) };
  const step = () => { ui.tick(current.snapshot, 0); ui.frame(1 / 60, { nowMs: FIXTURE_NOW }); };
  ui.init(app, client);
  step();
  assert.equal(ui.debugState().loadoutOpen, false, 'alive: no loadout');
  const dead = flags => ({ ...base, self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW + 2500, tf: { flags } }) });
  current = dead(DF.deploy);
  step();
  assert.equal(ui.debugState().loadoutOpen, true, 'death: loadout open');
  assert.equal(document.querySelector('.tf-lo-respawn').hidden, false, 'death: countdown shown');
  assert.equal(document.querySelector('.tf-lo-deploy').textContent, 'DEPLOY · 2.5', 'death: DEPLOY shows the timer');
  document.querySelector('.tf-loadout').dispatchEvent({ type: 'click', target: document.querySelector('.tf-lo-deploy') });
  assert.ok(sent.some(f => Number.isInteger(f.deploy)), 'death: early DEPLOY sent (queued by the server)');
  assert.equal(ui.debugState().loadoutOpen, false, 'death: closed after DEPLOY');
  current = dead(DF.deploy | DF.deployQueued);
  step();
  assert.equal(ui.debugState().loadoutOpen, false, 'queued: stays closed');
  assert.equal(document.querySelector('.tf-dead span').textContent, 'DEPLOYING IN 2.5', 'queued: dead HUD counts down');
  current = base;
  step();
  current = { ...dead(DF.deploy), snapshot: { ...base.snapshot, match: { ...base.snapshot.match, phase: 'post' } } };
  step();
  assert.equal(ui.debugState().loadoutOpen, false, 'match end: no loadout over the results');
  ui.dispose();
});

dom.restore();
console.log(`Titanfall HUD state: ${checks.length} checks passed (model fixtures, keys, digits, wheel, loadout, deploy gate, announcer, touch, intents, dispose).`);
