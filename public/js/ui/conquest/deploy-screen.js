/**
 * Deploy screen while dead in Conquest: map with selectable spawns from the
 * shared deployOptions(), spawn list, a two-row class strip (five base kits,
 * then the level unlocks; locked kits show a padlock, the unlock level and XP
 * progress and cannot be picked; fresh unlocks are named in the section
 * header), one loadout slot under the base row with the picked class's
 * variant and gadget toggles (Engineer: AT launcher or STINGER), a class info line (the hint of the
 * hovered, focused or selected class, or why a tapped class is locked),
 * killer card, countdown to respawnAt and the Deploy button (desktop: beside
 * the unlocks row). The server holds the chosen
 * spawn and spawns the player once respawnAt passes, so a choice may be sent
 * during the countdown; any later change is re-sent.
 */
import { el, loadPref, savePref } from '../hud-support.js';
import { deployModel } from '../conquest-hud-state.js';
import { NorthUpMap } from './big-map.js';
import { svgIcon } from './icons.js';

const KIT_PREF = 'vb-conquest-kit';
/** A tapped locked class says when it opens for this long in the class info line. */
const LOCK_NOTE_MS = 4000;
const fmt = n => Math.round(n).toLocaleString('en-US');
const SEAT_SHORT = Object.freeze({ driver: 'DRIVER', gunner: 'GUNNER', commander: 'CMDR', 'front-passenger': 'PASS',
  'rear-left': 'REAR L', 'rear-right': 'REAR R', 'door-left': 'DOOR L', 'door-right': 'DOOR R' });
const seatLabel = id => SEAT_SHORT[id] || String(id).toUpperCase();

