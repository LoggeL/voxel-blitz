/**
 * Comeback call-in on the HUD (docs/conquest.md "Comeback call-in"; design
 * docs/design/conquest/events/comeback/, variant A "strike strip"). Reads the
 * decoded `ev` row (cq.mapEvents) and the `map_event` events only; the
 * server decides who may call, where and what lands.
 *
 *   banners    READY for the caller's side only (the other side learns of it
 *              from the telegraph), then "BOMBER RUN · INCOMING" (red, the
 *              target side) / "· INBOUND" (the caller's side) with the impact
 *              countdown, and the strike
 *   READY pill a compact "CALL-IN READY · M" chip at the top left (under the
 *              touch column on phones) while the own side holds the call-in
 *   designator on the full map (M) of a squad leader of that side: a strip under
 *              the map header with BOMBER RUN / ARTILLERY cards, a hover
 *              preview (the bomb line from the own HQ, or the 25 m circle) and
 *              a click / tap / cursor pick that sends the `use` intent
 *              `comeback:call:<kind>:<x>:<z>`; refused spots (outside the
 *              combat area, on an HQ) preview grey with the reason
 *   maps       the strike's bomb line or circle under the markers while it
 *              warns and lands (red, pulsing through the telegraph)
 *   marker     the hexagon names the strike ("BOMBER RUN · 4 S")
 */
import {
  COMEBACK_TUNING, comebackCallKey, comebackHeadingDeg, comebackKindOf, comebackStrikePlan, comebackTargetRefusal, comebackZoneOf,
} from '../../../../../shared/map-events/comeback.js';
import { el } from '../../hud-support.js';
import { svgIcon } from '../icons.js';

export const COMEBACK_KIND_NAMES = Object.freeze({ bomber: 'BOMBER RUN', artillery: 'ARTILLERY' });
const KIND_DETAIL = Object.freeze({
  bomber: `${COMEBACK_TUNING.bomber.bombs} BOMBS · LINE`,
  artillery: `${COMEBACK_TUNING.artillery.shells} SHELLS · ${COMEBACK_TUNING.artillery.radius} M`,
});
const KIND_GLYPH = Object.freeze({ bomber: 'plane', artillery: 'mortar' });
const REFUSAL_TEXT = Object.freeze({ area: 'OUTSIDE THE COMBAT AREA', hq: 'NO STRIKES ON AN HQ' });
const RED = '#ff4b4b', GREY = '#9fb0bd';

/** The strike kind of a `map_event` event (its data) or of a snapshot banner (the row's extra). */
const kindOfEv = ev => ev?.data?.kind ?? comebackKindOf(ev?.extra?.[0]);

/** The comeback row of the decoded snapshot, or null. */
export const comebackEvent = cq => (cq?.mapEvents?.events ?? []).find(e => e.id === 'comeback') ?? null;

/** True while the viewer's side holds a call-in nobody has designated yet. */
export const comebackReady = (cq, selfTeam) => {
  const e = comebackEvent(cq);
  return !!e && e.phase === 'armed' && !!selfTeam && e.team === selfTeam;
};

/** The READY pill model, or null: {leader, text}. */
export function comebackReadyModel(cq, selfTeam, { leader = false, alive = true, mapKey = 'M' } = {}) {
  if (!alive || !comebackReady(cq, selfTeam)) return null;
  return { leader, text: leader ? `CALL-IN READY · ${mapKey}` : 'CALL-IN READY · SQUAD LEADER' };
}

/**
 * Hover preview of a designation at (x, z) for `team`: the plan the server
 * would build (its bomb line or circle) and the refusal, if any.
 */
export function comebackPreview(meta, team, kind, x, z) {
  const refusal = comebackTargetRefusal(meta, x, z);
  const target = { x: Math.round(x), z: Math.round(z) };
  const headingDeg = comebackHeadingDeg(meta, team, target);
  return { kind, target, refusal, plan: comebackStrikePlan({ kind, target, headingDeg }), base: meta?.bases?.[team] ?? null };
}

