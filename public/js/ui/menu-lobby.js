import {
  MODE_IDS,
  MAP_IDS,
  isModeMapCompatible,
  DEFAULT_MODE_ID,
  DEFAULT_MAP_ID,
  normalizeModeId,
  normalizeMapId,
} from '../../../shared/modes.js';
import {
  HudSupport,
  MAP_DESCRIPTIONS,
  MAP_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  cleanCode,
  copyInviteLink as copyInviteText,
  el,
  loadName,
  loadPref,
  loadPrefNum,
  resolveInviteBase,
  saveName,
  savePref,
} from './hud-support.js';

const NOOP = () => {};

export class MenuLobbyController {
  constructor(host = {}) {
    this.host = host;
    this.support = new HudSupport();

    this.onMenuAction = null;
    this._lobbyCallbacks = null;
    this.lobbyDom = {};
    this.joinStatus = null;
    this._onLobbyKeyDown = null;
  }

  _callHost(name, ...args) {
    const callback = this.host && this.host[name];
    if (typeof callback === 'function') return callback.call(this.host, ...args);
    return undefined;
  }

  _settingsOpen() {
    if (this.host && typeof this.host.isSettingsOpen === 'function') {
      return !!this.host.isSettingsOpen();
    }
    return !!(this.host && this.host.settingsOpen);
  }

  _buyMenuOpen() {
    return !!this._callHost('isBuyMenuOpen');
  }

  _sensitivity() {
    const configured = this._callHost('getSensitivity');
    if (Number.isFinite(+configured)) {
      return Math.min(0.08, Math.max(0.005, +configured));
    }
    return loadPrefNum('vb-sens', 0.030, 0.005, 0.08);
  }

