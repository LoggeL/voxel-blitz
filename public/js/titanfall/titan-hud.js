/**
 * Titanfall HUD DOM (docs/titanfall.md §8.1; WP6). A thin render of the pure
 * model from titan-hud-state.js: pilot layout (score bar, radial titan meter
 * with the call prompt, tactical chip by the crosshair, rodeo / battery
 * prompts, AT chip with the lock ring, OOB warning) and titan cockpit layout
 * (weapon tile, core ring, doom and eject panel, dash chevrons, health and
 * shield arc under the reticle, ability tiles, smoke charges, rider and lock
 * warnings). References: docs/design/titanfall/hud-pilot.png and
 * hud-titan.png, option 2. Every write goes through a paint cache, so an
 * unchanged model costs no DOM mutation.
 */
const SVG = 'http://www.w3.org/2000/svg';
const ARC_SEGMENTS = 20;
/** Health arc geometry (viewBox units): centre, radius, start and sweep (radians, 0 = right, clockwise down). */
const ARC = Object.freeze({ cx: 200, cy: -200, r: 300, from: Math.PI * 0.5 + 0.58, sweep: -1.16 });

function node(doc, tag, className = '', parent = null, text = '') {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  parent?.appendChild(element);
  return element;
}
function svg(doc, tag, attrs = {}, parent = null) {
  const element = doc.createElementNS ? doc.createElementNS(SVG, tag) : doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  parent?.appendChild(element);
  return element;
}
const hexPoints = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => {
  const a = Math.PI / 6 + i * Math.PI / 3;
  return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
}).join(' ');
/** One arc band segment as an SVG path (annulus slice between radii r0..r1). */
function arcSegment(i, n, r0, r1, gap = 0.012) {
  const g = Math.sign(ARC.sweep) * gap;
  const a0 = ARC.from + ARC.sweep * (i / n) + g, a1 = ARC.from + ARC.sweep * ((i + 1) / n) - g;
  const p = (r, a) => `${(ARC.cx + r * Math.cos(a)).toFixed(2)} ${(ARC.cy + r * Math.sin(a)).toFixed(2)}`;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 0 0 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 1 ${p(r0, a0)} Z`;
}
/** The dark backing band behind both arc bands (centre line + width in viewBox units). */
function arcBand(pad = 0.035) {
  const r = 286, a0 = ARC.from - Math.sign(ARC.sweep) * pad, a1 = ARC.from + ARC.sweep + Math.sign(ARC.sweep) * pad;
  const p = a => `${(ARC.cx + r * Math.cos(a)).toFixed(2)} ${(ARC.cy + r * Math.sin(a)).toFixed(2)}`;
  return `M ${p(a0)} A ${r} ${r} 0 0 0 ${p(a1)}`;
}
function ring(doc, parent, className, r = 22) {
  const box = svg(doc, 'svg', { class: className, viewBox: '0 0 56 56', 'aria-hidden': 'true' }, parent);
  svg(doc, 'circle', { class: 'tf-ring-bg', cx: 28, cy: 28, r }, box);
  const fill = svg(doc, 'circle', { class: 'tf-ring-fill', cx: 28, cy: 28, r, pathLength: 100, transform: 'rotate(-90 28 28)' }, box);
  return { box, fill };
}
function kbd(doc, parent, text = '') { return node(doc, 'kbd', 'tf-key', parent, text); }

export class TitanHud {
  constructor(parent = typeof document !== 'undefined' ? document.body : null, { documentRef = typeof document !== 'undefined' ? document : null } = {}) {
    this.doc = documentRef;
    this.cache = new Map();
    this.layout = null;
    if (!this.doc || !parent) return;
    const d = this.doc;
    const root = this.root = node(d, 'section', 'tf-hud', parent);
    root.id = 'titanfall-hud';
    root.setAttribute('aria-label', 'Titanfall HUD');
    root.dataset.layout = 'hidden';
    const $ = this.$ = {};

    // Score bar (both layouts).
    const top = $.top = node(d, 'div', 'tf-top', root);
    const own = node(d, 'div', 'tf-top-side tf-own', top);
    $.ownLabel = node(d, 'span', 'tf-team', own, 'MILITIA');
    $.ownScore = node(d, 'b', 'tf-score', own, '0');
    $.ownBar = node(d, 'i', '', node(d, 'i', 'tf-bar', own));
    const clock = node(d, 'div', 'tf-clock', top);
    $.clock = node(d, 'b', '', clock, '--:--');
    $.limit = node(d, 'span', '', clock, '');   // '/ <scoreLimit>' from the model on the first render
    const enemy = node(d, 'div', 'tf-top-side tf-enemy', top);
    $.enemyBar = node(d, 'i', '', node(d, 'i', 'tf-bar', enemy));
    $.enemyScore = node(d, 'b', 'tf-score', enemy, '0');
    $.enemyLabel = node(d, 'span', 'tf-team', enemy, 'IMC');
    $.banner = node(d, 'div', 'tf-banner', root);
    $.banner.setAttribute('role', 'status');

    // Pilot layout.
    const pilot = $.pilot = node(d, 'div', 'tf-pilot', root);
    const tac = $.tac = node(d, 'div', 'tf-tactical tf-glass', pilot);
    $.tacKey = kbd(d, tac, 'Q');
    $.tacLabel = node(d, 'span', 'tf-tac-label', tac, 'GRAPPLE');
    $.tacPips = node(d, 'div', 'tf-pips', tac);
    const rodeo = $.rodeo = node(d, 'div', 'tf-rodeo tf-glass', pilot);
    $.rodeoRing = ring(d, rodeo, 'tf-rodeo-ring', 22);
    node(d, 'span', 'tf-rodeo-icon', rodeo);
    const rodeoText = node(d, 'div', 'tf-rodeo-text', rodeo);
    const rodeoLine = node(d, 'span', 'tf-rodeo-hold', rodeoText);
    $.rodeoHold = node(d, 'span', '', rodeoLine, 'HOLD');
    $.rodeoKey = kbd(d, rodeoLine, 'T');
    $.rodeoLabel = node(d, 'b', '', rodeoText, 'RODEO');
    const dock = node(d, 'div', 'tf-dock', pilot);
    const meter = $.meter = node(d, 'div', 'tf-meter', dock);
    const hex = svg(d, 'svg', { class: 'tf-hex', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, meter);
    svg(d, 'polygon', { class: 'tf-hex-bg', points: hexPoints(50, 50, 44) }, hex);
    $.hexFill = svg(d, 'polygon', { class: 'tf-hex-fill', points: hexPoints(50, 50, 44), pathLength: 100 }, hex);
    svg(d, 'polygon', { class: 'tf-hex-core', points: hexPoints(50, 50, 33) }, hex);
    const helm = svg(d, 'g', { class: 'tf-hex-icon' }, hex);
    svg(d, 'path', { d: 'M38 36 h24 l6 10 -4 16 h-6 l-2 -6 h-12 l-2 6 h-6 l-4 -16 z' }, helm);
    svg(d, 'rect', { class: 'tf-hex-eye', x: 44, y: 44, width: 12, height: 5, rx: 1 }, helm);
    const meterText = node(d, 'div', 'tf-meter-text', meter);
    $.meterTitle = node(d, 'span', '', meterText, 'TITAN');
    $.meterPct = node(d, 'b', '', meterText, '0%');
    $.meterState = node(d, 'span', 'tf-meter-state', meterText, '');
    const call = $.call = node(d, 'div', 'tf-call tf-glass', dock);
    $.callKey = kbd(d, call, 'E');
    $.callLabel = node(d, 'span', '', call, 'CALL TITAN');
    // On the pilot root, not the dock: its touch placement is in viewport terms (beside the pause button).
    $.battery = node(d, 'div', 'tf-battery tf-glass', pilot);
    node(d, 'span', 'tf-battery-icon', $.battery);
    node(d, 'span', '', $.battery, 'BATTERY CARRIED');
    const at = $.at = node(d, 'div', 'tf-at tf-glass', pilot);
    $.atRing = ring(d, at, 'tf-at-ring', 20);
    const atText = node(d, 'div', 'tf-at-text', at);
    node(d, 'span', 'tf-at-role', atText, 'ANTI-TITAN');
    $.atLabel = node(d, 'b', '', atText, '');
    $.atAmmo = node(d, 'span', 'tf-at-ammo', at, '');

    // Titan layout.
    const titan = $.titan = node(d, 'div', 'tf-titan', root);
    const weapon = $.weapon = node(d, 'div', 'tf-weapon tf-tile', titan);
    $.weaponLabel = node(d, 'span', 'tf-weapon-label', weapon, '');
    const weaponRow = node(d, 'div', 'tf-weapon-row', weapon);
    $.weaponAmmo = node(d, 'b', '', weaponRow, '');
    $.weaponBar = node(d, 'i', '', node(d, 'i', 'tf-ammo-bar', weaponRow));
    $.weaponCharge = node(d, 'i', '', node(d, 'i', 'tf-charge-bar', weapon));
    const core = $.core = node(d, 'div', 'tf-core tf-tile', titan);
    node(d, 'span', 'tf-core-title', core, 'CORE');
    $.corePct = node(d, 'b', '', core, '0%');
    $.coreRing = ring(d, core, 'tf-core-ring', 22);
    $.coreKey = kbd(d, core, 'V');
    $.coreLabel = node(d, 'span', 'tf-core-label', core, '');
    const doom = $.doom = node(d, 'div', 'tf-doom', titan);
    node(d, 'b', 'tf-doom-title', doom, 'DOOMED');
    $.doomCells = node(d, 'div', 'tf-doom-cells', doom);
    $.doomCellList = Array.from({ length: 7 }, () => node(d, 'i', '', $.doomCells));
    const eject = node(d, 'div', 'tf-eject', doom);
    $.ejectPress = node(d, 'span', '', eject, 'PRESS');
    $.ejectKey = kbd(d, eject, 'X');
    $.ejectTaps = node(d, 'span', 'tf-eject-taps', eject, '×3');
    node(d, 'b', '', eject, 'EJECT');
    const dash = $.dash = node(d, 'div', 'tf-dash tf-tile', titan);
    const dashHead = node(d, 'div', 'tf-dash-head', dash);
    node(d, 'span', '', dashHead, 'DASH');
    $.dashKey = kbd(d, dashHead, 'SPACE');
    $.dashCells = node(d, 'div', 'tf-chevrons', dash);
    node(d, 'div', 'tf-reticle-ring', titan);
    const health = $.health = node(d, 'div', 'tf-health', titan);
    // Shield on the inner band (above), hull on the outer band, as in hud-titan.png option 2.
    const arc = svg(d, 'svg', { class: 'tf-arc', viewBox: '0 0 400 112', 'aria-hidden': 'true' }, health);
    svg(d, 'path', { class: 'tf-arc-band', d: arcBand() }, arc);
    $.shieldSegs = Array.from({ length: ARC_SEGMENTS }, (_, i) => svg(d, 'path', { class: 'tf-seg tf-seg-shield', d: arcSegment(i, ARC_SEGMENTS, 268, 280) }, arc));
    $.hullSegs = Array.from({ length: ARC_SEGMENTS }, (_, i) => svg(d, 'path', { class: 'tf-seg tf-seg-hull', d: arcSegment(i, ARC_SEGMENTS, 283, 304) }, arc));
    const healthText = node(d, 'div', 'tf-health-text', health);
    $.shieldText = node(d, 'span', 'tf-shield-text', healthText, '');
    $.hullText = node(d, 'b', 'tf-hull-text', healthText, '');
    const abilities = $.abilities = node(d, 'div', 'tf-abilities', titan);
    $.slots = ['defensive', 'tactical', 'ordnance'].map(slot => {
      const tile = node(d, 'div', `tf-ability tf-tile tf-ability-${slot}`, abilities);
      tile.dataset.slot = slot;
      const key = kbd(d, tile, '');
      const radial = ring(d, tile, 'tf-ability-ring', 20);
      node(d, 'span', `tf-ability-icon tf-icon-${slot}`, tile);
      const pctText = node(d, 'span', 'tf-ability-pct', tile, '');
      const label = node(d, 'span', 'tf-ability-label', tile, '');
      return { tile, key, radial, pct: pctText, label };
    });
    const smoke = $.smoke = node(d, 'div', 'tf-smoke tf-tile', titan);
    $.smokeKey = kbd(d, smoke, 'C');
    node(d, 'span', '', smoke, 'SMOKE');
    $.smokePips = node(d, 'div', 'tf-pips', smoke);
    $.lock = node(d, 'div', 'tf-lock', titan);

    // Dead layout: the loadout screen covers the screen (titan-loadout.js); the meter stays.
    $.dead = node(d, 'div', 'tf-dead', root);
    $.deadText = node(d, 'span', '', $.dead, '');
  }

  _set(key, element, prop, value) {
    if (!element) return;
    const id = `${key}.${prop}`;
    if (this.cache.get(id) === value) return;
    this.cache.set(id, value);
    if (prop === 'text') element.textContent = value;
    else if (prop === 'hidden') element.hidden = !!value;
    else if (prop.startsWith('data-')) element.setAttribute(prop, value);
    else if (prop.startsWith('--')) element.style.setProperty(prop, value);
    else if (prop === 'dash') element.setAttribute('stroke-dasharray', value);
    else if (prop === 'class') element.setAttribute('class', value);
  }
  _ring(key, ringRef, frac) {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    this._set(key, ringRef.fill, 'dash', `${pct} 100`);
  }
  _pips(key, container, values, max) {
    if (!container) return;
    const sig = `${max}`;
    if (this.cache.get(`${key}.count`) !== sig) {
      this.cache.set(`${key}.count`, sig);
      container.textContent = '';
      for (let i = 0; i < max; i++) node(this.doc, 'i', '', container);
    }
    [...container.children].forEach((pip, i) => this._set(`${key}.${i}`, pip, 'data-fill', values[i] >= 1 ? 'full' : values[i] > 0 ? 'part' : 'empty'));
  }

  /** Paint one model (titanHudModel). Returns the layout painted. */
  render(model) {
    if (!this.root) return null;
    const layout = model?.layout ?? 'hidden';
    this._set('root', this.root, 'data-layout', layout);
    if (layout !== this.layout) this.layout = layout;
    const $ = this.$;
    const top = model?.top;
    this._set('top', $.top, 'hidden', !top || layout === 'hidden');
    if (top) {
      this._set('ownLabel', $.ownLabel, 'text', top.own.label);
      this._set('ownScore', $.ownScore, 'text', String(top.own.score));
      this._set('ownBar', $.ownBar, '--fill', `${(top.own.frac * 100).toFixed(1)}%`);
      this._set('enemyLabel', $.enemyLabel, 'text', top.enemy.label);
      this._set('enemyScore', $.enemyScore, 'text', String(top.enemy.score));
      this._set('enemyBar', $.enemyBar, '--fill', `${(top.enemy.frac * 100).toFixed(1)}%`);
      this._set('clock', $.clock, 'text', top.clock);
      this._set('limit', $.limit, 'text', `/ ${top.limit}`);
      this._set('clockUrgent', $.clock, 'data-urgent', String(!!top.urgent));
      this._set('ownTeam', $.top, 'data-own', top.own.team);
    }
    const banner = model?.rider || model?.oob?.label || (model?.titan?.lock?.state === 3 ? model.titan.lock.label : '') || model?.toast || '';
    this._set('banner', $.banner, 'text', banner);
    this._set('bannerHidden', $.banner, 'hidden', !banner);
    this._set('bannerKind', $.banner, 'data-kind', model?.rider ? 'rider' : model?.oob ? 'oob' : model?.titan?.lock?.state === 3 ? 'lock' : 'toast');
    this._set('pilotHidden', $.pilot, 'hidden', layout !== 'pilot');
    this._set('titanHidden', $.titan, 'hidden', layout !== 'titan');
    this._set('deadHidden', $.dead, 'hidden', layout !== 'dead');
    this._touch = !!model?.touch;
    if (layout === 'pilot') this._pilot(model.pilot);
    else if (layout === 'titan') this._titan(model.titan);
    else if (layout === 'dead') {
      const meter = model.meter;
      const queued = model.deploy?.queued ? (model.respawnIn > 0.05 ? `DEPLOYING IN ${model.respawnIn.toFixed(1)}` : 'DEPLOYING') : '';
      this._set('deadText', $.deadText, 'text', queued || (meter ? `${meter.label} · ${meter.pct}%` : ''));
    }
    return layout;
  }

  _pilot(p) {
    const $ = this.$;
    if (!p) return;
    const m = p.meter;
    this._set('meterState', $.meter, 'data-state', m.state);
    this._set('hexFill', $.hexFill, 'dash', `${m.pct} 100`);
    this._set('meterTitle', $.meterTitle, 'text', m.title ?? (m.state === 'filling' ? 'TITAN' : m.titan));
    this._set('meterPct', $.meterPct, 'text', `${m.pct}%`);
    this._set('meterLabel', $.meterState, 'text', m.state === 'filling' ? '' : m.label);
    this._set('callHidden', $.call, 'hidden', !m.prompt);
    if (m.prompt) {
      this._set('callKey', $.callKey, 'text', m.prompt.key);
      this._set('callLabel', $.callLabel, 'text', m.prompt.hold ? `HOLD · ${m.prompt.label}` : m.prompt.label);
      this._set('callHold', $.call, 'data-holding', String((m.prompt.progress ?? 0) > 0));
      this._set('callKind', $.call, 'data-kind', m.prompt.label === 'EMBARK' ? 'embark' : 'call');
      this._set('callProgress', $.call, '--progress', `${Math.round((m.prompt.progress ?? 0) * 100)}%`);
    }
    this._set('battery', $.battery, 'hidden', !p.battery);
    const t = p.tactical;
    this._set('tacKey', $.tacKey, 'text', t.key);
    this._set('tacLabel', $.tacLabel, 'text', t.label);
    this._set('tacState', $.tac, 'data-state', t.state);
    this._pips('tacPips', $.tacPips, t.pips, t.max);
    const r = p.rodeo;
    this._set('rodeoHidden', $.rodeo, 'hidden', !r);
    if (r) {
      this._set('rodeoKind', $.rodeo, 'data-kind', r.kind);
      this._set('rodeoLabel', $.rodeoLabel, 'text', r.label);
      // Touch acts through the RODEO / RIP / BATTERY context button: the verb names it, the key chip hides (CSS).
      // An insert in the display slack (MOVE CLOSER) names the battery and shows no key: a press does nothing yet.
      const far = r.kind === 'insert' && r.inReach === false;
      // A rodeo a jump reaches (not yet in contact): touch names the jump, the RODEO chip is not offered.
      const leap = r.kind === 'mount' && r.inReach === false;
      // The rip runs on by itself once started (a tap): STAY ON names what keeps it going, not a held key.
      this._set('rodeoHold', $.rodeoHold, 'text', r.kind === 'ripping' ? 'STAY ON' : r.kind === 'riding' ? (r.sub ?? '') : far ? 'BATTERY'
        : this._touch ? (leap ? 'JUMP' : 'TAP') : 'PRESS');
      this._set('rodeoKey', $.rodeoKey, 'text', r.kind === 'riding' ? r.key : r.hold ?? r.key ?? 'T');
      this._set('rodeoKeyHidden', $.rodeoKey, 'hidden', far || r.kind === 'ripping');
      this._ring('rodeoRing', $.rodeoRing, r.progress ?? (r.kind === 'riding' ? 1 : 0));
    }
    const at = p.at;
    this._set('atHidden', $.at, 'hidden', !at);
    if (at) {
      this._set('atLabel', $.atLabel, 'text', at.label);
      this._set('atAmmo', $.atAmmo, 'text', at.mag == null ? '' : `${at.mag} / ${at.reserve ?? 0}`);
      this._set('atState', $.at, 'data-lock', at.locked ? 'locked' : at.lock > 0 ? 'locking' : 'none');
      this._set('atEquipped', $.at, 'data-equipped', String(!!at.equipped));
      this._ring('atRing', $.atRing, at.lock);
    }
  }

  _titan(t) {
    const $ = this.$;
    if (!t) return;
    this._set('titanType', $.titan, 'data-type', t.type);
    this._set('titanDoomed', $.titan, 'data-doomed', String(!!t.doomed));
    const w = t.weapon;
    this._set('weaponHidden', $.weapon, 'hidden', !w);
    if (w) {
      this._set('weaponLabel', $.weaponLabel, 'text', w.label);
      this._set('weaponAmmo', $.weaponAmmo, 'text', w.reload > 0 && w.ammo === 0 ? 'RELOAD' : w.ammoText);
      this._set('weaponBar', $.weaponBar, '--fill', `${Math.round(w.frac * 100)}%`);
      this._set('weaponCharge', $.weaponCharge, '--fill', `${Math.round(Math.max(w.charge, w.heat) * 100)}%`);
      this._set('weaponChargeHidden', $.weaponCharge.parentNode, 'hidden', !(w.charge > 0 || w.heat > 0));
    }
    this._set('corePct', $.corePct, 'text', t.core.active ? 'ACTIVE' : `${t.core.pct}%`);
    this._set('coreKey', $.coreKey, 'text', t.core.key);
    this._set('coreLabel', $.coreLabel, 'text', t.core.label);
    this._set('coreState', $.core, 'data-state', t.core.active ? 'active' : t.core.ready ? 'ready' : 'charging');
    this._ring('coreRing', $.coreRing, t.core.frac);
    this._set('doomHidden', $.doom, 'hidden', !t.doomed);
    if (t.doomed) {
      const lit = Math.ceil(t.doomFrac * $.doomCellList.length);
      $.doomCellList.forEach((cell, i) => this._set(`doom${i}`, cell, 'data-fill', i < lit ? 'full' : 'empty'));
      this._set('ejectKey', $.ejectKey, 'text', t.eject?.key ?? 'X');
      this._set('ejectPress', $.ejectPress, 'text', this._touch ? 'TAP' : 'PRESS');
      this._set('ejectTaps', $.ejectTaps, 'text', t.eject?.taps ? `${t.eject.taps}/3` : '×3');
    }
    this._set('dashKey', $.dashKey, 'text', t.dash.key);
    this._pips('dash', $.dashCells, t.dash.cells, t.dash.max);
    // Doomed: the hull band is empty and the doom countdown is its red fill.
    const hullLit = Math.round((t.doomed ? t.doomFrac : t.hpFrac) * ARC_SEGMENTS), shieldLit = Math.round(t.shieldFrac / 0.35 * ARC_SEGMENTS);
    $.hullSegs.forEach((seg, i) => this._set(`hull${i}`, seg, 'class', `tf-seg tf-seg-hull${i < hullLit ? ' is-lit' : ''}`));
    $.shieldSegs.forEach((seg, i) => this._set(`shield${i}`, seg, 'class', `tf-seg tf-seg-shield${i < shieldLit ? ' is-lit' : ''}`));
    this._set('shieldText', $.shieldText, 'text', t.shield > 0 ? `SHIELD ${t.shield}` : '');
    this._set('hullText', $.hullText, 'text', t.healthText);
    t.abilities.forEach((a, i) => {
      const slot = $.slots[i];
      if (!slot) return;
      this._set(`ab${i}key`, slot.key, 'text', a.key);
      this._set(`ab${i}label`, slot.label, 'text', a.label);
      this._set(`ab${i}state`, slot.tile, 'data-state', a.state);
      this._set(`ab${i}pct`, slot.pct, 'text', a.state === 'cooling' ? `${a.readyPct}%` : '');
      this._ring(`ab${i}ring`, slot.radial, a.ready);
    });
    this._set('smokeKey', $.smokeKey, 'text', t.smoke.key);
    this._set('smokeState', $.smoke, 'data-state', t.smoke.active ? 'active' : t.smoke.charges > 0 ? 'ready' : 'empty');
    this._pips('smokePips', $.smokePips, Array.from({ length: t.smoke.max }, (_, i) => i < t.smoke.charges ? 1 : 0), t.smoke.max);
    this._set('lock', $.lock, 'text', t.lock?.label ?? '');
    this._set('lockHidden', $.lock, 'hidden', !t.lock);
    this._set('lockState', $.lock, 'data-state', String(t.lock?.state ?? 0));
  }

  dispose() {
    this.root?.remove();
    this.root = null;
    this.cache.clear();
  }
}
