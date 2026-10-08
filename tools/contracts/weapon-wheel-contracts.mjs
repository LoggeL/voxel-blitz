// Wheel geometry and session lifecycle. Real pointer/DOM interactions are
// covered separately by `npm run wheel:browser`.

export async function runWeaponWheelContracts(ok) {
  const { WHEEL_DEAD_ZONE, wheelAngleForSlot, wheelSlotFromVector } =
    await import('../../public/js/ui/weapon-wheel.js');

  ok(WHEEL_DEAD_ZONE > 0 && WHEEL_DEAD_ZONE < 1
      && wheelSlotFromVector(WHEEL_DEAD_ZONE * 0.5, 0, 8) === -1
      && wheelSlotFromVector(0, -(WHEEL_DEAD_ZONE + 0.01), 8) === 0,
    'the default dead zone ignores small deflections and selects just outside it');

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
    'a ten-slot wheel maps up/right/down/left onto slots 0/3/5/8');
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
  const { WEAPON_IDS } = await import('../../shared/combatmath.js');
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
  ok(WEAPON_IDS.slice(0, 14).join() === 'rifle,smg,shotgun,sniper,lmg,revolver,longarc,rocket,lance,knife,minigun,flamethrower,glaive,bubble'
      && WEAPON_IDS[14] === 'mgl' && entries.length === 15
      && entries[9].key === '[0]' && entries[9].ammo === '∞'
      && entries[14].id === 'mgl' && entries[14].name === 'GL-3 SKIPJACK'
      && entries[14].key === '[WHEEL]' && entries[14].ammo === '—' && !entries[14].owned
      && !entries[0].owned && entries[5].owned,
    'wheel appends SKIPJACK without changing legacy numeric slots and uses authoritative ownership');
  controller.openWheel();
  controller.commit(0);
  controller.openWheel();
  controller.commit(9);
  ok(!controller.open && picks.length === 1 && picks[0] === 9,
    'wheel confirmation ignores locked slots and equips an owned selection once');

  for (const mode of ['ttt', 'bastion', 'snd', 'gungame', 'duel']) {
    context.match.mode = mode;
    context.self.owned = [];
    ok(controller.entries().every(entry => entry.owned === (mode === 'ttt' && entry.id === 'knife')), `${mode}: an empty authoritative inventory keeps only the TTT knife available`);
    context.self.owned = ['rifle'];
    ok(controller.entries().filter(entry => entry.owned).map(entry => entry.id).join() === (mode === 'ttt' ? 'rifle,knife' : 'rifle'),
      `${mode}: only the carried weapon is selectable`);
  }
  for (const mode of ['fun', 'chaos', 'tdm', 'training']) {
    context.match.mode = mode;
    ok(controller.entries().every(entry => entry.owned), `${mode}: the wheel opens without restricting the loadout`);
  }
  context.match.mode = 'snd'; context.self.owned = ['revolver', 'knife'];

  // Conquest: the wheel lists only what the kit carries, from the snapshot's
  // authoritative owned list, in primary / gadget / sidearm / melee order.
  {
    const { kitLoadout } = await import('../../shared/conquest-kits.js');
    const { KIT_WHEEL_ROLES } = await import('../../public/js/session/weapon-wheel-controller.js');
    const kitPicks = [];
    const kitContext = { match: { mode: 'conquest' }, self: { owned: [], state: 'alive' }, enabled: true, alive: true, spectating: false,
      weapon: { slot: 0, ammoOf: (id) => ammoBy[id], forceWeapon: (slot) => kitPicks.push(slot) } };
    let ammoBy = {};
    const equip = (kit, variant = 0, gadget = 0, current = 'primary') => {
      const loadout = kitLoadout(kit, variant, gadget);
      // The snapshot's owned list may arrive in any order; the wheel orders by role.
      kitContext.self.owned = [...loadout.owned].reverse();
      ammoBy = Object.fromEntries(WEAPON_IDS.map((id, slot) => [id, { mag: loadout.mag[slot], reserve: loadout.reserve[slot] }]));
      kitContext.weapon.slot = WEAPON_IDS.indexOf(loadout[current]);
      return loadout;
    };
    const kitWheel = new WeaponWheelController({
      input: { setWeaponWheelOpen() {}, isWeaponWheelClosing: () => false },
      hud: { setWeaponWheelState() {} },
      getContext: () => kitContext,
    });
    const view = () => kitWheel.entries().map(e => `${e.id}:${e.role}:${e.key}:${e.ammo}:${e.current ? 'eq' : ''}`).join(' ');

    ok(KIT_WHEEL_ROLES.join() === 'primary,gadget,sidearm,melee', 'the kit wheel orders segments primary, gadget, sidearm, melee');
    equip('engineer', 0, 0);
    ok(view() === 'smg:PRIMARY:2:36 / 6:eq rocket:GADGET · AT:8:1 / 4: revolver:SIDEARM:6:6 / 8: knife:MELEE:0:∞:',
      `conquest Engineer AT: four segments, slot keys, issued ammo, equipped primary (${view()})`);
    equip('engineer', 1, 1, 'gadget');
    ok(view() === 'shotgun:PRIMARY:3:7 / 42: stinger:GADGET · AA:8:1 / 2:eq revolver:SIDEARM:6:6 / 8: knife:MELEE:0:∞:',
      `conquest Engineer AA: the STINGER takes the gadget segment on the launcher digit (${view()})`);
    ok(kitWheel.entries().every(e => e.owned) && !kitWheel.entries().some(e => ['rocket', 'rifle', 'mgl'].includes(e.id)),
      'conquest: no locked or unowned weapons are listed');
    equip('assault');
    ok(view() === 'rifle:PRIMARY:1:30 / 6:eq revolver:SIDEARM:6:6 / 8: knife:MELEE:0:∞:',
      `conquest Assault: no gadget, three segments (${view()})`);
    equip('support', 1);
    ok(kitWheel.entries()[0].id === 'minigun' && kitWheel.entries()[0].key === '' && kitWheel.entries().length === 3,
      'conquest Support FURNACE: a primary without a digit shows no key badge');

    // Selection maps the wheel index to the weapon slot; digits map through the kit.
    equip('engineer', 0, 1);
    kitPicks.length = 0;
    kitWheel.openWheel();
    kitWheel.commit(1);
    kitWheel.openWheel();
    kitWheel.commit(2);
    ok(kitPicks.join() === `${WEAPON_IDS.indexOf('stinger')},${WEAPON_IDS.indexOf('revolver')}`,
      `conquest: picking segments equips the STINGER and the sidearm by weapon slot (${kitPicks.join()})`);
    ok(kitWheel.directIndex(WEAPON_IDS.indexOf('rocket')) === 1 && kitWheel.directIndex(9) === 3
        && kitWheel.directIndex(5) === 2 && kitWheel.directIndex(1) === 0 && kitWheel.directIndex(0) === -1,
      'conquest: digits pressed in the wheel pick the entry they equip outside it (launcher digit -> gadget)');
    kitPicks.length = 0;
    kitWheel.openWheel();
    kitWheel.commit(kitWheel.directIndex(0));
    kitWheel.openWheel();
    kitWheel.commit(0);
    ok(!kitWheel.open && kitPicks.length === 0,
      'conquest: a digit the kit lacks and the already equipped primary close without switching');

    kitContext.self.owned = undefined;
    ok(kitWheel.entries().length === 15 && kitWheel.entries().every(e => !e.role),
      'conquest before the first owned list falls back to the full wheel');
    for (const mode of ['snd', 'tdm', 'ttt']) {
      kitContext.match.mode = mode;
      kitContext.self.owned = ['rifle', 'revolver', 'knife'];
      ok(kitWheel.entries().length === 15 && kitWheel.entries().every((e, i) => !e.role && e.slot === i)
          && kitWheel.directIndex(4) === 4,
        `${mode}: the full roster wheel is unchanged (no kit roles, index == slot)`);
    }
  }

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
      'wheel-key press, card movement and release before a frame equip once using the visible radius');
  }
  {
    const { queue, state, wheel } = gestureHarness();
    queue.open = queue.release = true;
    wheel.sync();
    ok(!wheel.open && !state.open && state.picks.length === 0,
      'a quick centered wheel-key tap closes without equipping a weapon');
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
      'wheel-key release immediately freezes absolute pointer hover before the next frame');
    wheel.sync();
    ok(!wheel.open && state.picks.join() === '11',
      'wheel-key release uses the current HUD highlight even without relative mouse movement');
  }
  {
    // The real input seam: the grenade pouch and the wheel never stack, and the open
    // wheel's scroll or pad Y branches no longer touch the throwable.
    const { Input } = await import('../../public/js/engine/input.js');
    const input = new Input({});
    input.fallback = true;
    try {
      input.setGrenadeCounts([1, 1, 1, 1, 1]);
      input.setGrenadePouchOpen(true);
      const wheel = new WeaponWheelController({
        input,
        hud: { setWeaponWheelState() {}, weaponWheelRadius: () => 230, weaponWheelHighlight: () => -1 },
        getContext: () => ({ ...context, match: { mode: 'fun' } }),
      });
      wheel.openWheel();
      ok(wheel.open && input.isWeaponWheelOpen() && !input.isGrenadePouchOpen()
          && !input.setGrenadePouchOpen(true),
        'opening the weapon wheel closes the grenade pouch and blocks it while the wheel is up');
      input._onWheel({ deltaY: 100, deltaMode: 0, timeStamp: 100, preventDefault() {} });
      ok(input.takeWheelSteps() === 1 && input.getGrenadeType() === 0,
        'the open wheel scroll steps wheel slots and never cycles the throwable');
      wheel.close();
    } finally { input.dispose(); }
  }
}
