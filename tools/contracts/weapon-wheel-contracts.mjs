// Weapon wheel seam: pure geometry contracts. The controller DOM is verified
// visually by the orchestrator; here we pin only the shared math a consumer
// (input seam -> HUD facade -> overlay) relies on.

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
    hud: { ensureWeaponWheel() {}, setWeaponWheelState() {} },
    getContext: () => context,
  });
  const entries = controller.entries();
  ok(entries.length === 10 && entries[9].key === '[0]' && entries[9].ammo === '∞'
      && !entries[0].owned && entries[5].owned,
    'wheel entries use the real tenth-slot key and authoritative ownership');
  controller.openWheel();
  controller.commit(0);
  controller.openWheel();
  controller.commit(9);
  ok(!controller.open && picks.length === 1 && picks[0] === 9,
    'wheel confirmation ignores locked slots and equips an owned selection once');

}
