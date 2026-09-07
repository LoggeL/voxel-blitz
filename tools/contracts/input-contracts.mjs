export async function runInputContracts(ok, installGlobals) {
  {
    const { Input } = await import('../../public/js/engine/input.js');
    const calls = [];
    const root = { requestFullscreen() { calls.push('fullscreen'); return Promise.resolve(); } };
    const doc = { documentElement: root, fullscreenElement: null, pointerLockElement: null };
    const restore = installGlobals({
      location: { search: '' }, document: doc,
      navigator: { userActivation: { isActive: true }, keyboard: {
        lock(keys) { calls.push(keys); return Promise.resolve(); },
        unlock() { calls.push('unlock'); },
      } },
    });
    let input;
    try {
      input = new Input({ requestPointerLock() { calls.push('pointer'); return Promise.resolve(); } });
      input._touchMode = false;
      input.requestLock();
      ok(calls[0] === 'pointer' && calls[1] === 'fullscreen',
        'desktop entry requests pointer lock before fullscreen consumes user activation');
      doc.fullscreenElement = root;
      doc.pointerLockElement = input.canvas;
      input._hLockChange();
      const captured = calls.at(-1);
      ok(Array.isArray(captured) && captured.includes('KeyW') && captured.includes('Digit1')
        && !captured.includes('Escape'), 'fullscreen gameplay captures shortcuts while leaving Escape free');
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
        let prevented = 0;
        const event = { code: 'KeyW', ...modifiers, preventDefault() { prevented++; } };
        input._onKeyDown(event);
        ok(input.keys.forward && prevented === 1, 'modified W moves and cancels browser default');
        input._onKeyUp(event);
        ok(!input.keys.forward && prevented === 2, 'modified W release clears movement and browser default');
      }
      input.setGameplayEnabled(false);
      ok(calls.at(-1) === 'unlock', 'pausing releases keyboard capture');
      let prevented = false;
      input._onKeyDown({ code: 'KeyW', preventDefault() { prevented = true; } });
      ok(!prevented && !input.keys.forward, 'paused gameplay leaves browser shortcuts alone');
      input.setGameplayEnabled(true);
      doc.fullscreenElement = null;
      input._hFullscreenChange();
      ok(calls.at(-1) === 'unlock', 'leaving fullscreen releases keyboard capture');
      root.requestFullscreen = () => Promise.reject(new Error('denied'));
      input.requestLock();
      await Promise.resolve();
      ok(calls.at(-1) === 'pointer', 'fullscreen denial still permits pointer lock');
      input.dispose();
      ok(calls.at(-1) === 'unlock', 'disposing releases keyboard capture');
    } finally {
      input?.dispose();
      restore();
    }
  }
  // Input: headless is a pointer-lock substitute, not a gameplay-suppression
  // bypass. Direct slots cover the full ten-gun roster and wheel edges drain.
  {
    let input = null;
    let unlocked = null;
    let touch = null;
    const restore = installGlobals({ location: { search: '?headless=1' } });
    try {
      const { Input } = await import('../../public/js/engine/input.js');
      const {
        joystickVector,
        resolveToggleRelease,
        shouldEnableTouchControls,
      } = await import('../../public/js/engine/touch-controls.js');
      ok(resolveToggleRelease(120, false) === true
        && resolveToggleRelease(600, false) === false
        && resolveToggleRelease(120, true) === false,
      'touch toggle buttons latch on a quick tap, release on a long hold, and unlatch on the next tap');
      input = new Input({});
      ok(input.getSensitivity() === 0.003,
        'fresh input starts at the canonical mouse sensitivity (~2100 px per turn)');

      const key = (code, repeat = false, timeStamp = 0) => ({
        code,
        repeat,
        timeStamp,
        preventDefault() {},
      });

      input._onMouseDown({ button: 1 });
      input._onMouseUp({ button: 1 });
      ok(input.takeWheelOpenRequest() && !input.takeWheelRelease(),
        'a middle-click released between render frames keeps the toggle open request without confirming');
      input.setWeaponWheelOpen(true);
      input._onMouseUp({ button: 1 });
      input.setWeaponWheelOpen(false);
      ok(!input.takeWheelRelease() && !input.takeWheelCancelRequest(),
        'closing the wheel clears pending release and cancel edges before another open');

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
      input._onKeyDown(key('Digit9'));
      ok(input.consumeWeaponSlot() === 8,
        'headless Digit9 reaches the ninth weapon slot');
      input._onKeyDown(key('Digit0'));
      ok(input.consumeWeaponSlot() === 9,
        'headless Digit0 reaches the tenth weapon slot');

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
      ok(input.consumeZoomStep() === 1 && input.consumeWeaponSwitch() === 1,
        'Z changes scope zoom while scrolling switches weapons even when scoped');
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
      touch._onTouchHold('interact', true, 200);
      ok(touch.getKeys().interact, 'mobile objective interaction stays available as a hold');
      touch._onTouchHold('interact', false, 800);
      ok(!touch.getKeys().interact, 'releasing mobile interaction stops planting or defusing');
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


  // Weapon wheel seam: the tap/hold split, the open-state rerouting, and the
  // closed-path invariants it must not break.
  {
    let input = null;
    const restore = installGlobals({ location: { search: '?headless=1' } });
    try {
      const { Input, PAD_WHEEL_HOLD_MS, WHEEL_VECTOR_RADIUS_PX } =
        await import('../../public/js/engine/input.js');
      const key = (code, repeat = false, timeStamp = 0) => ({
        code, repeat, timeStamp, preventDefault() {},
      });
      const wheel = (deltaY, timeStamp, deltaMode = 0) => ({
        deltaY, deltaMode, timeStamp, preventDefault() {},
      });
      ok(PAD_WHEEL_HOLD_MS === 260
          && WHEEL_VECTOR_RADIUS_PX === 90,
      'the wheel seam pins its pad hold threshold and selection radius for the overlay');

      // Q opens once per physical hold and preserves a release before the frame.
      input = new Input({});
      ok(!input.isWeaponWheelClosing(), 'a new input has no pending wheel close');
      input._onKeyDown(key('KeyQ', false, 1000));
      ok(input.takeWheelOpenRequest() && !input.takeWheelOpenRequest(),
        'Q immediately queues exactly one wheel open');
      input.setWeaponWheelOpen(true);
      for (let time = 1100; time <= 3000; time += 100) {
        input._onKeyDown(key('KeyQ', true, time));
      }
      input._onKeyDown(key('KeyQ', false, 3100));
      ok(!input.takeWheelCancelRequest() && !input.takeWheelRelease()
          && !input.takeWheelOpenRequest() && input.isWeaponWheelOpen(),
        'holding Q through repeated or duplicate keydown events keeps the wheel open');
      input._onKeyUp(key('KeyQ', false, 3200));
      ok(input.takeWheelRelease() && !input.takeWheelRelease() && !input.consumeLastWeaponRequest(),
        'releasing Q confirms once without requesting the previous weapon');
      input.setWeaponWheelOpen(false);
      input._onKeyDown(key('KeyQ', false, 3300));
      input._onKeyUp(key('KeyQ', false, 3301));
      ok(input.takeWheelOpenRequest(), 'a quick Q tap still opens the wheel');
      input.setWeaponWheelOpen(true);
      ok(input.takeWheelRelease(), 'a Q release before the next frame survives opening the wheel');
      input.setWeaponWheelOpen(false);
      input._onKeyDown(key('KeyQ', false, 3400));
      input.clearTransient();
      input._onKeyUp(key('KeyQ', false, 3500));
      ok(!input.takeWheelRelease() && !input.takeWheelOpenRequest(),
        'a focus reset cancels the Q hold without selecting a weapon');

      for (const action of ['flick', 'cancel']) {
        input._onKeyDown(key('KeyQ', false, 3600));
        ok(input.takeWheelOpenRequest(), `${action} begins with a new physical Q press`);
        input.setWeaponWheelOpen(true);
        if (action === 'cancel') input._onKeyDown(key('Escape'));
        input.setWeaponWheelOpen(false);
        input._onKeyDown(key('KeyQ', true, 3700));
        input._onKeyDown(key('KeyQ', false, 3800));
        ok(!input.takeWheelOpenRequest() && !input.takeWheelRelease()
            && !input.takeWheelCancelRequest(),
          `a ${action} close stays closed through held-Q repeats and duplicate keydown events`);
        input._onKeyUp(key('KeyQ', false, 3900));
        ok(!input.takeWheelRelease(), `Q release after a ${action} close cannot select twice`);
      }

      input._onKeyDown(key('KeyQ', false, 4000));
      input._onKeyDown(key('Escape', false, 4001));
      ok(input.takeWheelOpenRequest() && input.takeWheelCancelRequest(),
        'Escape can cancel a Q open request before the first frame');
      input.setWeaponWheelOpen(false);
      input.fallback = false;
      input._touchMode = false;
      input._locked = false;
      input._onKeyUp(key('KeyQ', false, 4002));
      ok(!input.takeWheelRelease(), 'Q release without gameplay access never selects a weapon');
      input._locked = true;
      input._onKeyDown(key('KeyQ', false, 4100));
      ok(input.takeWheelOpenRequest(),
        'Q release without gameplay access still rearms the next physical Q press');
      input.setWeaponWheelOpen(true);
      input._hBlur();
      input._onKeyDown(key('KeyQ', true, 4200));
      input._onKeyUp(key('KeyQ', false, 4300));
      ok(!input.isWeaponWheelOpen() && !input.takeWheelOpenRequest() && !input.takeWheelRelease(),
        'blur cancels the wheel and later Q repeats or release cannot reopen or equip');
      input.dispose();

      // Middle mouse opens; its release leaves it open. A closed right click latches
      // toggle ADS, an open-wheel right click only cancels.
      input = new Input({});
      input.setOptions({ adsMode: 'toggle' });
      input._onMouseDown({ button: 1, isTrusted: true, preventDefault() {} });
      ok(input.takeWheelOpenRequest(),
      'a middle-mouse press queues the wheel open');
      input.setWeaponWheelOpen(true);
      input._onMouseUp({ button: 1 });
      ok(!input.takeWheelRelease(),
      'releasing the middle mouse button keeps the wheel open');
      input.setWeaponWheelOpen(false);
      input._onMouseDown({ button: 2, isTrusted: true, preventDefault() {} });
      input._onMouseUp({ button: 2 });
      ok(input.wantAdsHeld,
      'a closed right click still latches toggle ADS');
      input.setWeaponWheelOpen(true);
      input._onMouseDown({ button: 2, isTrusted: true, preventDefault() {} });
      ok(input.takeWheelCancelRequest() && !input.takeWheelCancelRequest(),
      'a right click while the wheel is up queues exactly one cancel');
      input.setWeaponWheelOpen(false);
      ok(!input.wantAdsHeld,
      'the wheel-open right click toggled nothing: ADS reads unchanged after close');
      input.dispose();

      // The wheel owns the left button while it is up: confirm, never fire.
      input = new Input({});
      input.setWeaponWheelOpen(true);
      input._onMouseDown({ button: 0, isTrusted: true, preventDefault() {} });
      ok(input.takeWheelRelease() && !input.consumeFireTap() && !input.wantFireHeld,
      'a left click on the open wheel confirms the pick and never queues a shot');
      input.dispose();

      // Open-wheel mouse motion feeds the selection vector; look stays frozen.
      input = new Input({});
      input._locked = true;
      input.setWeaponWheelOpen(true);
      input._onMouseMove({ movementX: 40, movementY: 30 });
      let vector = input.takeWheelVector();
      ok(Math.abs(vector.x - 40 / 90) < 1e-9 && Math.abs(vector.y - 30 / 90) < 1e-9,
      'open-wheel mouse motion accumulates into a vector normalized to the ring radius');
      input._onMouseMove({ movementX: 400, movementY: 0 });
      vector = input.takeWheelVector();
      ok(Math.abs(vector.x - 400 / 90) < 1e-9 && vector.y === 0,
      'a fast swing preserves its full travel beyond the ring radius');
      input._onMouseMove({ movementX: 200, movementY: -100 });
      vector = input.takeWheelVector(200);
      ok(vector.x === 1 && vector.y === -0.5 && input.takeWheelVector(200).x === 0,
      'mouse travel uses the measured visible ring radius and drains once');
      input._onMouseMove({ movementX: 90, movementY: 0 });
      ok(input.takeWheelVector(0).x === 1,
      'an unavailable ring radius falls back to the default normalization');
      ok(input.consumeDelta().dx === 0 && input.consumeDelta().dy === 0,
      'the camera look accumulator stays frozen while the wheel steers');
      input.setWeaponWheelOpen(false);
      input._onKeyDown(key('KeyQ'));
      input._onMouseMove({ movementX: 260, movementY: -80 });
      input._onKeyUp(key('KeyQ'));
      ok(input.isWeaponWheelClosing() && input.isWeaponWheelClosing(),
        'the readonly closing state freezes overlay motion immediately after Q release');
      input._onMouseMove({ movementX: -180, movementY: 180 });
      ok(input.takeWheelOpenRequest(), 'a rapid Q gesture requests the wheel');
      input.setWeaponWheelOpen(true);
      vector = input.takeWheelVector(200);
      ok(vector.x === 1.3 && vector.y === -0.4 && input.takeWheelRelease()
          && input.consumeDelta().dx === 0 && input.consumeDelta().dy === 0,
      'a rapid Q gesture keeps movement before release and ignores movement after release');

      for (const stop of ['release', 'cancel']) {
        input.setWeaponWheelOpen(false);
        input._onKeyDown(key('KeyQ'));
        input.takeWheelOpenRequest();
        input.setWeaponWheelOpen(true);
        input._onMouseMove({ movementX: 40, movementY: 20 });
        if (stop === 'release') input._onKeyUp(key('KeyQ'));
        else input._onKeyDown(key('Escape'));
        ok(input.isWeaponWheelClosing(), `${stop} exposes the frozen wheel state to pointer overlays`);
        input._onMouseMove({ movementX: -200, movementY: 200 });
        vector = input.takeWheelVector(200);
        ok(vector.x === 0.2 && vector.y === 0.1
            && input.consumeDelta().dx === 0 && input.consumeDelta().dy === 0,
          `mouse movement after wheel ${stop} preserves the release position and keeps the camera still`);
        input.setWeaponWheelOpen(false);
        ok(!input.isWeaponWheelClosing(), `${stop} close clears the frozen state for the next gesture`);
        input._onKeyUp(key('KeyQ'));
      }
      input.setWeaponWheelOpen(true);
      input._locked = false;
      input._onMouseMove({ movementX: 200, movementY: 100 });
      vector = input.takeWheelVector(200);
      ok(vector.x === 0 && vector.y === 0,
      'unlocked overlay pointer motion is never applied again as relative wheel input');
      input.dispose();

      // Open-wheel scroll steps the wheel and wins over scope zoom.
      input = new Input({});
      input.setWeaponWheelOpen(true);
      input._onWheel(wheel(100, 1000));
      ok(input.takeWheelSteps() === 1 && input.takeWheelSteps() === 0,
      'an open-wheel scroll queues one slot step and drains');
      input.setScopeZoomMode(true);
      input._onWheel(wheel(100, 1200));
      ok(input.consumeZoomStep() === 0 && input.takeWheelSteps() === 1,
      'an open wheel wins over scope zoom: scroll steps the wheel, not the scope');
      input.setScopeZoomMode(false);
      input.dispose();

      // Digits route to the wheel while open and to the slot seam while closed.
      input = new Input({});
      input.setWeaponWheelOpen(true);
      input._onKeyDown(key('Digit3'));
      ok(input.takeWheelDirectSlot() === 2 && input.consumeWeaponSlot() === null,
      'a digit while the wheel is up picks the wheel slot directly and skips the closed seam');
      input.setWeaponWheelOpen(false);
      input._onKeyDown(key('Digit3'));
      ok(input.consumeWeaponSlot() === 2 && input.consumeWeaponSlot() === null,
      'a closed digit still routes through the weapon-slot seam');
      input.setWeaponWheelOpen(true);
      input._onKeyDown(key('Digit0'));
      ok(input.takeWheelDirectSlot() === 9 && input.consumeWeaponSlot() === null,
      'a Digit0 while the wheel is up picks the tenth wheel slot directly');
      input.setWeaponWheelOpen(false);
      input.dispose();

      // While the wheel is up every combat edge is suppressed; movement stays live.
      input = new Input({});
      input.setOptions({ adsMode: 'hold' });
      input.setWeaponWheelOpen(true);
      input._onKeyDown(key('KeyR'));
      ok(!input.getKeys().reload,
      'R cannot reload through the open wheel');
      input._onKeyDown(key('KeyF'));
      ok(!input.wantAdsHeld,
      'F cannot aim through the open wheel');
      input._onKeyUp(key('KeyF'));
      input.setWeaponWheelOpen(false);
      ok(!input.wantAdsHeld,
      'the suppressed F leaves no ADS held or latched after close');
      input.setWeaponWheelOpen(true);
      input._onKeyDown(key('KeyG', false, 2000));
      input._onKeyUp(key('KeyG', false, 2100));
      ok(input.consumeGrenadeThrow() === null && !input.isGrenadeCharging(),
      'G cannot start or release a grenade through the open wheel');
      input._onKeyDown(key('KeyB'));
      ok(!input.consumeBuyMenuRequest(),
      'B cannot open the armory through the open wheel');
      input._onKeyDown(key('KeyE'));
      ok(!input.getKeys().interact,
      'E cannot interact through the open wheel');
      input._onKeyDown(key('KeyZ'));
      ok(input.consumeZoomStep() === 0,
      'Z cannot zoom through the open wheel');
      input._onKeyDown(key('KeyH'));
      ok(input.getGrenadeType() === 0,
      'H cannot cycle the throwable through the open wheel');
      input._onKeyDown(key('KeyW'));
      ok(input.getKeys().forward,
      'movement stays live while the wheel is up');
      input.dispose();

      // Opening force-clears every held or queued combat intent.
      input = new Input({});
      input._onMouseDown({ button: 0, isTrusted: true, preventDefault() {} });
      ok(input.wantFireHeld && input.consumeFireTap(),
      'control: a closed left click holds fire and queues its tap');
      input.setWeaponWheelOpen(true);
      ok(!input.wantFireHeld && !input.consumeFireTap(),
      'opening the wheel force-clears held fire and any queued tap');
      input.dispose();
      input = new Input({});
      input._onKeyDown(key('KeyG', false, 1000));
      ok(input.isGrenadeCharging(),
      'control: a closed G starts the grenade hold');
      input.setWeaponWheelOpen(true);
      ok(!input.isGrenadeCharging() && input.consumeGrenadeThrow() === null,
      'opening the wheel cancels a cooking grenade without throwing it');
      input.dispose();

      // Escape cancels; a transient reset closes the wheel and drains every edge.
      input = new Input({});
      input.setWeaponWheelOpen(true);
      input._onKeyDown(key('Escape'));
      ok(input.takeWheelCancelRequest(),
      'Escape while the wheel is up queues the cancel');
      input._onKeyDown(key('Digit3'));
      input._onWheel(wheel(100, 500));
      input._onMouseMove({ movementX: 10, movementY: 0 });
      input.clearTransient();
      ok(!input.isWeaponWheelOpen() && !input.takeWheelOpenRequest()
          && !input.takeWheelRelease() && !input.takeWheelCancelRequest()
          && input.takeWheelDirectSlot() === null && input.takeWheelSteps() === 0
          && input.takeWheelVector().x === 0,
      'a transient reset closes the wheel and drains every wheel edge');
      input.dispose();
    } finally {
      input?.dispose();
      restore();
    }
  }

  {
    const { stickCurve, readGamepadFrame, PAD_BUTTONS } = await import('../../public/js/engine/gamepad.js');
    const { visibleTouchActions, TouchControls } =
      await import('../../public/js/engine/touch-controls.js');
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
        && [...prep].sort().join(',') === 'buy,jump'
        && [...live].sort().join(',') === 'ads,fire,interact,jump,reload,weapon',
    'touch buttons appear only for actions the current gameplay context allows');
    const wheelLive = visibleTouchActions({
      alive: true, canFire: true, canReload: true, grenades: 1, canInteract: true,
      weaponCount: 2, canBuy: false, scoped: true, wheelOpen: true,
    });
    ok(wheelLive.size === 0,
    'a wheelOpen touch context hides every chip (the pause button stays outside this set)');
    const holds = [];
    const controls = new TouchControls({
      documentRef: null,
      onHold: (action, held) => holds.push(`${action}:${held}`),
    });
    controls._heldPointers.set('fire', 7);
    controls._latched.add('ads');
    controls.setContext({ alive: true, canFire: false, grenades: 0 });
    ok(holds.includes('fire:false') && holds.includes('ads:false'),
    'hiding a held or latched touch button releases it before it disappears');
    ok(controls.setOptions({ size: 'large', hand: 'left' }).hand === 'left'
        && controls.setOptions({ size: 'huge' }).size === 'large',
    'touch layout options accept only known sizes and hands');
    controls.dispose();

    // Exercise the pointer callbacks, including cancellation, without a browser.
    const target = () => ({
      handlers: new Map(),
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener(type, fn) { this.handlers.set(type, fn); },
      removeEventListener(type) { this.handlers.delete(type); },
      dispatch(type, pointerId = 1, timeStamp = 0) {
        this.handlers.get(type)?.({ type, pointerId, timeStamp, clientX: 50, clientY: 50,
          preventDefault() {}, stopPropagation() {} });
      },
    });
    const pulses = [];
    const minimal = new TouchControls({ documentRef: null, onPulse: (action) => pulses.push(action) });
    minimal.setEnabled(true);
    minimal.dom.look = target();
    minimal._bindLook();
    minimal.dom.look.dispatch('pointerdown');
    minimal.dom.look.dispatch('pointerup', 1, 50);
    ok(pulses.length === 0, 'tapping the aim surface never fires a weapon');
    const swap = target();
    minimal._bindPulse(swap, 'weapon');
    for (const heldMs of [50, 900]) {
      swap.dispatch('pointerdown');
      swap.dispatch('pointerup', 1, heldMs);
    }
    ok(pulses.join(',') === 'weapon,weapon', 'short and long ammo-panel presses each swap once without opening a wheel');
    for (const cancelled of ['pointercancel', 'lostpointercapture']) {
      swap.dispatch('pointerdown');
      swap.dispatch(cancelled);
      swap.dispatch('pointerup');
    }
    swap.dispatch('pointerdown');
    swap.dispatch('pointerdown', 2);
    swap.dispatch('pointerup', 2);
    minimal.setContext({ alive: false });
    swap.dispatch('pointerup');
    ok(pulses.length === 2, 'cancelled, hidden, and secondary-finger presses cannot trigger a swap');
    minimal.dispose();

    const restore = installGlobals({ location: { search: '?headless=1' } });
    let pad = null;
    try {
      const { Input, PAD_WHEEL_HOLD_MS, WHEEL_VECTOR_RADIUS_PX } =
        await import('../../public/js/engine/input.js');
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
      // Pad wheel seam: Y is a tap/hold split, the d-pad steps the open wheel,
      // B cancels it instead of toggling crouch, and pad look steers the ring.
      padButtons[PAD_BUTTONS.weapon] = { pressed: true, value: 1 };
      pad.poll(1600, 1 / 60);
      padButtons[PAD_BUTTONS.weapon] = { pressed: false, value: 0 };
      pad.poll(1700, 1 / 60);
      ok(!pad.takeWheelOpenRequest() && pad.consumeWeaponSwitch() === 1,
      'a quick pad Y tap still queues one weapon switch without arming the wheel');
      padButtons[PAD_BUTTONS.weapon] = { pressed: true, value: 1 };
      pad.poll(1800, 1 / 60);
      pad.poll(2060, 1 / 60);
      ok(pad.takeWheelOpenRequest() && PAD_WHEEL_HOLD_MS === 260,
      'a pad Y held the full threshold queues exactly one wheel open');
      pad.setWeaponWheelOpen(true);
      padButtons[PAD_BUTTONS.crouch] = { pressed: true, value: 1 };
      pad.poll(2100, 1 / 60);
      ok(pad.takeWheelCancelRequest(),
      'pad B while the wheel is up queues the cancel instead of crouch');
      padButtons[PAD_BUTTONS.crouch] = { pressed: false, value: 0 };
      padButtons[PAD_BUTTONS.slotDown] = { pressed: true, value: 1 };
      pad.poll(2150, 1 / 60);
      padButtons[PAD_BUTTONS.slotDown] = { pressed: false, value: 0 };
      ok(pad.takeWheelSteps() === 1,
      'pad d-pad down steps the open wheel forward');
      padButtons[PAD_BUTTONS.slotUp] = { pressed: true, value: 1 };
      pad.poll(2200, 1 / 60);
      padButtons[PAD_BUTTONS.slotUp] = { pressed: false, value: 0 };
      ok(pad.takeWheelSteps() === -1,
      'pad d-pad up steps the open wheel backward');
      fake.axes = [0, 0, 1, 0];
      pad.poll(2250, 1 / 60);
      const wheelVec = pad.takeWheelVector();
      fake.axes = [0, 0, 0, 0];
      ok(Math.abs(wheelVec.x - 1) < 1e-9 && Math.abs(wheelVec.y) < 1e-9
          && pad.consumeDelta().dx === 0 && pad.consumeDelta().dy === 0,
      `pad look steers the wheel at the shared ${WHEEL_VECTOR_RADIUS_PX}px radius and freezes the camera`);
      fake.axes = [0, 0, 1, 0];
      pad.poll(2255, 1 / 60);
      pad._onKeyDown({ code: 'KeyQ', preventDefault() {} });
      pad._onKeyUp({ code: 'KeyQ', preventDefault() {} });
      fake.axes = [0, 0, -1, 1];
      pad.poll(2260, 1 / 60);
      const releasedPadVec = pad.takeWheelVector();
      ok(releasedPadVec.x === 1 && releasedPadVec.y === 0 && pad.takeWheelRelease()
          && pad.consumeDelta().dx === 0 && pad.consumeDelta().dy === 0,
        'pad look after Q release preserves prior wheel movement and cannot move the camera');
      pad._onKeyDown({ code: 'Escape', preventDefault() {} });
      pad.poll(2265, 1 / 60);
      const cancelledPadVec = pad.takeWheelVector();
      ok(cancelledPadVec.x === 0 && cancelledPadVec.y === 0 && pad.takeWheelCancelRequest(),
        'pad look after wheel cancel adds no selection movement');
      fake.axes = [0, 0, 0, 0];
      padButtons[PAD_BUTTONS.weapon] = { pressed: false, value: 0 };
      pad.poll(2300, 1 / 60);
      ok(!pad.takeWheelRelease(),
      'releasing Y while the wheel is up keeps it open');
      pad.setWeaponWheelOpen(false);
      pad.clearTransient();
      pad._onKeyDown({ code: 'KeyW', preventDefault() {} });
      for (const action of ['crouch', 'grenade', 'weapon', 'fire']) {
        padButtons[PAD_BUTTONS[action]] = { pressed: true, value: 1 };
      }
      pad.poll(3000, 1 / 60);
      pad.consumeFireTap();
      fake.connected = false;
      pad.poll(3050, 1 / 60);
      pad.poll(3100, 1 / 60);
      ok(pad.getKeys().forward && !pad.getKeys().crouch && !pad.wantFireHeld
          && !pad.isGrenadeCharging() && pad.consumeGrenadeThrow() === null
          && pad.consumeWeaponSwitch() === 0 && !pad.deviceInfo(3100).padActive,
        'controller disconnect cancels combat and crouch holds without throwing, swapping, or clearing keyboard movement');

      pad.setWeaponWheelOpen(true);
      pad._onTouchLook(40, 20);
      pad._onTouchHold('fire', true);
      pad._onTouchHold('grenade', true, 3200);
      pad._onTouchPulse('reload');
      pad._onTouchPulse('fireTap');
      pad.setWeaponWheelOpen(false);
      const afterWheel = pad.consumeDelta();
      ok(afterWheel.dx === 0 && afterWheel.dy === 0 && !pad.wantFireHeld
          && !pad.isGrenadeCharging() && !pad.getKeys().reload && !pad.consumeFireTap(),
        'touch input behind the weapon wheel cannot move the camera or queue combat after closing');
    } finally {
      pad?.dispose();
      restore();
    }
  }
}
