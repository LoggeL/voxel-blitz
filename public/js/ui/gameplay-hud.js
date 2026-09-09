import { isScopeActive } from '../guns/scope-state.js';
import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import {
  CARDINAL,
  clamp01,
  el,
  resolveKey,
  spreadFromCone,
  beamReticleRadiusPx,
  weaponImagePath,
} from './hud-support.js';
import { Scoreboard } from './scoreboard.js';
import { MatchHud } from './match-hud.js';
import { createSniperScope } from './sniper-scope.js';
import { displaySettings } from './display-settings.js';
import { NetworkHud } from './network-hud.js';
import { PowerupHud } from './powerup-hud.js';
import { GRENADE_TYPES, GRENADE_TYPE_IDS, clampGrenadeType } from '../../../shared/grenade-rules.js';
import { FLAME_RULES } from '../../../shared/flame-rules.js';

const EMPTY_READ_MODEL = Object.freeze({ dead: false, painImpulse: 0 });
const noop = () => {};

function clearBag(bag) {
  for (const key of Object.keys(bag)) delete bag[key];
}

/** Owns the live gameplay DOM, per-frame presentation state, and its RAFs/listeners. */
export class GameplayHud {
  constructor({
    root = null,
    ensureSettings = noop,
    ensureBuyMenu = noop,
    onBuyMenuState = noop,
    onBeforeBuild = noop,
    readModel = EMPTY_READ_MODEL,
    matchHud = null,
  } = {}) {
    this._rootProvider = root;
    this._ownedHudRoot = null;
    this.ensureSettings = ensureSettings;
    this.ensureBuyMenu = ensureBuyMenu;
    this.onBeforeBuild = onBeforeBuild;
    this.readModel = readModel;

    this.built = false;
    this.st = {};
    this._painted = {};
    this.dom = {};
    this.scoreboard = new Scoreboard();
    this.scoreboardMatch = null;
    this.scoreboardSelfId = null;

    this.scopeShown = false;
    this.scopeProgress = 0;
    this.scopeRAF = 0;
    this.compassRAF = 0;
    this.ringOn = false;
    this.compassW = 0;
    this.compassPPD = 2;
    this.compassZeroX = 720;
    this.compassMeasured = false;
    this.lastWepKey = '';
    this.chGap = undefined;
    this._scopeZoomShown = 0;

    this.tabBound = false;
    this.onKD = null;
    this.onKU = null;
    this._onWindowResize = () => {
      this.compassW = 0;
      this.compassMeasured = false;
    };

    this.match = matchHud || new MatchHud({
      onBuyMenuState,
      onPlayers: (players, match, selfRow) => this.setPlayers(players, match, selfRow),
      readModel,
    });
    this.matchDom = this.match.dom;
    this.network = new NetworkHud();
    this.powerups = new PowerupHud();
  }

