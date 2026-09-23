import { bindingLabel, matchesBinding, isTypingTarget, subscribeKeybindings } from '../keybindings.js';
import { isScopeActive } from '../guns/scope-state.js';
import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import {
  CARDINAL,
  clamp01,
  el,
  resolveKey,
  spreadFromCone,
  beamReticleRadiusPx,
  glaiveDiscSlots,
  weaponImagePath,
  GRENADE_HUD_ICONS,
} from './hud-support.js';
import { Scoreboard } from './scoreboard.js';
import { MatchHud } from './match-hud.js';
import { createSniperScope } from './sniper-scope.js';
import { displaySettings } from './display-settings.js';
import { NetworkHud } from './network-hud.js';
import { PowerupHud } from './powerup-hud.js';
import { MedkitHud } from './medkit-hud.js';
import { BubbleHud } from './bubble-hud.js';
import {
  GRENADE_TYPES,
  GRENADE_TYPE_IDS,
  GRENADE_ROLES,
  GRENADE_POWER_STEPS,
  GRENADE_DEFAULT_POWER_INDEX,
  clampGrenadeType,
} from '../../../shared/grenade-rules.js';
import { CLAYMORE_RULES } from '../../../shared/claymore-rules.js';
import { GrenadePouchController } from './grenade-pouch.js';
import { FLAME_RULES } from '../../../shared/flame-rules.js';

const EMPTY_READ_MODEL = Object.freeze({ dead: false, painImpulse: 0 });
// IRON PICK attack indicator: a 16-step pixel bar (Minecraft's 16-texel
// cooldown bar) and a pixel pick that pops when the next swing is ready.
const MELEE_STEPS = 16;
const MELEE_MARK_MS = 280;
const MELEE_READY_PIXELS = [
  ['#dfe4e8', [[1, 0], [2, 0], [3, 0], [4, 0], [5, 1], [6, 1], [6, 2], [7, 3], [7, 4], [8, 5]]],
  ['#8e979e', [[2, 1], [3, 1], [4, 1], [5, 2], [6, 3], [7, 5]]],
  ['#9a6b3a', [[4, 3], [3, 4], [2, 5], [1, 6], [0, 7]]],
  ['#5e4125', [[5, 3], [4, 4], [3, 5], [2, 6], [1, 7]]],
];
const MELEE_READY_SVG = `<svg viewBox="0 0 9 8" shape-rendering="crispEdges" aria-hidden="true">${
  MELEE_READY_PIXELS.map(([fill, cells]) => cells.map(([x, y]) =>
    `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`).join('')).join('')}</svg>`;
