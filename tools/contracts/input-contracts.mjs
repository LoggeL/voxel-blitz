export async function runInputContracts(ok, installGlobals) {
  // Input: headless is a pointer-lock substitute, not a gameplay-suppression
  // bypass. Direct slots cover the full eight-gun roster and wheel edges drain.
  {
    let input = null;
    let unlocked = null;
    let touch = null;
    const restore = installGlobals({ location: { search: '?headless=1' } });
    try {
      const { Input } = await import('../../public/js/engine/input.js');
      const {
        isTapToFire,
        joystickVector,
        resolveToggleRelease,
        shouldEnableTouchControls,
      } = await import('../../public/js/engine/touch-controls.js');
      ok(resolveToggleRelease(120, false) === true
        && resolveToggleRelease(600, false) === false
        && resolveToggleRelease(120, true) === false,
      'touch toggle buttons latch on a quick tap, release on a long hold, and unlatch on the next tap');
      ok(isTapToFire(90, 4) && !isTapToFire(400, 4) && !isTapToFire(90, 40),
        'a short, still look-zone touch is a tap-to-fire while drags and long presses aim');
      input = new Input({});
      ok(input.getSensitivity() === 0.003,
        'fresh input starts at the canonical mouse sensitivity (~2100 px per turn)');

      const key = (code, repeat = false, timeStamp = 0) => ({
        code,
        repeat,
        timeStamp,
        preventDefault() {},
      });

      input._onKeyDown(key('KeyG', false, 100));
      input._onKeyDown(key('KeyG', true, 400));
      ok(input.consumeGrenadeThrow() === null
        && input.getGrenadeCharge(700) === 0.5
        && input.getGrenadeHoldMs(700) === 600,
      'holding G exposes deterministic charge and cook progress without throwing or repeating');
      input._onKeyUp(key('KeyG', false, 1300));
      const fullThrow = input.consumeGrenadeThrow();
      ok(fullThrow?.charge === 1 && fullThrow.cookMs === 1200 && fullThrow.type === 0
        && input.consumeGrenadeThrow() === null,
      'releasing a fully charged G queues exactly one maximum-strength throw with its cook time');
      input._onKeyDown(key('KeyG', false, 2000));
      input._onKeyUp(key('KeyG', false, 2000));
      ok(input.consumeGrenadeThrow()?.charge === 0,
        'a quick G tap remains a valid zero-charge short throw');
      const typeInput = new Input({});
      typeInput._onKeyDown(key('KeyH'));
      const cycled = typeInput.getGrenadeType();
      typeInput._onKeyDown(key('KeyG', false, 3000));
      typeInput._onWheel({ deltaY: 100, deltaMode: 0, timeStamp: 3100, preventDefault() {} });
      const wheeled = typeInput.getGrenadeType();
      typeInput._onKeyUp(key('KeyG', false, 3200));
      const typed = typeInput.consumeGrenadeThrow();
      ok(cycled === 1 && wheeled === 2 && typed?.type === 2
        && typeInput.consumeWeaponSwitch() === 0,
      'H cycles the throwable, the wheel cycles it while G is held instead of switching weapons, and the release carries the type');
      typeInput._onKeyDown(key('KeyG', false, 4000));
      ok(typeInput.forceGrenadeRelease(6600) && typeInput.consumeGrenadeThrow()?.cookMs === 2600,
        'a presentation-forced release reports the full cooked hold');
      typeInput.dispose?.();

      input._onKeyDown(key('Digit5'));
      ok(input.consumeWeaponSlot() === 4 && input.consumeWeaponSlot() === null,
        'headless Digit5 queues and consumes weapon slot five exactly once');
      input._onKeyDown(key('Digit6'));
      ok(input.consumeWeaponSlot() === 5,
        'headless Digit6 reaches the sixth weapon slot');
      input._onKeyDown(key('Digit7'));
      ok(input.consumeWeaponSlot() === 6,
        'headless Digit7 reaches the seventh weapon slot');
      input._onKeyDown(key('Digit8'));
      ok(input.consumeWeaponSlot() === 7,
        'headless Digit8 reaches the eighth weapon slot');

      let prevented = 0;
      const wheel = (deltaY, timeStamp, deltaMode = 0) => ({
        deltaY, deltaMode, timeStamp, preventDefault() { prevented++; },
      });
      input._onWheel(wheel(100, 1000));
      input._onWheel(wheel(-100, 1400));
      ok(input.consumeWeaponSwitch() === 0 && prevented === 2,
        'headless wheel accumulates opposing weapon steps and prevents page scroll');
      input._onWheel(wheel(100, 2000));
      ok(input.consumeWeaponSwitch() === 1 && input.consumeWeaponSwitch() === 0,
        'headless wheel switch is a draining edge');
      input._onWheel(wheel(1, 3000, 1));
      input._onWheel(wheel(1, 3030, 1));
      ok(input.consumeWeaponSwitch() === 1,
        'line-mode wheel notches inside the cooldown collapse to one weapon step');
      // Trackpad: a two-finger flick streams small pixel deltas that add up to one notch.
      for (let i = 0; i < 12; i++) input._onWheel(wheel(6, 4000 + i * 8));
      ok(input.consumeWeaponSwitch() === 1 && input.pointerKind() === 'trackpad'
        && input.deviceInfo().trackpadDetected && input.adsMode() === 'toggle',
      'a trackpad scroll burst is one weapon step, flags the trackpad, and defaults ADS to toggle');
      input._onMouseDown({ button: 2, isTrusted: true, preventDefault() {} });
      input._onMouseUp({ button: 2 });
      const latched = input.wantAdsHeld;
      input._onMouseDown({ button: 2, isTrusted: true, preventDefault() {} });
      input._onMouseUp({ button: 2 });
      ok(latched && !input.wantAdsHeld,
        'toggle ADS latches on the first click and releases on the second');
      input.setOptions({ adsMode: 'hold' });
      input._onKeyDown(key('KeyF'));
      const heldByKey = input.wantAdsHeld;
      input._onKeyUp(key('KeyF'));
      ok(heldByKey && !input.wantAdsHeld && input.getOptions().adsMode === 'hold',
        'hold ADS follows the F key edge and the option persists');
      input.setOptions({ adsMode: '', pointerMode: 'mouse' });
      ok(input.pointerKind() === 'mouse' && input.adsMode() === 'hold',
        'an explicit mouse pointer mode overrides trackpad detection');
      input._onMouseMove({ movementX: 10, movementY: 0 });
      const mouseLook = input.consumeDelta().dx;
      input.setOptions({ pointerMode: 'trackpad' });
      input._onMouseMove({ movementX: 10, movementY: 0 });
      const trackpadFirst = input.consumeDelta().dx;
      let trackpadRest = 0;
      for (let i = 0; i < 12; i++) trackpadRest += input.consumeDelta().dx;
      ok(Math.abs(mouseLook - 0.03) < 1e-12
        && trackpadFirst > mouseLook && trackpadRest > 0
        && trackpadFirst > 0.6 * 0.03 * 2.4
        && Math.abs(trackpadFirst + trackpadRest - 0.03 * 2.4) < 1e-6,
      'trackpad mode scales look up and smooths it over a few frames without losing motion');
      input.setOptions({ pointerMode: 'auto' });
      input._onKeyDown(key('KeyZ'));
      input.setScopeZoomMode(true);
      input._onWheel(wheel(100, 9000));
      ok(input.consumeZoomStep() === 2 && input.consumeWeaponSwitch() === 0,
        'Z and the wheel while scoped queue zoom steps instead of weapon switches');
      input.setScopeZoomMode(false);

      input._onKeyDown(key('KeyE'));
      ok(input.getKeys().interact,
        'held E is exposed as interaction input');
      input._onKeyUp(key('KeyE'));
      ok(!input.getKeys().interact,
        'releasing E clears held interaction input');

      input.setGameplayEnabled(false);
      input._onKeyDown(key('Digit6'));
      input._onWheel({ deltaY: 1, preventDefault() {} });
      ok(input.consumeWeaponSlot() === null && input.consumeWeaponSwitch() === 0,
        'explicit gameplay suppression still blocks headless weapon input');

      globalThis.location = { search: '' };
      unlocked = new Input({});
      unlocked.setGameplayEnabled(false);
      unlocked._onKeyDown(key('KeyB'));
      unlocked._onKeyDown(key('KeyE'));
      unlocked._onKeyDown(key('KeyW'));
      unlocked._onKeyDown(key('Digit5'));
      unlocked._onWheel({ deltaY: 1, preventDefault() {} });
      unlocked._onMouseDown({
        button: 0,
        isTrusted: false,
        preventDefault() {},
      });
      const suppressedKeys = unlocked.getKeys();
      ok(!unlocked.isLocked()
        && unlocked.consumeBuyMenuRequest()
        && !suppressedKeys.interact
        && !suppressedKeys.forward
        && !unlocked.wantFireHeld
        && !unlocked.consumeFireTap()
        && unlocked.consumeWeaponSlot() === null
        && unlocked.consumeWeaponSwitch() === 0,
      'unlocked suppressed input admits the B UI edge but no gameplay input');
      unlocked._onKeyDown(key('KeyB', true));
      ok(!unlocked.consumeBuyMenuRequest(),
        'a physical B repeat cannot enqueue a second toggle');

      unlocked._onKeyUp(key('KeyB'));
      unlocked._onKeyDown(key('KeyB'));
      ok(unlocked.consumeBuyMenuRequest(),
        'B keyup while suppressed rearms exactly one close-capable UI edge');

      unlocked._onKeyUp(key('KeyB'));
      unlocked._onKeyDown(key('KeyB'));
      unlocked.clearTransient();
      ok(!unlocked.consumeBuyMenuRequest(),
        'transient reset clears a stale queued B edge');
      unlocked._onKeyDown(key('KeyB'));
      ok(unlocked.consumeBuyMenuRequest(),
        'transient reset also clears the held-B latch for a fresh physical edge');

      const deadStick = joystickVector(3, -4, 54);
      const fullForward = joystickVector(0, -54, 54);
      ok(deadStick.magnitude === 0
        && fullForward.x === 0
        && fullForward.y === -1
        && fullForward.magnitude === 1,
      'mobile joystick shaping has a stable dead zone and normalized full travel');
      ok(shouldEnableTouchControls({
        windowRef: null,
        navigatorRef: { maxTouchPoints: 0 },
        locationRef: { search: '?touch=1' },
      }) && shouldEnableTouchControls({
        windowRef: { matchMedia: () => ({ matches: true }) },
        navigatorRef: { maxTouchPoints: 0 },
        locationRef: { search: '' },
      }) && !shouldEnableTouchControls({
        windowRef: { matchMedia: (query) => ({ matches: query === '(pointer: fine)' }) },
        navigatorRef: { maxTouchPoints: 10 },
        locationRef: { search: '' },
      }), 'mobile controls detect QA/coarse pointers without hijacking fine-pointer hybrids');

      globalThis.location = { search: '?touch=1' };
      touch = new Input({});
      ok(touch.usesTouchControls() && !touch.requiresPointerLock(),
        'touch input is gameplay-ready without pointer lock');
      touch._onMouseMove({ movementX: 10, movementY: -5 });
      ok(touch.consumeDelta().dx === 0,
        'touch mode does not turn unlocked hybrid-device mouse movement into aim');
      touch._onTouchMove({ x: 0.45, y: -0.9, magnitude: 0.92 });
      const mobileMove = touch.getKeys();
      ok(mobileMove.forward && mobileMove.right && mobileMove.sprint
        && !mobileMove.back && !mobileMove.left,
      'mobile joystick maps diagonals and outer-ring auto sprint onto canonical movement keys');
      touch._onTouchLook(10, -5);
      const mobileLook = touch.consumeDelta();
      ok(Math.abs(mobileLook.dx - 0.042) < 1e-12
        && Math.abs(mobileLook.dy + 0.021) < 1e-12,
      'mobile aim feeds the canonical look accumulator at the bounded touch scale');
      let touchResetCalls = 0;
      touch._touchControls = {
        reset: () => { touchResetCalls += 1; },
        setEnabled: () => {},
        dispose: () => {},
      };
      touch.consumeDelta();
      ok(touchResetCalls === 0 && touch.getKeys().forward,
        'reading look deltas never releases the active mobile joystick');
      touch._onTouchHold('fire', true, 100);
      ok(touch.wantFireHeld && touch.consumeFireTap(),
        'mobile fire queues one tap and exposes held automatic fire');
      touch._onTouchHold('fire', false, 120);
      touch._onTouchHold('ads', true, 130);
      touch._onTouchHold('jump', true, 140);
      ok(!touch.wantFireHeld && touch.wantAdsHeld && touch.getKeys().jump,
        'mobile hold buttons independently release fire and hold ADS/jump');
      touch._onTouchPulse('reload');
      touch._onTouchPulse('weapon');
      touch._onTouchPulse('buy');
      ok(touch.getKeys().reload && touch.consumeWeaponSwitch() === 1
        && touch.consumeBuyMenuRequest(),
      'mobile reload, weapon swap, and armory emit the existing draining edges');
      touch._onTouchPulse('fireTap');
      ok(touch.consumeFireTap() && !touch.consumeFireTap() && !touch.wantFireHeld,
        'a look-zone tap queues exactly one shot without latching automatic fire');
      touch._onTouchHold('grenade', true, 200);
      touch._onTouchHold('grenade', false, 800);
      ok(touch.consumeGrenadeThrow()?.charge === 0.5,
        'mobile grenade hold/release uses the shared charge duration');
      touch._onTouchPulse('grenadeType');
      ok(touch.getGrenadeType() === 1,
        'the mobile type chip cycles the selected throwable');
      touch.setGrenadeType(0);
      touch.setGameplayEnabled(false);
      ok(!touch.wantAdsHeld && !touch.getKeys().jump && touch.consumeWeaponSwitch() === 0
        && touchResetCalls === 1,
        'mobile gameplay suppression clears all held and queued state');

      input.setGameplayEnabled(true);
      input._onKeyDown(key('KeyE'));
      input._onKeyDown(key('KeyB'));
      input.dispose();
      ok(!input.getKeys().interact
        && !input.consumeBuyMenuRequest(),
      'Input disposal clears held interaction and pending buy-menu state');
      input = null;
    } finally {
      input?.dispose();
      unlocked?.dispose();
      touch?.dispose();
      restore();
    }
  }

  {
    const { stickCurve, readGamepadFrame, PAD_BUTTONS } = await import('../../public/js/engine/gamepad.js');
    const { visibleTouchActions, TouchControls } = await import('../../public/js/engine/touch-controls.js');
    const { wheelSwitchStep } = await import('../../public/js/input-settings.js');

    const dead = stickCurve(0.1, 0.05, 0.18, 1.75);
    const rim = stickCurve(0, 1, 0.18, 1.75);
    const mid = stickCurve(0.59, 0, 0.18, 1.75);
    ok(dead.magnitude === 0 && rim.magnitude === 1 && Math.abs(rim.y - 1) < 1e-9
        && mid.magnitude > 0 && mid.magnitude < 0.5,
    'gamepad sticks have a radial dead zone, a full rim, and an expo curve for fine aim');

    const button = (pressed, value = pressed ? 1 : 0) => ({ pressed, value });
    const buttons = Array.from({ length: 17 }, () => button(false));
    buttons[PAD_BUTTONS.fire] = { pressed: false, value: 0.8 };
    buttons[PAD_BUTTONS.jump] = button(true);
    const first = readGamepadFrame({ axes: [0, -1, 0.5, 0], buttons }, null);
    buttons[PAD_BUTTONS.jump] = button(false);
    const second = readGamepadFrame({ axes: [0, -1, 0.5, 0], buttons }, first.held);
    ok(first.held.fire && first.pressed.fire && first.pressed.jump && first.any
        && second.released.jump && !second.pressed.fire && second.held.fire,
    'gamepad frames expose analog triggers as buttons and report press/release edges');

    const wheelState = { acc: 0, lastAt: -Infinity };
    let steps = 0;
    for (let i = 0; i < 20; i++) steps += wheelSwitchStep(wheelState, { deltaY: 5, deltaMode: 0 }, i * 10);
    const reversal = { acc: 30, lastAt: -Infinity };
    const reversed = wheelSwitchStep(reversal, { deltaY: -30, deltaMode: 0 }, 1000);
    ok(steps === 1 && reversed === 0 && reversal.acc === -30,
      'pixel wheel deltas accumulate to one notch per burst and a reversal resets the bank');

    const none = visibleTouchActions(null);
    const dead2 = visibleTouchActions({ alive: false, canFire: true, grenades: 2 });
    const prep = visibleTouchActions({
      alive: true, canFire: false, canReload: false, grenades: 2, canInteract: false,
      weaponCount: 1, canBuy: true, scoped: false,
    });
    const live = visibleTouchActions({
      alive: true, canFire: true, canReload: true, grenades: 1, canInteract: true,
      weaponCount: 2, canBuy: false, scoped: true,
    });
    ok(none.size === 0 && dead2.size === 0
        && [...prep].sort().join(',') === 'buy,crouch,jump'
        && [...live].sort().join(',') === 'ads,crouch,fire,grenade,grenadeType,interact,jump,reload,weapon,zoom',
    'touch buttons appear only for actions the current gameplay context allows');

    const holds = [];
    const controls = new TouchControls({
      documentRef: null,
      onHold: (action, held) => holds.push(`${action}:${held}`),
    });
    controls._heldPointers.set('grenade', 7);
    controls._latched.add('ads');
    const changed = controls.setContext({ alive: true, canFire: false, grenades: 0 });
    ok(changed.includes('fire') && changed.includes('grenade')
        && controls.hiddenActions.has('grenade') && controls.hiddenActions.has('ads')
        && holds.includes('grenade:false') && holds.includes('ads:false')
        && !controls.hiddenActions.has('jump'),
    'hiding a held or latched touch button releases it before it disappears');
    ok(controls.setOptions({ size: 'large', hand: 'left' }).hand === 'left'
        && controls.setOptions({ size: 'huge' }).size === 'large',
    'touch layout options accept only known sizes and hands');
    controls.dispose();

    const restore = installGlobals({ location: { search: '?headless=1' } });
    let pad = null;
    try {
      const { Input } = await import('../../public/js/engine/input.js');
      pad = new Input({});
      const padButtons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
      const fake = { connected: true, mapping: 'standard', axes: [0, -1, 1, 0], buttons: padButtons };
      pad._pad.navigator = { getGamepads: () => [fake] };
      padButtons[PAD_BUTTONS.fire] = { pressed: true, value: 1 };
      padButtons[PAD_BUTTONS.reload] = { pressed: true, value: 1 };
      padButtons[PAD_BUTTONS.crouch] = { pressed: true, value: 1 };
      pad.poll(1000, 1 / 60);
      const padKeys = pad.getKeys();
      const look = pad.consumeDelta();
      const fired = pad.wantFireHeld && pad.consumeFireTap();
      padButtons[PAD_BUTTONS.crouch] = { pressed: false, value: 0 };
      pad.poll(1100, 1 / 60);
      const crouchLatched = pad.getKeys().crouch;
      padButtons[PAD_BUTTONS.crouch] = { pressed: true, value: 1 };
      pad.poll(1200, 1 / 60);
      padButtons[PAD_BUTTONS.crouch] = { pressed: false, value: 0 };
      pad.poll(1300, 1 / 60);
      ok(padKeys.forward && padKeys.reload && fired
          && Math.abs(look.dx - 2.1 / 60) < 1e-9 && look.dy === 0
          && crouchLatched && !pad.getKeys().crouch
          && pad.deviceInfo(1300).padActive && pad.aimAssistEligible(1300),
      'a standard gamepad drives movement, look, fire, reload, and tap-toggle crouch through Input');
      pad.consumeDelta();
      pad.setAimAssist(1);
      pad.poll(1400, 1 / 60);
      const assisted = pad.consumeDelta().dx;
      pad.setOptions({ aimAssist: false });
      ok(Math.abs(assisted - (2.1 / 60) * 0.5) < 1e-9 && !pad.aimAssistEligible(1400),
        'aim assist slows pad look by at most half and can be switched off');
      pad._onKeyDown({ code: 'KeyW', preventDefault() {} });
      padButtons[PAD_BUTTONS.fire] = { pressed: false, value: 0 };
      fake.axes = [0, 0, 0, 0];
      pad.poll(1500, 1 / 60);
      ok(pad.getKeys().forward && !pad.wantFireHeld,
        'keyboard and pad inputs combine without one device cancelling the other');
    } finally {
      pad?.dispose();
      restore();
    }
  }
}