  buildHUD() {
    this.onBeforeBuild();
    this.built = true;
    if (this.scopeRAF) {
      cancelAnimationFrame(this.scopeRAF);
      this.scopeRAF = 0;
    }
    if (this.compassRAF) {
      cancelAnimationFrame(this.compassRAF);
      this.compassRAF = 0;
    }
    this.scopeShown = false;
    this.scopeProgress = 0;
    this.ringOn = false;
    this.compassW = 0;
    this.compassPPD = 2;
    this.compassZeroX = 720;
    this.compassMeasured = false;
    this.lastWepKey = '';
    this._scopeZoomShown = 0;
    clearBag(this.dom);
    this._painted = {};
    this.chGap = undefined;

    const hud = this._root('hud');
    hud.innerHTML = '';
    const d = this.dom;

    this.match.build(hud);
    this.network.build(hud);

    d.ch = el('div', '', hud, 'crosshair');
    for (let i = 0; i < 4; i++) el('span', 'ch-arm', d.ch);
    d.beamRing = el('div', 'vb-beam-reticle', d.ch);
    d.beamRing.style.display = 'none';
    d.ring = el('div', 'vb-reload-ring', d.ch);
    d.ring.style.display = 'none';
    d.ringHint = el('div', '', d.ch, 'reload-hint');
    d.ringHint.textContent = 'RELOADING';
    d.ringHint.style.display = 'none';
    // Breath meter: only while aiming, shows the hold-breath window draining.
    d.breath = el('div', 'vb-breath-meter', hud, 'breath-meter');
    d.breathFill = el('i', '', d.breath);
    d.breathHint = el('span', 'vb-breath-hint', d.breath);
    d.breathHint.textContent = 'SHIFT · STEADY YOURSELF';
    d.breath.style.display = 'none';
    if (this.st.crosshairConeDeg != null) {
      this.setSpread(spreadFromCone(this.st.crosshairConeDeg));
    } else {
      this.setSpread(this.st.bloomPx);
    }

    d.hb = el('div', '', hud, 'healthbar');
    d.track = el('div', 'hp-track', d.hb);
    d.hpf = el('div', '', d.track, 'hpfill');
    this.powerups.build(hud, d.hb);
    d.conditionMeters = ['pain', 'panic'].map(key => {
      const root = el('div', `vb-condition-meter vb-condition-${key}`, d.hb, `${key}-meter`);
      root.hidden = true;
      root.setAttribute('role', 'meter');
      root.setAttribute('aria-label', key === 'pain' ? 'Pain' : 'Panic');
      root.setAttribute('aria-valuemin', '0');
      root.setAttribute('aria-valuemax', '100');
      el('span', '', root).textContent = key.toUpperCase();
      const value = el('b', '', root);
      const track = el('div', 'vb-condition-track', root);
      const fill = el('i', '', track);
      return { key, root, value, fill, percent: -1 };
    });

    d.ammo = el('div', '', hud, 'ammo');
    d.weaponIcon = el('img', 'vb-weapon-icon', d.ammo, 'weapon-icon');
    d.weaponIcon.alt = '';
    d.weaponIcon.setAttribute('aria-hidden', 'true');
    // Kept outside #ammo because that panel's angular clip-path also clips
    // absolutely positioned descendants above its bounds.
    d.grenades = el('div', 'vb-grenade-count', hud, 'grenade-count');
    d.grenadeKey = el('span', 'vb-grenade-key', d.grenades);
    d.grenadeKey.textContent = 'G';
    d.grenadeSwitch = el('span', 'vb-grenade-switch', d.grenades);
    d.grenadeSwitch.textContent = 'H · SWITCH';
    d.grenadeSwitch.title = 'Switch grenade type (H)';
    d.grenadeTypes = el('span', 'vb-grenade-types', d.grenades);
    d.grenadeTypeChips = [];
    for (const typeId of GRENADE_TYPE_IDS) {
      const type = GRENADE_TYPES[typeId];
      const chip = el('span', `vb-grenade-type vb-grenade-type-${typeId}`, d.grenadeTypes);
      chip.dataset.type = typeId;
      chip.style.setProperty('--nade', type.color);
      const label = el('b', 'vb-grenade-type-label', chip);
      label.textContent = type.short;
      const pips = el('span', 'vb-grenade-icons', chip);
      chip.pips = [];
      for (let i = 0; i < type.perLife; i++) {
        const icon = el('span', 'vb-grenade-icon is-spent', pips);
        icon.setAttribute('aria-hidden', 'true');
        chip.pips.push(icon);
      }
      d.grenadeTypeChips.push(chip);
    }
    d.grenadeName = el('span', 'vb-grenade-name', d.grenades);
    d.grenadeName.textContent = GRENADE_TYPES[GRENADE_TYPE_IDS[0]].name;
    d.grenades.dataset.type = GRENADE_TYPE_IDS[0];
    d.grenades.style.setProperty('--nade', GRENADE_TYPES[GRENADE_TYPE_IDS[0]].color);
    d.grenadeCharge = el('span', 'vb-grenade-charge', d.grenades);
    d.grenadeChargeFill = el('i', '', d.grenadeCharge);
    d.grenadeHint = el('span', 'vb-grenade-hint', d.grenades);
    d.grenadeHint.textContent = 'HOLD · RELEASE';
    this._grenadeType = 0;
    d.grenadeTypeChips[0].classList.add('is-selected');
    // Charge weapons (LONGARC): capacitor meter under the ammo panel.
    d.chargeMeter = el('div', 'vb-charge-meter', hud, 'charge-meter');
    d.chargeMeterTrack = el('span', 'vb-charge-track', d.chargeMeter);
    d.chargeMeterFill = el('i', '', d.chargeMeterTrack);
    d.chargeMeterLabel = el('span', 'vb-charge-label', d.chargeMeter);
    d.chargeMeterLabel.textContent = 'COIL CHARGE';
    d.mag = el('span', '', d.ammo, 'ammocount');
    d.sep = el('span', '', d.ammo);
    d.sep.textContent = '/';
    d.res = el('span', '', d.ammo, 'ammoreserve');
    d.wname = el('div', '', d.ammo, 'weaponname');

    d.kf = el('div', '', hud, 'killfeed');
    d.dmglayer = el('div', '', hud, 'dmglayer');

    d.sb = this.scoreboard.build(hud);

    d.hitmarker = el('div', '', hud, 'hitmarker');
    d.lowhp = el('div', '', hud, 'lowhp-vignette');
    d.lowhp.style.opacity = '0';

    d.flash = el('div', '', hud, 'hitflash');
    d.flash.style.opacity = '0';

    d.deathFx = el('div', 'vb-death-fx', hud, 'death-fx');
    d.deathFx.style.setProperty('--death-opacity', '0.58');
    d.deathFx.style.setProperty('--death-blood-opacity', '0.38');

    d.compass = el('div', '', hud, 'compass');
    d.strip = el('div', '', d.compass, 'compassstrip');
    d.ticks = new Map();
    for (let deg = -360; deg < 720; deg += 15) {
      const norm = ((deg % 360) + 360) % 360;
      let cls = 'minor';
      let label = '';
      if (deg % 90 === 0) {
        cls = 'deg';
        label = CARDINAL[norm];
      } else if (deg % 45 === 0) {
        cls = 'deg';
        label = String(norm);
      }
      const tick = el('span', cls, d.strip);
      tick.textContent = label;
      if (!d.ticks.has(norm)) d.ticks.set(norm, tick);
    }

    this.ensureSettings();
    this.ensureBuyMenu();

    if (!this.tabBound) {
      this.tabBound = true;
      this.onKD = (event) => {
        if (event.code === 'Tab') {
          event.preventDefault();
          this.setScoreboard(true);
        }
      };
      this.onKU = (event) => {
        if (event.code === 'Tab') {
          event.preventDefault();
          this.setScoreboard(false);
        }
      };
      document.addEventListener('keydown', this.onKD);
      document.addEventListener('keyup', this.onKU);
      window.addEventListener('resize', this._onWindowResize);
    }

    this.apply();
  }