/** Paint a strike plan in world metres (the map context already maps x/z; `px` canvas px per metre). */
export function paintComebackPlan(ctx, plan, { px = 1, color = RED, pulse = 0, base = null, fill = true } = {}) {
  // Line widths and marks in screen pixels (the map scales by `px`): legible over the flag markers at any map size.
  const lw = 2.4 / px, m = 1 / px;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round';
  if (plan.kind === 'bomber') {
    const { a, b, dir } = plan;
    if (fill) {
      ctx.globalAlpha = 0.22 + 0.14 * pulse; ctx.lineWidth = plan.zone.w * 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.z); ctx.lineTo(b.x, b.z); ctx.stroke();
    }
    // The approach from the caller's HQ side, dashed, then the bomb line with a dot per bomb.
    if (base) {
      ctx.globalAlpha = 0.8; ctx.setLineDash([7 * m, 6 * m]); ctx.lineWidth = lw * 0.8;
      ctx.beginPath(); ctx.moveTo(a.x - dir.x * 180, a.z - dir.z * 180); ctx.lineTo(a.x, a.z); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(a.x, a.z); ctx.lineTo(b.x, b.z); ctx.stroke();
    for (const d of plan.drops) { ctx.beginPath(); ctx.arc(d.x, d.z, 3.4 * m, 0, Math.PI * 2); ctx.fill(); }
    // Arrow head past the last bomb.
    const s = 11 * m, tip = { x: b.x + dir.x * (8 * m + s), z: b.z + dir.z * (8 * m + s) }, side = { x: -dir.z, z: dir.x };
    ctx.beginPath(); ctx.moveTo(tip.x, tip.z);
    ctx.lineTo(tip.x - dir.x * s + side.x * s * 0.6, tip.z - dir.z * s + side.z * s * 0.6);
    ctx.lineTo(tip.x - dir.x * s - side.x * s * 0.6, tip.z - dir.z * s - side.z * s * 0.6); ctx.closePath(); ctx.fill();
  } else {
    const z = plan.zone, r = COMEBACK_TUNING.artillery.radius;
    if (fill) { ctx.globalAlpha = 0.2 + 0.14 * pulse; ctx.beginPath(); ctx.arc(z.x, z.z, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.lineWidth = lw; ctx.setLineDash([6 * m, 4 * m]);
    ctx.beginPath(); ctx.arc(z.x, z.z, r + 2 * pulse, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    const c = 9 * m;
    ctx.beginPath(); ctx.moveTo(z.x - c, z.z); ctx.lineTo(z.x + c, z.z); ctx.moveTo(z.x, z.z - c); ctx.lineTo(z.x, z.z + c); ctx.stroke();
  }
  ctx.restore();
}

/**
 * The full-map designator (strip under the map header + the pick) of one
 * BigMap. Created lazily by the presenter's `hud` hook; inert unless the
 * viewer leads a squad of the side holding the call-in.
 */
export class ComebackDesignator {
  constructor(bigMap, { send }) {
    this.bigMap = bigMap;
    this.send = send;
    this.kind = 'artillery';
    this.state = null;
    this.hover = null;
    this.sentAt = -Infinity;
    const mapRoot = bigMap.map.root, panel = mapRoot.parentElement ?? mapRoot.parentNode ?? null;
    const doc = globalThis.document;
    this.root = el('div', 'cq-callin', null);
    // Under the map header, above the map (the fake DOM of the Node suites has no parent links: the panel's end).
    if (typeof panel?.insertBefore === 'function') panel.insertBefore(this.root, mapRoot);
    else bigMap.root?.appendChild?.(this.root);
    this.root.hidden = true;
    const badge = el('span', 'cq-callin-badge', this.root);
    const icon = svgIcon(doc, 'callin', 'vb-cq-icon cq-callin-glyph');
    if (icon) badge.appendChild(icon);
    const text = el('div', 'cq-callin-text', this.root);
    el('strong', 'cq-callin-title', text).textContent = 'CALL-IN READY';
    this.sub = el('span', 'cq-callin-sub', text);
    const cards = el('div', 'cq-callin-cards', this.root);
    this.cards = {};
    for (const kind of ['bomber', 'artillery']) {
      const card = el('button', 'cq-callin-card', cards);
      card.type = 'button';
      card.dataset.kind = kind;
      const glyph = svgIcon(doc, KIND_GLYPH[kind], 'vb-cq-icon cq-callin-card-glyph');
      if (glyph) card.appendChild(glyph);
      const label = el('span', 'cq-callin-card-text', card);
      el('b', '', label).textContent = COMEBACK_KIND_NAMES[kind];
      el('small', '', label).textContent = KIND_DETAIL[kind];
      card.addEventListener('click', event => { event.preventDefault?.(); this.setKind(kind); });
      this.cards[kind] = card;
    }
    this.setKind(this.kind);
    // The map's own pick and hover (NorthUpMap.onPoint / onHover, in world metres).
    bigMap.tool = this;
  }

  setKind(kind) {
    if (!this.cards[kind]) return;
    this.kind = kind;
    if (this.hover) this.hoverAt(this.hover.target.x, this.hover.target.z);
    for (const [k, card] of Object.entries(this.cards)) card.dataset.selected = String(k === kind);
  }

  /** Per frame: {active, team, meta, sub}. */
  update(state) {
    this.state = state?.active ? state : null;
    this.root.hidden = !this.state;
    this.bigMap.root.dataset.callin = String(!!this.state);
    if (this.state && this.sub.textContent !== this.state.sub) this.sub.textContent = this.state.sub;
    if (!this.state) this.hover = null;
    // A pad / keyboard cursor already resting on the map previews without a move.
    else if (!this.hover && this.active && this.bigMap.cursorVisible) {
      const at = this.bigMap.map.worldAt(this.bigMap.cursorAt.u, this.bigMap.cursorAt.v);
      this.hoverAt(at.x, at.z);
    }
  }

  get active() { return !!this.state && this.bigMap.open; }

  /** The map hint while designating (BigMap.setOrders defers to it). */
  hint() { return this.hover?.refusal ? REFUSAL_TEXT[this.hover.refusal] : 'CLICK THE MAP TO MARK THE TARGET · ESC CANCELS'; }

  /** Pointer over the map (world metres) or null. */
  hoverAt(x, z) {
    if (!this.active || !Number.isFinite(x)) { this.hover = null; return; }
    this.hover = comebackPreview(this.state.meta, this.state.team, this.kind, x, z);
  }

  /** A pick on the map (world metres): send the call when the spot is allowed. True when consumed. */
  pick(x, z) {
    if (!this.active) return false;
    const preview = comebackPreview(this.state.meta, this.state.team, this.kind, x, z);
    this.hover = preview;
    if (preview.refusal) return true;
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (now - this.sentAt < 600) return true;
    this.sentAt = now;
    this.send({ type: 'use', targetId: comebackCallKey(this.kind, preview.target.x, preview.target.z) });
    return true;
  }

  /** World-space overlay over the map (NorthUpMap.draw, under the markers). */
  paint(ctx, { px = 1 } = {}) {
    if (!this.active || !this.hover) return;
    paintComebackPlan(ctx, this.hover.plan, { px, color: this.hover.refusal ? GREY : RED, base: this.hover.base, fill: !this.hover.refusal });
  }
}

export const COMEBACK_PRESENTER = {
  banner(ev, { selfTeam }, base) {
    if (!base) return undefined;
    const own = !!ev.team && ev.team === selfTeam;
    if (ev.phase === 'armed') {
      if (!own) return null;
      // Touch has no M key (the lit MAP button is the way in).
      const touch = !!globalThis.document?.documentElement?.classList?.contains?.('vb-touch-mode');
      return { ...base, title: 'CALL-IN READY', tone: 'own', detail: touch ? String(base.detail ?? '').replace(' (M)', '') : base.detail };
    }
    if (ev.phase !== 'warning' && ev.phase !== 'active') return null;
    const kind = kindOfEv(ev);
    const name = COMEBACK_KIND_NAMES[kind] ?? 'CALL-IN';
    const word = ev.phase === 'warning' ? (own ? 'INBOUND' : 'INCOMING') : own ? 'ON TARGET' : 'IMPACT';
    return { ...base, title: `${name} · ${word}`, tone: own ? 'own' : 'danger', icon: KIND_GLYPH[kind] ?? base.icon };
  },

  paintMap(ctx, event, { nowMs = 0, px = 1 } = {}) {
    if (event.phase !== 'warning' && event.phase !== 'active') return;
    const plan = comebackZoneOf(event);
    if (!plan) return;
    const pulse = event.phase === 'warning' ? (Math.sin(nowMs / 140) + 1) / 2 : 0.6;
    paintComebackPlan(ctx, plan, { px, pulse });
  },

  marker(model, event, { selfTeam } = {}) {
    const kind = comebackKindOf(event.extra?.[0]);
    const seconds = Number.isFinite(event.leftMs) && event.phase === 'warning' ? Math.ceil(event.leftMs / 1000) : null;
    const name = COMEBACK_KIND_NAMES[kind] ?? model.name;
    return { ...model, name: seconds != null ? `${name} · ${seconds} S` : name, tone: event.team && event.team === selfTeam ? 'own' : 'danger' };
  },

  /**
   * HUD hook (ConquestHud._render, every frame): the READY pill and the
   * full-map designator. `ctx`: {hud, cq, self, selfTeam, leader, living, touch, nowMs}.
   */
  hud({ hud, cq, selfTeam, leader, living, touch }) {
    if (!hud?.root || !hud.bigMap) return;
    let ui = this._ui?.get?.(hud);
    if (!ui) {
      ui = { pill: el('div', 'cq-callin-pill', hud.root), designator: new ComebackDesignator(hud.bigMap, { send: intent => hud.onSupport?.(intent) }) };
      const icon = svgIcon(globalThis.document, 'callin', 'vb-cq-icon cq-callin-glyph');
      if (icon) ui.pill.appendChild(icon);
      ui.pillText = el('span', '', ui.pill);
      (this._ui ??= new WeakMap()).set(hud, ui);
    }
    const model = comebackReadyModel(cq, selfTeam, { leader, alive: living });
    // Touch: no pill over the crowded top row; the MAP button itself lights up for a leader.
    ui.pill.hidden = !model || hud.bigMap.open || !!touch;
    const mapButton = touch ? globalThis.document?.getElementById?.('touch-bigMap') : null;
    if (mapButton) mapButton.dataset.callin = String(!!model?.leader);
    else if (ui.mapButton) ui.mapButton.dataset.callin = 'false';
    ui.mapButton = mapButton ?? ui.mapButton ?? null;
    if (model && ui.pillText.textContent !== model.text) ui.pillText.textContent = model.text;
    ui.pill.dataset.leader = String(!!model?.leader);
    const deficit = Math.abs((cq?.tickets?.alpha ?? 0) - (cq?.tickets?.bravo ?? 0));
    const sub = cq?.breakthrough ? 'ONE STRIKE THIS ROUND' : `${deficit} TICKETS BEHIND · ONE STRIKE THIS ROUND`;
    ui.designator.update({ active: !!model && leader, team: selfTeam, meta: cq?.meta ?? null, sub });
  },
};