  buildMenu(onAction) {
    this.onMenuAction = typeof onAction === 'function' ? onAction : NOOP;
    this.hideLobby();
    this._callHost('closeSettings');
    this._callHost('closeBuyMenuDirect');

    const root = this.support.root('menu');
    root.innerHTML = '';
    root.classList.remove('hidden');
    root.style.display = 'flex';
    root.setAttribute('aria-hidden', 'false');

    const panel = el('div', 'vb-panel', root);

    const title = el('h1', 'vb-title', panel, 'menu-title');
    title.textContent = 'VOXEL BLITZ';
    const sub = el('div', 'vb-sub', panel);
    sub.textContent = 'tactical arena · six weapons · voxel combat';

    const callsignLabel = el('label', 'vb-label', panel);
    callsignLabel.textContent = 'CALLSIGN';
    callsignLabel.htmlFor = 'name-input';
    const nameInput = el('input', '', panel, 'name-input');
    nameInput.maxLength = 16;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.placeholder = 'OPERATOR';
    nameInput.value = loadName();

    const modeSection = el('div', 'vb-menu-field-group', panel);
    const modeLabel = el('label', 'vb-label', modeSection);
    modeLabel.textContent = 'GAME MODE';
    modeLabel.htmlFor = 'game-mode-select';

    const modeSelect = el('select', 'vb-select', modeSection, 'game-mode-select');
    modeSelect.setAttribute('aria-describedby', 'game-mode-desc');

    for (const modeId of MODE_IDS) {
      const option = el('option', '', modeSelect);
      option.value = modeId;
      option.textContent = MODE_LABELS[modeId] || modeId.toUpperCase();
    }
    const savedMode = loadPref('vb-mode', DEFAULT_MODE_ID);
    modeSelect.value = normalizeModeId(savedMode, DEFAULT_MODE_ID);

    const modeDescription = el('div', 'vb-field-desc', modeSection, 'game-mode-desc');
    modeDescription.setAttribute('role', 'status');
    modeDescription.setAttribute('aria-live', 'polite');

    const mapSection = el('div', 'vb-menu-field-group', panel);
    const mapLabel = el('label', 'vb-label', mapSection);
    mapLabel.textContent = 'ARENA MAP';
    mapLabel.htmlFor = 'map-select';

    const mapSelect = el('select', 'vb-select', mapSection, 'map-select');
    mapSelect.setAttribute('aria-describedby', 'map-desc');

    const mapDescription = el('div', 'vb-field-desc', mapSection, 'map-desc');
    mapDescription.setAttribute('role', 'status');
    mapDescription.setAttribute('aria-live', 'polite');

    const syncMapOptions = (currentMode, preferredMap) => {
      mapSelect.innerHTML = '';
      const validMaps = MAP_IDS.filter((mapId) => isModeMapCompatible(currentMode, mapId));
      for (const mapId of validMaps) {
        const option = el('option', '', mapSelect);
        option.value = mapId;
        option.textContent = MAP_LABELS[mapId] || mapId.toUpperCase();
      }
      if (preferredMap && validMaps.includes(preferredMap)) {
        mapSelect.value = preferredMap;
      } else {
        mapSelect.value = validMaps[0] || DEFAULT_MAP_ID;
      }
      modeDescription.textContent = MODE_DESCRIPTIONS[currentMode] || '';
      mapDescription.textContent = MAP_DESCRIPTIONS[mapSelect.value] || '';
    };

    const savedMap = loadPref('vb-map', DEFAULT_MAP_ID);
    syncMapOptions(modeSelect.value, normalizeMapId(savedMap, DEFAULT_MAP_ID));

    modeSelect.addEventListener('change', () => {
      const chosenMode = normalizeModeId(modeSelect.value, DEFAULT_MODE_ID);
      savePref('vb-mode', chosenMode);
      syncMapOptions(chosenMode, mapSelect.value);
      savePref('vb-map', mapSelect.value);
    });

    mapSelect.addEventListener('change', () => {
      const chosenMap = normalizeMapId(mapSelect.value, DEFAULT_MAP_ID);
      savePref('vb-map', chosenMap);
      mapDescription.textContent = MAP_DESCRIPTIONS[chosenMap] || '';
    });

    const botsSection = el('div', 'vb-menu-field-group', panel);
    const botsLabel = el('label', 'vb-label', botsSection);
    botsLabel.textContent = 'BOTS TARGET';
    botsLabel.htmlFor = 'bot-count';
    const bots = el('select', 'vb-select', botsSection, 'bot-count');
    for (let count = 0; count <= 7; count += 1) {
      const option = el('option', '', bots);
      option.value = String(count);
      option.textContent = `${count} BOTS`;
    }
    bots.value = '3';

    const sensitivityLabel = el('label', 'vb-label', panel);
    sensitivityLabel.textContent = 'SENSITIVITY';
    sensitivityLabel.htmlFor = 'sens-slider';
    const sensitivityRow = el('div', 'vb-sensrow', panel);
    const sensitivityInput = el('input', '', sensitivityRow, 'sens-slider');
    sensitivityInput.type = 'range';
    sensitivityInput.min = '0.005';
    sensitivityInput.max = '0.08';
    sensitivityInput.step = '0.001';
    sensitivityInput.value = String(this._sensitivity());
    sensitivityInput.setAttribute('aria-label', 'Mouse Sensitivity');
    const sensitivityValue = el('span', '', sensitivityRow, 'sens-val');

    const showSensitivity = () => {
      const value = Number(sensitivityInput.value);
      sensitivityValue.textContent = (value * 100).toFixed(1);
      savePref('vb-sens', value);
      this._callHost('setSensitivity', value);
    };
    showSensitivity();
    sensitivityInput.addEventListener('input', showSensitivity);

    const actionsBox = el('div', 'vb-menu-actions', panel);

    const quickBox = el('div', 'vb-quick-box', actionsBox);
    const quickPlayButton = el('button', 'vb-btn vb-quick-play-btn', quickBox, 'play-btn');
    quickPlayButton.type = 'button';
    quickPlayButton.textContent = 'QUICK PLAY';
    const quickHint = el('div', 'vb-action-hint', quickBox);
    quickHint.textContent = 'Instant skirmish · Shared Fun mode · Auto-rotating maps';

    const createBox = el('div', 'vb-create-box', actionsBox);
    const createLobbyButton = el(
      'button',
      'vb-btn vb-create-lobby-btn',
      createBox,
      'create-lobby-btn',
    );
    createLobbyButton.type = 'button';
    createLobbyButton.textContent = 'CREATE BRIEFING LOBBY';
    const createHint = el('div', 'vb-action-hint', createBox);
    createHint.textContent = 'Hosts custom briefing using selected mode & map above';

    const joinSection = el('div', 'vb-join-section', panel);
    const joinLabel = el('label', 'vb-label', joinSection);
    joinLabel.textContent = 'JOIN VIA ROOM CODE';
    joinLabel.htmlFor = 'join-code-input';
    const joinHint = el('div', 'vb-action-hint vb-join-hint', joinSection);
    joinHint.textContent = 'Inherits host game mode & map settings automatically';

    const joinRow = el('div', 'vb-join-row', joinSection);
    const joinInput = el('input', 'vb-join-input', joinRow, 'join-code-input');
    joinInput.maxLength = 5;
    joinInput.autocomplete = 'off';
    joinInput.spellcheck = false;
    joinInput.placeholder = 'CODE';

    const joinButton = el('button', 'vb-btn vb-join-btn', joinRow, 'join-lobby-btn');
    joinButton.type = 'button';
    joinButton.textContent = 'JOIN';

    this.joinStatus = el('div', 'vb-status', panel, 'join-status');
    this.joinStatus.setAttribute('role', 'status');
    this.joinStatus.setAttribute('aria-live', 'polite');

    const getPayload = (mode, code = '') => {
      const name = nameInput.value.trim().slice(0, 16) || 'PLAYER';
      saveName(name);
      const botCount = Math.round(Number(bots.value)) || 0;
      const sensitivity = Number(sensitivityInput.value);
      let gameMode = normalizeModeId(modeSelect.value, DEFAULT_MODE_ID);
      let map = normalizeMapId(mapSelect.value, DEFAULT_MAP_ID);
      if (mode === 'quick') {
        gameMode = 'fun';
        map = 'foundry';
      } else if (!isModeMapCompatible(gameMode, map)) {
        map = MAP_IDS.find((mapId) => isModeMapCompatible(gameMode, mapId)) || DEFAULT_MAP_ID;
      }
      return { mode, gameMode, map, name, bots: botCount, sensitivity, code };
    };

    const triggerQuick = () => {
      if (quickPlayButton.disabled) return;
      this.onMenuAction(getPayload('quick', ''));
    };

    const triggerCreate = () => {
      if (createLobbyButton.disabled) return;
      this.onMenuAction(getPayload('create', ''));
    };

    const triggerJoin = () => {
      if (joinButton.disabled) return;
      const raw = joinInput.value.trim();
      const cleaned = cleanCode(raw);
      if (!cleaned) {
        this.showJoinState('ENTER 5-CHARACTER ROOM CODE', 'err');
        joinInput.focus();
        return;
      }
      if (cleaned.length !== 5) {
        this.showJoinState('ROOM CODE MUST BE 5 CHARACTERS', 'err');
        joinInput.focus();
        return;
      }
      this.showJoinState('');
      this.onMenuAction(getPayload('join', cleaned));
    };

    quickPlayButton.addEventListener('click', triggerQuick);
    createLobbyButton.addEventListener('click', triggerCreate);
    joinButton.addEventListener('click', triggerJoin);

    joinInput.addEventListener('input', () => {
      joinInput.value = cleanCode(joinInput.value);
    });

    joinInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        triggerJoin();
      }
    });

    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const cleaned = cleanCode(joinInput.value.trim());
        if (cleaned.length === 5) triggerJoin();
        else triggerQuick();
      }
    });

    let prefillCode = '';
    try {
      const params = new URLSearchParams(window.location.search);
      const paramCode = params.get('lobby');
      if (paramCode) prefillCode = cleanCode(paramCode);
    } catch (_) {}

    if (prefillCode) {
      joinInput.value = prefillCode;
      this.showJoinState(`INVITE CODE DETECTED: ${prefillCode}`, 'ok');
      this.support.defer(() => {
        try {
          if (document.getElementById('join-code-input') === joinInput) {
            joinInput.focus();
            joinInput.select();
          }
        } catch (_) {}
      });
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
    const status = document.getElementById('join-status') || this.joinStatus;
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('ok', tone === 'ok');
    status.classList.toggle('err', tone === 'err');
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
    const panel = el('div', 'vb-lobby-panel', root);

    const title = el('h2', 'vb-title', panel, 'lobby-title');
    title.textContent = 'SQUAD BRIEFING';
    const sub = el('div', 'vb-sub', panel);
    sub.textContent = 'tactical deployment staging';

    const metaCard = el('div', 'vb-lobby-card vb-lobby-meta-card', panel);
    const metaHeader = el('div', 'vb-lobby-meta-header', metaCard);
    el('span', 'vb-label', metaHeader).textContent = 'MISSION BRIEFING (FIXED)';

    const chipsRow = el('div', 'vb-lobby-chips-row', metaCard);

    const modeChip = el('div', 'vb-lobby-chip vb-lobby-mode-chip', chipsRow);
    el('span', 'vb-chip-label', modeChip).textContent = 'MODE';
    const modeValue = el('span', 'vb-chip-val', modeChip, 'lobby-mode-val');
    modeValue.textContent = 'SEARCH & DESTROY';

    const mapChip = el('div', 'vb-lobby-chip vb-lobby-map-chip', chipsRow);
    el('span', 'vb-chip-label', mapChip).textContent = 'MAP';
    const mapValue = el('span', 'vb-chip-val', mapChip, 'lobby-map-val');
    mapValue.textContent = 'CITADEL';

    const inviteCard = el('div', 'vb-lobby-card vb-lobby-invite-card', panel);
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
      codeVal: codeValue,
      inviteInput,
      copyBtn: copyButton,
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
        if (this._settingsOpen()) return;
        if (this._buyMenuOpen()) return;
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

  showLobby(state, { onReady, onStart, onLeave } = {}) {
    this._callHost('closeSettings');
    if (this._buyMenuOpen()) this._callHost('toggleBuyMenu', false);
    else this._callHost('closeBuyMenuDirect');

    this._lobbyCallbacks = { onReady, onStart, onLeave };
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
    if (dom.modeVal) dom.modeVal.textContent = MODE_LABELS[gameMode] || gameMode.toUpperCase();
    if (dom.mapVal) dom.mapVal.textContent = MAP_LABELS[map] || map.toUpperCase();

    const code = cleanCode(state.code) || state.code || '-----';
    if (dom.codeVal) dom.codeVal.textContent = code;

    const inviteUrl = `${resolveInviteBase()}?lobby=${code}`;
    if (dom.inviteInput && dom.inviteInput.value !== inviteUrl) {
      dom.inviteInput.value = inviteUrl;
    }

    const members = Array.isArray(state.members) ? state.members : [];
    const humans = members.filter((member) => !member.bot);
    const readyHumans = humans.filter((member) => !!member.ready).length;
    const totalHumans = humans.length;
    const allHumansReady = totalHumans > 0 && readyHumans === totalHumans;

    if (dom.readyCount) {
      dom.readyCount.textContent = `${members.length}/8 OPERATORS · ${readyHumans}/${totalHumans} READY`;
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