  menuDone() {
    const menu = document.getElementById('menu');
    if (menu) {
      menu.classList.add('hidden');
      menu.style.display = 'none';
      menu.setAttribute('aria-hidden', 'true');
    }
    const hud = document.getElementById('hud');
    if (hud) hud.classList.remove('hidden');
    if (this.built) this.apply();
  }

  setState(state) {
    Object.assign(this.st, state || {});
    if (!this.built) return;
    this.apply();
  }

  apply() {
    const s = this.st;
    const d = this.dom;
    if (!d.hpf) return;
    const alive = s.alive !== false && this.readModel.dead !== true;
    const painted = this._painted;
    const key = resolveKey(s.wid);
    this.powerups.update(s.armor, alive);

    if (s.hp != null) {
      const hp = Math.min(100, Math.max(0, Number(s.hp)));
      if (hp !== painted.hp) {
        painted.hp = hp;
        d.hpf.style.width = `${hp}%`;
        d.hb.dataset.hp = String(Math.round(hp));
        d.hb.classList.toggle('critical', hp < 30);
      }
      const low = alive && hp < 35;
      const opacity = low
        ? (((35 - hp) / 35) * 0.85 * (0.82 + 0.18 * Math.sin((performance.now() / 1200) * Math.PI * 2))).toFixed(3)
        : '0';
      if (d.lowhp.style.opacity !== opacity) d.lowhp.style.opacity = opacity;
    } else {
      d.lowhp.style.opacity = '0';
    }

    if (key !== this.lastWepKey) {
      const tint = WEAPON_IDS.includes(key) ? `vb-w-${key}` : '';
      d.wname.className = tint;
      d.ammo.className = tint;
      if (key) d.weaponIcon.src = weaponImagePath(key);
      d.res.title = WEAPONS[key]?.spareRounds != null ? 'Spare shells' : 'Spare magazines';
      d.res.setAttribute('aria-label', d.res.title);
      this.lastWepKey = key;
    }
    const melee = WEAPONS[key]?.mode === 'melee';
    if (s.mag != null && (s.mag !== painted.mag || melee !== painted.melee)) {
      painted.mag = s.mag;
      painted.melee = melee;
      d.mag.textContent = melee ? '∞' : String(Math.max(0, s.mag | 0));
      d.sep.style.display = melee ? 'none' : '';
      d.res.style.display = melee ? 'none' : '';
    }
    if (painted.ammoWeapon !== key || painted.ammoMag !== s.mag) {
      painted.ammoWeapon = key;
      painted.ammoMag = s.mag;
      this.updateAmmoLow();
    }
    if (s.reserve != null && (s.reserve !== painted.reserve || s.infiniteMagazines !== painted.infiniteMagazines)) {
      painted.reserve = s.reserve;
      painted.infiniteMagazines = s.infiniteMagazines;
      d.res.textContent = s.infiniteMagazines ? '∞' : String(Math.max(0, s.reserve | 0));
    }
    if (s.wname != null && s.wname !== painted.wname) {
      painted.wname = s.wname;
      d.wname.textContent = String(s.wname).toUpperCase();
    }
    if (s.grenadeType != null) {
      const index = clampGrenadeType(s.grenadeType);
      if (index !== this._grenadeType) {
        this._grenadeType = index;
        d.grenades.dataset.type = GRENADE_TYPE_IDS[index];
        d.grenades.style.setProperty('--nade', GRENADE_TYPES[GRENADE_TYPE_IDS[index]].color);
        d.grenadeName.textContent = GRENADE_TYPES[GRENADE_TYPE_IDS[index]].name;
        for (let i = 0; i < d.grenadeTypeChips.length; i++) {
          d.grenadeTypeChips[i].classList.toggle('is-selected', i === index);
        }
      }
    }
    if (s.grenades != null) {
      const counts = painted.grenades || (painted.grenades = []);
      let total = 0;
      let changed = false;
      for (let t = 0; t < d.grenadeTypeChips.length; t++) {
        const count = Math.max(0, (Array.isArray(s.grenades) ? s.grenades[t] : t === 0 ? s.grenades : 0) | 0);
        total += count;
        if (counts[t] === count) continue;
        counts[t] = count;
        changed = true;
        const chip = d.grenadeTypeChips[t];
        chip.classList.toggle('is-empty', count <= 0);
        for (let i = 0; i < chip.pips.length; i++) {
          chip.pips[i].classList.toggle('is-spent', i >= count);
        }
      }
      if (changed) d.grenades.setAttribute('aria-label', `${total} grenades remaining`);
    }
    const grenadeCharge = clamp01(s.grenadeCharge);
    const charging = grenadeCharge > 0 || !!s.grenadeCharging;
    const cook01 = clamp01(s.grenadeCook01);
    const grenadeFlags = Number(charging) | (Number(grenadeCharge >= 1) << 1)
      | (Number(charging && cook01 > 0) << 2) | (Number(charging && cook01 >= 0.7) << 3);
    if (grenadeFlags !== painted.grenadeFlags) {
      painted.grenadeFlags = grenadeFlags;
      d.grenades.classList.toggle('is-charging', charging);
      d.grenades.classList.toggle('is-full', grenadeCharge >= 1);
      d.grenades.classList.toggle('is-cooking', charging && cook01 > 0);
      d.grenades.classList.toggle('is-critical', charging && cook01 >= 0.7);
    }
    const grenadeFill = charging && cook01 > 0 ? 1 - cook01 : grenadeCharge;
    if (grenadeFill !== painted.grenadeFill) {
      painted.grenadeFill = grenadeFill;
      d.grenadeChargeFill.style.transform = `scaleX(${grenadeFill})`;
    }
    let hint = 'HOLD · RELEASE';
    if (charging && cook01 > 0 && Number.isFinite(s.grenadeCookLeftMs)) {
      hint = `COOKING · ${(Math.max(0, s.grenadeCookLeftMs) / 1000).toFixed(1)}s`;
    } else if (grenadeCharge >= 1) {
      hint = 'MAX · RELEASE';
    }
    if (d.grenadeHint.textContent !== hint) d.grenadeHint.textContent = hint;

    if (s.charge01 !== undefined) {
      const thermal = Number.isFinite(s.heat01);
      const fuel = Number.isFinite(s.fuel01);
      const chargeVisible = thermal || fuel || s.charge01 !== null && Number.isFinite(s.charge01);
      const charge01 = clamp01(thermal ? s.heat01 : fuel ? s.fuel01 : s.charge01);
      const chargeFlags = Number(thermal) | (Number(fuel) << 1) | (Number(chargeVisible) << 2)
        | (Number(thermal && s.heat01 >= 0.9 && !s.overheated) << 3)
        | (Number(thermal && !!s.overheated) << 4) | (Number(charge01 > 0) << 5)
        | (Number(charge01 >= 1) << 6);
      if (chargeFlags !== painted.chargeFlags) {
        painted.chargeFlags = chargeFlags;
        d.chargeMeter.classList.toggle('is-thermal', thermal);
        d.chargeMeter.classList.toggle('is-fuel', fuel);
        d.chargeMeter.classList.toggle('is-critical', thermal && s.heat01 >= 0.9 && !s.overheated);
        d.chargeMeter.classList.toggle('is-overheated', thermal && !!s.overheated);
        d.chargeMeter.classList.toggle('is-visible', chargeVisible);
        d.chargeMeter.classList.toggle('is-charging', charge01 > 0);
        d.chargeMeter.classList.toggle('is-full', charge01 >= 1);
      }
      if (chargeVisible) {
        const color = thermal ? (s.overheated || s.heat01 >= 0.9 ? '#ff5750' : s.heat01 >= 0.65 ? '#ff9f32' : '#ffd06b') : fuel ? '#ff9f54' : '';
        if (color !== painted.chargeColor) {
          painted.chargeColor = color;
          d.chargeMeterFill.style.background = color;
        }
        if (charge01 !== painted.chargeFill) {
          painted.chargeFill = charge01;
          d.chargeMeterFill.style.transform = `scaleX(${charge01})`;
        }
        let label;
        if (thermal) {
          if (s.overheated) label = 'OVERHEATED · COOLING';
          else if (s.minigunSpinningUp) label = `SPIN UP · ${Math.round(s.spin01 * 100)}%`;
          else if (s.heat01 >= 0.9) label = `HEAT ${Math.round(s.heat01 * 100)}% · RELEASE TO COOL`;
          else if (s.minigunPrimed && s.heat01 < 0.65) label = 'ROTOR READY · PULL TRIGGER';
          else if (s.heat01 <= 0 && s.spin01 <= 0) label = 'AIM TO PRE-SPIN';
          else label = `${s.heat01 >= 0.65 ? 'SWEET SPOT' : 'HEAT'} ${Math.round(s.heat01 * 100)}% · +${Math.round((s.heatDamageMult - 1) * 100)}% DMG`;
        } else if (fuel) {
          label = `FUEL ${Math.max(0, s.fuelSeconds || 0).toFixed(1)}s · ${s.flameFiring ? 'IGNITING' : `${FLAME_RULES.range}m JET`}`;
        } else label = charge01 >= 1 ? 'CHARGED' : charge01 > 0 ? 'CHARGING' : 'COIL CHARGE';
        if (d.chargeMeterLabel.textContent !== label) d.chargeMeterLabel.textContent = label;
      }
    }

    const beamRadius = beamReticleRadiusPx(s.crosshairHitRadius, s.crosshairDistance,
      s.crosshairFov, s.crosshairHeight, s.crosshairConeDeg ?? 0);
    if (d.beamRing && beamRadius !== painted.beamRadius) {
      painted.beamRadius = beamRadius;
      d.beamRing.style.display = beamRadius > 0 ? 'block' : 'none';
      d.beamRing.style.width = d.beamRing.style.height = `${beamRadius * 2}px`;
    }
    const spread = s.crosshairConeDeg != null ? spreadFromCone(s.crosshairConeDeg)
      : s.bloomPx != null ? s.bloomPx : this.chGap;
    const aimX = Number.isFinite(s.crosshairX) ? s.crosshairX * 100 : 50;
    const aimY = Number.isFinite(s.crosshairY) ? s.crosshairY * 100 : 50;
    if (aimX !== painted.aimX || aimY !== painted.aimY) {
      painted.aimX = aimX; painted.aimY = aimY;
      d.ch.style.left = `${aimX}%`;
      d.ch.style.top = `${aimY}%`;
      if (d.hitmarker) {
        d.hitmarker.style.left = `${aimX}%`;
        d.hitmarker.style.top = `${aimY}%`;
      }
    }
    if (spread != null) this.setSpread(beamRadius > 0 ? Math.max(spread, beamRadius + 3) : spread);
    this.updateCrosshairStress(s.panic, s.pain, alive);
    this.setReloadProgress(s.reloading01 == null ? null : s.reloading01, !!s.reloadStaged);
    if (s.yawDeg != null) this.updateCompass(s.yawDeg);

    const adsT = Number(s.adsT01) || 0;
    const wantScope = alive && (s.scopeActive ?? isScopeActive({ weapon: key, ads: adsT, alive }));
    this.setScope(wantScope);
    this.setScopeZoom(s.scopeZoom);
    this.setBreath(s, alive, adsT);
    this.setConditionMeters(s, alive);
    this.hideCrosshairForAds(!alive || adsT > 0.35);
    if (alive !== painted.alive) {
      painted.alive = alive;
      d.ch.classList.toggle('vb-dead', !alive);
    }
  }

