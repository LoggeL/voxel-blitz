// Conquest number keys are kit-relative (Battlefield style): weapon slot key
// 1 raises the primary, 2 the IRONCLAD .44, 3 the Engineer's launcher (AT or
// STINGER; nothing for other kits), 4 the IRON PICK, and 5-0 do nothing. The
// mapping follows the snapshot's authoritative owned list, so it is right for
// every kit, variant, gadget and redeploy. Other modes keep the global
// WEAPON_IDS digits; seated, the slot keys keep picking seat weapons and F1-F5
// keep switching seats. The kit wheel shows the same 1-4 badges.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

installFakeDom({ width: 1440, height: 900 });
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };

const { WEAPON_IDS } = await import('../shared/combatmath.js');
const { KIT_IDS } = await import('../shared/conquest-contract.js');
const { KIT_DIGIT_ROLES, kitDigitWeapon, kitWeaponDigit, kitWeapons } = await import('../shared/conquest-kits.js');
const { WeaponState } = await import('../public/js/guns/weapon-state.js');
const { Input } = await import('../public/js/engine/input.js');
const { KEYBINDING_ACTIONS, setKeybinding, resetKeybindings, bindingLabel } = await import('../public/js/keybindings.js');
const { WeaponWheelController } = await import('../public/js/session/weapon-wheel-controller.js');
const { WeaponWheelController: WheelOverlay } = await import('../public/js/ui/weapon-wheel.js');
const { VehicleController } = await import('../public/js/session/vehicle-controller.js');
const { vehicleMountOrder } = await import('../shared/conquest-contract.js');

let checks = 0;
const check = (fn) => { fn(); checks++; };
const slotOf = id => WEAPON_IDS.indexOf(id);

/* ------------------------------------------------------------ shared mapping */

check(() => assert.deepEqual([...KIT_DIGIT_ROLES], ['primary', 'sidearm', 'gadget', 'melee']));
const loadouts = [];
for (const kit of KIT_IDS) for (const variant of [0, 1]) for (const gadget of kit === 'engineer' ? [0, 1] : [0]) {
  loadouts.push({ kit, variant, gadget, ...kitWeapons(kit, variant, gadget) });
}
for (const l of loadouts) {
  const name = `${l.kit} v${l.variant} g${l.gadget}`;
  // The snapshot may list owned weapons in any order.
  const owned = [...l.owned].reverse();
  check(() => assert.deepEqual([0, 1, 2, 3].map(i => kitDigitWeapon(owned, i)), [l.primary, 'revolver', l.gadget, 'knife'], name));
  check(() => assert.ok([4, 5, 6, 7, 8, 9, -1, 1.5, null].every(i => kitDigitWeapon(owned, i) === null), `${name}: keys 5-0 raise nothing`));
  check(() => assert.equal(kitWeaponDigit(l.primary), 0, `${name}: primary on key 1`));
}
check(() => assert.deepEqual(['stinger', 'rocket', 'revolver', 'knife', 'minigun'].map(kitWeaponDigit), [2, 2, 1, 3, 0]));
check(() => assert.equal(kitDigitWeapon(undefined, 0), null, 'no owned list yet: nothing'));
check(() => assert.equal(loadouts.filter(l => l.gadget).length, 4, 'both Engineer primaries with both gadgets'));

/* ------------------------------------------------ Input -> WeaponState chain */

function weaponState() {
  let now = 10_000;
  const draws = [];
  const state = new WeaponState({
    rig: { setWeapon() {}, equipWeapon: id => draws.push(id), fire: () => true, reload() {}, cancelReload() {}, pumpAnim() {}, boltAnim() {}, ads() {} },
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
    network: { isCurrentGeneration: () => true, isRunning: () => true },
    feedback: { addExhaustion() {}, addRecoil() {} },
    now: () => now, setTimer: () => 0, clearTimer() {}, random: () => 0.5,
  });
  state.resetToLoadout();
  return { state, draws, tick: () => { now += 5_000; return now; } };
}

const input = new Input({});
input.fallback = true;
const key = (code, extra = {}) => ({ code, preventDefault() {}, repeat: false, timeStamp: 100, ...extra });
/** Press `code`, run the frame's intents through WeaponState; returns the weapon id drawn. */
function press(rig, code, mode, owned) {
  input._onKeyDown(key(code));
  input._onKeyUp(key(code));
  const slot = input.consumeWeaponSlot();
  rig.state.applyIntents({ slot }, rig.tick(), { allowFire: true, alive: true, mode, owned });
  return WEAPON_IDS[rig.state.slot];
}

