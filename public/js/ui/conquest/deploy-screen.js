/**
 * Deploy screen while dead in Conquest: map with selectable spawns from the
 * shared deployOptions(), spawn list, kit picker with variant and gadget
 * (Engineer: AT launcher or STINGER), killer card,
 * countdown to respawnAt and the Deploy button. The server holds the chosen
 * spawn and spawns the player once respawnAt passes, so a choice may be sent
 * during the countdown; any later change is re-sent.
 */
import { el, loadPref, savePref } from '../hud-support.js';
import { deployModel } from '../conquest-hud-state.js';
import { NorthUpMap } from './big-map.js';
import { svgIcon } from './icons.js';

const KIT_PREF = 'vb-conquest-kit';
const SEAT_SHORT = Object.freeze({ driver: 'DRIVER', gunner: 'GUNNER', commander: 'CMDR', 'front-passenger': 'PASS',
  'rear-left': 'REAR L', 'rear-right': 'REAR R', 'door-left': 'DOOR L', 'door-right': 'DOOR R' });
const seatLabel = id => SEAT_SHORT[id] || String(id).toUpperCase();

export class DeployScreen {
  constructor(parent, { onDeploy = () => {}, onOpen = () => {} } = {}) {
    this.onDeploy = onDeploy;
    this.onOpen = onOpen;
    this.root = el('section', 'cq-deploy', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Deploy');
    const panel = el('div', 'cq-deploy-panel', this.root);
    const head = el('header', 'cq-deploy-head', panel);
    const titles = el('div', 'cq-deploy-titles', head);
    el('h2', 'cq-deploy-title', titles).textContent = 'DEPLOY';
    this.teamLabel = el('span', 'cq-deploy-team', titles);
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

    const side = el('div', 'cq-deploy-side', body);
    el('h3', 'cq-deploy-section', side).textContent = 'KIT';
    this.kits = el('div', 'cq-deploy-kits', side);
    this.kits.setAttribute('role', 'radiogroup');
    this.kits.setAttribute('aria-label', 'Kit');

    const foot = el('footer', 'cq-deploy-foot', panel);
    this.status = el('div', 'cq-deploy-status', foot);
    this.status.setAttribute('aria-live', 'polite');
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
    if (next && !this.open) { this.readied = false; this.refused = null; this._resend = false; }
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

  /** deploy_refused for us: back to choosing with the reason shown. */
  refuse(reason) { this.refused = reason || 'invalid'; this.readied = false; this._resend = false; }

  select(patch) {
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
    const list = field === 'spawn' ? model.options.filter(option => option.ok) : field === 'kit' ? model.kits || [] : [];
    if (list.length < 2) return false;
    const current = field === 'spawn' ? list.findIndex(option => option.spawn === model.selectedKey) : list.findIndex(card => card.selected);
    const next = list[((current < 0 ? (delta > 0 ? -1 : 0) : current) + delta + list.length) % list.length];
    this.select(field === 'spawn' ? { spawn: next.spawn } : { kit: next.id });
    // Show the pick now; the next snapshot update rebuilds the model.
    this.model = deployModel({ ...this._modelArgs, selection: this.selection, refused: this.refused }) || model;
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
    const model = deployModel({ ...this._modelArgs, selection: this.selection, refused: this.refused });
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
    const kitSig = JSON.stringify([model.kit, model.variant, model.gadget]);
    if (kitSig !== this._kitSig) {
      this._kitSig = kitSig;
      this.kits.textContent = '';
      for (const card of model.kits) {
        const node = el('div', 'cq-kit', this.kits);
        node.classList.toggle('is-selected', card.selected);
        node.dataset.kit = card.id;
        const pick = el('button', 'cq-kit-pick', node);
        pick.type = 'button';
        pick.setAttribute('role', 'radio');
        pick.setAttribute('aria-checked', String(card.selected));
        const icon = svgIcon(globalThis.document, card.id, 'cq-kit-icon');
        if (icon) pick.appendChild(icon);
        const name = el('span', 'cq-kit-name', pick);
        el('b', '', name).textContent = card.label;
        el('small', '', name).textContent = card.ability;
        pick.addEventListener('click', () => this.select({ kit: card.id }));
        const variants = el('div', 'cq-kit-variants', node);
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
          const gadgets = el('div', 'cq-kit-gadgets', node);
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
        }
        el('div', 'cq-kit-gear', node).textContent = [card.gadgets.length ? null : card.gadget, ...card.grenades].filter(Boolean).join(' · ');
      }
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
    const status = model.refused ? `REFUSED · ${model.refused.text}` : !model.valid ? model.reasonText
      : model.down ? 'A TEAMMATE CAN STILL REVIVE YOU · DEPLOYING FORFEITS IT'
      : model.timeoutMs !== null && !this.readied && model.waitMs === 0 ? `AUTO-DEPLOY IN ${Math.ceil(model.timeoutMs / 1000)} S` : '';
    if (this.status.textContent !== status) this.status.textContent = status;
    this.status.dataset.tone = model.refused || !model.valid ? 'warn' : 'info';
  }
}