export class DeployScreen {
  constructor(parent, { onDeploy = () => {}, onOpen = () => {}, career = () => null } = {}) {
    this.onDeploy = onDeploy;
    this.onOpen = onOpen;
    this.career = typeof career === 'function' ? career : () => null;
    this.unlocks = null;
    this.lockNote = null;
    this.lockNoteUntil = 0;
    /** Kits the latest own kit_unlocks named as new: a NEW tag until picked. */
    this.newKits = new Set();
    /**
     * New kits that arrived while this screen was open (the HUD banner stays hidden
     * under it): also named in the header status, which phones always keep in view.
     */
    this.announceKits = new Set();
    /** Card under the pointer or keyboard / gamepad focus: its hint fills the info line. */
    this.focusKit = null;
    this.root = el('section', 'cq-deploy', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Deploy');
    const panel = el('div', 'cq-deploy-panel', this.root);
    const head = el('header', 'cq-deploy-head', panel);
    const titles = el('div', 'cq-deploy-titles', head);
    el('h2', 'cq-deploy-title', titles).textContent = 'DEPLOY';
    this.teamLabel = el('span', 'cq-deploy-team', titles);
    // Status (refusals, revive wait, auto-deploy) sits in the header, always in view.
    this.status = el('div', 'cq-deploy-status', head);
    this.status.setAttribute('aria-live', 'polite');
    // Tapping the unlock note brings the UNLOCKS row (below the fold on phones) into view.
    this.status.addEventListener('click', () => {
      if (this.status.dataset.tone !== 'new') return;
      this.kits.querySelector('.cq-deploy-section-unlock')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    });
    this.killer = el('div', 'cq-deploy-killer', head);
    this.killerTitle = el('span', 'cq-deploy-killer-title', this.killer);
    this.killerName = el('strong', 'cq-deploy-killer-name', this.killer);
    this.killerDetail = el('span', 'cq-deploy-killer-detail', this.killer);
    this.killer.hidden = true;

    const body = el('div', 'cq-deploy-body', panel);
    const mapCol = el('div', 'cq-deploy-mapcol', body);
    this.map = new NorthUpMap(mapCol, 'cq-northmap cq-deploy-map', { onPick: spawn => this.select({ spawn }) });
    this.spawnList = el('div', 'cq-deploy-spawns', mapCol);
    this.spawnList.setAttribute('role', 'listbox');
    this.spawnList.setAttribute('aria-label', 'Spawn points');

    // Class strip: under the map and spawn list on desktop (DEPLOY beside the unlocks
    // row), a scrolling third column in phone landscape, stacked on phone portrait.
    const side = el('div', 'cq-deploy-side', body);
    this.kits = el('div', 'cq-deploy-kits', side);
    this.kits.setAttribute('role', 'radiogroup');
    this.kits.setAttribute('aria-label', 'Class');
    // Re-attached between the two rows on every class rebuild.
    this.kitInfo = el('div', 'cq-kit-info', side);
    this.kitInfo.setAttribute('aria-live', 'polite');

    const foot = el('footer', 'cq-deploy-foot', body);
    this.button = el('button', 'cq-deploy-button', foot);
    this.button.type = 'button';
    this.button.addEventListener('click', () => this.deploy());

    const kit = loadPref(KIT_PREF, 'assault');
    this.selection = { spawn: 'hq', kit, variant: Number(loadPref(`${KIT_PREF}-variant`, '0')) === 1 ? 1 : 0,
      gadget: Number(loadPref(`${KIT_PREF}-gadget`, '0')) === 1 ? 1 : 0 };
    this.readied = false;
    this._resend = false;
    this.refused = null;
    this.model = null;
    this.open = false;
    this._spawnSig = '';
    this._kitSig = '';
  }

  setOpen(open, killerInfo = null) {
    const next = !!open;
    if (next && !this.open) { this.readied = false; this.refused = null; this._resend = false; this.lockNote = null; this.focusKit = null; this.announceKits.clear(); }
    const opening = next && !this.open;
    this.open = next;
    this.root.hidden = !next;
    if (next) this.setKiller(killerInfo);
    // The screen is driven by the mouse: free a pointer lock left over from play.
    if (opening) this.onOpen();
  }

  setKiller(info) {
    const has = info && (info.name || info.killerName);
    this.killer.hidden = !has;
    if (!has) return;
    this.killerTitle.textContent = info.self ? 'YOU DIED' : 'KILLED BY';
    this.killerName.textContent = String(info.name || info.killerName).toUpperCase();
    const bits = [info.weaponName || info.weapon, Number.isFinite(info.distance) ? `${Math.round(info.distance)} M` : null,
      info.headshot ? 'HEADSHOT' : null, Number.isFinite(info.hp) ? `${Math.ceil(info.hp)} HP LEFT` : null].filter(Boolean);
    this.killerDetail.textContent = bits.join(' · ');
  }

  /** deploy_refused for us: back to choosing with the reason shown ({reason:'locked', level} for a class gate). */
  refuse(reason) { this.refused = reason || 'invalid'; this.readied = false; this._resend = false; }

  /** Authoritative kit unlocks (kitUnlockState of the latest own kit_unlocks event). */
  setUnlocks(unlocks) {
    this.unlocks = unlocks ?? null;
    this._kitSig = '';
    if (this.open && this._modelArgs) {
      this.model = deployModel({ ...this._modelArgs, selection: this.selection, refused: this.refused, unlocks: this.unlocks, career: this._careerView() }) || this.model;
      if (this.model) this._render(this.model);
    }
  }

  _careerView() {
    try { return this.career() ?? null; } catch { return null; }
  }

  /** Kits a level-up just opened: tagged NEW on the picker until picked. */
  markNew(kits = []) {
    for (const kit of kits || []) {
      this.newKits.add(kit);
      if (this.open) this.announceKits.add(kit);
    }
    this._kitSig = '';
    if (this.open && this.model) this._render(this.model);
  }

  /** A click on a locked class card: say when it opens (next to the cards), never select it. */
  lockedPick(card) {
    this.lockNote = `${card.label} UNLOCKS AT LV ${card.unlockLevel}`;
    this.lockNoteUntil = this._nowMs() + LOCK_NOTE_MS;
    if (this.model) this._render(this.model);
    return false;
  }

  _nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

  /** Hover / focus on a class card (null when it leaves): the info line explains that class. */
  hoverKit(id) {
    this.focusKit = id || null;
    if (this.model) this._renderInfo(this.model);
  }

  select(patch) {
    this.lockNote = null;
    if (patch.kit) { this.newKits.delete(patch.kit); this.announceKits.delete(patch.kit); }
    this.selection = { ...this.selection, ...patch };
    if (patch.kit) savePref(KIT_PREF, patch.kit);
    if (patch.variant !== undefined) savePref(`${KIT_PREF}-variant`, String(patch.variant));
    if (patch.gadget !== undefined) savePref(`${KIT_PREF}-gadget`, String(patch.gadget));
    this.refused = null;
    // Already readied: the next update re-sends the new choice from a fresh model.
    if (this.readied) this._resend = true;
  }

  /** Gamepad: step the spawn (deployable options only) or the kit by `delta`, wrapping. */
  step(field, delta) {
    const model = this.model;
    if (!this.open || !model) return false;
    // Locked classes are skipped: LB / RB only step through classes the server accepts.
    const list = field === 'spawn' ? model.options.filter(option => option.ok) : field === 'kit' ? (model.kits || []).filter(card => card.unlocked !== false) : [];
    if (list.length < 2) return false;
    const current = field === 'spawn' ? list.findIndex(option => option.spawn === model.selectedKey) : list.findIndex(card => card.selected);
    const next = list[((current < 0 ? (delta > 0 ? -1 : 0) : current) + delta + list.length) % list.length];
    this.select(field === 'spawn' ? { spawn: next.spawn } : { kit: next.id });
    // Show the pick now; the next snapshot update rebuilds the model.
    this.model = deployModel({ ...this._modelArgs, selection: this.selection, refused: this.refused, unlocks: this.unlocks, career: this._careerView() }) || model;
    this._render(this.model);
    return true;
  }

  deploy() {
    const model = this.model;
    if (!model?.valid) return false;
    this.readied = true;
    this._resend = !this._send(model.choice);
    this._render(model);
    return true;
  }

  /**
   * Hand the choice to onDeploy. An explicit `false` (sendConquest's rate limit
   * or a closed socket) keeps it pending, so the next update re-sends it and
   * the server never deploys a stale kit or spawn the screen no longer shows.
   */
  _send(choice) {
    const gadget = choice.gadget === undefined ? {} : { gadget: choice.gadget };
    return this.onDeploy({ spawn: choice.spawn, kit: choice.kit, variant: choice.variant, ...gadget }) !== false;
  }

  update({ cq, self, players, vehicles, nowMs, mapItems = [], meta = null }) {
    if (!this.open || !cq || !self) return null;
    this._modelArgs = { cq, self, players, vehicles, nowMs };
    const model = deployModel({ ...this._modelArgs, selection: this.selection, refused: this.refused, unlocks: this.unlocks, career: this._careerView() });
    if (!model) return null;
    if (model.spawn !== this.selection.spawn) {
      // The held spawn left the option list (flag lost, squadmate down, hull gone): the server
      // will refuse it, so the screen asks again instead of showing a stale "deploying".
      this.selection.spawn = model.spawn;
      if (this.readied) { this.readied = false; this._resend = false; }
    }
    this.model = model;
    if (this._resend) {
      if (model.valid) this._resend = !this._send(model.choice);
      else { this._resend = false; this.readied = false; }
    }
    this._render(model);
    this.map.draw({ items: mapItems, size: cq.size, meta, spawns: model.options, selected: model.selectedKey, nowMs, labels: true });
    return model;
  }

  _render(model) {
    this.teamLabel.textContent = `${model.teamName}${model.down ? ' · AWAITING REVIVE' : ''}`;
    this.root.dataset.team = model.team;
    const spawnSig = JSON.stringify([model.selectedKey, this.selection.spawn, model.options.map(o => [o.spawn, o.ok, o.reason, o.label, o.detail, o.seats, o.takeoverNames])]);
    if (spawnSig !== this._spawnSig) {
      this._spawnSig = spawnSig;
      this.spawnList.textContent = '';
      for (const option of model.options) {
        const row = el('div', 'cq-spawn-row', this.spawnList);
        const b = el('button', 'cq-spawn', row);
        b.type = 'button';
        b.dataset.kind = option.kind;
        b.dataset.ok = String(option.ok);
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(option.spawn === model.selectedKey));
        b.classList.toggle('is-selected', option.spawn === model.selectedKey);
        const icon = svgIcon(globalThis.document, option.kind === 'hq' ? 'hq' : option.kind === 'squad' ? 'squad' : option.kind === 'vehicle' ? option.type || 'tank' : 'hq', 'cq-spawn-icon');
        if (option.kind === 'flag') el('span', 'cq-spawn-letter', b).textContent = option.id;
        else if (icon) b.appendChild(icon);
        const text = el('span', 'cq-spawn-text', b);
        el('b', '', text).textContent = option.label;
        el('small', '', text).textContent = option.ok ? option.detail : option.reasonText;
        b.disabled = !option.ok;
        b.addEventListener('click', () => this.select({ spawn: option.spawn }));
        // Free seats and seats a bot holds (TAKE: the bot is put out), in F-key order.
        const takeover = option.takeoverNames || {};
        const seatIds = option.kind === 'vehicle' && option.ok ? option.seatChoices || option.seats || [] : [];
        if (seatIds.length > 1) {
          const seats = el('div', 'cq-spawn-seats', row);
          for (const seatId of seatIds) {
            const chip = el('button', 'cq-spawn-seat', seats);
            chip.type = 'button';
            const bot = takeover[seatId];
            chip.textContent = bot ? `TAKE ${seatLabel(seatId)}` : seatLabel(seatId);
            chip.classList.toggle('is-takeover', !!bot);
            if (bot) chip.title = `Take the ${seatLabel(seatId)} seat from ${bot}`;
            const choice = `${option.spawn}:${seatId}`;
            chip.classList.toggle('is-selected', this.selection.spawn === choice);
            chip.setAttribute('aria-label', bot ? `${option.label} take ${seatLabel(seatId)} seat from ${bot}` : `${option.label} ${seatLabel(seatId)} seat`);
            chip.addEventListener('click', () => this.select({ spawn: choice }));
          }
        }
      }
    }
    const kitSig = JSON.stringify([model.kit, model.variant, model.gadget, model.kits.map(card => [card.unlocked, card.progress?.xp ?? null]), [...this.newKits]]);
    if (kitSig !== this._kitSig) {
      this._kitSig = kitSig;
      this.kits.textContent = '';
      const rows = {};
      let loadout = null;
      for (const [row, title] of [['base', 'CLASSES'], ['unlock', 'UNLOCKS']]) {
        // One loadout slot (the picked class's toggles) under the base row, then the
        // class info line, then the unlocks: picking a class never moves the rows.
        if (row === 'unlock') {
          loadout = el('div', 'cq-kit-loadout', this.kits);
          this.kits.appendChild(this.kitInfo);
        }
        const head = el('h3', `cq-deploy-section cq-deploy-section-${row}`, this.kits);
        head.textContent = title;
        // Fresh unlocks are announced here, in the screen's own flow: a HUD banner would cover the spawns and cards.
        const fresh = model.kits.filter(card => card.row === row && card.unlocked && this.newKits.has(card.id)).map(card => card.label);
        if (fresh.length) el('span', 'cq-deploy-section-new', head).textContent = `${fresh.length > 1 ? 'NEW CLASSES' : 'NEW CLASS'} · ${fresh.join(' · ')}`;
        rows[row] = el('div', `cq-kit-row cq-kit-row-${row}`, this.kits);
        rows[row].dataset.row = row;
      }
      for (const card of model.kits) {
        const node = el('div', 'cq-kit', rows[card.row] || rows.base);
        node.classList.toggle('is-selected', card.selected);
        node.classList.toggle('is-locked', !card.unlocked);
        node.dataset.kit = card.id;
        // Hover and keyboard / gamepad focus explain the class in the info line (touch: the tap does).
        node.addEventListener('pointerenter', () => this.hoverKit(card.id));
        node.addEventListener('pointerleave', () => this.hoverKit(null));
        node.addEventListener('focusin', () => this.hoverKit(card.id));
        node.addEventListener('focusout', () => this.hoverKit(null));
        const pick = el('button', 'cq-kit-pick', node);
        pick.type = 'button';
        pick.setAttribute('role', 'radio');
        pick.setAttribute('aria-checked', String(card.selected));
        pick.setAttribute('aria-disabled', String(!card.unlocked));
        pick.title = card.unlocked ? card.hint : `${card.label} UNLOCKS AT LV ${card.unlockLevel} · ${card.hint}`;
        const icon = svgIcon(globalThis.document, card.id, 'cq-kit-icon');
        if (icon) pick.appendChild(icon);
        const name = el('span', 'cq-kit-name', pick);
        el('b', '', name).textContent = card.label;
        el('small', '', name).textContent = card.unlocked ? card.ability : card.lockText;
        if (card.unlocked && this.newKits.has(card.id)) el('span', 'cq-kit-new', pick).textContent = 'NEW';
        if (!card.unlocked) {
          const lock = svgIcon(globalThis.document, 'padlock', 'cq-kit-lock');
          if (lock) pick.appendChild(lock);
          if (card.progress) {
            const bar = el('span', 'cq-kit-xp', node);
            el('i', 'cq-kit-xp-fill', bar).style.width = `${(card.progress.fraction * 100).toFixed(1)}%`;
            el('small', 'cq-kit-xp-text', node).textContent = `${fmt(card.progress.xp)} / ${fmt(card.progress.need)} XP`;
          }
          pick.addEventListener('click', () => this.lockedPick(card));
          continue;
        }
        pick.addEventListener('click', () => this.select({ kit: card.id }));
      }
      this._renderLoadout(loadout, model);
    }
    const selected = model.options.find(o => o.spawn === model.selectedKey);
    const where = selected ? selected.label : 'HQ';
    let label, disabled = !model.valid;
    if (!model.valid) label = 'SPAWN UNAVAILABLE';
    else if (this.readied) label = model.waitMs > 0 ? `DEPLOYING IN ${model.countdown}` : 'DEPLOYING…';
    else label = model.waitMs > 0 ? `DEPLOY · ${where} · ${model.countdown}` : `DEPLOY · ${where}`;
    if (this.button.textContent !== label) this.button.textContent = label;
    this.button.disabled = disabled;
    this.button.classList.toggle('is-ready', this.readied);
    const medic = model.medic ? `NEAREST MEDIC ${model.medic.name} · ${model.medic.distance} M` : 'NO MEDIC NEARBY';
    const status = model.refused ? `REFUSED · ${model.refused.text}` : !model.valid ? model.reasonText
      : model.down ? `AWAITING REVIVE · ${medic} · DEPLOYING FORFEITS IT`
      : model.timeoutMs !== null && !this.readied && model.waitMs === 0 ? `AUTO-DEPLOY IN ${Math.ceil(model.timeoutMs / 1000)} S` : '';
    // A class unlocked while this screen is open leads the status (warnings keep the line to themselves).
    const fresh = model.refused || !model.valid ? []
      : model.kits.filter(card => card.unlocked && this.announceKits.has(card.id)).map(card => card.label);
    const news = fresh.length ? `${fresh.length > 1 ? 'NEW CLASSES' : 'NEW CLASS'} · ${fresh.join(' · ')}` : '';
    const line = [news, status].filter(Boolean).join(' · ');
    if (this.status.textContent !== line) this.status.textContent = line;
    this.status.dataset.tone = model.refused || !model.valid ? 'warn' : news ? 'new' : 'info';
    this._renderInfo(model);
  }

