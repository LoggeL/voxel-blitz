import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { WEAPON_NAMES, WEAPON_CLASSES, weaponImagePath } from '../ui/hud-support.js';
import { usesOwnedLoadout } from '../../../shared/modes.js';
import { KIT_GADGET_LABELS, kitWeaponRole as kitRole, kitWeaponDigit } from '../../../shared/conquest-kits.js';
import { bindingLabel } from '../keybindings.js';

/** Conquest kit wheel segment order: one role per segment, clockwise from the top. */
export const KIT_WHEEL_ROLES = Object.freeze(['primary', 'gadget', 'sidearm', 'melee']);

/** Kit-relative slot binding that equips `id` in Conquest (`slot1` primary … `slot4` melee). */
function kitSlotAction(id) {
  const index = kitWeaponDigit(id);
  return index >= 0 ? `slot${index + 1}` : null;
}

/** Wheel ammo text for one weapon id in the given mode. */
function ammoLabel(context, id, mode) {
  if (WEAPONS[id].mode === 'melee') return '∞';
  const ammo = context.weapon?.ammoOf(id);
  return `${ammo?.mag || 0} / ${mode === 'gungame' ? '∞' : ammo?.reserve || 0}`;
}

/** Coordinates wheel input, ownership, and HUD presentation for one live session. */
export class WeaponWheelController {
  constructor({ input, hud, getContext, forceOpen = false }) {
    this.input = input;
    this.hud = hud;
    this.getContext = getContext;
    this.forceOpen = forceOpen;
    this.open = false;
    this._entriesSig = '';
  }

  /**
   * Wheel entries for every weapon slot: display name/class from the HUD support
   * tables, live ammo, and per-slot ownership. Ownership is only authoritative in
   * inventory-based modes when the server sent an owned list; otherwise every slot is usable.
   */
  entries() {
    const context = this.getContext();
    const mode = context.match?.mode;
    const authoritative = Array.isArray(context.self?.owned) && usesOwnedLoadout(mode);
    if (authoritative && mode === 'conquest') return this.kitEntries(context);
    // Kit-only gadgets (the STINGER) sit at the end of WEAPON_IDS and only appear
    // when the authoritative kit owns them, so every listed index stays its slot.
    const shown = WEAPON_IDS.filter(id => !WEAPONS[id].gadgetOnly || (authoritative && context.self.owned.includes(id)));
    return shown.map((id) => {
      const slot = WEAPON_IDS.indexOf(id);
      const locked = authoritative && !context.self.owned.includes(id) && !(mode === 'ttt' && id === 'knife');
      const ammo = context.weapon?.ammoOf(id);
      return {
        id,
        name: WEAPON_NAMES[id] || id.toUpperCase(),
        cls: WEAPON_CLASSES[id] || '',
        icon: weaponImagePath(id),
        key: slot < 10 ? `[${(slot + 1) % 10}]` : '[WHEEL]',
        ammo: locked ? '—' : ammoLabel(context, id, mode),
        owned: !locked,
        current: context.weapon?.slot === slot,
        slot,
      };
    });
  }

  /**
   * Conquest wheel: only what the kit carries, straight from the snapshot's
   * authoritative `owned` list, one segment per role in KIT_WHEEL_ROLES order
   * (primary, gadget, sidearm, melee; a kit without a gadget gets three).
   * `key` is the kit-relative slot key that equips the weapon outside the wheel
   * (KIT_DIGIT_ROLES: 1 primary, 2 sidearm, 3 gadget, 4 melee).
   */
  kitEntries(context = this.getContext()) {
    const owned = context.self.owned.filter(id => Object.hasOwn(WEAPONS, id) && WEAPON_IDS.includes(id));
    const ordered = KIT_WHEEL_ROLES.flatMap(role => owned.filter(id => kitRole(id) === role));
    return ordered.map((id) => {
      const slot = WEAPON_IDS.indexOf(id);
      const role = kitRole(id);
      const action = kitSlotAction(id);
      const gadgetRole = role === 'gadget' ? KIT_GADGET_LABELS[id]?.role : null;
      return {
        id,
        name: WEAPON_NAMES[id] || id.toUpperCase(),
        cls: WEAPON_CLASSES[id] || '',
        icon: weaponImagePath(id),
        key: action ? bindingLabel(action) : '',
        ammo: ammoLabel(context, id, 'conquest'),
        owned: true,
        current: context.weapon?.slot === slot,
        slot,
        role: gadgetRole ? `${role.toUpperCase()} · ${gadgetRole}` : role.toUpperCase(),
      };
    });
  }

  /**
   * Wheel index a slot key pressed while the wheel is open selects. The full
   * wheel lists weapons in slot order, so the key is the index; the kit wheel
   * finds the entry that kit-relative key equips outside it (1 primary,
   * 2 sidearm, 3 gadget, 4 melee). -1 when the kit carries nothing on that key.
   */
  directIndex(digitSlot, entries = this.entries()) {
    if (!entries.some(entry => entry.role)) return digitSlot;
    return entries.findIndex(entry => kitWeaponDigit(entry.id) === digitSlot);
  }