for (const l of loadouts) {
  const name = `${l.kit} v${l.variant} g${l.gadget}`;
  const rig = weaponState();
  const owned = [...l.owned];
  rig.state.forceWeapon(slotOf('knife'), { mode: 'conquest', owned });
  check(() => assert.equal(press(rig, 'Digit1', 'conquest', owned), l.primary, `${name}: 1 = primary`));
  check(() => assert.equal(press(rig, 'Digit2', 'conquest', owned), 'revolver', `${name}: 2 = IRONCLAD .44`));
  if (l.gadget) check(() => assert.equal(press(rig, 'Digit3', 'conquest', owned), l.gadget, `${name}: 3 = ${l.gadget}`));
  else check(() => assert.equal(press(rig, 'Digit3', 'conquest', owned), 'revolver', `${name}: 3 = nothing without a gadget`));
  check(() => assert.equal(press(rig, 'Digit4', 'conquest', owned), 'knife', `${name}: 4 = IRON PICK`));
  for (const code of ['Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']) {
    check(() => assert.equal(press(rig, code, 'conquest', owned), 'knife', `${name}: ${code} does nothing`));
  }
}

// Redeploy on a different kit: the keys follow the new owned list at once.
{
  const rig = weaponState();
  const at = kitWeapons('engineer', 0, 0).owned;
  const aa = kitWeapons('engineer', 1, 1).owned;
  const recon = kitWeapons('recon', 1).owned;
  check(() => assert.equal(press(rig, 'Digit3', 'conquest', at), 'rocket'));
  check(() => assert.equal(press(rig, 'Digit1', 'conquest', aa), 'shotgun', 'redeploy: 1 is the new primary'));
  check(() => assert.equal(press(rig, 'Digit3', 'conquest', aa), 'stinger', 'redeploy AT -> AA: 3 is the STINGER'));
  check(() => assert.equal(press(rig, 'Digit1', 'conquest', recon), 'longarc', 'redeploy to Recon: 1 is the LONGARC'));
  check(() => assert.equal(press(rig, 'Digit3', 'conquest', recon), 'longarc', 'redeploy to Recon: 3 does nothing'));
  // Before the first owned list the keys do nothing (the server would refuse anyway).
  const fresh = weaponState();
  const before = WEAPON_IDS[fresh.state.slot];
  check(() => assert.equal(press(fresh, 'Digit2', 'conquest', undefined), before, 'no owned list yet: digits do nothing'));
}

// Other modes keep the global digits (slot N-1 of WEAPON_IDS, 0 = slot 10).
for (const mode of ['tdm', 'fun', 'snd', 'gungame', 'ttt']) {
  const rig = weaponState();
  const owned = mode === 'tdm' || mode === 'fun' ? undefined : WEAPON_IDS.filter(id => id !== 'stinger');
  check(() => assert.equal(press(rig, 'Digit3', mode, owned), WEAPON_IDS[2], `${mode}: 3 is global slot 3`));
  check(() => assert.equal(press(rig, 'Digit6', mode, owned), WEAPON_IDS[5], `${mode}: 6 is global slot 6`));
  check(() => assert.equal(press(rig, 'Digit8', mode, owned), WEAPON_IDS[7], `${mode}: 8 is global slot 8`));
  check(() => assert.equal(press(rig, 'Digit0', mode, owned), WEAPON_IDS[9], `${mode}: 0 is global slot 10`));
}

// Rebinding: slot keys keep their identity, so a rebound "Weapon slot 3" is the gadget in Conquest.
{
  const rig = weaponState();
  const owned = kitWeapons('engineer', 0, 1).owned;
  check(() => assert.equal(setKeybinding('slot3', 'KeyO').ok, true));
  check(() => assert.equal(press(rig, 'KeyO', 'conquest', owned), 'stinger', 'rebound slot 3 raises the gadget'));
  check(() => assert.equal(press(rig, 'Digit3', 'conquest', owned), 'stinger', 'the old digit is free'));
  check(() => assert.equal(bindingLabel('slot3'), 'O'));
  resetKeybindings();
  const labels = Object.fromEntries(KEYBINDING_ACTIONS.map(a => [a.id, a.label]));
  check(() => assert.deepEqual([1, 2, 3, 4].map(n => labels[`slot${n}`]),
    KIT_DIGIT_ROLES.map((role, i) => `Weapon slot ${i + 1} (Conquest: ${role})`), 'settings rows name the Conquest kit role'));
  check(() => assert.equal(labels.slot5, 'Weapon slot 5'));
}

