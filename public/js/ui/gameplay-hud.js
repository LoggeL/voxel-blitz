import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import {
  CARDINAL,
  SCOPE_MS,
  clamp01,
  el,
  resolveKey,
  spreadFromCone,
} from './hud-support.js';
import { MatchHud } from './match-hud.js';

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
    this.dom = {};
    this.names = new Map();

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

    this.tabBound = false;
    this.onKD = null;
    this.onKU = null;
    this._onWindowResize = () => {
      this.compassW = 0;
      this.compassMeasured = false;
    };

    this.match = matchHud || new MatchHud({
      onBuyMenuState,
      onPlayers: (players) => this.setPlayers(players),
      readModel,
    });
    this.matchDom = this.match.dom;
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
    this.names.clear();
    clearBag(this.dom);

    const hud = this._root('hud');
    hud.innerHTML = '';
    const d = this.dom;

    this.match.build(hud);

    d.ch = el('div', '', hud, 'crosshair');
    for (let i = 0; i < 4; i++) el('span', 'ch-arm', d.ch);
    d.ring = el('div', 'vb-reload-ring', d.ch);
    d.ring.style.display = 'none';
    d.ringHint = el('div', '', d.ch, 'reload-hint');
    d.ringHint.textContent = 'RELOADING';
    d.ringHint.style.display = 'none';
    if (this.st.crosshairConeDeg != null) {
      this.setSpread(spreadFromCone(this.st.crosshairConeDeg));
    } else {
      this.setSpread(this.st.bloomPx);
    }

    d.hb = el('div', '', hud, 'healthbar');
    d.track = el('div', 'hp-track', d.hb);
    d.hpf = el('div', '', d.track, 'hpfill');

    d.ammo = el('div', '', hud, 'ammo');
    d.mag = el('span', '', d.ammo, 'ammocount');
    d.sep = el('span', '', d.ammo);
    d.sep.textContent = '/';
    d.res = el('span', '', d.ammo, 'ammoreserve');
    d.wname = el('div', '', d.ammo, 'weaponname');

    d.kf = el('div', '', hud, 'killfeed');
    d.dmglayer = el('div', '', hud, 'dmglayer');

    d.sb = el('div', '', hud, 'scoreboard');
    d.sb.style.display = 'none';
    const table = el('table', '', d.sb);
    const thead = el('thead', '', table);
    const hr = el('tr', '', thead);
    for (const h of ['TEAM', 'SCORE', 'KILLS', 'DEATHS', 'OPERATOR']) {
      el('th', '', hr).textContent = h;
    }
    el('tbody', '', table, 'scores');

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

    if (s.hp != null) {
      const hp = Math.min(100, Math.max(0, Number(s.hp)));
      d.hpf.style.width = `${hp}%`;
      d.hb.dataset.hp = String(Math.round(hp));
      d.hb.classList.toggle('critical', hp < 30);
      const low = alive && hp < 35;
      const beat = 0.82 + 0.18 * Math.sin((performance.now() / 1200) * Math.PI * 2);
      d.lowhp.style.opacity = low ? (((35 - hp) / 35) * 0.85 * beat).toFixed(3) : '0';
    } else {
      d.lowhp.style.opacity = '0';
    }

    if (s.mag != null) {
      d.mag.textContent = String(Math.max(0, s.mag | 0));
      this.updateAmmoLow();
    }
    if (s.reserve != null) d.res.textContent = String(Math.max(0, s.reserve | 0));
    if (s.wname != null) d.wname.textContent = String(s.wname).toUpperCase();

    const key = resolveKey(s.wid);
    if (key && key !== this.lastWepKey) {
      const tint = WEAPON_IDS.includes(key) ? `vb-w-${key}` : '';
      d.wname.className = tint;
      d.ammo.className = tint;
      this.lastWepKey = key;
      this.updateAmmoLow();
    }

    if (s.crosshairConeDeg != null) {
      this.setSpread(spreadFromCone(s.crosshairConeDeg));
    } else if (s.bloomPx != null) {
      this.setSpread(s.bloomPx);
    }
    this.updateCrosshairStress(s.panic, s.pain, alive);
    this.setReloadProgress(s.reloading01 == null ? null : s.reloading01);
    if (s.yawDeg != null) this.updateCompass(s.yawDeg);

    const adsT = Number(s.adsT01) || 0;
    const wantScope = key === 'sniper' && adsT >= 0.72 && alive;
    this.setScope(wantScope);
    this.hideCrosshairForAds(!alive || adsT > 0.35);
    d.ch.classList.toggle('vb-dead', !alive);
  }

  updateAmmoLow() {
    const def = WEAPONS[this.lastWepKey];
    const magEl = this.dom.mag;
    if (!def || !magEl) return;
    const mag = parseInt(magEl.textContent, 10);
    magEl.classList.toggle(
      'vb-low',
      Number.isFinite(mag) && mag <= Math.max(1, Math.round(def.magSize * 0.22)),
    );
  }

  setSpread(px) {
    if (!this.dom.ch) return;
    const n = Number(px);
    const gap = Math.min(76, Math.max(4, Number.isFinite(n) ? n : 4));
    const previous = Number.isFinite(this.chGap) ? this.chGap : gap;
    this.chGap = gap;
    this.dom.ch.style.setProperty('--gap-ease', gap >= previous ? '52ms' : '115ms');
    this.dom.ch.style.setProperty('--gap', `${Math.round(gap * 100) / 100}px`);
  }

  updateCrosshairStress(panicValue, painValue, alive = true) {
    const ch = this.dom.ch;
    if (!ch) return;
    const panic = clamp01(panicValue);
    const pain = clamp01(painValue);
    const painImpulse = Number(this.readModel.painImpulse) || 0;
    const stress = alive ? Math.min(1, panic * 0.72 + pain * 0.82 + painImpulse * 0.48) : 0;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const amplitude = stress * (0.45 + painImpulse * 1.35);
    const jx = amplitude * Math.sin(now * 0.041 + pain * 5.1);
    const jy = amplitude * Math.sin(now * 0.053 + panic * 4.3 + 1.7);
    const pulse = stress * (0.5 + 0.5 * Math.sin(now * 0.019));
    ch.style.setProperty('--ch-jx', `${jx.toFixed(2)}px`);
    ch.style.setProperty('--ch-jy', `${jy.toFixed(2)}px`);
    ch.style.setProperty('--ch-rot', `${(jx * 0.85).toFixed(2)}deg`);
    ch.style.setProperty('--ch-arm-opacity', (0.78 + pulse * 0.22).toFixed(3));
    ch.style.setProperty('--ch-glow', `${(4 + stress * 7).toFixed(2)}px`);
  }

  hideCrosshairForAds(hidden) {
    if (!this.dom.ch) return;
    this.dom.ch.style.opacity = hidden ? '0' : '1';
  }

  setReloadProgress(t01) {
    const ring = this.dom.ring;
    const hint = this.dom.ringHint;
    if (!ring) return;
    if (t01 == null || !isFinite(t01)) {
      if (this.ringOn) {
        ring.style.display = 'none';
        if (hint) hint.style.display = 'none';
        ring.classList.remove('vb-reload-flash');
        this.ringOn = false;
      }
      return;
    }
    const t = clamp01(t01);
    if (!this.ringOn) {
      ring.style.display = 'block';
      if (hint) hint.style.display = 'block';
      this.ringOn = true;
    }
    ring.style.setProperty('--pct', `${Math.round(clamp01(t) * 100)}%`);
    ring.classList.toggle('vb-reload-flash', t > 0.86);
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
    d.strip.style.transform = `translate3d(${x}px,0,0)`;
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

  setPlayers(players) {
    const body = document.getElementById('scores');
    if (!body || !Array.isArray(players)) return;

    for (const player of players) {
      if (player && player.id != null) {
        this.names.set(String(player.id), String(player.name || player.id));
      }
    }

    const rows = players.slice().sort((a, b) => {
      const scoreA = a.score | 0;
      const scoreB = b.score | 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return (b.kills | 0) - (a.kills | 0);
    });

    body.innerHTML = '';
    for (const player of rows) {
      const me = player.local === true;
      const dead = player.state === 'dead';
      const team = player.team === 'alpha' || player.team === 'bravo' ? player.team : null;
      const classes = [
        me ? 'vb-me' : '',
        dead ? 'dead' : '',
        team ? `vb-team-${team}` : '',
      ].filter(Boolean).join(' ');

      const tr = el('tr', classes);
      tr.dataset.pid = String(player.id ?? '');

      const teamTd = el('td', 'vb-sb-team', tr);
      if (team) {
        const teamBadge = el('span', `vb-sb-team-badge vb-badge-${team}`, teamTd);
        teamBadge.textContent = team.toUpperCase();
      } else {
        teamTd.textContent = 'FFA';
      }

      el('td', '', tr).textContent = String(player.score | 0);
      el('td', '', tr).textContent = String(player.kills | 0);
      el('td', '', tr).textContent = String(player.deaths | 0);

      const nameTd = el('td', 'vb-sb-name', tr);
      nameTd.textContent = String(player.name || 'OPERATOR');
      if (player.bomb) {
        const bombBadge = el('span', 'vb-sb-bomb-badge', nameTd);
        bombBadge.textContent = '[BOMB]';
      }

      body.appendChild(tr);
    }
  }

  ensureScope() {
    if (this.dom.scope) return this.dom.scope;
    const hud = this._root('hud');
    const scope = el('div', '', hud, 'sniper-scope');
    scope.style.pointerEvents = 'none';

    el('div', '', scope, 'scope-vignette');
    el('div', 'scope-line h', scope);
    el('div', 'scope-line v', scope);
    el('div', 'scope-duplex scope-duplex-left', scope);
    el('div', 'scope-duplex scope-duplex-right', scope);
    el('div', 'scope-duplex scope-duplex-top', scope);
    el('div', 'scope-duplex scope-duplex-bottom', scope);

    const rings = el('div', '', scope);
    rings.style.position = 'absolute';
    rings.style.inset = '0';
    rings.style.pointerEvents = 'none';

    for (const vmin of [22, 44]) {
      const ring = el('div', '', rings);
      ring.style.position = 'absolute';
      ring.style.left = '50%';
      ring.style.top = '50%';
      ring.style.width = `${vmin}vmin`;
      ring.style.height = `${vmin}vmin`;
      ring.style.margin = `-${vmin / 2}vmin 0 0 -${vmin / 2}vmin`;
      ring.style.borderRadius = '50%';
      ring.style.border = '1px solid rgba(160, 185, 210, 0.18)';
    }

    for (const pct of [-0.10, -0.075, -0.05, -0.025, 0.025, 0.05, 0.075, 0.10]) {
      const dot = el('div', '', rings);
      dot.style.position = 'absolute';
      dot.style.left = `${50 + pct * 100}%`;
      dot.style.top = '50%';
      dot.style.width = '2px';
      dot.style.height = Math.abs(pct) % 0.05 === 0 ? '6px' : '3px';
      dot.style.marginTop = Math.abs(pct) % 0.05 === 0 ? '-3px' : '-1.5px';
      dot.style.marginLeft = '-1px';
      dot.style.background = 'rgba(160, 185, 210, 0.65)';
    }

    for (const pct of [0.025, 0.05, 0.075, 0.10, 0.13, 0.16]) {
      const tick = el('div', '', rings);
      tick.style.position = 'absolute';
      tick.style.left = '50%';
      tick.style.top = `${50 + pct * 100}%`;
      const widthPx = pct >= 0.10 ? 8 : (pct === 0.05 ? 6 : 4);
      tick.style.width = `${widthPx}px`;
      tick.style.height = '1px';
      tick.style.marginLeft = `-${widthPx / 2}px`;
      tick.style.background = 'rgba(160, 185, 210, 0.65)';
    }

    const zoomVal = Number(WEAPONS.sniper && WEAPONS.sniper.zoom) || 5;
    el('div', '', scope, 'scope-zoom-label').textContent = `${zoomVal.toFixed(1)}×`;
    el('div', 'scope-model-label', scope).textContent = 'LONGSHOT MK-II · OPTIC 5×42';

    this.dom.scope = scope;
    return scope;
  }

  setScope(on) {
    if (!this.built) return;
    if (on === this.scopeShown
      && (this.scopeRAF !== 0 || (on ? this.scopeProgress >= 1 : this.scopeProgress <= 0))) {
      return;
    }
    const scope = on ? this.ensureScope() : this.dom.scope;
    if (!scope) return;

    this.scopeShown = !!on;
    if (this.scopeRAF) {
      cancelAnimationFrame(this.scopeRAF);
      this.scopeRAF = 0;
    }

    if (this.scopeShown) {
      scope.classList.add('active');
      scope.classList.remove('exiting');
    } else {
      scope.classList.remove('active');
      if (this.scopeProgress > 0) scope.classList.add('exiting');
    }

    if (this.scopeShown && this.scopeProgress >= 1) {
      scope.style.opacity = '1';
      scope.style.transform = 'scale(1)';
      return;
    }
    if (!this.scopeShown && this.scopeProgress <= 0) {
      scope.classList.remove('exiting', 'active');
      scope.style.opacity = '';
      scope.style.transform = '';
      return;
    }

    let lastT = performance.now();
    const rate = 1 / (SCOPE_MS / 1000);
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      if (this.scopeShown) {
        this.scopeProgress = Math.min(1, this.scopeProgress + dt * rate);
      } else {
        this.scopeProgress = Math.max(0, this.scopeProgress - dt * rate);
      }

      const p = this.scopeProgress;
      const k = 1 - Math.pow(1 - p, 3);
      const scale = 0.94 + 0.06 * k;
      scope.style.opacity = p.toFixed(4);
      scope.style.transform = `scale(${scale.toFixed(4)})`;

      if (this.scopeShown && p >= 1) {
        this.scopeRAF = 0;
        scope.classList.remove('exiting');
        scope.classList.add('active');
        scope.style.opacity = '1';
        scope.style.transform = 'scale(1)';
      } else if (!this.scopeShown && p <= 0) {
        this.scopeRAF = 0;
        scope.classList.remove('exiting', 'active');
        scope.style.opacity = '';
        scope.style.transform = '';
      } else {
        this.scopeRAF = requestAnimationFrame(tick);
      }
    };

    this.scopeRAF = requestAnimationFrame(tick);
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
    this.names.clear();
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
    const hud = doc ? doc.getElementById('hud') : null;
    if (this._ownedHudRoot) {
      this._ownedHudRoot.remove();
      this._ownedHudRoot = null;
    } else if (hud) {
      hud.innerHTML = '';
    }

    clearBag(this.dom);
    clearBag(this.st);
    this.names.clear();
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