  setConditionMeters(state, alive) {
    const settings = displaySettings();
    for (const meter of this.dom.conditionMeters || []) {
      const enabled = settings[meter.key === 'pain' ? 'showPainMeter' : 'showPanicMeter'];
      const hidden = !alive || !enabled;
      if (meter.root.hidden !== hidden) meter.root.hidden = hidden;
      if (meter.root.hidden) continue;
      const percent = Math.round(clamp01(Number(state[meter.key]) || 0) * 100);
      if (percent === meter.percent) continue;
      meter.percent = percent;
      meter.value.textContent = `${percent}%`;
      meter.fill.style.transform = `scaleX(${percent / 100})`;
      meter.root.setAttribute('aria-valuenow', String(percent));
    }
  }

  /** Keep breath feedback visible independently of the hidden ADS crosshair. */
  setBreath(s, alive, adsT) {
    const d = this.dom;
    if (!d.breath) return;
    const holding = !!s.holdingBreath;
    const breath = s.breath01 == null ? 1 : clamp01(s.breath01);
    const canHold = alive && adsT > 0.5 && s.canHoldBreath !== false;
    const show = canHold;
    const display = show ? 'block' : 'none';
    if (d.breath.style.display !== display) d.breath.style.display = display;
    if (!show) return;
    const fill = breath.toFixed(3);
    const exhausted = !!s.breathExhausted;
    if (fill !== this._painted.breathFill || holding !== this._painted.holdingBreath ||
        exhausted !== this._painted.breathExhausted) {
      this._painted.breathExhausted = exhausted;
      this._painted.breathFill = fill;
      this._painted.holdingBreath = holding;
      d.breathFill.style.transform = `scaleX(${fill})`;
      d.breath.classList.toggle('is-holding', holding);
      d.breath.classList.toggle('is-spent', exhausted);
    }
    const hint = holding ? 'STEADYING' : (s.breathExhausted ? 'RECOVERING' : 'SHIFT · STEADY YOURSELF');
    if (d.breathHint.textContent !== hint) d.breathHint.textContent = hint;
  }