/* ----------------------------------------------------- wheel badges 1/2/3/4 */

{
  const context = { match: { mode: 'conquest' }, self: { owned: [], state: 'alive' }, enabled: true, alive: true, spectating: false,
    weapon: { slot: 0, ammoOf: () => ({ mag: 1, reserve: 1 }), forceWeapon() {} } };
  const controller = new WeaponWheelController({ input: { setWeaponWheelOpen() {}, isWeaponWheelClosing: () => false }, hud: { setWeaponWheelState() {} }, getContext: () => context });
  const overlay = new WheelOverlay();
  for (const l of loadouts) {
    context.self.owned = [...l.owned];
    const entries = controller.entries();
    overlay.open(entries);
    const shown = overlay.dom.slots.map(item => `${item.role.textContent}=${item.key.textContent}`).join(' ');
    const expected = l.gadget
      ? `PRIMARY=1 GADGET · ${l.gadget === 'rocket' ? 'AT' : 'AA'}=3 SIDEARM=2 MELEE=4`
      : 'PRIMARY=1 SIDEARM=2 MELEE=4';
    check(() => assert.equal(shown, expected, `${l.kit} v${l.variant} g${l.gadget}: wheel badges`));
    // A key pressed while the wheel is open picks the segment that key raises outside it.
    for (let digit = 0; digit < 10; digit++) {
      const index = controller.directIndex(digit, entries);
      check(() => assert.equal(index < 0 ? null : entries[index].id, kitDigitWeapon(context.self.owned, digit), `${l.kit}: wheel key ${digit + 1}`));
    }
    overlay.close();
  }
  context.match.mode = 'tdm';
  context.self.owned = undefined;
  overlay.open(controller.entries());
  check(() => assert.deepEqual(overlay.dom.slots.slice(0, 10).map(item => item.key.textContent),
    ['[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]', '[8]', '[9]', '[0]'], 'tdm: the full wheel keeps the global digits'));
  overlay.dispose?.();
}

/* -------------------------------------------- seated: seat keys and weapons */

{
  const listeners = new Map();
  const target = {
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    fire(type, init) {
      const event = { repeat: false, defaultPrevented: false, target: null, button: 0, ...init, prevented: false, preventDefault() { this.prevented = true; } };
      for (const fn of listeners.get(type) || []) fn(event);
      return event;
    },
  };
  const controller = new VehicleController({ eventTarget: target, raycast: () => null, now: () => 1000 });
  const mounts = vehicleMountOrder('tank').map(() => [0, 0, 1, 0, 0]);
  const tank = { id: 'tank-1', type: 'tank', team: 'alpha', x: 10, y: 10, z: 10, yaw: 0, turretYaw: 0, turretPitch: 0, hp: 600, mounts,
    seatOccupants: { driver: 'p' }, occupantId: 'p' };
  const self = { id: 'p', state: 'alive', team: 'alpha', x: 10, y: 10, z: 10, hp: 100, vehicleId: 'tank-1', owned: kitWeapons('engineer').owned };
  controller.sync({ self, vehicles: [tank], enabled: true });
  check(() => assert.equal(controller.seatId, 'driver'));
  target.fire('keydown', { code: 'Digit2' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'weapon', index: 1 }, 'seated: 2 still picks the tank HE shell'));
  target.fire('keydown', { code: 'Digit3' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'weapon', index: 2 }, 'seated: 3 still picks the coax'));
  target.fire('keydown', { code: 'Digit4' });
  check(() => assert.equal(controller.consumeAction(), null, 'seated: no fourth tank weapon'));
  target.fire('keydown', { code: 'F2' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'seat', seatId: 'commander' }, 'F2 still switches seats'));
  check(() => assert.equal(input._keyboardAction?.('F2') ?? null, null, 'F keys are no weapon slot binding'));
}

input.dispose();
console.log(`Conquest kit digits: ${checks} checks passed.`);
