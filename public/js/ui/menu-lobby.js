import {
  HudSupport,
  MAP_LABELS,
  MAP_PREVIEWS,
  MODE_LABELS,
  cleanCode,
  copyInviteLink as copyInviteText,
  el,
  loadName,
  loadPref,
  loadPrefNum,
  resolveInviteBase,
  saveName,
} from './hud-support.js';
import { LobbyInviteQr } from './lobby-invite-qr.js';
import { addMenuIcon } from './menu-icons.js';
import { LobbyBrowser } from './lobby-browser.js';
import { LobbySettings } from './lobby-settings.js';
import { normalizeModeId, mapForMode } from '../../../shared/modes.js';
import {
  clampMouseSensitivity,
  MOUSE_SENSITIVITY,
  SENSITIVITY_PREF_KEY,
} from '../input-settings.js';
import { buildMenuShell, setMenuBackdrop } from './menu-chrome.js';

const NOOP = () => {};
const QUICK_PLAY_BOTS = 5;

export class MenuLobbyController {
  constructor(host, navigation = null) {
    this.host = host;
    this.navigation = navigation;
    this.support = new HudSupport();

    this.onMenuAction = null;
    this._lobbyCallbacks = null;
    this.lobbyDom = {};
    this.joinStatus = null;
    this._onLobbyKeyDown = null;
  }

  _sensitivity() {
    const configured = this.host.getSensitivity();
    if (Number.isFinite(+configured)) {
      return clampMouseSensitivity(configured);
    }
    return loadPrefNum(
      SENSITIVITY_PREF_KEY,
      MOUSE_SENSITIVITY.default,
      MOUSE_SENSITIVITY.min,
      MOUSE_SENSITIVITY.max,
    );
  }