  /** Optic magnification label inside the scope overlay (zoom steps change it live). */
  setScopeZoom(zoom) {
    const value = Number(zoom);
    if (!Number.isFinite(value) || value <= 0 || value === this._scopeZoomShown) return;
    const scope = this.dom.scope;
    if (!scope) return;
    const label = scope.querySelector?.('#scope-zoom-label');
    if (!label) return;
    label.textContent = `${value.toFixed(1)}×`;
    this._scopeZoomShown = value;
  }

  updateAmmoLow() {
    const def = WEAPONS[this.lastWepKey];
    const magEl = this.dom.mag;
    if (!def || !magEl) return;
    if (def.mode === 'melee') {
      // A knife has no magazine: never carry a stale low-ammo flag across swings.
      magEl.classList.remove('vb-low');
      return;
    }
    const mag = parseInt(magEl.textContent, 10);
    magEl.classList.toggle(
      'vb-low',
      Number.isFinite(mag) && mag <= Math.max(1, Math.round(def.magSize * 0.22)),
    );
  }

  setSpread(px) {
    if (!this.dom.ch) return;
    const n = Number(px);
    const gap = Math.round(Math.min(76, Math.max(4, Number.isFinite(n) ? n : 4)) * 100) / 100;
    if (gap === this.chGap) return;
    const previous = Number.isFinite(this.chGap) ? this.chGap : gap;
    this.chGap = gap;
    this.dom.ch.style.setProperty('--gap-ease', gap >= previous ? '52ms' : '115ms');
    this.dom.ch.style.setProperty('--gap', `${gap}px`);
  }

