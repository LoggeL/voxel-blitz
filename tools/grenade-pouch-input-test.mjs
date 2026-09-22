// Quick-draw pouch input: G tap/hold throws, H tap/hold pouch, power steps, pin back,
// type lock, cooldown and build gating across keyboard/mouse, gamepad and touch.
import assert from 'node:assert/strict';
import { Input, PAD_WHEEL_HOLD_MS, WHEEL_VECTOR_RADIUS_PX } from '../public/js/engine/input.js';
import { PAD_BUTTONS } from '../public/js/engine/gamepad.js';
import { resetKeybindings, setKeybinding } from '../public/js/keybindings.js';
import {
  GRENADE_PIN_MS, GRENADE_POUCH_HOLD_MS, GRENADE_THROW_COOLDOWN_MS, GRENADE_THROW_COOLDOWN_CLIENT_SLACK_MS, GRENADE_TYPES, GRENADE_TYPE_IDS,
} from '../shared/grenade-rules.js';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };

const key = (code, timeStamp = 0, repeat = false) => ({ code, timeStamp, repeat, preventDefault() {} });
const wheel = (deltaY, timeStamp) => ({ deltaY, deltaMode: 0, timeStamp, preventDefault() {} });
const kinds = input => input.consumeGrenadeUiEvents().map(event => `${event.kind}:${event.reason}`);
const make = (counts = [1, 1, 1, 1, 1]) => {
  const input = new Input({});
  input.fallback = true;
  input._locked = true;
  input.setGrenadeCounts(counts);
  input.consumeGrenadeUiEvents();
  return input;
};
const tapKey = (input, code, at, holdMs = 40) => {
  input._onKeyDown(key(code, at));
  input._onKeyUp(key(code, at + holdMs));
};
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

