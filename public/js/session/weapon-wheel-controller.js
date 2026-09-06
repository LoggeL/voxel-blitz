import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { WEAPON_NAMES, WEAPON_CLASSES } from '../ui/hud-support.js';

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
   * snd/gungame when the server sent an owned list; otherwise every slot is usable.
   */
  entries() {
    const context = this.getContext();
    const authoritative = Array.isArray(context.self?.owned) &&
      (context.match?.mode === 'snd' || context.match?.mode === 'gungame');
    return WEAPON_IDS.map((id, slot) => {
      const locked = authoritative && !context.self.owned.includes(id);
      const ammo = context.weapon?.ammoOf(id);
      return {
        id,
        name: WEAPON_NAMES[id] || id.toUpperCase(),
        cls: WEAPON_CLASSES[id] || '',
        icon: `./assets/weapons/hud/${id}.png`,
        key: `[${(slot + 1) % 10}]`,
        ammo: locked ? '—' : (WEAPONS[id].mode === 'melee' ? '∞' : `${ammo?.mag || 0} / ${context.match?.mode === 'gungame' ? '∞' : ammo?.reserve || 0}`),
        owned: !locked,
        current: context.weapon?.slot === slot,
      };
    });
  }

  /**
   * Open the radial wheel: freezes aim in the input seam and shows the overlay.
   * Pointer-drag interaction is enabled only for touch users.
   */
  openWheel() {
    const context = this.getContext();
    if (!context.weapon || this.open) return false;
    this.open = true;
    this.input.setWeaponWheelOpen(true);
    this.hud.ensureWeaponWheel();
    this.hud.setWeaponWheelState({
      open: true,
      entries: this.entries(),
      pointerInteractive: this.input.usesTouchControls(),
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
   * Confirm a wheel pick (digit, gamepad confirm, touch/pointer release). A locked
   * or already-current weapon just closes without switching.
   */
  commit(slot) {
    const context = this.getContext();
    if (!this.open) return;
    const entry = this.entries()[slot];
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
    if (this.open && !forced && !openable) {
      this.close();
      return;
    }
    if (!this.open) {
      if (this.input.takeWheelOpenRequest() && (forced || openable)) this.openWheel();
      return;
    }
    if (this.input.takeWheelCancelRequest()) {
      this.close();
      return;
    }
    const direct = this.input.takeWheelDirectSlot();
    if (direct !== null) {
      this.commit(direct);
      return;
    }
    const steps = this.input.takeWheelSteps();
    if (steps) this.hud.setWeaponWheelState({ step: steps });
    const vector = this.input.takeWheelVector();
    if (vector.x || vector.y) this.hud.setWeaponWheelState({ x: vector.x, y: vector.y });
    if (this.input.takeWheelRelease()) {
      const highlighted = this.hud.weaponWheelHighlight();
      this.close(highlighted >= 0 ? highlighted : null);
      return;
    }
    const entries = this.entries();
    const sig = entries.map((entry) =>
      `${entry.id}|${entry.name}|${entry.ammo}|${entry.owned ? 1 : 0}|${entry.current ? 1 : 0}`).join(';');
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