  /**
   * Open the radial wheel: freezes aim in the input seam and shows the overlay.
   * Unlocked pointers hover directly; locked mouse movement steers a virtual cursor.
   */
  openWheel() {
    const context = this.getContext();
    if (!context.weapon || this.open) return false;
    this.open = true;
    this.input.setWeaponWheelOpen(true);
    this.hud.setWeaponWheelState({
      open: true,
      entries: this.entries(),
      pointerInteractive: true,
      canMovePointer: () => !this.input.isWeaponWheelClosing(),
    });
    this._entriesSig = '';
    return true;
  }

  /**
   * Close the wheel. A non-null `slot` equips through forceWeapon, which re-checks
   * the authoritative owned list; cancel paths pass null and switch nothing.
   */
  close(slot = null) {
    const context = this.getContext();
    if (!this.open) return false;
    this.open = false;
    this.input.setWeaponWheelOpen(false);
    this.hud.setWeaponWheelState({ open: false });
    if (slot !== null && context.weapon) {
      context.weapon.forceWeapon(slot, { mode: context.match?.mode, owned: context.self?.owned });
    }
    return true;
  }

  /**
   * Confirm a wheel pick by wheel index (digit, gamepad confirm, touch/pointer
   * release); the entry's `slot` is what gets equipped. A locked or
   * already-current weapon, or an index without an entry, just closes.
   */
  commit(index) {
    const context = this.getContext();
    if (!this.open) return;
    const entry = this.entries()[index];
    const slot = entry?.slot ?? index;
    if (!entry?.owned || entry.current || slot === context.weapon?.slot) {
      this.close();
    } else {
      this.close(slot);
    }
  }

  /**
   * Per-frame wheel pump: ?ui=wheel debug force-open, open/close validation against
   * the live gameplay state, highlight streaming, and cancel/release edge handling.
   */
  sync() {
    const context = this.getContext();
    const forced = this.forceOpen && !!context.weapon;
    if (forced && !this.open) this.openWheel();
    const openable = context.enabled && context.alive &&
      context.self?.state === 'alive' && context.spectating !== true &&
      !this.hud.isBuyMenuOpen() && !this.hud.settingsOpen;
    if (this.open && ((!forced && !openable) || this.input.isWeaponWheelOpen?.() === false)) {
      this.close();
      return;
    }
    if (this.input.takeWheelCancelRequest()) {
      if (!this.close()) this.input.setWeaponWheelOpen(false);
      return;
    }
    if (!this.open) {
      if (!this.input.takeWheelOpenRequest() || (!forced && !openable)) return;
      if (!this.openWheel()) return;
    }
    const direct = this.input.takeWheelDirectSlot();
    if (direct !== null) {
      this.commit(this.directIndex(direct));
      return;
    }
    const steps = this.input.takeWheelSteps();
    if (steps) this.hud.setWeaponWheelState({ step: steps });
    const vector = this.input.takeWheelVector(this.hud.weaponWheelRadius());
    if (vector.x || vector.y) {
      this.hud.setWeaponWheelState({ dx: vector.x, dy: vector.y });
      if (!this.open) return; // Crossing the outer ring can commit synchronously.
    }
    if (this.input.takeWheelRelease()) {
      const highlighted = this.hud.weaponWheelHighlight();
      if (highlighted >= 0) this.commit(highlighted);
      else this.close();
      return;
    }
    const entries = this.entries();
    const sig = entries.map((entry) =>
      `${entry.id}|${entry.name}|${entry.ammo}|${entry.key}|${entry.owned ? 1 : 0}|${entry.current ? 1 : 0}`).join(';');
    if (sig !== this._entriesSig) {
      this._entriesSig = sig;
      this.hud.setWeaponWheelState({ entries });
    }
  }

  reset() {
    this.open = false;
    this._entriesSig = '';
    this.input.setWeaponWheelOpen(false);
    this.hud.setWeaponWheelState({ open: false });
  }
}

/**
 * Session side of the grenade pouch radial. Input owns the pouch state (hover,
 * confirm, wheel exclusivity); this closes it when gameplay can no longer use it
 * and routes the overlay's touch picks back into the input seam. The HUD paints
 * it from setState's grenadePouch* fields.
 */
export class GrenadePouchSessionController {
  constructor({ input, hud, getContext }) {
    this.input = input;
    this.hud = hud;
    this.getContext = getContext;
  }

  get open() { return !!this.input.isGrenadePouchOpen?.(); }

  /** Touch: a tapped stocked slot readies it; a tap outside closes without a change. */
  setup() {
    this.hud.setupGrenadePouch?.({
      onPick: (slot) => this.pick(slot),
      onCancel: () => this.input.setGrenadePouchOpen?.(false),
    });
  }

  pick(slot) {
    if (!this.open) return false;
    this.input.setGrenadePouchHover(slot);
    return this.input.setGrenadePouchOpen(false, { confirm: true });
  }

  /** Per frame: the pouch never outlives death, spectating, menus or disabled gameplay. */
  sync() {
    if (!this.open) return;
    const context = this.getContext();
    const usable = context.enabled && context.alive && context.self?.state === 'alive' &&
      context.spectating !== true && !this.hud.isBuyMenuOpen() && !this.hud.settingsOpen;
    if (!usable) this.input.setGrenadePouchOpen(false);
  }

  reset() {
    this.input.setGrenadePouchOpen?.(false);
    this.hud.setGrenadePouchState?.({ open: false });
  }
}