// Grenade HUD pulse windows (ms); the CSS animations run inside them.
const GRENADE_DENIED_MS = 150;
const GRENADE_THROWN_MS = 120;
const GRENADE_ADVANCE_MS = 1200;
const GRENADE_READIED_MS = 1200;
const GRENADE_PINBACK_MS = 700;
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
    this.medkit = new MedkitHud();
    this.bubble = new BubbleHud();
    this.pouch = new GrenadePouchController();
    this._device = {};
    this._grenadePulse = {};
  }

  buildHUD() {
    this.onBeforeBuild();
    this.built = true;
    if (this.compassRAF) {
      cancelAnimationFrame(this.compassRAF);
      this.compassRAF = 0;
    }
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
    // RIPTIDE: one small pip per disc under the reticle, lit while it is in hand.
    d.chDiscs = el('div', 'vb-ch-discs', d.ch);
    d.chDiscs.setAttribute('aria-hidden', 'true');
    d.chDiscs.hidden = true;
    // IRON PICK attack indicator under the reticle (hidden with it while aiming).
    d.meleeMeter = el('div', 'vb-melee-meter', d.ch, 'melee-meter');
    d.meleeMeter.setAttribute('role', 'meter');
    d.meleeMeter.setAttribute('aria-label', 'Pickaxe swing ready');
    d.meleeMeterFill = el('i', '', el('span', 'vb-melee-track', d.meleeMeter));
    d.meleeReady = el('span', 'vb-melee-ready', d.meleeMeter);
    d.meleeReady.innerHTML = MELEE_READY_SVG;
    // Breath meter: only while aiming, shows the hold-breath window draining.
    d.breath = el('div', 'vb-breath-meter', hud, 'breath-meter');
    d.breathFill = el('i', '', d.breath);
    d.breathHint = el('span', 'vb-breath-hint', d.breath);
    d.breathHint.textContent = `${bindingLabel('sprint')} · STEADY YOURSELF`;
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
    this.medkit.build(hud, d.hb);
    this.bubble.build(hud, d.ch);
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
    d.weaponIcon = el('img', 'vb-weapon-icon vb-weapon-art', d.ammo, 'weapon-icon');
    d.weaponIcon.alt = '';
    d.weaponIcon.setAttribute('aria-hidden', 'true');
    // Kept outside #ammo because that panel's angular clip-path also clips
    // absolutely positioned descendants above its bounds.
    // Ready Card: the one grenade G throws, its stock, and five fixed-order
    // pouch dots (lit = stocked, ringed = ready) tinted by role.
    d.grenades = el('div', 'vb-grenade-count', hud, 'grenade-count');
    d.grenadeKey = el('span', 'vb-grenade-key', d.grenades);
    d.grenadeIcon = el('img', 'vb-grenade-card-icon', d.grenades);
    d.grenadeIcon.alt = '';
    d.grenadeIcon.draggable = false;
    d.grenadeIcon.setAttribute('aria-hidden', 'true');
    d.grenadeName = el('span', 'vb-grenade-name', d.grenades);
    d.grenadeAmmo = el('b', 'vb-grenade-ammo', d.grenades);
    d.grenadeDots = el('span', 'vb-grenade-dots', d.grenades);
    d.grenadeDots.setAttribute('aria-hidden', 'true');
    d.grenadeDotList = GRENADE_TYPE_IDS.map((typeId) => {
      const dot = el('i', `vb-grenade-dot vb-grenade-dot-${typeId}`, d.grenadeDots);
      dot.dataset.type = typeId;
      dot.dataset.role = GRENADE_ROLES[typeId] || '';
      return dot;
    });
    d.grenadePouchKey = el('span', 'vb-grenade-pouch', d.grenades);
    d.grenadePouchKeyBadge = el('kbd', 'vb-grenade-pouch-key', d.grenadePouchKey);
    el('span', '', d.grenadePouchKey).textContent = 'POUCH';
    d.grenadeFlash = el('span', 'vb-grenade-flash', d.grenades);
    d.grenadeCharge = el('span', 'vb-grenade-charge', d.grenades);
    d.grenadeChargeFill = el('i', '', d.grenadeCharge);
    d.grenadeHint = el('span', 'vb-grenade-hint', d.grenades);
    // Touch keeps only these (styles/touch-controls.css compact card).
    for (const node of [d.grenadeIcon, d.grenadeAmmo, d.grenadeCharge]) node.dataset.touchCompact = '';
    // Readied tag under the crosshair: fades in on every ready-type change.
    d.grenadeReadied = el('div', 'vb-grenade-readied', hud, 'grenade-readied');
    d.grenadeReadied.setAttribute('aria-live', 'polite');
    d.grenadeReadiedIcon = el('img', '', d.grenadeReadied);
    d.grenadeReadiedIcon.alt = '';
    d.grenadeReadiedIcon.setAttribute('aria-hidden', 'true');
    d.grenadeReadiedCount = el('b', '', d.grenadeReadied);
    d.grenadeReadiedNote = el('span', 'vb-grenade-readied-note', d.grenadeReadied);
    // Aim reticle: power notches, fuse ring, and the release hints while held.
    d.grenadeAim = el('div', 'vb-grenade-aim', hud, 'grenade-aim');
    d.grenadeAim.setAttribute('aria-hidden', 'true');
    d.grenadeAimPower = el('div', 'vb-aim-power', d.grenadeAim);
    d.grenadeAimNotches = GRENADE_POWER_STEPS.map((step, index) => {
      const notch = el('i', 'vb-aim-notch', d.grenadeAimPower);
      notch.style.setProperty('--notch', String(index));
      return notch;
    });
    d.grenadeAimPowerLabel = el('span', 'vb-aim-power-label', d.grenadeAimPower);
    d.grenadeAimFuse = el('div', 'vb-aim-fuse', d.grenadeAim);
    d.grenadeAimFuseRing = el('i', 'vb-aim-fuse-ring', d.grenadeAimFuse);
    d.grenadeAimFuseLabel = el('span', 'vb-aim-fuse-label', d.grenadeAimFuse);
    d.grenadeAimMount = el('div', 'vb-aim-mount', d.grenadeAim);
    d.grenadeAimHint = el('div', 'vb-aim-hint', d.grenadeAim);
    this._grenadeType = -1;
    this._paintGrenadeType(0);
    this.setDeviceLabels(this._device);
    // Charge weapons (LONGARC): capacitor meter under the ammo panel.
    d.chargeMeter = el('div', 'vb-charge-meter', hud, 'charge-meter');
    d.chargeMeterTrack = el('span', 'vb-charge-track', d.chargeMeter);
    d.chargeMeterFill = el('i', '', d.chargeMeterTrack);
    d.chargeMeterLabel = el('span', 'vb-charge-label', d.chargeMeter);
    d.chargeMeterLabel.textContent = 'COIL CHARGE';
    d.mag = el('span', '', d.ammo, 'ammocount');
    d.sep = el('span', 'vb-ammo-sep', d.ammo);
    d.sep.textContent = '/';
    d.res = el('span', '', d.ammo, 'ammoreserve');
    d.wname = el('div', '', d.ammo, 'weaponname');
    // RIPTIDE replaces mag/reserve with disc pips: in hand, in flight,
    // embedded in a wall, or being fabricated by the launcher.
    d.discs = el('span', 'vb-disc-pips', d.ammo, 'disc-pips');
    d.discs.setAttribute('role', 'img');
    d.discs.hidden = true;
    d.discReturn = el('span', 'vb-disc-return', d.ammo);
    d.discReturn.textContent = `${bindingLabel('reload')} · RETURN`;
    d.discReturn.title = `Return every disc on its out leg (${bindingLabel('reload')})`;
    d.discReturn.hidden = true;

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
        if (!event.defaultPrevented && !isTypingTarget(event.target) && !event.target?.closest?.('#settings-overlay') && matchesBinding(event, 'scoreboard')) {
          event.preventDefault();
          this.setScoreboard(true);
        }
      };
      this.onKU = (event) => {
        if (matchesBinding(event, 'scoreboard')) {
          event.preventDefault();
          this.setScoreboard(false);
        }
      };
      document.addEventListener('keydown', this.onKD);
      document.addEventListener('keyup', this.onKU);
      window.addEventListener('resize', this._onWindowResize);
    }

    this._unsubscribeBindings?.();
    this._unsubscribeBindings = subscribeKeybindings(() => {
      this.setScoreboard(false);
      this.setDeviceLabels(this._device);
      d.discReturn.textContent = `${bindingLabel('reload')} · RETURN`;
      d.discReturn.title = `Return every disc on its out leg (${bindingLabel('reload')})`;
    });
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
    this.medkit.update(s.medkit, alive, s.hp);
    this.bubble.update(s, key, alive);

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
      if (key) {
        d.weaponIcon.src = weaponImagePath(key);
        d.weaponIcon.dataset.weaponId = key;
      } else {
        d.weaponIcon.removeAttribute('data-weapon-id');
      }
      d.res.title = WEAPONS[key]?.spareRounds != null ? 'Spare shells' : 'Spare magazines';
      d.res.setAttribute('aria-label', d.res.title);
      const discs = !!WEAPONS[key]?.glaive;
      d.ammo.classList.toggle('is-discs', discs);
      d.discs.hidden = !discs;
      d.discReturn.hidden = !discs;
      d.chDiscs.hidden = !discs;
      painted.discs = undefined;
      this.lastWepKey = key;
    }
    if (WEAPONS[key]?.glaive) this.setGlaiveDiscs(s, WEAPONS[key]);
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
    this.paintGrenades(s, alive);

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
        } else if (key === 'bubble') {
          // SUDSBLASTER: a tap is a Soap Shot; a held film grows a Big Bubble and lets go by itself.
          label = charge01 >= 1 ? 'BIG BUBBLE · LETS GO SOON'
            : charge01 > 0 ? 'BLOWING · RELEASE TO FIRE' : 'TAP · HOLD FOR BIG BUBBLE';
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
    if (wantScope) {
      // Scope marks follow the same shot ray as the ordinary crosshair while
      // the camera remains free to turn ahead of the weapon.
      this.dom.scope.style.setProperty('--scope-aim-x', `${aimX - 50}vw`);
      this.dom.scope.style.setProperty('--scope-aim-y', `${aimY - 50}vh`);
    }
    this.setScopeZoom(s.scopeZoom);
    const opticLabel = this.dom.scope?.querySelector?.(".scope-model-label");
    const opticText = `${s.wname || WEAPONS[key]?.name || ""} · ${s.opticName || "Factory optic"}`;
    if (opticLabel && opticLabel.textContent !== opticText) opticLabel.textContent = opticText;
    this.setBreath(s, alive, adsT);
    this.setMeleeMeter(s, alive);
    this.setConditionMeters(s, alive);
    // The pick has no sight (its ADS pose sits off the aim axis): keep the
    // crosshair and the attack meter up while it zooms.
    this.hideCrosshairForAds(!alive || (adsT > 0.35 && WEAPONS[key]?.mode !== 'melee'));
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
    const hint = holding ? 'STEADYING' : (s.breathExhausted ? 'RECOVERING' : `${bindingLabel('sprint')} · STEADY YOURSELF`);
    if (d.breathHint.textContent !== hint) d.breathHint.textContent = hint;
  }

  /**
   * Attack indicator: `melee01` is the weapon state's swing readiness (null
   * unless the pick is drawn). The bar shows while recharging, draws included
   * (Minecraft's swap cooldown); only a swing's recharge pops the ready pick.
   */
  setMeleeMeter(s, alive) {
    const d = this.dom;
    if (!d.meleeMeter) return;
    const painted = this._painted;
    const value = alive && s.melee01 != null && Number.isFinite(Number(s.melee01)) ? clamp01(s.melee01) : null;
    const step = value === null ? -1 : Math.floor(value * MELEE_STEPS + 1e-6);
    if (step !== painted.meleeStep) {
      const charging = step >= 0 && step < MELEE_STEPS;
      d.meleeMeter.classList.toggle('is-charging', charging);
      // A full -> charging drop is a swing; the pop plays only when that swing's
      // recharge fills, never after a draw or respawn recharge.
      if (painted.meleeStep === MELEE_STEPS && charging) painted.meleeSwung = true;
      else if (step < 0) painted.meleeSwung = false;
      if (charging) d.meleeMeter.classList.remove('is-ready');
      else if (step === MELEE_STEPS && painted.meleeSwung) {
        d.meleeMeter.classList.add('is-ready');
        painted.meleeSwung = false;
      } else d.meleeMeter.classList.remove('is-ready');
      if (charging) d.meleeMeterFill.style.transform = `scaleX(${step / MELEE_STEPS})`;
      d.meleeMeter.setAttribute('aria-valuenow', String(Math.max(0, step)));
      painted.meleeStep = step;
    }
    if (this._meleeMarkUntil && performance.now() >= this._meleeMarkUntil) this._clearMeleeMark();
  }

  /** Heavier hitmarker for a pickaxe hit; `kind` tints it (crit, backstab, armor, knockback). */
  meleeHitmark(kind = 'strong') {
    const hm = this.dom.hitmarker;
    if (!hm) return;
    this._clearMeleeMark();
    hm.classList.add('vb-melee', `vb-melee-${kind}`);
    this._meleeMark = kind;
    this._meleeMarkUntil = performance.now() + MELEE_MARK_MS;
  }

  _clearMeleeMark() {
    if (this._meleeMark) this.dom.hitmarker?.classList.remove('vb-melee', `vb-melee-${this._meleeMark}`);
    this._meleeMark = null;
    this._meleeMarkUntil = 0;
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

  /**
   * Paint RIPTIDE disc pips from the authoritative split: `mag` is discs in
   * hand, `glaive` carries { magSize, inFlight, outLeg, embedded, fab01[] }.
   */
  setGlaiveDiscs(s, def) {
    const d = this.dom;
    const g = s.glaive || {};
    const slots = glaiveDiscSlots({
      magSize: g.magSize ?? def.magSize,
      mag: s.mag,
      inFlight: g.inFlight,
      embedded: g.embedded,
      fab01: g.fab01,
    });
    const returnable = Math.max(0, Number(g.outLeg ?? g.inFlight) || 0);
    const signature = `${slots.map((slot) => `${slot.state}:${Math.round(slot.fill01 * 100)}`).join(',')}|${returnable > 0}`;
    if (signature === this._painted.discs) return;
    this._painted.discs = signature;
    while (d.discs.children.length > slots.length) d.discs.children[d.discs.children.length - 1].remove();
    while (d.chDiscs.children.length > slots.length) d.chDiscs.children[d.chDiscs.children.length - 1].remove();
    while (d.discs.children.length < slots.length) el('i', 'vb-disc-pip', d.discs);
    while (d.chDiscs.children.length < slots.length) el('i', 'vb-ch-disc', d.chDiscs);
    const tally = { hand: 0, flight: 0, embedded: 0, fab: 0, empty: 0 };
    slots.forEach((slot, i) => {
      tally[slot.state]++;
      const pip = d.discs.children[i];
      pip.className = `vb-disc-pip is-${slot.state}`;
      pip.style.setProperty('--fill', `${Math.round(slot.fill01 * 100)}%`);
      d.chDiscs.children[i].className = `vb-ch-disc${slot.state === 'hand' ? ' is-ready' : ''}`;
    });
    const parts = [`${tally.hand} ready`];
    if (tally.flight) parts.push(`${tally.flight} in flight`);
    if (tally.embedded) parts.push(`${tally.embedded} embedded`);
    if (tally.fab) parts.push(`${tally.fab} fabricating`);
    d.discs.setAttribute('aria-label', `Discs: ${parts.join(', ')}`);
    d.ammo.classList.toggle('is-disc-empty', tally.hand === 0);
    d.discReturn.classList.toggle('is-ready', returnable > 0);
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

  setTelemetry(frameDt, stats, atMs, frameStats = null) {
    this.network.update(frameDt, stats, atMs, frameStats);
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
    scope.classList.toggle('active', !!on);
    scope.classList.remove('exiting');
    scope.style.opacity = on ? '1' : '';
    scope.style.transform = '';
  }

  /**
   * Key badges and hint copy for the active device: bindings on keyboard, pad
   * glyphs while a pad drives, and no key badges on touch (the buttons carry them).
   *
   * @param {{padActive?: boolean, touch?: boolean}} [device]
   */
  setDeviceLabels(device = {}) {
    this._device = device || {};
    const d = this.dom;
    if (!d.grenadeKey) return;
    const pad = !!this._device.padActive;
    const touch = !!this._device.touch && !pad;
    d.grenadeKey.textContent = pad ? 'RB' : bindingLabel('grenade');
    d.grenadeKey.hidden = touch;
    d.grenadePouchKeyBadge.textContent = pad ? 'D▼' : bindingLabel('grenadeType');
    d.grenadePouchKey.hidden = touch;
    d.grenadePouchKey.title = pad
      ? 'Tap D-pad down for the next grenade, hold for the pouch'
      : `Tap ${bindingLabel('grenadeType')} for the next grenade, hold for the pouch`;
    d.grenades.classList.toggle('is-touch', touch);
    // Hints read the device, so force the next paint to rebuild them.
    this._painted.grenadeHint = undefined;
    this._painted.grenadeAimHint = undefined;
    if (this.built) this.paintGrenades(this.st, this.st.alive !== false && this.readModel.dead !== true);
  }

  /** Card identity (type, tint, icon, name) for roster index `index`. @private */
  _paintGrenadeType(index) {
    if (index === this._grenadeType) return;
    this._grenadeType = index;
    const d = this.dom;
    const typeId = GRENADE_TYPE_IDS[index];
    const type = GRENADE_TYPES[typeId];
    d.grenades.dataset.type = typeId;
    d.grenades.style.setProperty('--nade', type.color);
    d.grenadeIcon.src = GRENADE_HUD_ICONS[typeId];
    d.grenadeReadiedIcon.src = GRENADE_HUD_ICONS[typeId];
    d.grenadeReadied.style.setProperty('--nade', type.color);
    d.grenadeAim.style.setProperty('--nade', type.color);
    this._painted.grenadeName = undefined;
  }

  /** Records a local timestamp whenever a pulse field changes to a truthy value. @private */
  _grenadePulseAt(key, value, now) {
    const pulse = this._grenadePulse;
    if (value === pulse[key]) return pulse[`${key}At`] ?? -Infinity;
    pulse[key] = value;
    if (value !== undefined && value !== null && value !== false && value !== -1) pulse[`${key}At`] = now;
    return pulse[`${key}At`] ?? -Infinity;
  }

  /**
   * Ready Card, readied tag, aim reticle and pouch from the authoritative
   * counts plus the input seam's pouch fields. Every new field may be missing.
   */
  paintGrenades(s, alive = true) {
    const d = this.dom;
    if (!d.grenades) return;
    const painted = this._painted;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const counts = GRENADE_TYPE_IDS.map((_, t) => Math.max(0, (Array.isArray(s.grenades) ? s.grenades[t] : t === 0 ? s.grenades : 0) | 0));
    const total = counts.reduce((sum, count) => sum + count, 0);
    const held = !!s.grenadeCharging || clamp01(s.grenadeCharge) > 0;
    const readyKnown = Number.isInteger(s.grenadeReady);
    const ready = readyKnown ? s.grenadeReady : (s.grenadeType != null ? clampGrenadeType(s.grenadeType) : 0);
    const emptyPouch = !held && (readyKnown ? ready < 0 : s.grenades != null && total === 0);
    // While held the type is locked to the held one; otherwise the ready one.
    const shown = held && s.grenadeType != null ? clampGrenadeType(s.grenadeType)
      : ready >= 0 ? clampGrenadeType(ready) : (this._grenadeType >= 0 ? this._grenadeType : 0);
    const previousShown = this._grenadeType;
    this._paintGrenadeType(shown);
    const typeId = GRENADE_TYPE_IDS[shown];
    const type = GRENADE_TYPES[typeId];
    const count = counts[shown];

    if (painted.grenadeCounts !== counts.join(',')) {
      const before = painted.grenadeCounts?.split(',').reduce((sum, value) => sum + Number(value), 0);
      if (before > total) this._grenadePulse.thrownAt = now;
      painted.grenadeCounts = counts.join(',');
      for (let t = 0; t < d.grenadeDotList.length; t++) d.grenadeDotList[t].classList.toggle('is-stocked', counts[t] > 0);
      d.grenades.setAttribute('aria-label', `${total} grenades remaining`);
    }
    if (painted.grenadeReadyDot !== ready) {
      painted.grenadeReadyDot = ready;
      for (let t = 0; t < d.grenadeDotList.length; t++) d.grenadeDotList[t].classList.toggle('is-ready', t === ready);
    }
    const name = emptyPouch ? 'POUCH EMPTY' : type.name;
    if (painted.grenadeName !== name) {
      painted.grenadeName = name;
      d.grenadeName.textContent = name;
    }
    const ammo = `×${count}`;
    if (painted.grenadeAmmo !== ammo) {
      painted.grenadeAmmo = ammo;
      d.grenadeAmmo.textContent = ammo;
      d.grenadeReadiedCount.textContent = ammo;
    }

    // Transient pulses. A ready change after the first paint also counts as
    // "readied" so pickups and respawns flash even without an input timestamp.
    if (previousShown >= 0 && previousShown !== shown && !held) this._grenadePulse.localReadiedAt = now;
    const deniedAt = this._grenadePulseAt('denied', s.grenadeDenied, now);
    const advancedAt = this._grenadePulseAt('advanced', s.grenadeAdvancedTo, now);
    const pinBackAt = this._grenadePulseAt('pinBack', s.grenadePinBackAt, now);
    const readiedAt = Math.max(Number.isFinite(s.grenadeReadiedAt) ? s.grenadeReadiedAt : -Infinity,
      this._grenadePulse.localReadiedAt ?? -Infinity, advancedAt);
    const denied = now - deniedAt < GRENADE_DENIED_MS;
    const advanced = now - advancedAt < GRENADE_ADVANCE_MS;
    const thrown = now - (this._grenadePulse.thrownAt ?? -Infinity) < GRENADE_THROWN_MS;
    const pinBack = now - pinBackAt < GRENADE_PINBACK_MS;
    const readiedVisible = alive && !emptyPouch && (held || now - readiedAt < GRENADE_READIED_MS || pinBack);

    const wallMine = !!type.wallMine;
    const power = wallMine ? 0 : clamp01(Number.isFinite(s.grenadePower) ? s.grenadePower : s.grenadeCharge);
    let powerIndex = Number.isInteger(s.grenadePowerIndex) ? s.grenadePowerIndex : -1;
    if (powerIndex < 0) {
      powerIndex = power > 0
        ? GRENADE_POWER_STEPS.reduce((best, step, i) => (Math.abs(step - power) < Math.abs(GRENADE_POWER_STEPS[best] - power) ? i : best), 0)
        : GRENADE_DEFAULT_POWER_INDEX;
    }
    powerIndex = Math.max(0, Math.min(GRENADE_POWER_STEPS.length - 1, powerIndex));
    const cook01 = clamp01(s.grenadeCook01);
    const cooking = held && cook01 > 0;
    const critical = held && cook01 >= 0.7;
    const placeable = wallMine && held && !!s.claymorePlacementValid;
    const flags = [held, power >= 1 && held, cooking, critical, emptyPouch, denied, advanced, thrown,
      readiedVisible, pinBack, wallMine, placeable, !!type.cook, alive].map(Number).join('');
    if (flags !== painted.grenadeFlags) {
      painted.grenadeFlags = flags;
      d.grenades.classList.toggle('is-charging', held);
      d.grenades.classList.toggle('is-full', held && power >= 1);
      d.grenades.classList.toggle('is-cooking', cooking);
      d.grenades.classList.toggle('is-critical', critical);
      d.grenades.classList.toggle('is-empty-pouch', emptyPouch);
      d.grenades.classList.toggle('is-denied', denied);
      d.grenades.classList.toggle('is-advanced', advanced);
      d.grenades.classList.toggle('is-thrown', thrown);
      d.grenadeReadied.classList.toggle('is-visible', readiedVisible);
      d.grenadeReadied.classList.toggle('is-advanced', advanced && !held);
      d.grenadeReadied.classList.toggle('is-pinback', pinBack && !held);
      d.grenadeAim.classList.toggle('is-visible', held && alive);
      d.grenadeAim.classList.toggle('is-wallmine', wallMine);
      d.grenadeAim.classList.toggle('is-valid', placeable);
      d.grenadeAim.classList.toggle('is-cook', !!type.cook);
      d.grenadeAim.classList.toggle('is-critical', critical);
    }
    const flash = advanced ? `NEXT · ${type.name}` : '';
    if (painted.grenadeFlash !== flash) {
      painted.grenadeFlash = flash;
      d.grenadeFlash.textContent = flash;
    }
    // A claymore let go off a wall is a pin back too, but it reads as the reason.
    const pinBackNote = s.grenadePinBackReason === 'noWall' ? 'NO WALL' : 'PIN BACK';
    const note = pinBack && !held ? pinBackNote : advanced && !held ? `→ ${type.name}` : '';
    if (painted.grenadeReadiedNote !== note) {
      painted.grenadeReadiedNote = note;
      d.grenadeReadiedNote.textContent = note;
    }

    // Thin mirror bar on the card: fuse while cooking, mount validity, else power.
    const fill = !held ? 0 : wallMine ? Number(placeable) : cooking ? 1 - cook01 : power;
    if (fill !== painted.grenadeFill) {
      painted.grenadeFill = fill;
      d.grenadeChargeFill.style.transform = `scaleX(${fill})`;
    }
    const pad = !!this._device.padActive;
    const touch = !!this._device.touch && !pad;
    const reach = `${Number(CLAYMORE_RULES.placementRange.toFixed(1))}m`;
    let hint = touch ? 'TAP · THROW' : `TAP ${pad ? 'RB' : bindingLabel('grenade')} · THROW`;
    if (held) {
      if (wallMine) hint = placeable ? 'RELEASE · MOUNT' : `NO WALL · MAX ${reach}`;
      else if (cooking && Number.isFinite(s.grenadeCookLeftMs)) hint = `COOKING · ${(Math.max(0, s.grenadeCookLeftMs) / 1000).toFixed(1)}s`;
      else hint = 'RELEASE · THROW';
    }
    if (painted.grenadeHint !== hint) {
      painted.grenadeHint = hint;
      d.grenadeHint.textContent = hint;
    }

    if (painted.grenadePowerIndex !== powerIndex) {
      painted.grenadePowerIndex = powerIndex;
      d.grenadeAimNotches.forEach((notch, i) => notch.classList.toggle('is-lit', i === powerIndex));
      d.grenadeAimPowerLabel.textContent = powerIndex === 0 ? 'LOB' : `${Math.round(GRENADE_POWER_STEPS[powerIndex] * 100)}%`;
    }
    const fuseLeftMs = type.cook
      ? Math.max(0, Number.isFinite(s.grenadeCookLeftMs) && cooking ? s.grenadeCookLeftMs : type.fuseMs * (1 - cook01))
      : 0;
    const fuse = type.cook ? `${(fuseLeftMs / 1000).toFixed(1)}s|${(1 - cook01).toFixed(3)}` : '';
    if (painted.grenadeFuse !== fuse) {
      painted.grenadeFuse = fuse;
      d.grenadeAimFuseLabel.textContent = type.cook ? fuse.split('|')[0] : '';
      d.grenadeAimFuseRing.style.setProperty('--fuse', type.cook ? fuse.split('|')[1] : '0');
    }
    const mount = wallMine ? (placeable ? '[ MOUNT ]' : `[ NO WALL · ${reach} ]`) : '';
    if (painted.grenadeMount !== mount) {
      painted.grenadeMount = mount;
      d.grenadeAimMount.textContent = mount;
    }
    const release = touch ? 'LIFT' : 'RELEASE';
    const cancelKeys = pad ? 'X' : [bindingLabel('reload'), bindingLabel('grenadeCancel')].filter((label) => label !== 'UNBOUND').join(' / ');
    const pinBackHint = touch ? 'SLIDE TO PIN BACK' : `${cancelKeys} · PIN BACK`;
    const aimHint = wallMine
      ? `${release} · MOUNT   ${pinBackHint}`
      : `${release} · THROW   ${touch ? 'TAP A STOP · RANGE' : pad ? 'D↕ · RANGE' : 'SCROLL · RANGE'}   ${pinBackHint}`;
    if (painted.grenadeAimHint !== aimHint) {
      painted.grenadeAimHint = aimHint;
      d.grenadeAimHint.textContent = aimHint;
    }

    // Pouch: lazy until first opened, then diffed by the controller itself.
    // Only state-driven when the host sends the field (else setGrenadePouchState owns it).
    const pouchOpen = alive && !!s.grenadePouchOpen;
    if (s.grenadePouchOpen !== undefined && (pouchOpen || this.pouch.dom.root)) {
      this.pouch.setState({
        open: pouchOpen,
        hover: Number.isInteger(s.grenadePouchHover) ? s.grenadePouchHover : -1,
        ready,
        counts,
        device: this._device,
        chaos: s.grenadeChaos ?? s.chaosUpgrades ?? 0,
      });
    }
  }

  resetScope() {
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
    this._grenadePulse = {};
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
    if (this.pouch.dom.root) this.pouch.setState({ open: false });
  }

  dispose() {
    this._unsubscribeBindings?.();
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
    this.medkit.dispose();
    this.bubble.dispose();
    this.pouch.dispose();
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
    this._grenadePulse = {};
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