try {
  resetKeybindings();
  // H tap readies the next stocked type (wrapping, skipping empties); a lone type shakes.
  {
    const input = make([1, 0, 1, 0, 1]);
    tapKey(input, 'KeyH', 0);
    check(input.getGrenadeType() === 2, 'an H tap skips the empty claymore and readies pulse');
    tapKey(input, 'KeyH', 100);
    tapKey(input, 'KeyH', 200);
    check(input.getGrenadeType() === 0 && kinds(input).every(kind => kind === 'readied:pick'),
      'H taps wrap through the stocked types and report each ready change');
    input.setGrenadeCounts([1, 0, 0, 0, 0]);
    tapKey(input, 'KeyH', 300);
    check(input.getGrenadeType() === 0 && kinds(input).includes('denied:noOther'),
      'with nothing else stocked an H tap keeps the type and reports the shake');
    input.dispose();
  }

  // H hold opens the pouch; the pointer snaps away from empty slots; release readies.
  {
    const input = make([1, 0, 1, 0, 1]);
    input._onKeyDown(key('KeyH', 1000));
    input.poll(1000 + GRENADE_POUCH_HOLD_MS - 1);
    check(!input.isGrenadePouchOpen(), 'the pouch stays shut under the hold threshold');
    input.poll(1000 + GRENADE_POUCH_HOLD_MS);
    check(input.isGrenadePouchOpen() && input.getGrenadePouchHover() === 0,
      `an H hold of ${GRENADE_POUCH_HOLD_MS} ms opens the pouch on the ready type`);
    const before = input.consumeDelta();
    input._onMouseMove({ movementX: WHEEL_VECTOR_RADIUS_PX, movementY: 0 });
    const look = input.consumeDelta();
    check(input.getGrenadePouchHover() === 2 && look.dx === 0 && look.dy === 0 && before.dx === 0,
      'a flick at the empty claymore wedge snaps to the nearest stocked slot and never turns the camera');
    input._onMouseMove({ movementX: -WHEEL_VECTOR_RADIUS_PX * 2, movementY: WHEEL_VECTOR_RADIUS_PX * 0.4 });
    check(input.getGrenadePouchHover() === 4, 'the clamped cursor follows a reversal straight to smoke');
    check(!input.wantFireHeld && !input.wantAdsHeld, 'fire and ADS read false while the pouch is up');
    input._onWheel(wheel(100, 1300));
    check(input.getGrenadePouchHover() === 0 && input.consumeWeaponSwitch() === 0,
      'scroll steps the pouch slots (wrapping) instead of switching weapons');
    input._onKeyUp(key('KeyH', 1400));
    check(!input.isGrenadePouchOpen() && input.getGrenadeType() === 0, 'releasing H readies the hovered slot');
    input.setGrenadePouchOpen(true);
    input.setGrenadePouchHover(1);
    check(input.getGrenadePouchHover() !== 1, 'a direct hover of an empty slot snaps to a stocked one');
    input.setGrenadePouchHover(4);
    input._onKeyDown(key('Escape', 1500));
    check(!input.isGrenadePouchOpen() && input.getGrenadeType() === 0, 'Escape closes the pouch unchanged');
    input.setGrenadePouchOpen(true);
    input.setGrenadePouchHover(4);
    input._onMouseDown({ button: 2, preventDefault() {} });
    check(!input.isGrenadePouchOpen() && input.getGrenadeType() === 0, 'RMB closes the pouch unchanged');
    input.setGrenadePouchOpen(true);
    input.setGrenadePouchHover(2);
    input._onMouseDown({ button: 0 });
    check(input.getGrenadeType() === 2 && !input.wantFireHeld && !input.consumeFireTap(),
      'LMB readies the hovered slot without a shot');
    input.dispose();
  }

  // G while the pouch is up confirms the slot and begins the hold in one press.
  {
    const input = make([1, 0, 1, 0, 1]);
    input._onKeyDown(key('KeyH', 0));
    input.poll(GRENADE_POUCH_HOLD_MS + 10);
    input.setGrenadePouchHover(4);
    input._onKeyDown(key('KeyG', 300));
    check(!input.isGrenadePouchOpen() && input.isGrenadeCharging() && input.getGrenadeHoldType() === 4,
      'G in the pouch readies smoke and starts the hold');
    input._onKeyUp(key('KeyH', 400));
    check(input.getGrenadeType() === 4, 'the H release after G changes nothing');
    input._onKeyUp(key('KeyG', 600));
    check(input.consumeGrenadeThrow()?.type === 4, 'the flick-then-G throw carries the picked type');
    input.dispose();
  }

  // Power: tap throws at 0.6, scroll up during a hold steps farther and is remembered.
  {
    const input = make();
    tapKey(input, 'KeyG', 0, 60);
    const tap = input.consumeGrenadeThrow();
    check(tap?.charge === 0.6 && tap.cookMs === 0 && tap.tap, 'a G tap quick-throws at 0.6 with no cook');
    input._onKeyDown(key('KeyG', 1000));
    input._onWheel(wheel(-100, 1100));
    input._onWheel(wheel(-100, 1300));
    input._onWheel(wheel(-100, 1500));
    check(input.getGrenadePower() === 1 && input.getGrenadePowerIndex() === 4
      && input.consumeWeaponSwitch() === 0 && input.getGrenadeType() === 0,
    'scroll during a hold clamps power at 1.0 and never switches weapons or types');
    input._onKeyUp(key('KeyG', 1600));
    check(input.consumeGrenadeThrow()?.charge === 1, 'the hold after two scroll steps throws at 1.0');
    tapKey(input, 'KeyG', 3000);
    check(input.consumeGrenadeThrow()?.charge === 1, 'the power step is remembered for that type');
    input.selectGrenadeType(2);
    tapKey(input, 'KeyG', 4000);
    check(input.consumeGrenadeThrow()?.charge === 0.6, 'each type remembers its own power step');
    input._onKeyDown(key('KeyG', 5000));
    for (let i = 0; i < 4; i++) input._onWheel(wheel(100, 5100 + i * 200));
    input._onKeyUp(key('KeyG', 6000));
    check(input.consumeGrenadeThrow()?.charge === 0.2, 'scrolling down bottoms out at the 0.2 lob');
    input.dispose();
  }

  // R (or grenadeCancel) while held is PIN BACK: nothing thrown, no reload queued.
  {
    const input = make();
    input._onKeyDown(key('KeyG', 0));
    input._onKeyDown(key('KeyR', 500));
    input._onKeyDown(key('KeyR', 530, true));
    input._onKeyUp(key('KeyR', 560));
    input._onKeyUp(key('KeyG', 700));
    check(!input.isGrenadeCharging() && input.consumeGrenadeThrow() === null && !input.getKeys().reload,
      'R while held cancels: no throw, no reload, and the key repeat stays swallowed');
    check(kinds(input).join() === 'cancel:pinBack', 'the pin back reports one cancel');
    input._onKeyDown(key('KeyG', 800));
    check(input.isGrenadeCharging(), 'a pin back does not start the throw cooldown');
    input._onKeyUp(key('KeyG', 900));
    input.consumeGrenadeThrow();
    input._onKeyDown(key('KeyR', 2000));
    check(input.getKeys().reload, 'R reloads again with no grenade in hand');
    setKeybinding('grenadeCancel', 'KeyP');
    input._onKeyDown(key('KeyG', 3000));
    input._onKeyDown(key('KeyP', 3100));
    input._onKeyUp(key('KeyG', 3200));
    check(input.consumeGrenadeThrow() === null && !input.isGrenadeCharging(), 'a bound grenadeCancel pins back too');
    resetKeybindings();
    // A release that presentation vets (claymore without a wall) is dropped before consume.
    input._onKeyDown(key('KeyG', 5000));
    input._onKeyUp(key('KeyG', 5100));
    check(input.peekGrenadeThrow()?.type === 0 && input.cancelGrenade('noWall')
      && input.consumeGrenadeThrow() === null, 'cancelGrenade drops a queued release before it is consumed');
    input._onKeyDown(key('KeyG', 5200));
    check(input.isGrenadeCharging(), 'a cancelled release refunds the cooldown');
    input.dispose();
  }

  // The type locks at the press: H, the previous key and quick keys are ignored mid-hold.
  {
    const input = make();
    setKeybinding('grenadeSmoke', 'KeyY');
    setKeybinding('grenadePrevious', 'KeyU');
    input._onKeyDown(key('KeyG', 0));
    tapKey(input, 'KeyH', 100);
    input._onKeyDown(key('KeyH', 200));
    input.poll(200 + GRENADE_POUCH_HOLD_MS + 50);
    input._onKeyUp(key('KeyH', 600));
    tapKey(input, 'KeyU', 700);
    tapKey(input, 'KeyY', 800);
    check(input.getGrenadeHoldType() === 0 && input.getGrenadeType() === 0 && !input.isGrenadePouchOpen()
      && input.selectGrenadeType(3) === false && input.cycleGrenadeType(1) === 0,
    'H, the pouch, previous and quick keys cannot change a held grenade');
    input._onKeyUp(key('KeyG', 900));
    check(input.consumeGrenadeThrow()?.type === 0, 'the release carries the type locked at the press');
    tapKey(input, 'KeyY', 2000, 60);
    const quick = input.consumeGrenadeThrow();
    check(quick?.type === 4 && quick.charge === 0.6 && input.getGrenadeType() === 4,
      'a quick key readies its type and a tap quick-throws it');
    tapKey(input, 'KeyU', 3000);
    check(input.getGrenadeType() === 3, 'the previous key readies the previous stocked type');
    input.setGrenadeCounts([1, 1, 1, 1, 0]);
    input.consumeGrenadeUiEvents();
    input._onKeyDown(key('KeyY', 4000));
    check(!input.isGrenadeCharging() && kinds(input).includes('denied:empty') && input.getGrenadeType() === 3,
      'a quick key for an empty type is refused with the dry click');
    input._onKeyUp(key('KeyY', 4050));
    input._onKeyDown(key('KeyY', 5000));
    input._onKeyDown(key('KeyG', 5010));
    input._onKeyUp(key('KeyG', 5100));
    check(input.isGrenadeCharging() === false && input.consumeGrenadeThrow()?.type === 3,
      'G releases only a hold that G started');
    resetKeybindings();
    input.dispose();
  }

  // Cook runs from the pin pull; presentation forces the release when cook reaches the fuse.
  {
    const input = make();
    const frag = GRENADE_TYPES.frag;
    input._onKeyDown(key('KeyG', 0));
    check(input.getGrenadeCookMs(GRENADE_PIN_MS) === 0 && input.getGrenadeCookMs(1000) === 1000 - GRENADE_PIN_MS,
      'the frag cook starts at the pin pull');
    const forceAt = GRENADE_PIN_MS + frag.fuseMs;
    // Mirrors main.js: force the release once the cook reaches the fuse.
    check(input.getGrenadeCookMs(forceAt - 1) < frag.fuseMs, 'no forced release before the fuse');
    check(input.getGrenadeCookMs(forceAt) >= frag.fuseMs && input.forceGrenadeRelease(forceAt),
      'the forced release happens at cook >= fuse');
    check(input.consumeGrenadeThrow()?.cookMs === frag.fuseMs, 'the forced throw reports the whole fuse as cook');
    input.selectGrenadeType(GRENADE_TYPE_IDS.indexOf('pulse'));
    input._onKeyDown(key('KeyG', forceAt + 2000));
    input._onKeyUp(key('KeyG', forceAt + 4000));
    check(input.consumeGrenadeThrow()?.cookMs === 0, 'non-cook types never report a cook');
    input.dispose();
  }

  // Auto-advance, empty presses, cooldown and build mode.
  {
    const input = make([1, 0, 0, 0, 1]);
    check(input.getGrenadeCount(0) === 1 && input.getGrenadeCount(1) === 0, 'getGrenadeCount mirrors the authoritative counts');
    input.setGrenadeCounts([0, 0, 0, 0, 1]);
    check(input.getGrenadeType() === 4 && kinds(input).join() === 'advanced:empty',
      'a count drop auto-advances the ready type and reports it');
    const ttt = make([1, 0, 0, 2, 1]);
    ttt.setGrenadeCounts([0, 0, 0, 2, 1]);
    check(ttt.getGrenadeType() === 3, 'auto-advance prefers the same role (frag -> molotov)');
    ttt.dispose();
    const bastion = make([0, 0, 1, 0, 1]);
    check(bastion.getGrenadeType() === 2, 'a Bastion spawn readies the first stocked type in belt order');
    bastion.dispose();
    input.setGrenadeCounts([0, 0, 0, 0, 0]);
    input._onKeyDown(key('KeyG', 0));
    check(!input.isGrenadeCharging() && input.getReadyGrenade() === -1 && kinds(input).includes('denied:empty'),
      'an empty pouch press is denied');
    input._onKeyUp(key('KeyG', 50));
    input._onKeyDown(key('KeyH', 100));
    input.poll(100 + GRENADE_POUCH_HOLD_MS);
    check(!input.isGrenadePouchOpen(), 'an empty pouch never opens');
    input._onKeyUp(key('KeyH', 400));
    input.setGrenadeCounts([2, 0, 0, 0, 0]);
    check(input.getGrenadeType() === 0 && kinds(input).includes('readied:stocked'), 'a pickup readies the new type');
    tapKey(input, 'KeyG', 1000);
    input.consumeGrenadeThrow();
    input._onKeyDown(key('KeyG', 1040 + 100));
    check(!input.isGrenadeCharging() && kinds(input).includes('denied:cooldown'), 'a press inside the throw cooldown is denied');
    input._onKeyUp(key('KeyG', 1150));
    input._onKeyDown(key('KeyG', 1040 + GRENADE_THROW_COOLDOWN_MS));
    check(!input.isGrenadeCharging() && kinds(input).includes('denied:cooldown'),
      'the client keeps a margin past the authority cooldown (jitter and tick quantization)');
    input._onKeyUp(key('KeyG', 1040 + GRENADE_THROW_COOLDOWN_MS + 20));
    input._onKeyDown(key('KeyG', 1040 + GRENADE_THROW_COOLDOWN_MS + GRENADE_THROW_COOLDOWN_CLIENT_SLACK_MS));
    check(input.isGrenadeCharging(), 'the press after the cooldown draws');
    input.setBuildMode(true);
    check(!input.isGrenadeCharging() && input.consumeGrenadeThrow() === null && kinds(input).includes('cancel:build'),
      'entering build mode pins the held grenade back');
    input._onKeyUp(key('KeyG', 1600));
    input._onKeyDown(key('KeyG', 3000));
    check(!input.isGrenadeCharging() && kinds(input).includes('denied:build'), 'G is refused in build mode');
    input._onKeyUp(key('KeyG', 3050));
    input._onKeyDown(key('KeyH', 3100));
    input.poll(3100 + GRENADE_POUCH_HOLD_MS + 10);
    check(!input.isGrenadePouchOpen() && !input.setGrenadePouchOpen(true), 'the pouch never opens in build mode');
    input._onKeyUp(key('KeyH', 3500));
    input.setBuildMode(false);
    input.setGrenadePouchOpen(true);
    input.setBuildMode(true);
    check(!input.isGrenadePouchOpen(), 'entering build mode closes the pouch');
    input.dispose();
  }

  // Weapon wheel exclusivity and transient resets.
  {
    const input = make();
    input._onKeyDown(key('KeyG', 0));
    input.setWeaponWheelOpen(true);
    check(!input.isGrenadeCharging() && input.consumeGrenadeThrow() === null && kinds(input).includes('cancel:wheel'),
      'opening the weapon wheel mid-hold pins the grenade back');
    input._onKeyUp(key('KeyG', 100));
    input._onKeyDown(key('KeyH', 200));
    input.poll(200 + GRENADE_POUCH_HOLD_MS + 10);
    check(!input.isGrenadePouchOpen(), 'the pouch cannot open over the weapon wheel');
    input._onKeyUp(key('KeyH', 600));
    input.setWeaponWheelOpen(false);
    input.setGrenadePouchOpen(true);
    input._onKeyDown(key('KeyK', 700));
    check(input.takeWheelOpenRequest(), 'the wheel key still asks for the wheel over the pouch');
    input.setWeaponWheelOpen(true);
    check(!input.isGrenadePouchOpen(), 'the wheel opening closes the pouch');
    input.setWeaponWheelOpen(false);
    input._onKeyUp(key('KeyK', 800));
    input.setGrenadePouchOpen(true);
    input._onKeyDown(key('KeyG', 5000));
    input.clearTransient();
    check(!input.isGrenadePouchOpen() && !input.isGrenadeCharging() && input.getGrenadeCount(0) === 1,
      'a transient reset closes the pouch and pins back but keeps the counts');
    input.dispose();
  }

  // Gamepad: RB tap/hold, D-pad power while held, X pin back, D-pad-down pouch, Y weapons only.
  {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    const fake = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
    const pad = make([1, 0, 1, 0, 1]);
    pad._pad.navigator = { getGamepads: () => [fake] };
    const press = (name, at) => { buttons[PAD_BUTTONS[name]] = { pressed: true, value: 1 }; pad.poll(at); };
    const release = (name, at) => { buttons[PAD_BUTTONS[name]] = { pressed: false, value: 0 }; pad.poll(at); };
    check(PAD_BUTTONS.grenadePouch === 13 && !('slotDown' in PAD_BUTTONS), 'd-pad down is the grenade pouch button');
    press('grenade', 0);
    release('grenade', 60);
    const tap = pad.consumeGrenadeThrow();
    check(tap?.charge === 0.6 && tap.tap && tap.type === 0, 'an RB tap quick-throws the ready type at 0.6');
    press('grenade', 1000);
    press('slotUp', 1020); release('slotUp', 1040);
    press('slotUp', 1060); release('slotUp', 1080);
    press('grenadePouch', 1100); release('grenadePouch', 1120);
    check(pad.getGrenadePowerIndex() === 3 && pad.consumeWeaponSwitch() === 0 && !pad.isGrenadePouchOpen(),
      'D-pad up/down step power while RB is held and never switch weapons or open the pouch');
    press('weapon', 1200); release('weapon', 1220);
    check(pad.getGrenadeHoldType() === 0 && pad.getGrenadeType() === 0, 'Y never touches the held grenade');
    pad.consumeWeaponSwitch();
    press('reload', 1300); release('reload', 1320);
    release('grenade', 1400);
    check(!pad.isGrenadeCharging() && pad.consumeGrenadeThrow() === null && !pad.getKeys().reload,
      'X while RB is held pins back without a reload or a throw');
    press('grenadePouch', 2000); release('grenadePouch', 2050);
    check(pad.getGrenadeType() === 2 && !pad.isGrenadePouchOpen(), 'a d-pad-down tap readies the next stocked type');
    press('grenadePouch', 3000);
    pad.poll(3000 + PAD_WHEEL_HOLD_MS);
    check(pad.isGrenadePouchOpen() && pad.getGrenadePouchHover() === 2, 'holding d-pad down opens the pouch');
    fake.axes = [0, 0, -0.8, -0.8];
    pad.poll(3300);
    fake.axes = [0, 0, 0, 0];
    check(pad.getGrenadePouchHover() === 4 && pad.consumeDelta().dx === 0, 'the right stick steers the pouch, not the camera');
    release('grenadePouch', 3400);
    check(pad.getGrenadeType() === 4 && !pad.isGrenadePouchOpen(), 'releasing d-pad down readies the hovered slot');
    press('grenadePouch', 4000);
    pad.poll(4000 + PAD_WHEEL_HOLD_MS);
    press('grenade', 4400);
    check(!pad.isGrenadePouchOpen() && pad.isGrenadeCharging() && pad.getGrenadeHoldType() === 4,
      'RB with the pouch up readies the hovered slot and begins the hold');
    release('grenadePouch', 4450);
    release('grenade', 4600);
    check(pad.consumeGrenadeThrow()?.type === 4, 'the pouch-then-RB throw carries the type');
    press('grenadePouch', 6000);
    pad.poll(6000 + PAD_WHEEL_HOLD_MS);
    pad.setGrenadePouchHover(0);
    press('crouch', 6400);
    release('crouch', 6420);
    release('grenadePouch', 6500);
    check(!pad.isGrenadePouchOpen() && pad.getGrenadeType() === 4 && !pad.getKeys().crouch,
      'B closes the pouch unchanged without crouching');
    press('weapon', 7000); release('weapon', 7050);
    check(pad.consumeWeaponSwitch() === 1 && pad.getGrenadeType() === 4, 'a Y tap swaps weapons and leaves grenades alone');
    pad.setWeaponWheelOpen(true);
    press('grenadePouch', 7200); release('grenadePouch', 7220);
    check(pad.takeWheelSteps() === 1 && !pad.isGrenadePouchOpen(), 'd-pad down still steps the open weapon wheel');
    pad.setWeaponWheelOpen(false);
    press('grenade', 8000);
    fake.connected = false;
    pad.poll(8100);
    check(!pad.isGrenadeCharging() && pad.consumeGrenadeThrow() === null && kinds(pad).includes('cancel:disconnect'),
      'a pad disconnect pins the RB grenade back');
    pad.dispose();
  }

  // Touch: grenade hold, power chips, PIN BACK, and the pouch button.
  {
    const input = make([1, 0, 1, 0, 1]);
    check(input._onTouchHold('grenade', true, 0) === true, 'a touch grenade press reports the hold it began');
    input._onTouchHold('grenade', false, 60);
    check(input.consumeGrenadeThrow()?.charge === 0.6, 'a touch grenade tap quick-throws');
    check(input._onTouchHold('grenade', true, 200) === false && !input.isGrenadeCharging()
      && kinds(input).includes('denied:cooldown'), 'a touch press inside the cooldown reports the denial to the button');
    input._onTouchPulse('grenadePower:0');
    check(input.getGrenadePowerIndex() === 2, 'a power stop without a grenade in hand leaves the ready step alone');
    input._onTouchHold('grenade', false, 240);
    input._onTouchHold('grenade', true, 1000);
    input._onTouchPulse('grenadePower:0');
    input._onTouchHold('grenade', false, 1500);
    check(input.consumeGrenadeThrow()?.charge === 0.2, 'a power chip sets the held step');
    input._onTouchHold('grenade', true, 3000);
    input._onTouchPulse('grenadeCancel');
    input._onTouchHold('grenade', false, 3200);
    check(input.consumeGrenadeThrow() === null && !input.isGrenadeCharging(), 'the PIN BACK chip cancels the touch hold');
    input._onTouchPulse('pouch');
    check(input.isGrenadePouchOpen(), 'the pouch button opens the pouch');
    input._onTouchPulse('pouchSlot:1');
    check(input.isGrenadePouchOpen() && input.getGrenadeType() === 0, 'an empty slot tap is ignored');
    input._onTouchPulse('pouchSlot:4');
    check(!input.isGrenadePouchOpen() && input.getGrenadeType() === 4, 'a stocked slot tap readies it and closes');
    input._onTouchPulse('pouch');
    input._onTouchPulse('pouch');
    check(!input.isGrenadePouchOpen() && input.getGrenadeType() === 4, 'a second pouch tap closes it unchanged');
    input.dispose();
  }
  console.log(`Grenade pouch input: ${checks} keyboard, mouse, pad and touch checks passed.`);
} finally {
  resetKeybindings();
  delete globalThis.localStorage;
}