  updateCrosshairStress(panicValue, painValue, alive = true) {
    const ch = this.dom.ch;
    if (!ch) return;
    const panic = clamp01(panicValue);
    const pain = clamp01(painValue);
    const painImpulse = Number(this.readModel.painImpulse) || 0;
    const stress = alive ? Math.min(1, panic * 0.72 + pain * 0.82 + painImpulse * 0.48) : 0;
    if (stress === this._painted.stress) return;
    this._painted.stress = stress;
    // The reticle tracks actual shot direction. Cosmetic jitter falsely implies
    // an additional aiming penalty, so conditions only change its static glow.
    ch.style.setProperty('--ch-jx', '0px');
    ch.style.setProperty('--ch-jy', '0px');
    ch.style.setProperty('--ch-rot', '0deg');
    ch.style.setProperty('--ch-arm-opacity', '1');
    ch.style.setProperty('--ch-glow', `${(4 + stress * 2).toFixed(2)}px`);
  }

  hideCrosshairForAds(hidden) {
    if (!this.dom.ch) return;
    const opacity = hidden ? '0' : '1';
    if (this.dom.ch.style.opacity !== opacity) this.dom.ch.style.opacity = opacity;
  }

  setReloadProgress(t01, staged = false) {
    const ring = this.dom.ring;
    const hint = this.dom.ringHint;
    if (!ring) return;
    if (t01 == null || !isFinite(t01)) {
      if (this.ringOn) {
        ring.style.display = 'none';
        if (hint) hint.style.display = 'none';
        ring.classList.remove('vb-reload-flash');
        this.ringOn = false;
        this._painted.reloadPercent = undefined;
      }
      return;
    }
    const t = clamp01(t01);
    if (!this.ringOn) {
      ring.style.display = 'block';
      if (hint) hint.style.display = 'block';
      this.ringOn = true;
    }
    if (hint) {
      const text = staged ? 'LOADING · FIRE TO INTERRUPT' : 'RELOADING';
      if (hint.textContent !== text) hint.textContent = text;
    }
    const percent = Math.round(t * 100);
    if (percent !== this._painted.reloadPercent) {
      this._painted.reloadPercent = percent;
      ring.style.setProperty('--pct', `${percent}%`);
    }
    const flash = t > 0.86;
    if (flash !== ring.classList.contains('vb-reload-flash')) ring.classList.toggle('vb-reload-flash', flash);
  }