  buildMenu(onAction, { musicEnabled = true, onMusicToggle = NOOP } = {}) {
    const previousMenu = document.getElementById('menu');
    const isInitialMenu = !this.browser;
    const retry = previousMenu?.getAttribute('aria-hidden') === 'false' ? this.browser?.retry : null;
    this.browser?.dispose();
    this.onMenuAction = typeof onAction === 'function' ? onAction : NOOP;
    this.hideLobby();
    this.host.closeSettings();
    this.host.closeBuyMenuDirect();

    const root = this.support.root('menu');
    root.innerHTML = '';
    root.classList.remove('hidden');
    root.style.display = 'flex';
    root.setAttribute('aria-hidden', 'false');
    setMenuBackdrop(root, 'foundry');

    const { stage, rail } = buildMenuShell(root, { context: 'MAIN MENU' });
    const musicButton = el('button', 'vb-btn vb-music-toggle', rail, 'menu-music-toggle');
    musicButton.type = 'button';
    musicButton.setAttribute('aria-label', 'Menu music');
    const syncMusic = () => {
      musicButton.textContent = `MUSIC: ${musicEnabled ? 'ON' : 'OFF'}`;
      musicButton.setAttribute('aria-pressed', String(musicEnabled));
    };
    syncMusic();
    musicButton.addEventListener('click', () => {
      musicEnabled = !musicEnabled;
      syncMusic();
      onMusicToggle(musicEnabled);
    });
    const panel = el('div', 'vb-panel vb-main-menu-panel', stage);

    const primary = el('section', 'vb-menu-primary', panel, 'menu-primary-step');
    primary.setAttribute('aria-labelledby', 'menu-title');
    const primaryBody = el('div', 'vb-menu-primary-body', primary);
    el('div', 'vb-menu-eyebrow', primaryBody).textContent = 'DESTRUCTIBLE MULTIPLAYER ARENA';
    const title = el('h1', 'vb-title vb-deployment-title', primaryBody, 'menu-title');
    el('span', '', title).textContent = 'VOXEL';
    el('span', '', title).textContent = ' BLITZ';
    const sub = el('div', 'vb-sub', primaryBody);
    sub.textContent = 'Fast rounds. Destructible arenas.';

    const playerIdentity = el('div', 'vb-player-identity', primaryBody);
    const callsignLabel = el('label', 'vb-label', playerIdentity);
    callsignLabel.textContent = 'PLAYER NAME';
    callsignLabel.htmlFor = 'name-input';
    const nameInput = el('input', '', playerIdentity, 'name-input');
    nameInput.maxLength = 16;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.placeholder = 'PLAYER';
    nameInput.value = loadName();

    const actionsBox = el('div', 'vb-menu-actions', primaryBody);

    const quickBox = el('div', 'vb-quick-box', actionsBox);
    const quickPlayButton = el('button', 'vb-btn vb-quick-play-btn', quickBox, 'play-btn');
    quickPlayButton.type = 'button';
    quickPlayButton.textContent = 'QUICK PLAY';
    const quickHint = el('div', 'vb-action-hint', quickBox);
    quickHint.textContent = '5+ BOTS · AUTO ARENA · INSTANT ACTION';

    const createBox = el('div', 'vb-create-box', actionsBox);
    const createLobbyButton = el(
      'button',
      'vb-btn vb-create-lobby-btn',
      createBox,
      'create-lobby-btn',
    );
    createLobbyButton.type = 'button';
    createLobbyButton.textContent = 'CREATE LOBBY';
    const duelBox = el('div', 'vb-duel-box', actionsBox);
    const duelButton = el('button', 'vb-btn', duelBox, 'create-duel-btn');
    duelButton.type = 'button';
    duelButton.textContent = 'INVITE TO 1V1';
    el('div', 'vb-action-hint', duelBox).textContent = 'A PRIVATE DUEL WITH A FRIEND';
    duelButton.addEventListener('click', () => {
      if (duelButton.disabled) return;
      this.onMenuAction({ mode: 'create', gameMode: 'duel', map: 'depot', bots: 0,
        code: '', password: createPassword.value, ...getIdentity() });
    });
    const createHint = el('div', 'vb-action-hint', createBox);
    createHint.textContent = 'YOUR RULES. YOUR ARENA.';

    const passwordOption = (parent, id, title) => {
      const details = el('details', 'vb-password-option', parent);
      el('summary', '', details).textContent = title;
      const label = el('label', '', details);
      el('span', '', label).textContent = 'PASSWORD (OPTIONAL)';
      const input = el('input', '', label, id);
      input.type = 'password';
      input.maxLength = 64;
      input.autocomplete = 'off';
      input.placeholder = 'Leave empty for an open lobby';
      return input;
    };
    const browseBox = el('div', 'vb-browse-box', actionsBox);
    const browseButton = el('button', 'vb-btn vb-browse-btn', browseBox, 'browse-lobbies-btn');
    browseButton.type = 'button';
    browseButton.textContent = 'FIND A LOBBY';
    browseButton.setAttribute('aria-haspopup', 'dialog');
    el('div', 'vb-action-hint', browseBox).textContent = 'BROWSE ROOMS OR ENTER A CODE';
    actionsBox.insertBefore(browseBox, createBox);
    for (const button of [quickPlayButton, browseButton, createLobbyButton, duelButton]) {
      const text = button.textContent;
      button.textContent = '';
      el('span', 'vb-action-title', button).textContent = text;
    }
    for (const [box, icon] of [[quickBox, 'arrows'], [browseBox, 'globe'], [createBox, 'squad'], [duelBox, 'duel']]) addMenuIcon(box, icon);
    const createPassword = passwordOption(actionsBox, 'create-password-input', 'Set a lobby password');

    this.joinStatus = el('div', 'vb-status', primaryBody, 'join-status');
    this.joinStatus.setAttribute('role', 'status');
    this.joinStatus.setAttribute('aria-live', 'polite');

    const training = el('section', 'vb-training-card', primary);
    const trainingImage = el('img', 'vb-training-image', training);
    trainingImage.src = '/assets/maps/killhouse-range.webp';
    trainingImage.alt = 'Covered firing bays in the Killhouse training facility';
    trainingImage.width = 1280;
    trainingImage.height = 720;
    const trainingInfo = el('div', 'vb-training-info', training);
    el('span', 'vb-step-kicker', trainingInfo).textContent = 'WARM UP';
    el('h2', '', trainingInfo).textContent = 'KILLHOUSE';
    el('p', '', trainingInfo).textContent = 'Find your aim. Beat your time.';
    const trainingButton = el('button', 'vb-btn vb-training-btn', trainingInfo, 'training-btn');
    trainingButton.type = 'button';
    trainingButton.textContent = 'ENTER KILLHOUSE';

    const menuFooter = el('div', 'vb-menu-footer', panel);
    el('span', '', menuFooter).textContent = 'MOVE FAST. BREAK EVERYTHING.';
    el('span', '', menuFooter).textContent = 'MULTIPLAYER · DESTRUCTIBLE ARENAS';

    const getIdentity = () => {
      const name = nameInput.value.trim().slice(0, 16) || 'PLAYER';
      saveName(name);
      return { name, sensitivity: this._sensitivity() };
    };

    const triggerQuick = () => {
      if (quickPlayButton.disabled) return;
      this.onMenuAction({
        mode: 'quick',
        bots: QUICK_PLAY_BOTS,
        code: '',
        ...getIdentity(),
      });
    };

    const triggerCreate = () => {
      if (createLobbyButton.disabled) return;
      const gameMode = normalizeModeId(loadPref('vb-mode', 'fun'), 'fun');
      this.onMenuAction({ mode: 'create', gameMode,
        map: mapForMode(gameMode, loadPref('vb-map', 'foundry')),
        bots: ['training', 'duel'].includes(gameMode) ? 0 : Math.round(loadPrefNum('vb-bots', 3, 0, 7)),
        code: '', password: createPassword.value, ...getIdentity() });
    };

    this.browser = new LobbyBrowser(root, (code, password) => {
      this.onMenuAction({ mode: 'join', code, password, ...getIdentity() });
    }, triggerCreate, this.navigation);
    browseButton.addEventListener('click', () => this.browser.show({}, browseButton));
    createPassword.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); triggerCreate(); }
    });

    trainingButton.addEventListener('click', () => {
      if (trainingButton.disabled) return;
      this.onMenuAction({ mode: 'create', gameMode: 'training', map: 'killhouse', bots: 0,
        code: '', ...getIdentity() });
    });
    quickPlayButton.addEventListener('click', triggerQuick);
    createLobbyButton.addEventListener('click', triggerCreate);

    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        triggerQuick();
      }
    });

    let prefillCode = '';
    try {
      const params = new URLSearchParams(window.location.search);
      const paramCode = params.get('lobby');
      if (paramCode) prefillCode = cleanCode(paramCode);
    } catch (_) {}

    if (prefillCode) this.browser.codeInput.value = prefillCode;
    if (retry || (isInitialMenu && prefillCode)) {
      this.browser.show(retry || { code: prefillCode }, browseButton);
      if (!retry) this.showJoinState(`INVITE CODE DETECTED: ${prefillCode}`, 'ok');
    } else {
      this.support.defer(() => {
        try {
          if (document.getElementById('name-input') === nameInput) {
            nameInput.focus();
            if (nameInput.value) nameInput.select();
          }
        } catch (_) {}
      });
    }
  }

  showJoinState(message, tone = '') {
    if (this.browser?.dialog.open) {
      this.browser.showJoinState(message, tone);
      return;
    }
    const status = document.getElementById('join-status') || this.joinStatus;
    if (status) {
      status.textContent = message || '';
      status.classList.toggle('ok', tone === 'ok');
      status.classList.toggle('err', tone === 'err');
    }
  }

  ensureLobbyDom() {
    if (this.lobbyDom.root) return this.lobbyDom.root;

    const root = this.support.root('lobby', {
      className: 'hidden',
      attributes: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'lobby-title',
        'aria-hidden': 'true',
      },
    });

    root.innerHTML = '';
    setMenuBackdrop(root, 'foundry');
    const { stage } = buildMenuShell(root, { context: 'LOBBY' });
    const panel = el('div', 'vb-lobby-panel', stage);

    const title = el('h2', 'vb-title', panel, 'lobby-title');
    title.textContent = 'SQUAD BRIEFING';
    const sub = el('div', 'vb-sub', panel);
    sub.textContent = 'Choose your arena. Get your squad ready.';

    const metaCard = el('div', 'vb-lobby-card vb-lobby-meta-card', panel);
    const metaHeader = el('div', 'vb-lobby-meta-header', metaCard);
    el('span', 'vb-label', metaHeader).textContent = 'MISSION SETUP';

    const missionPreview = el('img', 'vb-lobby-mission-image', metaCard, 'lobby-map-preview');
    missionPreview.width = 720;
    missionPreview.height = 360;

    const settings = new LobbySettings(metaCard, (value) => this._lobbyCallbacks?.onConfigure?.(value));

    const chipsRow = el('div', 'vb-lobby-chips-row', metaCard);

    const modeChip = el('div', 'vb-lobby-chip vb-lobby-mode-chip', chipsRow);
    el('span', 'vb-chip-label', modeChip).textContent = 'MODE';
    const modeValue = el('span', 'vb-chip-val', modeChip, 'lobby-mode-val');
    modeValue.textContent = 'SEARCH & DESTROY';

    const mapChip = el('div', 'vb-lobby-chip vb-lobby-map-chip', chipsRow);
    el('span', 'vb-chip-label', mapChip).textContent = 'MAP';
    const mapValue = el('span', 'vb-chip-val', mapChip, 'lobby-map-val');
    mapValue.textContent = 'CITADEL';

    const missionStatus = el('div', 'vb-lobby-mission-status', metaCard);
    el('span', 'vb-online-dot', missionStatus).setAttribute('aria-hidden', 'true');
    el('span', '', missionStatus).textContent = 'WAITING FOR OPERATORS';

    const inviteCard = el('div', 'vb-lobby-card vb-lobby-invite-card', panel);
    el('h3', 'vb-lobby-section-title', inviteCard).textContent = 'INVITE YOUR SQUAD';
    const codeHeader = el('div', 'vb-lobby-code-row', inviteCard);
    el('span', 'vb-label', codeHeader).textContent = 'ROOM CODE';
    const codeValue = el('span', 'vb-lobby-code-val', codeHeader, 'lobby-code-val');
    codeValue.textContent = '-----';

    const inviteRow = el('div', 'vb-invite-row', inviteCard);
    const inviteInput = el('input', 'vb-invite-input', inviteRow, 'lobby-invite-input');
    inviteInput.type = 'text';
    inviteInput.readOnly = true;
    inviteInput.setAttribute('aria-label', 'Lobby Invite Link');
    inviteInput.spellcheck = false;
    inviteInput.autocomplete = 'off';
    inviteInput.addEventListener('click', () => {
      try { inviteInput.select(); } catch (_) {}
    });

    const copyButton = el('button', 'vb-btn-copy', inviteRow, 'lobby-copy-btn');
    copyButton.type = 'button';
    copyButton.textContent = 'COPY LINK';
    copyButton.setAttribute('aria-label', 'Copy Invite Link');
    copyButton.addEventListener('click', () => {
      void this.copyInviteLink(inviteInput.value);
    });

    const qr = new LobbyInviteQr(root, this.navigation);
    const qrButton = el('button', 'vb-btn-copy', inviteRow, 'lobby-qr-btn');
    qrButton.type = 'button';
    qrButton.textContent = 'QR CODE';
    qrButton.setAttribute('aria-haspopup', 'dialog');
    qrButton.setAttribute('aria-label', 'Show lobby invitation QR code');
    qrButton.addEventListener('click', () => {
      void qr.show(inviteInput.value, codeValue.textContent, qrButton).catch(() => {
        this.showLobbyStatus('Could not display the QR code. Please use the invite link.', 'err');
      });
    });

    const rosterCard = el('div', 'vb-lobby-card vb-roster-card', panel);
    const rosterHeader = el('div', 'vb-roster-header', rosterCard);
    el('span', 'vb-label', rosterHeader).textContent = 'OPERATORS';
    const readyCount = el('span', 'vb-ready-count', rosterHeader, 'lobby-ready-count');
    readyCount.textContent = '0 / 0 READY';

    const rosterList = el('div', 'vb-roster-list', rosterCard, 'lobby-roster');
    rosterList.setAttribute('role', 'list');

    const actionsRow = el('div', 'vb-lobby-actions', panel);

    const leaveButton = el('button', 'vb-btn vb-btn-leave', actionsRow, 'lobby-leave-btn');
    leaveButton.type = 'button';
    leaveButton.textContent = 'LEAVE';
    leaveButton.addEventListener('click', () => {
      if (this._lobbyCallbacks && typeof this._lobbyCallbacks.onLeave === 'function') {
        this._lobbyCallbacks.onLeave();
      }
    });

    const readyButton = el('button', 'vb-btn vb-btn-ready', actionsRow, 'lobby-ready-btn');
    readyButton.type = 'button';
    readyButton.textContent = 'MARK READY';
    readyButton.setAttribute('aria-pressed', 'false');
    readyButton.addEventListener('click', () => {
      if (this._lobbyCallbacks && typeof this._lobbyCallbacks.onReady === 'function') {
        const currentReady = readyButton.getAttribute('aria-pressed') === 'true';
        this._lobbyCallbacks.onReady(!currentReady);
      }
    });

    const startButton = el('button', 'vb-btn vb-btn-start', actionsRow, 'lobby-start-btn');
    startButton.type = 'button';
    startButton.textContent = 'START MATCH';
    startButton.disabled = true;
    startButton.setAttribute('aria-disabled', 'true');
    startButton.addEventListener('click', () => {
      if (startButton.disabled) return;
      if (this._lobbyCallbacks && typeof this._lobbyCallbacks.onStart === 'function') {
        this._lobbyCallbacks.onStart();
      }
    });

    const waitingHint = el(
      'div',
      'vb-lobby-waiting-hint',
      actionsRow,
      'lobby-waiting-hint',
    );
    waitingHint.textContent = 'WAITING FOR HOST TO LAUNCH MATCH';
    waitingHint.style.display = 'none';

    const status = el('div', 'vb-status', panel, 'lobby-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    this.lobbyDom = {
      root,
      panel,
      modeVal: modeValue,
      mapVal: mapValue,
      missionPreview,
      settings,
      codeVal: codeValue,
      inviteInput,
      copyBtn: copyButton,
      qr,
      readyCount,
      rosterList,
      leaveBtn: leaveButton,
      readyBtn: readyButton,
      startBtn: startButton,
      waitingHint,
      status,
    };

    if (!this._onLobbyKeyDown) {
      this._onLobbyKeyDown = (event) => {
        if (root.classList.contains('hidden') || root.style.display === 'none') return;
        if (this.lobbyDom.qr?.isOpen) return;
        if (this.host.isSettingsOpen()) return;
        if (this.host.isBuyMenuOpen()) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          if (this._lobbyCallbacks && typeof this._lobbyCallbacks.onLeave === 'function') {
            this._lobbyCallbacks.onLeave();
          }
        }
      };
      document.addEventListener('keydown', this._onLobbyKeyDown);
    }

    return root;
  }

  showLobby(state, { onReady, onStart, onLeave, onConfigure } = {}) {
    this.host.closeSettings();
    if (this.host.isBuyMenuOpen()) this.host.toggleBuyMenu(false);
    else this.host.closeBuyMenuDirect();

    this._lobbyCallbacks = { onReady, onStart, onLeave, onConfigure };
    this.navigation?.open(this, () => this._lobbyCallbacks?.onLeave?.());
    const menu = document.getElementById('menu');
    if (menu) {
      menu.classList.add('hidden');
      menu.style.display = 'none';
      menu.setAttribute('aria-hidden', 'true');
    }

    const root = this.ensureLobbyDom();
    root.classList.remove('hidden');
    root.style.display = 'flex';
    root.setAttribute('aria-hidden', 'false');

    this.updateLobby(state);

    this.support.defer(() => {
      try {
        if (
          this.lobbyDom.root?.getAttribute('aria-hidden') === 'false'
          && this.lobbyDom.readyBtn
        ) {
          this.lobbyDom.readyBtn.focus();
        }
      } catch (_) {}
    });
  }

  updateLobby(state) {
    if (!state) return;
    this.ensureLobbyDom();
    const dom = this.lobbyDom;
    if (!dom || !dom.root) return;

    const gameMode = state.gameMode || 'fun';
    const map = state.map || 'foundry';
    setMenuBackdrop(dom.root, map);
    if (dom.modeVal) dom.modeVal.textContent = MODE_LABELS[gameMode] || gameMode.toUpperCase();
    if (dom.mapVal) dom.mapVal.textContent = MAP_LABELS[map] || map.toUpperCase();
    if (dom.missionPreview) {
      dom.missionPreview.src = MAP_PREVIEWS[map] || MAP_PREVIEWS.foundry;
      dom.missionPreview.alt = `${MAP_LABELS[map] || map} arena preview`;
    }

    const code = cleanCode(state.code) || state.code || '-----';
    if (dom.codeVal) dom.codeVal.textContent = code;

    const inviteUrl = `${resolveInviteBase()}?lobby=${code}`;
    if (dom.inviteInput && dom.inviteInput.value !== inviteUrl) {
      dom.inviteInput.value = inviteUrl;
    }

    const members = Array.isArray(state.members) ? [...state.members] : [];
    if (state.phase === 'waiting' && gameMode !== 'training') {
      const count = Math.min(state.bots || 0, 8 - members.length);
      for (let i = 0; i < count; i++) members.push({ id: `planned-bot-${i}`, name: `TACTICAL BOT ${i + 1}`, bot: true });
    }
    const humans = members.filter((member) => !member.bot);
    const readyHumans = humans.filter((member) => !!member.ready).length;
    const totalHumans = humans.length;
    const allHumansReady = totalHumans > 0 && readyHumans === totalHumans
      && (gameMode !== 'duel' || totalHumans === 2);

    if (dom.readyCount) {
      dom.readyCount.textContent = `${members.length}/${gameMode === 'duel' ? 2 : 8} OPERATORS · ${readyHumans}/${totalHumans} READY`;
    }

    if (dom.readyBtn) {
      dom.readyBtn.classList.remove('is-ready');
      dom.readyBtn.setAttribute('aria-pressed', 'false');
      dom.readyBtn.textContent = 'MARK READY';
    }

    if (dom.rosterList) {
      dom.rosterList.innerHTML = '';
      for (const member of members) {
        const isSelf = state.selfId != null && String(member.id) === String(state.selfId);
        const isHost = state.host != null && String(member.id) === String(state.host);
        const isBot = !!member.bot;

        const item = el('div', `vb-roster-item${isSelf ? ' is-self' : ''}`, dom.rosterList);
        item.setAttribute('role', 'listitem');

        const portrait = el('span', `vb-operator-icon${isBot ? ' is-bot' : ''}`, item);
        portrait.setAttribute('aria-hidden', 'true');
        const leftColumn = el('div', 'vb-roster-left', item);
        const name = el('span', 'vb-roster-name', leftColumn);
        name.textContent = member.name || (isBot ? 'TACTICAL BOT' : 'OPERATOR');

        if (isSelf) {
          const badge = el('span', 'vb-badge vb-badge-you', leftColumn);
          badge.textContent = 'YOU';
        }
        if (isHost) {
          const badge = el('span', 'vb-badge vb-badge-host', leftColumn);
          badge.textContent = 'HOST';
        }
        if (isBot) {
          const badge = el('span', 'vb-badge vb-badge-bot', leftColumn);
          badge.textContent = 'BOT';
        }

        const rightColumn = el('div', 'vb-roster-right', item);
        if (!isBot) {
          const ping = el('span', 'vb-roster-ping', rightColumn);
          ping.textContent = Number.isFinite(member.ping) ? `${member.ping} ms` : 'Measuring…';
          ping.setAttribute('aria-label', Number.isFinite(member.ping) ? `Ping: ${member.ping} milliseconds` : 'Measuring ping');
        }
        const readyPill = el('span', 'vb-ready-pill', rightColumn);
        if (isBot) {
          readyPill.classList.add('bot');
          readyPill.textContent = 'AUTO-READY';
        } else if (member.ready) {
          readyPill.classList.add('ready');
          readyPill.textContent = 'READY';
        } else {
          readyPill.classList.add('not-ready');
          readyPill.textContent = 'WAITING';
        }

        if (isSelf && dom.readyBtn) {
          const isReady = !!member.ready;
          dom.readyBtn.classList.toggle('is-ready', isReady);
          dom.readyBtn.setAttribute('aria-pressed', isReady ? 'true' : 'false');
          dom.readyBtn.textContent = isReady ? 'CANCEL READY' : 'MARK READY';
        }
      }
    }

    const isHost =
      state.selfId != null
      && state.host != null
      && String(state.selfId) === String(state.host);
    dom.settings.update(state, isHost);
    if (isHost) {
      if (dom.startBtn) {
        dom.startBtn.style.display = 'block';
        dom.startBtn.disabled = !allHumansReady;
        dom.startBtn.setAttribute('aria-disabled', allHumansReady ? 'false' : 'true');
        dom.startBtn.title = allHumansReady ? 'Launch Match' : 'All human players must be ready';
      }
      if (dom.waitingHint) dom.waitingHint.style.display = 'none';
    } else {
      if (dom.startBtn) dom.startBtn.style.display = 'none';
      if (dom.waitingHint) dom.waitingHint.style.display = 'block';
    }
  }

  hideLobby() {
    this.lobbyDom.qr?.close();
    this.navigation?.close(this);
    const root = document.getElementById('lobby');
    if (root) {
      root.classList.add('hidden');
      root.style.display = 'none';
      root.setAttribute('aria-hidden', 'true');
    }
    this._lobbyCallbacks = null;
  }

  isLobbyOpen() {
    return this.lobbyDom.root?.getAttribute('aria-hidden') === 'false';
  }

  showLobbyStatus(message, tone = '') {
    const status = document.getElementById('lobby-status') || this.lobbyDom.status;
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('ok', tone === 'ok');
    status.classList.toggle('err', tone === 'err');
  }

  async copyInviteLink(url) {
    const copied = await copyInviteText(url);
    if (copied) {
      this.showLobbyStatus('INVITE LINK COPIED TO CLIPBOARD', 'ok');
    } else {
      this.showLobbyStatus('CLIPBOARD DENIED — SELECT & COPY LINK ABOVE', 'err');
    }
    return copied;
  }

  dispose() {
    this.browser?.dispose();
    this.browser = null;
    const doc = typeof document !== 'undefined' ? document : null;
    if (this._onLobbyKeyDown) {
      if (doc) doc.removeEventListener('keydown', this._onLobbyKeyDown);
      this._onLobbyKeyDown = null;
    }

    if (doc) this.hideLobby();
    else this._lobbyCallbacks = null;

    this.support.dispose();
    this.onMenuAction = null;
    this._lobbyCallbacks = null;
    this.joinStatus = null;
    this.lobbyDom = {};
  }
}
