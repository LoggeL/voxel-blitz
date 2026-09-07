// Wheel geometry and session lifecycle. Real pointer/DOM interactions are
// covered separately by tools/weapon-wheel-browser-test.mjs.

export async function runWeaponWheelContracts(ok) {
  const { WHEEL_DEAD_ZONE, wheelAngleForSlot, wheelSlotFromVector } =
    await import('../../public/js/ui/weapon-wheel.js');

  ok(WHEEL_DEAD_ZONE === 0.32,
    'the weapon wheel pins its selection dead zone');

  ok(wheelAngleForSlot(0, 4) === 270 && wheelAngleForSlot(1, 4) === 0
      && wheelAngleForSlot(2, 4) === 90 && wheelAngleForSlot(3, 4) === 180,
    'slot angles grow clockwise in atan2 space with slot 0 at the top (normalized -90)');

  ok(wheelSlotFromVector(0, -1, 8) === 0 && wheelSlotFromVector(1, 0, 8) === 2
      && wheelSlotFromVector(0, 1, 8) === 4 && wheelSlotFromVector(-1, 0, 8) === 6,
    'an eight-slot wheel maps up/right/down/left onto slots 0/2/4/6');
  ok(wheelSlotFromVector(0, -1, 6) === 0 && wheelSlotFromVector(1, 0, 6) === 2
      && wheelSlotFromVector(0, 1, 6) === 3 && wheelSlotFromVector(-1, 0, 6) === 5,
    'a six-slot wheel keeps the top slot and spreads the cardinals clockwise');
  ok(wheelSlotFromVector(0, -1, 4) === 0 && wheelSlotFromVector(1, 0, 4) === 1
      && wheelSlotFromVector(0, 1, 4) === 2 && wheelSlotFromVector(-1, 0, 4) === 3,
    'a four-slot wheel gives each cardinal its own slot');
  ok(wheelSlotFromVector(0, -1, 10) === 0 && wheelSlotFromVector(1, 0, 10) === 3
      && wheelSlotFromVector(0, 1, 10) === 5 && wheelSlotFromVector(-1, 0, 10) === 8,
    'the shipped ten-slot wheel maps up/right/down/left onto slots 0/3/5/8');
  ok(wheelSlotFromVector(Math.sin(Math.PI / 10), -Math.cos(Math.PI / 10), 10) === 1,
    'a vector on the ten-slot half-up boundary between slots rounds into the next clockwise slot');
  ok(wheelSlotFromVector(-Math.sin(Math.PI / 10), -Math.cos(Math.PI / 10), 10) === 0,
    'a vector on the last ten-slot half-up boundary wraps around into slot 0');

  ok(wheelSlotFromVector(0.1, 0.1, 8) === -1 && wheelSlotFromVector(0, 0, 8) === -1
      && wheelSlotFromVector(NaN, 1, 8) === -1 && wheelSlotFromVector(1, NaN, 8) === -1
      && wheelSlotFromVector(0, 1, 0) === -1,
    'vectors inside the dead zone and non-finite or empty wheels select nothing');

  // Half-up sector boundaries at 22.5deg and 337.5deg for a eight-slot wheel.
  ok(wheelSlotFromVector(Math.sin(Math.PI / 8), -Math.cos(Math.PI / 8), 8) === 1,
    'a vector on the half-up boundary between slots rounds into the next clockwise slot');
  ok(wheelSlotFromVector(-Math.sin(Math.PI / 8), -Math.cos(Math.PI / 8), 8) === 0,
    'a vector on the last half-up boundary wraps around into slot 0');
  const { WeaponWheelController } = await import('../../public/js/session/weapon-wheel-controller.js');
  const picks = [];
  const context = {
    match: { mode: 'snd' }, self: { owned: ['revolver', 'knife'], state: 'alive' },
    enabled: true, alive: true, spectating: false,
    weapon: { slot: 5, ammoOf: () => ({ mag: 6, reserve: 3 }), forceWeapon: (slot) => picks.push(slot) },
  };
  const controller = new WeaponWheelController({
    input: { setWeaponWheelOpen() {}, usesTouchControls: () => false },
    hud: { setWeaponWheelState() {} },
    getContext: () => context,
  });
  const entries = controller.entries();
  ok(entries.length === 12 && entries[9].key === '[0]' && entries[9].ammo === '∞'
      && !entries[0].owned && entries[5].owned,
    'wheel entries use the real tenth-slot key and authoritative ownership');
  controller.openWheel();
  controller.commit(0);
  controller.openWheel();
  controller.commit(9);
  ok(!controller.open && picks.length === 1 && picks[0] === 9,
    'wheel confirmation ignores locked slots and equips an owned selection once');

  const { WHEEL_COMMIT_RADIUS } = await import('../../public/js/ui/weapon-wheel.js');
  // The facade uses the real sector math; queued input represents one frame's
  // complete gesture, including motion and release arriving before it opens.
  function gestureHarness() {
    const queue = { open: false, cancel: false, release: false, vector: { x: 0, y: 0 } };
    const state = { open: false, x: 0, y: 0, highlighted: -1, radius: null, picks: [] };
    let inputOpen = false;
    const take = (key) => { const value = queue[key]; queue[key] = false; return value; };
    const input = {
      isWeaponWheelOpen: () => inputOpen,
      isWeaponWheelClosing: () => queue.release || queue.cancel,
      setWeaponWheelOpen(value) {
        inputOpen = value;
        if (!value) {
          queue.open = queue.cancel = queue.release = false;
          queue.vector = { x: 0, y: 0 };
        }
      },
      takeWheelOpenRequest: () => take('open'),
      takeWheelCancelRequest: () => take('cancel'),
      takeWheelRelease: () => take('release'),
      takeWheelDirectSlot: () => null,
      takeWheelSteps: () => 0,
      takeWheelVector(radius) {
        state.radius = radius;
        const vector = queue.vector;
        queue.vector = { x: 0, y: 0 };
        return vector;
      },
    };
    const hud = {
      settingsOpen: false,
      isBuyMenuOpen: () => false,
      weaponWheelRadius: () => 230,
      weaponWheelHighlight: () => state.highlighted,
      setWeaponWheelState(update) {
        if (update.canMovePointer) state.canMovePointer = update.canMovePointer;
        if (update.open !== undefined) {
          state.open = update.open;
          state.x = state.y = 0;
          state.highlighted = -1;
        }
        if (update.dx || update.dy) {
          state.x += update.dx || 0;
          state.y += update.dy || 0;
          state.highlighted = wheelSlotFromVector(state.x, state.y, 12);
          if (Math.hypot(state.x, state.y) >= WHEEL_COMMIT_RADIUS) wheel.commit(state.highlighted);
        }
      },
    };
    const wheel = new WeaponWheelController({ input, hud, getContext: () => ({
      ...context,
      match: { mode: 'fun' },
      weapon: { ...context.weapon, forceWeapon: (slot) => state.picks.push(slot) },
    }) });
    return { queue, state, input, wheel };
  }

  {
    const { queue, state, wheel } = gestureHarness();
    queue.open = queue.release = true;
    queue.vector = { x: -1, y: 0 };
    wheel.sync();
    ok(!wheel.open && !state.open && state.picks.join() === '9' && state.radius === 230,
      'Q press, card movement and release before a frame equip once using the visible radius');
  }
  {
    const { queue, state, wheel } = gestureHarness();
    queue.open = queue.release = true;
    wheel.sync();
    ok(!wheel.open && !state.open && state.picks.length === 0,
      'a quick centered Q tap closes without equipping a weapon');
  }
  {
    const { queue, state, wheel } = gestureHarness();
    queue.open = queue.cancel = true;
    queue.vector = { x: -2, y: 0 };
    wheel.sync();
    wheel.sync();
    ok(!wheel.open && !state.open && state.picks.length === 0,
      'Escape cancels a queued opening before its outward movement can equip');
  }
  {
    const { queue, state, wheel } = gestureHarness();
    queue.open = queue.release = true;
    queue.vector = { x: -2, y: 0 };
    wheel.sync();
    wheel.sync();
    ok(!wheel.open && !state.open && state.picks.join() === '9',
      'an outward commit ends the frame before its queued release can equip twice or reopen');
  }
  {
    const { queue, state, input, wheel } = gestureHarness();
    queue.open = true;
    wheel.sync();
    input.setWeaponWheelOpen(false);
    wheel.sync();
    ok(!wheel.open && !state.open && state.picks.length === 0,
      'input focus reset closes the overlay without requiring a cancel edge');
  }
  {
    const { queue, state, wheel } = gestureHarness();
    queue.open = true;
    wheel.sync();
    state.highlighted = 11; // Absolute mouse hover comes directly from the HUD.
    queue.release = true;
    ok(!state.canMovePointer(),
      'Q release immediately freezes absolute pointer hover before the next frame');
    wheel.sync();
    ok(!wheel.open && state.picks.join() === '11',
      'Q release uses the current HUD highlight even without relative mouse movement');
  }
}