  updateCompass(yawDeg) {
    const d = this.dom;
    if (!d.strip) return;
    if (!this.compassW) this.compassW = d.compass.clientWidth || 340;
    if (!this.compassMeasured && !this.compassRAF && typeof requestAnimationFrame === 'function') {
      this.compassMeasured = true;
      this.compassRAF = requestAnimationFrame(() => {
        this.compassRAF = 0;
        this.measureCompass();
      });
    }
    const y = ((yawDeg % 360) + 360) % 360;
    const x = this.compassW / 2 - y * this.compassPPD - this.compassZeroX;
    if (x !== this._painted.compassX) {
      this._painted.compassX = x;
      d.strip.style.transform = `translate3d(${x}px,0,0)`;
    }
  }

  measureCompass() {
    const zero1 = this.dom.ticks && this.dom.ticks.get(0);
    if (!zero1) return;
    const zero2 = this.findNextZeroTick(zero1);
    if (!zero2 || !(zero2.offsetLeft > zero1.offsetLeft)) return;
    this.compassZeroX = zero1.offsetLeft + zero1.offsetWidth / 2;
    this.compassPPD = (zero2.offsetLeft - zero1.offsetLeft) / 360;
  }

  findNextZeroTick(after) {
    const strip = this.dom.strip;
    if (!strip) return null;
    const kids = strip.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] !== after && kids[i].textContent === CARDINAL[0]) return kids[i];
    }
    return null;
  }

  setScoreboard(on) {
    const sb = this.dom.sb;
    if (!sb) return;
    sb.style.display = on ? 'block' : 'none';
  }

  setTelemetry(frameDt, stats, atMs) {
    this.network.update(frameDt, stats, atMs);
  }

  setPlayers(players, match = this.scoreboardMatch, selfRow = null) {
    if (!Array.isArray(players)) return;
    this.scoreboardMatch = match;
    if (selfRow) this.scoreboardSelfId = selfRow.id;
    this.scoreboard.update(players, match, this.scoreboardSelfId);
  }

  ensureScope() {
    if (this.dom.scope) return this.dom.scope;
    const scope = createSniperScope(this._root('hud'));
    this.dom.scope = scope;
    return scope;
  }

  setScope(on) {
    if (!this.built) return;
    const scope = on ? this.ensureScope() : this.dom.scope;
    if (!scope) return;
    this.scopeShown = !!on;
    this.scopeProgress = on ? 1 : 0;
    if (this.scopeRAF) cancelAnimationFrame(this.scopeRAF);
    this.scopeRAF = 0;
    scope.classList.toggle('active', !!on);
    scope.classList.remove('exiting');
    scope.style.opacity = on ? '1' : '';
    scope.style.transform = '';
  }

  resetScope() {
    this.scopeShown = false;
    this.scopeProgress = 0;
    if (this.scopeRAF) {
      cancelAnimationFrame(this.scopeRAF);
      this.scopeRAF = 0;
    }
    if (this.dom.scope) {
      this.dom.scope.classList.remove('active', 'exiting');
      this.dom.scope.style.opacity = '';
      this.dom.scope.style.transform = '';
    }
  }


  reset() {
    this.resetScope();
    if (this.compassRAF) {
      cancelAnimationFrame(this.compassRAF);
      this.compassRAF = 0;
    }
    clearBag(this.st);
    this._painted = {};
    this._grenadeType = -1;
    this.ringOn = false;
    this.compassW = 0;
    this.compassPPD = 2;
    this.compassZeroX = 720;
    this.compassMeasured = false;
    this.lastWepKey = '';
    this.chGap = undefined;

    const d = this.dom;
    if (d.ring) {
      d.ring.style.display = 'none';
      d.ring.classList.remove('vb-reload-flash');
    }
    if (d.ringHint) d.ringHint.style.display = 'none';
    if (d.ch) {
      d.ch.style.opacity = '1';
      d.ch.classList.remove('vb-dead');
      this.setSpread(4);
      this.updateCrosshairStress(0, 0, true);
    }
    if (d.lowhp) d.lowhp.style.opacity = '0';
    if (d.strip) d.strip.style.transform = '';
    this.setScoreboard(false);
    if (typeof document !== 'undefined') this.setPlayers([]);
    this.match.reset();
    this.network.reset();
    this.powerups.reset();
  }

  dispose() {
    if (this.scopeRAF) {
      cancelAnimationFrame(this.scopeRAF);
      this.scopeRAF = 0;
    }
    if (this.compassRAF) {
      cancelAnimationFrame(this.compassRAF);
      this.compassRAF = 0;
    }

    const doc = typeof document !== 'undefined' ? document : null;
    const win = typeof window !== 'undefined' ? window : null;
    if (this.tabBound) {
      if (doc && this.onKD) doc.removeEventListener('keydown', this.onKD);
      if (doc && this.onKU) doc.removeEventListener('keyup', this.onKU);
      if (win) win.removeEventListener('resize', this._onWindowResize);
    }
    this.tabBound = false;
    this.onKD = null;
    this.onKU = null;

    this.match.dispose();
    this.scoreboard.dispose();
    this.network.dispose();
    this.powerups.dispose();
    const hud = doc ? doc.getElementById('hud') : null;
    if (this._ownedHudRoot) {
      this._ownedHudRoot.remove();
      this._ownedHudRoot = null;
    } else if (hud) {
      hud.innerHTML = '';
    }

    clearBag(this.dom);
    clearBag(this.st);
    this._painted = {};
    this._grenadeType = -1;
    this.scopeShown = false;
    this.scopeProgress = 0;
    this.ringOn = false;
    this.compassW = 0;
    this.compassPPD = 2;
    this.compassZeroX = 720;
    this.compassMeasured = false;
    this.lastWepKey = '';
    this.chGap = undefined;
    this.built = false;
  }

  _root(id) {
    if (this._rootProvider) return this._rootProvider(id);
    let node = document.getElementById(id);
    if (!node) {
      node = el('div', '', document.body, id);
      if (id === 'hud') this._ownedHudRoot = node;
    }
    return node;
  }
}