  /**
   * Toggles of the picked class (primary variants, Engineer gadget, gear line)
   * in the one loadout slot. A gadget row is reserved whenever any open class
   * has one, so the slot keeps its height from class to class.
   */
  _renderLoadout(loadout, model) {
    if (!loadout) return;
    const card = model.kits.find(c => c.selected && c.unlocked);
    loadout.dataset.kit = card?.id ?? '';
    if (!card) return;
    el('span', 'cq-kit-loadout-name', loadout).textContent = card.label;
    const variants = el('div', 'cq-kit-variants', loadout);
    for (const primary of card.primaries) {
      const v = el('button', 'cq-kit-variant', variants);
      v.type = 'button';
      v.textContent = primary.label;
      v.classList.toggle('is-selected', primary.selected);
      v.setAttribute('aria-pressed', String(primary.selected));
      v.addEventListener('click', () => this.select({ kit: card.id, variant: primary.index }));
    }
    if (card.gadgets.length) {
      // Gadget choice (Engineer): AT launcher or AA STINGER, same toggle as the primaries.
      const gadgets = el('div', 'cq-kit-gadgets', loadout);
      gadgets.setAttribute('role', 'radiogroup');
      gadgets.setAttribute('aria-label', `${card.label} gadget`);
      for (const gadget of card.gadgets) {
        const g = el('button', 'cq-kit-gadget', gadgets);
        g.type = 'button';
        g.dataset.gadget = gadget.weapon;
        g.classList.toggle('is-selected', gadget.selected);
        g.setAttribute('role', 'radio');
        g.setAttribute('aria-checked', String(gadget.selected));
        g.title = gadget.hint;
        el('span', 'cq-kit-gadget-role', g).textContent = gadget.role;
        el('span', 'cq-kit-gadget-name', g).textContent = gadget.label;
        g.addEventListener('click', () => this.select({ kit: card.id, gadget: gadget.index }));
      }
    } else if (model.kits.some(c => c.unlocked && c.gadgets.length)) {
      el('div', 'cq-kit-gadgets is-placeholder', loadout).setAttribute('aria-hidden', 'true');
    }
    el('div', 'cq-kit-gear', loadout).textContent = [card.gadgets.length ? null : card.gadget, ...card.grenades].filter(Boolean).join(' · ');
  }

  /**
   * Class info line: a fresh locked-class note, else the hovered / focused
   * class, else the selected one. Every number comes from the kit tables.
   */
  _renderInfo(model) {
    if (this.lockNote && this._nowMs() >= this.lockNoteUntil) this.lockNote = null;
    const card = model.kits.find(c => c.id === this.focusKit) ?? model.kits.find(c => c.selected) ?? null;
    let text = '', tone = 'info';
    if (this.lockNote) {
      const locked = model.kits.find(c => this.lockNote.startsWith(`${c.label} `));
      const progress = locked?.progress ? ` · ${fmt(locked.progress.xp)} / ${fmt(locked.progress.need)} XP` : '';
      text = `${this.lockNote}${progress}`;
      tone = 'warn';
    } else if (card) {
      text = card.unlocked ? `${card.label} · ${card.ability} — ${card.hint}` : `${card.label} · UNLOCKS AT LV ${card.unlockLevel} — ${card.hint}`;
    }
    if (this.kitInfo.textContent !== text) this.kitInfo.textContent = text;
    this.kitInfo.dataset.tone = tone;
  }
}
