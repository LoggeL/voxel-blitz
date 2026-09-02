export async function runInputContracts(ok, installGlobals) {
  // Input: headless is a pointer-lock substitute, not a gameplay-suppression
  // bypass. Direct slots cover the full six-gun roster and wheel edges drain.
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
        && input.getGrenadeCharge(700) === 0.5,
      'holding G exposes deterministic charge progress without throwing or repeating');
      input._onKeyUp(key('KeyG', false, 1300));
      ok(input.consumeGrenadeThrow() === 1 && input.consumeGrenadeThrow() === null,
        'releasing a fully charged G queues exactly one maximum-strength throw');
      input._onKeyDown(key('KeyG', false, 2000));
      input._onKeyUp(key('KeyG', false, 2000));
      ok(input.consumeGrenadeThrow() === 0,
        'a quick G tap remains a valid zero-charge short throw');

      input._onKeyDown(key('Digit5'));
      ok(input.consumeWeaponSlot() === 4 && input.consumeWeaponSlot() === null,
        'headless Digit5 queues and consumes weapon slot five exactly once');
      input._onKeyDown(key('Digit6'));
      ok(input.consumeWeaponSlot() === 5,
        'headless Digit6 reaches the sixth weapon slot');

      let prevented = 0;
      input._onWheel({ deltaY: 12, preventDefault() { prevented++; } });
      input._onWheel({ deltaY: -3, preventDefault() { prevented++; } });
      ok(input.consumeWeaponSwitch() === 0 && prevented === 2,
        'headless wheel accumulates opposing weapon steps and prevents page scroll');
      input._onWheel({ deltaY: 1, preventDefault() {} });
      ok(input.consumeWeaponSwitch() === 1 && input.consumeWeaponSwitch() === 0,
        'headless wheel switch is a draining edge');

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
      ok(touch.consumeGrenadeThrow() === 0.5,
        'mobile grenade hold/release uses the shared charge duration');
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

}
