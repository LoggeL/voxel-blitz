// Voxel Blitz HUD — tactical industrial match UI, mode/map selection,
// authoritative S&D match state, squad briefing lobby, accessible buy armory,
// and team presentation.
//
// Constructor touches NO DOM: `new HUD()` is safe detached; build*/apply run
// only when explicitly invoked. Structural styling lives inline and classes in
// style.css.

import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import {
  MODE_IDS,
  MAP_IDS,
  WEAPON_PRICES,
  isModeMapCompatible,
  DEFAULT_MODE_ID,
  DEFAULT_MAP_ID,
  normalizeModeId,
  normalizeMapId,
} from '../../../shared/modes.js';

const GLYPH = {
  rifle: 'R',
  smg: 'S',
  shotgun: 'SG',
  sniper: 'SN',
  lmg: 'LMG',
  revolver: 'REV',
};

export const WEAPON_NAMES = {
  revolver: 'IRONCLAD .44',
  smg: 'HORNET SMG',
  shotgun: 'M-DOCK 12',
  rifle: 'VK-77 RAPTOR',
  lmg: 'BASTION LMG',
  sniper: 'LONGSHOT MK-II',
};

export const WEAPON_CLASSES = {
  revolver: 'SIDEARM · SEMI-AUTO',
  smg: 'SUBMACHINE GUN · FULL AUTO',
  shotgun: 'TACTICAL SHOTGUN · PUMP',
  rifle: 'ASSAULT RIFLE · FULL AUTO',
  lmg: 'HEAVY MACHINE GUN · AUTO',
  sniper: 'PRECISION SNIPER · 5× OPTIC',
};

export const WEAPON_BUY_ORDER = ['revolver', 'smg', 'shotgun', 'rifle', 'lmg', 'sniper'];

export const MODE_LABELS = {
  fun: 'FUN · FREE FOR ALL',
  tdm: 'TEAM DEATHMATCH',
  snd: 'SEARCH & DESTROY',
};

export const MODE_DESCRIPTIONS = {
  fun: 'Shared instant skirmish · 6-gun full loadout · Rapid respawn',
  tdm: 'Alpha vs Bravo · First team to 40 kills wins · Team spawns',
  snd: 'Attackers vs Defenders · Buy phase economy · First to 7 round wins',
};

export const MAP_LABELS = {
  foundry: 'FOUNDRY',
  depot: 'DEPOT',
  citadel: 'CITADEL',
};

export const MAP_DESCRIPTIONS = {
  foundry: 'Industrial foundry with multi-level catwalks and mid-lane cover (All Modes)',
  depot: 'Point-symmetric cargo depot with mirrored containers & central plaza (Fun / TDM)',
  citadel: 'Urban fortress with Courtyard A and Compound B tactical bomb sites (All Modes)',
};

const CARDINAL = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
const SCOPE_MS = 120;
const DMG_MS = 650;
const DMG_MAX_POOL = 40;

function el(tag, cls, parent, id) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (id) n.id = id;
  if (parent) parent.appendChild(n);
  return n;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

function formatClock(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function resolveInviteBase() {
  try {
    const browserLocation =
      (typeof window !== 'undefined' && window.location)
      || (typeof globalThis !== 'undefined' && globalThis.location)
      || null;
    if (!browserLocation) return '';
    const { origin, pathname } = browserLocation;
    if (typeof origin !== 'string' || typeof pathname !== 'string') return '';
    return `${origin}${pathname}`;
  } catch (_) {
    return '';
  }
}

export class HUD {
  constructor() {
    this.built = false;

    this.onMenuAction = null;
    this._lobbyCallbacks = null;
    this.lobbyDom = {};
    this._onLobbyKeyDown = null;
    this._ownedRoots = new Set();
    this._deferredTimers = new Set();

    this._buyMenuCallbacks = null;
    this._buyMenuOpen = false;
    this._buyMenuState = {
      phase: 'idle',
      credits: 0,
      owned: [],
    };
    this.buyDom = {};
    this._buyPreviousFocus = null;
    this._onBuyKeyDown = null;
    this._isClosingBuyMenu = false;
    this._isClosingSettings = false;
    this._settingsPreviousFocus = null;
    this.matchDom = {};
    this._latestMatch = null;
    this._latestSelfRow = null;
    this._latestPlayers = [];

    this.st = {};
    this.dom = {};
    this.dead = false;
    this.flashV = 0;
    this.flashRAF = 0;
    this.painImpulse = 0;
    this.painDirectionSeed = 0;
    this.deathBrutality = 0;
    this.deathImpactTimer = 0;
    this.scopeShown = false;
    this.scopeProgress = 0;
    this.scopeRAF = 0;
    this.compassRAF = 0;
    this.ringOn = false;
    this.compassW = 0;
    this.compassPPD = 2;
    this.compassZeroX = 720;
    this.compassMeasured = false;
    this._onWindowResize = () => {
      this.compassW = 0;
      this.compassMeasured = false;
    };
    this.dmgPool = [];
    this.dmgActive = [];
    this.dmgRAF = 0;
    this.lastCritAt = -1e9;
    this.hmTimer = 0;
    this.killfeedTimers = new Set();
    this.names = new Map();
    this.tabBound = false;
    this.lastWepKey = '';

    // Settings overlay state
    this._settingsOpen = false;
    this._settingsConfig = {
      sensitivity: this.loadPrefNum('vb-sens', 0.030, 0.005, 0.08),
      volume: this.loadPrefNum('vb-volume', 0.80, 0, 1),
      fov: this.loadPrefNum('vb-fov', 75, 65, 100),
    };
    this._settingsOnChange = null;
    this._settingsOnResume = null;
    this.settingsDom = {};
  }

  /* ------------------------------------------------------------ helpers */

  root(id) {
    let n = document.getElementById(id);
    if (!n) {
      n = el('div', '', document.body, id);
      this._ownedRoots.add(n);
    }
    return n;
  }

  defer(callback) {
    const timer = setTimeout(() => {
      this._deferredTimers.delete(timer);
      callback();
    }, 0);
    this._deferredTimers.add(timer);
    return timer;
  }

  loadName() {
    try { return localStorage.getItem('vb-name') || ''; } catch (_) { return ''; }
  }

  saveName(v) {
    try { localStorage.setItem('vb-name', v); } catch (_) {}
  }

  loadPref(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }

  savePref(key, v) {
    try { localStorage.setItem(key, String(v)); } catch (_) {}
  }

  loadPrefNum(key, fallback, minVal, maxVal) {
    try {
      const v = parseFloat(localStorage.getItem(key));
      if (Number.isFinite(v)) {
        if (minVal != null && maxVal != null) {
          return Math.min(maxVal, Math.max(minVal, v));
        }
        return v;
      }
    } catch (_) {}
    return fallback;
  }

  resolveKey(wid) {
    if (typeof wid === 'number') return WEAPON_IDS[wid] || '';
    if (typeof wid === 'string') return wid;
    return '';
  }

  spreadFromCone(coneDeg) {
    const cone = Math.max(0, Number(coneDeg) || 0);
    return 4 + 72 * (1 - Math.exp(-cone / 7));
  }

  cleanCode(raw) {
    if (typeof raw !== 'string') return '';
    return raw.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '').slice(0, 5);
  }

  async copyInviteLink(url) {
    let ok = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch (_) {
        ok = false;
      }
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, 99999);
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) {
        ok = false;
      }
    }
    if (ok) {
      this.showLobbyStatus('INVITE LINK COPIED TO CLIPBOARD', 'ok');
    } else {
      this.showLobbyStatus('CLIPBOARD DENIED — SELECT & COPY LINK ABOVE', 'err');
    }
    return ok;
  }

  /* ---------------------------------------------------------------- menu */

  buildMenu(onAction) {
    this.onMenuAction = typeof onAction === 'function' ? onAction : () => {};
    this.hideLobby();
    this.closeSettings();
    this.closeBuyMenuDirect();

    const root = this.root('menu');
    root.innerHTML = '';
    root.classList.remove('hidden');
    root.style.display = 'flex';
    root.setAttribute('aria-hidden', 'false');

    const panel = el('div', 'vb-panel', root);

    const title = el('h1', 'vb-title', panel, 'menu-title');
    title.textContent = 'VOXEL BLITZ';
    const sub = el('div', 'vb-sub', panel);
    sub.textContent = 'tactical arena · six weapons · voxel combat';

    // Callsign
    const callsignLabel = el('label', 'vb-label', panel);
    callsignLabel.textContent = 'CALLSIGN';
    callsignLabel.htmlFor = 'name-input';
    const nameIn = el('input', '', panel, 'name-input');
    nameIn.maxLength = 16;
    nameIn.autocomplete = 'off';
    nameIn.spellcheck = false;
    nameIn.placeholder = 'OPERATOR';
    nameIn.value = this.loadName();

    // Mode Selector
    const modeSection = el('div', 'vb-menu-field-group', panel);
    const modeLabel = el('label', 'vb-label', modeSection);
    modeLabel.textContent = 'GAME MODE';
    modeLabel.htmlFor = 'game-mode-select';

    const modeSelect = el('select', 'vb-select', modeSection, 'game-mode-select');
    modeSelect.setAttribute('aria-describedby', 'game-mode-desc');

    for (const mid of MODE_IDS) {
      const opt = el('option', '', modeSelect);
      opt.value = mid;
      opt.textContent = MODE_LABELS[mid] || mid.toUpperCase();
    }
    const savedMode = this.loadPref('vb-mode', DEFAULT_MODE_ID);
    modeSelect.value = normalizeModeId(savedMode, DEFAULT_MODE_ID);

    const modeDesc = el('div', 'vb-field-desc', modeSection, 'game-mode-desc');
    modeDesc.setAttribute('role', 'status');
    modeDesc.setAttribute('aria-live', 'polite');

    // Map Selector
    const mapSection = el('div', 'vb-menu-field-group', panel);
    const mapLabel = el('label', 'vb-label', mapSection);
    mapLabel.textContent = 'ARENA MAP';
    mapLabel.htmlFor = 'map-select';

    const mapSelect = el('select', 'vb-select', mapSection, 'map-select');
    mapSelect.setAttribute('aria-describedby', 'map-desc');

    const mapDesc = el('div', 'vb-field-desc', mapSection, 'map-desc');
    mapDesc.setAttribute('role', 'status');
    mapDesc.setAttribute('aria-live', 'polite');

    const syncMapOptions = (curMode, preferredMap) => {
      mapSelect.innerHTML = '';
      const validMaps = MAP_IDS.filter((mapId) => isModeMapCompatible(curMode, mapId));
      for (const mapId of validMaps) {
        const opt = el('option', '', mapSelect);
        opt.value = mapId;
        opt.textContent = MAP_LABELS[mapId] || mapId.toUpperCase();
      }
      if (preferredMap && validMaps.includes(preferredMap)) {
        mapSelect.value = preferredMap;
      } else {
        mapSelect.value = validMaps[0] || DEFAULT_MAP_ID;
      }
      modeDesc.textContent = MODE_DESCRIPTIONS[curMode] || '';
      mapDesc.textContent = MAP_DESCRIPTIONS[mapSelect.value] || '';
    };

    const savedMap = this.loadPref('vb-map', DEFAULT_MAP_ID);
    syncMapOptions(modeSelect.value, normalizeMapId(savedMap, DEFAULT_MAP_ID));

    modeSelect.addEventListener('change', () => {
      const chosenMode = normalizeModeId(modeSelect.value, DEFAULT_MODE_ID);
      this.savePref('vb-mode', chosenMode);
      syncMapOptions(chosenMode, mapSelect.value);
      this.savePref('vb-map', mapSelect.value);
    });

    mapSelect.addEventListener('change', () => {
      const chosenMap = normalizeMapId(mapSelect.value, DEFAULT_MAP_ID);
      this.savePref('vb-map', chosenMap);
      mapDesc.textContent = MAP_DESCRIPTIONS[chosenMap] || '';
    });

    // Bots count
    const botsSection = el('div', 'vb-menu-field-group', panel);
    const botsLabel = el('label', 'vb-label', botsSection);
    botsLabel.textContent = 'BOTS TARGET';
    botsLabel.htmlFor = 'bot-count';
    const bots = el('select', 'vb-select', botsSection, 'bot-count');
    for (let n = 0; n <= 7; n++) {
      const opt = el('option', '', bots);
      opt.value = String(n);
      opt.textContent = `${n} BOTS`;
    }
    bots.value = '3';

    // Sensitivity slider
    const sensLabel = el('label', 'vb-label', panel);
    sensLabel.textContent = 'SENSITIVITY';
    sensLabel.htmlFor = 'sens-slider';
    const sensRow = el('div', 'vb-sensrow', panel);
    const sens = el('input', '', sensRow, 'sens-slider');
    sens.type = 'range';
    sens.min = '0.005';
    sens.max = '0.08';
    sens.step = '0.001';
    sens.value = String(this._settingsConfig.sensitivity);
    sens.setAttribute('aria-label', 'Mouse Sensitivity');
    const sensVal = el('span', '', sensRow, 'sens-val');

    const showSens = () => {
      const val = Number(sens.value);
      sensVal.textContent = (val * 100).toFixed(1);
      this._settingsConfig.sensitivity = val;
      this.savePref('vb-sens', val);
      if (this.settingsDom.sensSlider && this.settingsDom.sensSlider.value !== sens.value) {
        this.settingsDom.sensSlider.value = sens.value;
        if (this.settingsDom.sensVal) this.settingsDom.sensVal.textContent = (val * 100).toFixed(1);
      }
      if (typeof this._settingsOnChange === 'function') {
        this._settingsOnChange({ ...this._settingsConfig });
      }
    };
    showSens();
    sens.addEventListener('input', showSens);

    // Action buttons container
    const actionsBox = el('div', 'vb-menu-actions', panel);

    // Quick Play Container (Instant Skirmish)
    const quickBox = el('div', 'vb-quick-box', actionsBox);
    const quickPlayBtn = el('button', 'vb-btn vb-quick-play-btn', quickBox, 'play-btn');
    quickPlayBtn.type = 'button';
    quickPlayBtn.textContent = 'QUICK PLAY';
    const quickHint = el('div', 'vb-action-hint', quickBox);
    quickHint.textContent = 'Instant skirmish · Shared Fun mode · Auto-rotating maps';

    // Create Lobby Container
    const createBox = el('div', 'vb-create-box', actionsBox);
    const createLobbyBtn = el('button', 'vb-btn vb-create-lobby-btn', createBox, 'create-lobby-btn');
    createLobbyBtn.type = 'button';
    createLobbyBtn.textContent = 'CREATE BRIEFING LOBBY';
    const createHint = el('div', 'vb-action-hint', createBox);
    createHint.textContent = 'Hosts custom briefing using selected mode & map above';

    // Join Section
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

    const joinBtn = el('button', 'vb-btn vb-join-btn', joinRow, 'join-lobby-btn');
    joinBtn.type = 'button';
    joinBtn.textContent = 'JOIN';

    this.joinStatus = el('div', 'vb-status', panel, 'join-status');
    this.joinStatus.setAttribute('role', 'status');
    this.joinStatus.setAttribute('aria-live', 'polite');

    const getPayload = (mode, code = '') => {
      const nm = (nameIn.value.trim().slice(0, 16)) || 'PLAYER';
      this.saveName(nm);
      const botCount = Math.round(Number(bots.value)) || 0;
      const sensitivity = Number(sens.value);
      let gameMode = modeSelect ? normalizeModeId(modeSelect.value, DEFAULT_MODE_ID) : DEFAULT_MODE_ID;
      let map = mapSelect ? normalizeMapId(mapSelect.value, DEFAULT_MAP_ID) : DEFAULT_MAP_ID;
      if (mode === 'quick') {
        gameMode = 'fun';
        map = 'foundry';
      } else if (!isModeMapCompatible(gameMode, map)) {
        map = MAP_IDS.find((mapId) => isModeMapCompatible(gameMode, mapId)) || DEFAULT_MAP_ID;
      }
      return { mode, gameMode, map, name: nm, bots: botCount, sensitivity, code };
    };

    const triggerQuick = () => {
      if (quickPlayBtn.disabled) return;
      this.onMenuAction(getPayload('quick', ''));
    };

    const triggerCreate = () => {
      if (createLobbyBtn.disabled) return;
      this.onMenuAction(getPayload('create', ''));
    };

    const triggerJoin = () => {
      if (joinBtn.disabled) return;
      const raw = joinInput.value.trim();
      const cleaned = this.cleanCode(raw);
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

    quickPlayBtn.addEventListener('click', triggerQuick);
    createLobbyBtn.addEventListener('click', triggerCreate);
    joinBtn.addEventListener('click', triggerJoin);

    joinInput.addEventListener('input', () => {
      joinInput.value = this.cleanCode(joinInput.value);
    });

    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        triggerJoin();
      }
    });

    nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const cleaned = this.cleanCode(joinInput.value.trim());
        if (cleaned.length === 5) {
          triggerJoin();
        } else {
          triggerQuick();
        }
      }
    });

    // Check ?lobby=CODE in URL search params
    let prefillCode = '';
    try {
      const params = new URLSearchParams(window.location.search);
      const paramCode = params.get('lobby');
      if (paramCode) {
        prefillCode = this.cleanCode(paramCode);
      }
    } catch (_) {}

    if (prefillCode) {
      joinInput.value = prefillCode;
      this.showJoinState(`INVITE CODE DETECTED: ${prefillCode}`, 'ok');
      this.defer(() => {
        try {
          if (document.getElementById('join-code-input') === joinInput) {
            joinInput.focus();
            joinInput.select();
          }
        } catch (_) {}
      });
    } else {
      this.defer(() => {
        try {
          if (document.getElementById('name-input') === nameIn) {
            nameIn.focus();
            if (nameIn.value) nameIn.select();
          }
        } catch (_) {}
      });
    }
  }

  showJoinState(msg, tone = '') {
    const el = document.getElementById('join-status') || this.joinStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('ok', tone === 'ok');
    el.classList.toggle('err', tone === 'err');
  }

  /* ------------------------------------------------------------ lobby */

  ensureLobbyDom() {
    if (this.lobbyDom.root) return this.lobbyDom.root;

    let root = document.getElementById('lobby');
    if (!root) {
      root = el('div', 'hidden', document.body, 'lobby');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-labelledby', 'lobby-title');
      root.setAttribute('aria-hidden', 'true');
      this._ownedRoots.add(root);
    }

    root.innerHTML = '';
    const panel = el('div', 'vb-lobby-panel', root);

    const title = el('h2', 'vb-title', panel, 'lobby-title');
    title.textContent = 'SQUAD BRIEFING';
    const sub = el('div', 'vb-sub', panel);
    sub.textContent = 'tactical deployment staging';

    // Mode and Map Immutable Chips Card
    const metaCard = el('div', 'vb-lobby-card vb-lobby-meta-card', panel);
    const metaHeader = el('div', 'vb-lobby-meta-header', metaCard);
    el('span', 'vb-label', metaHeader).textContent = 'MISSION BRIEFING (FIXED)';

    const chipsRow = el('div', 'vb-lobby-chips-row', metaCard);

    const modeChip = el('div', 'vb-lobby-chip vb-lobby-mode-chip', chipsRow);
    el('span', 'vb-chip-label', modeChip).textContent = 'MODE';
    const modeVal = el('span', 'vb-chip-val', modeChip, 'lobby-mode-val');
    modeVal.textContent = 'SEARCH & DESTROY';

    const mapChip = el('div', 'vb-lobby-chip vb-lobby-map-chip', chipsRow);
    el('span', 'vb-chip-label', mapChip).textContent = 'MAP';
    const mapVal = el('span', 'vb-chip-val', mapChip, 'lobby-map-val');
    mapVal.textContent = 'CITADEL';

    // Invite Card
    const inviteCard = el('div', 'vb-lobby-card vb-lobby-invite-card', panel);
    const codeHeader = el('div', 'vb-lobby-code-row', inviteCard);
    el('span', 'vb-label', codeHeader).textContent = 'ROOM CODE';
    const codeVal = el('span', 'vb-lobby-code-val', codeHeader, 'lobby-code-val');
    codeVal.textContent = '-----';

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

    const copyBtn = el('button', 'vb-btn-copy', inviteRow, 'lobby-copy-btn');
    copyBtn.type = 'button';
    copyBtn.textContent = 'COPY LINK';
    copyBtn.setAttribute('aria-label', 'Copy Invite Link');
    copyBtn.addEventListener('click', () => {
      this.copyInviteLink(inviteInput.value);
    });

    // Roster Card
    const rosterCard = el('div', 'vb-lobby-card vb-roster-card', panel);
    const rosterHeader = el('div', 'vb-roster-header', rosterCard);
    el('span', 'vb-label', rosterHeader).textContent = 'OPERATORS';
    const readyCount = el('span', 'vb-ready-count', rosterHeader, 'lobby-ready-count');
    readyCount.textContent = '0 / 0 READY';

    const rosterList = el('div', 'vb-roster-list', rosterCard, 'lobby-roster');
    rosterList.setAttribute('role', 'list');

    // Actions Row
    const actionsRow = el('div', 'vb-lobby-actions', panel);

    const leaveBtn = el('button', 'vb-btn vb-btn-leave', actionsRow, 'lobby-leave-btn');
    leaveBtn.type = 'button';
    leaveBtn.textContent = 'LEAVE';
    leaveBtn.addEventListener('click', () => {
      if (this._lobbyCallbacks && typeof this._lobbyCallbacks.onLeave === 'function') {
        this._lobbyCallbacks.onLeave();
      }
    });

    const readyBtn = el('button', 'vb-btn vb-btn-ready', actionsRow, 'lobby-ready-btn');
    readyBtn.type = 'button';
    readyBtn.textContent = 'MARK READY';
    readyBtn.setAttribute('aria-pressed', 'false');
    readyBtn.addEventListener('click', () => {
      if (this._lobbyCallbacks && typeof this._lobbyCallbacks.onReady === 'function') {
        const currentReady = readyBtn.getAttribute('aria-pressed') === 'true';
        this._lobbyCallbacks.onReady(!currentReady);
      }
    });

    const startBtn = el('button', 'vb-btn vb-btn-start', actionsRow, 'lobby-start-btn');
    startBtn.type = 'button';
    startBtn.textContent = 'START MATCH';
    startBtn.disabled = true;
    startBtn.setAttribute('aria-disabled', 'true');
    startBtn.addEventListener('click', () => {
      if (startBtn.disabled) return;
      if (this._lobbyCallbacks && typeof this._lobbyCallbacks.onStart === 'function') {
        this._lobbyCallbacks.onStart();
      }
    });

    const waitingHint = el('div', 'vb-lobby-waiting-hint', actionsRow, 'lobby-waiting-hint');
    waitingHint.textContent = 'WAITING FOR HOST TO LAUNCH MATCH';
    waitingHint.style.display = 'none';

    const status = el('div', 'vb-status', panel, 'lobby-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    this.lobbyDom = {
      root,
      panel,
      modeVal,
      mapVal,
      codeVal,
      inviteInput,
      copyBtn,
      readyCount,
      rosterList,
      leaveBtn,
      readyBtn,
      startBtn,
      waitingHint,
      status,
    };

    if (!this._onLobbyKeyDown) {
      this._onLobbyKeyDown = (e) => {
        if (root.classList.contains('hidden') || root.style.display === 'none') return;
        if (this._settingsOpen) return;
        if (this._buyMenuOpen) return;
        if (e.key === 'Escape') {
          e.preventDefault();
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
    this.closeSettings();
    if (this._buyMenuOpen) this.toggleBuyMenu(false);
    else this.closeBuyMenuDirect();
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

    this.defer(() => {
      try {
        if (
          this.lobbyDom.root?.getAttribute('aria-hidden') === 'false' &&
          this.lobbyDom.readyBtn
        ) {
          this.lobbyDom.readyBtn.focus();
        }
      } catch (_) {}
    });
  }

  updateLobby(state) {
    if (!state) return;
    this.ensureLobbyDom();
    const d = this.lobbyDom;
    if (!d || !d.root) return;

    // Mode & Map immutable chips
    const gameMode = state.gameMode || 'fun';
    const map = state.map || 'foundry';
    if (d.modeVal) {
      d.modeVal.textContent = MODE_LABELS[gameMode] || gameMode.toUpperCase();
    }
    if (d.mapVal) {
      d.mapVal.textContent = MAP_LABELS[map] || map.toUpperCase();
    }

    const code = this.cleanCode(state.code) || state.code || '-----';
    if (d.codeVal) d.codeVal.textContent = code;

    const inviteUrl = `${resolveInviteBase()}?lobby=${code}`;
    if (d.inviteInput && d.inviteInput.value !== inviteUrl) {
      d.inviteInput.value = inviteUrl;
    }

    const members = Array.isArray(state.members) ? state.members : [];
    const humans = members.filter((m) => !m.bot);
    const readyHumans = humans.filter((m) => !!m.ready).length;
    const totalHumans = humans.length;
    const allHumansReady = totalHumans > 0 && readyHumans === totalHumans;

    if (d.readyCount) {
      d.readyCount.textContent = `${members.length}/8 OPERATORS · ${readyHumans}/${totalHumans} READY`;
    }

    // Populate roster list
    if (d.readyBtn) {
      d.readyBtn.classList.remove('is-ready');
      d.readyBtn.setAttribute('aria-pressed', 'false');
      d.readyBtn.textContent = 'MARK READY';
    }
    if (d.rosterList) {
      d.rosterList.innerHTML = '';
      for (const m of members) {
        const isSelf = state.selfId != null && String(m.id) === String(state.selfId);
        const isHost = state.host != null && String(m.id) === String(state.host);
        const isBot = !!m.bot;

        const item = el('div', 'vb-roster-item' + (isSelf ? ' is-self' : ''), d.rosterList);
        item.setAttribute('role', 'listitem');

        const leftCol = el('div', 'vb-roster-left', item);

        const nameSpan = el('span', 'vb-roster-name', leftCol);
        nameSpan.textContent = m.name || (isBot ? 'TACTICAL BOT' : 'OPERATOR');

        if (isSelf) {
          const badge = el('span', 'vb-badge vb-badge-you', leftCol);
          badge.textContent = 'YOU';
        }
        if (isHost) {
          const badge = el('span', 'vb-badge vb-badge-host', leftCol);
          badge.textContent = 'HOST';
        }
        if (isBot) {
          const badge = el('span', 'vb-badge vb-badge-bot', leftCol);
          badge.textContent = 'BOT';
        }

        const rightCol = el('div', 'vb-roster-right', item);
        const readyPill = el('span', 'vb-ready-pill', rightCol);
        if (isBot) {
          readyPill.classList.add('bot');
          readyPill.textContent = 'AUTO-READY';
        } else if (m.ready) {
          readyPill.classList.add('ready');
          readyPill.textContent = 'READY';
        } else {
          readyPill.classList.add('not-ready');
          readyPill.textContent = 'WAITING';
        }

        if (isSelf && d.readyBtn) {
          const isReady = !!m.ready;
          d.readyBtn.classList.toggle('is-ready', isReady);
          d.readyBtn.setAttribute('aria-pressed', isReady ? 'true' : 'false');
          d.readyBtn.textContent = isReady ? 'CANCEL READY' : 'MARK READY';
        }
      }
    }

    const isHost = state.selfId != null && state.host != null && String(state.selfId) === String(state.host);
    if (isHost) {
      if (d.startBtn) {
        d.startBtn.style.display = 'block';
        d.startBtn.disabled = !allHumansReady;
        d.startBtn.setAttribute('aria-disabled', allHumansReady ? 'false' : 'true');
        d.startBtn.title = allHumansReady ? 'Launch Match' : 'All human players must be ready';
      }
      if (d.waitingHint) {
        d.waitingHint.style.display = 'none';
      }
    } else {
      if (d.startBtn) {
        d.startBtn.style.display = 'none';
      }
      if (d.waitingHint) {
        d.waitingHint.style.display = 'block';
      }
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

  showLobbyStatus(msg, tone = '') {
    const el = document.getElementById('lobby-status') || (this.lobbyDom && this.lobbyDom.status);
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('ok', tone === 'ok');
    el.classList.toggle('err', tone === 'err');
  }

  /* ------------------------------------------------------------ settings */

  setupSettings({ sensitivity, volume, fov, onChange, onResume } = {}) {
    if (sensitivity != null && Number.isFinite(+sensitivity)) {
      this._settingsConfig.sensitivity = Math.min(0.08, Math.max(0.005, +sensitivity));
      this.savePref('vb-sens', this._settingsConfig.sensitivity);
    }
    if (volume != null && Number.isFinite(+volume)) {
      this._settingsConfig.volume = Math.min(1, Math.max(0, +volume));
      this.savePref('vb-volume', this._settingsConfig.volume);
    }
    if (fov != null && Number.isFinite(+fov)) {
      this._settingsConfig.fov = Math.min(100, Math.max(65, Math.round(+fov)));
      this.savePref('vb-fov', this._settingsConfig.fov);
    }
    if (typeof onChange === 'function') {
      this._settingsOnChange = onChange;
    }
    if (typeof onResume === 'function') {
      this._settingsOnResume = onResume;
    }

    this.ensureSettings();
    this.syncSettingsUI();
  }

  openSettings() {
    if (this.isLobbyOpen()) return;
    this.closeBuyMenuDirect();
    this.ensureSettings();
    this.syncSettingsUI();
    this._settingsPreviousFocus = document.activeElement;
    this._settingsOpen = true;
    if (this.settingsDom.root) {
      this.settingsDom.root.classList.remove('hidden');
      this.settingsDom.root.style.display = 'flex';
      this.settingsDom.root.setAttribute('aria-hidden', 'false');
    }
    this.defer(() => {
      try {
        if (this._settingsOpen && this.settingsDom.resumeBtn) {
          this.settingsDom.resumeBtn.focus();
        }
      } catch (_) {}
    });
  }

  closeSettings() {
    this._settingsOpen = false;
    if (this.settingsDom.root) {
      this.settingsDom.root.classList.add('hidden');
      this.settingsDom.root.style.display = 'none';
      this.settingsDom.root.setAttribute('aria-hidden', 'true');
    }
    const previousFocus = this._settingsPreviousFocus;
    this._settingsPreviousFocus = null;
    if (
      previousFocus &&
      !this.settingsDom.root?.contains(previousFocus) &&
      typeof previousFocus.focus === 'function'
    ) {
      try { previousFocus.focus(); } catch (_) {}
    }
  }

  get settingsOpen() {
    return !!this._settingsOpen;
  }

  ensureSettings() {
    if (this.settingsDom.root) return this.settingsDom.root;

    const root = el('div', 'hidden', document.body, 'settings-overlay');
    this._ownedRoots.add(root);
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'settings-title');
    root.setAttribute('aria-hidden', 'true');
    root.style.display = 'none';

    const panel = el('div', 'vb-settings-panel', root);

    const title = el('h2', 'vb-title', panel, 'settings-title');
    title.textContent = 'SETTINGS';
    const sub = el('div', 'vb-sub', panel);
    sub.textContent = 'tactical system configuration';

    // Sensitivity row
    const sensRow = el('div', 'vb-setting-row', panel);
    const sensHeader = el('div', 'vb-setting-header', sensRow);
    const sensLabel = el('label', 'vb-label', sensHeader);
    sensLabel.textContent = 'MOUSE SENSITIVITY';
    sensLabel.htmlFor = 'settings-sens-slider';
    const sensVal = el('span', 'vb-setting-val', sensHeader, 'settings-sens-val');
    const sensSlider = el('input', 'vb-slider', sensRow, 'settings-sens-slider');
    sensSlider.type = 'range';
    sensSlider.min = '0.005';
    sensSlider.max = '0.08';
    sensSlider.step = '0.001';
    sensSlider.setAttribute('aria-label', 'Mouse Sensitivity');
    sensSlider.setAttribute('aria-valuemin', '0.005');
    sensSlider.setAttribute('aria-valuemax', '0.08');

    // Master Volume row
    const volRow = el('div', 'vb-setting-row', panel);
    const volHeader = el('div', 'vb-setting-header', volRow);
    const volLabel = el('label', 'vb-label', volHeader);
    volLabel.textContent = 'MASTER VOLUME';
    volLabel.htmlFor = 'settings-vol-slider';
    const volVal = el('span', 'vb-setting-val', volHeader, 'settings-vol-val');
    const volSlider = el('input', 'vb-slider', volRow, 'settings-vol-slider');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.01';
    volSlider.setAttribute('aria-label', 'Master Volume');
    volSlider.setAttribute('aria-valuemin', '0');
    volSlider.setAttribute('aria-valuemax', '1');

    // Base FOV row
    const fovRow = el('div', 'vb-setting-row', panel);
    const fovHeader = el('div', 'vb-setting-header', fovRow);
    const fovLabel = el('label', 'vb-label', fovHeader);
    fovLabel.textContent = 'BASE FIELD OF VIEW (FOV)';
    fovLabel.htmlFor = 'settings-fov-slider';
    const fovVal = el('span', 'vb-setting-val', fovHeader, 'settings-fov-val');
    const fovSlider = el('input', 'vb-slider', fovRow, 'settings-fov-slider');
    fovSlider.type = 'range';
    fovSlider.min = '65';
    fovSlider.max = '100';
    fovSlider.step = '1';
    fovSlider.setAttribute('aria-label', 'Field of View');
    fovSlider.setAttribute('aria-valuemin', '65');
    fovSlider.setAttribute('aria-valuemax', '100');

    // Resume button
    const resumeBtn = el('button', 'vb-btn vb-resume-btn', panel, 'settings-resume-btn');
    resumeBtn.type = 'button';
    resumeBtn.textContent = 'RESUME';

    const hint = el('div', 'vb-settings-hint', panel);
    hint.textContent = 'ESC TO RESUME';

    this.settingsDom = {
      root,
      panel,
      sensSlider,
      sensVal,
      volSlider,
      volVal,
      fovSlider,
      fovVal,
      resumeBtn,
    };

    const onSliderChange = () => {
      const sensitivity = Math.min(0.08, Math.max(0.005, parseFloat(sensSlider.value) || 0.03));
      const volume = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
      const fov = Math.min(100, Math.max(65, Math.round(parseFloat(fovSlider.value) || 75)));

      sensVal.textContent = (sensitivity * 100).toFixed(1);
      sensSlider.setAttribute('aria-valuenow', String(sensitivity));
      sensSlider.setAttribute('aria-valuetext', `${(sensitivity * 100).toFixed(1)} sensitivity`);

      volVal.textContent = `${Math.round(volume * 100)}%`;
      volSlider.setAttribute('aria-valuenow', String(volume));
      volSlider.setAttribute('aria-valuetext', `${Math.round(volume * 100)} percent`);

      fovVal.textContent = `${fov}°`;
      fovSlider.setAttribute('aria-valuenow', String(fov));
      fovSlider.setAttribute('aria-valuetext', `${fov} degrees`);

      this._settingsConfig = { sensitivity, volume, fov };

      this.savePref('vb-sens', sensitivity);
      this.savePref('vb-volume', volume);
      this.savePref('vb-fov', fov);

      if (typeof this._settingsOnChange === 'function') {
        this._settingsOnChange({ sensitivity, volume, fov });
      }
    };

    sensSlider.addEventListener('input', onSliderChange);
    volSlider.addEventListener('input', onSliderChange);
    fovSlider.addEventListener('input', onSliderChange);

    const doResume = () => {
      if (this._isClosingSettings) return;
      this._isClosingSettings = true;
      try {
        this.closeSettings();
        if (typeof this._settingsOnResume === 'function') {
          this._settingsOnResume();
        }
      } finally {
        this._isClosingSettings = false;
      }
    };

    resumeBtn.addEventListener('click', doResume);

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        doResume();
      }
    });

    this.syncSettingsUI();
    return root;
  }

  syncSettingsUI() {
    const d = this.settingsDom;
    if (!d.sensSlider) return;
    const cfg = this._settingsConfig;

    d.sensSlider.value = String(cfg.sensitivity);
    d.sensVal.textContent = (cfg.sensitivity * 100).toFixed(1);
    d.sensSlider.setAttribute('aria-valuenow', String(cfg.sensitivity));
    d.sensSlider.setAttribute('aria-valuetext', `${(cfg.sensitivity * 100).toFixed(1)} sensitivity`);

    d.volSlider.value = String(cfg.volume);
    d.volVal.textContent = `${Math.round(cfg.volume * 100)}%`;
    d.volSlider.setAttribute('aria-valuenow', String(cfg.volume));
    d.volSlider.setAttribute('aria-valuetext', `${Math.round(cfg.volume * 100)} percent`);

    d.fovSlider.value = String(cfg.fov);
    d.fovVal.textContent = `${cfg.fov}°`;
    d.fovSlider.setAttribute('aria-valuenow', String(cfg.fov));
    d.fovSlider.setAttribute('aria-valuetext', `${cfg.fov} degrees`);
  }

  /* ------------------------------------------------------------ buy menu */

  ensureBuyMenu() {
    if (this.buyDom.root) return this.buyDom.root;

    let root = document.getElementById('buy-menu');
    if (!root) {
      root = el('div', 'hidden', document.body, 'buy-menu');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-labelledby', 'buy-title');
      root.setAttribute('aria-hidden', 'true');
      this._ownedRoots.add(root);
    }

    root.innerHTML = '';
    root.style.display = 'none';

    const panel = el('div', 'vb-buy-panel', root);

    // Header
    const header = el('div', 'vb-buy-header', panel);

    const titlesBox = el('div', 'vb-buy-titles', header);
    const title = el('h2', 'vb-title', titlesBox, 'buy-title');
    title.textContent = 'ARMORY REQUISITION';
    const sub = el('div', 'vb-sub', titlesBox);
    sub.textContent = 'Tactical weapons procurement · Prep phase only';

    const metaBox = el('div', 'vb-buy-meta-row', header);

    const credMeta = el('div', 'vb-buy-meta-item', metaBox);
    el('span', 'vb-label', credMeta).textContent = 'CREDITS BALANCE';
    const credVal = el('span', 'vb-buy-credits-val', credMeta, 'buy-credits-val');
    credVal.textContent = '$ 800';

    const phaseMeta = el('div', 'vb-buy-meta-item', metaBox);
    el('span', 'vb-label', phaseMeta).textContent = 'STATUS';
    const phaseVal = el('span', 'vb-buy-phase-val', phaseMeta, 'buy-phase-val');
    phaseVal.textContent = 'PREP PHASE';

    const closeBtn = el('button', 'vb-buy-close-btn', metaBox, 'buy-close-btn');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕ CLOSE [ESC]';
    closeBtn.setAttribute('aria-label', 'Close Armory Requisition');

    // Weapons Grid
    const grid = el('div', 'vb-buy-grid', panel, 'buy-grid');
    const cards = {};

    WEAPON_BUY_ORDER.forEach((wid, idx) => {
      const def = WEAPONS[wid] || {};
      const price = WEAPON_PRICES[wid] || 0;
      const keyNum = idx + 1;

      const card = el('div', 'vb-buy-card', grid, `buy-card-${wid}`);
      card.dataset.wid = wid;

      const cardTop = el('div', 'vb-buy-card-top', card);
      const keyBadge = el('span', 'vb-buy-key-badge', cardTop);
      keyBadge.textContent = `[${keyNum}]`;

      const glyphBadge = el('span', `vb-buy-glyph-badge vb-w-${wid}`, cardTop);
      glyphBadge.textContent = GLYPH[wid] || wid.toUpperCase();

      const priceBadge = el('span', 'vb-buy-price-badge', cardTop, `buy-price-${wid}`);
      priceBadge.textContent = price > 0 ? `$${price.toLocaleString()}` : 'FREE';

      const cardBody = el('div', 'vb-buy-card-body', card);
      const nameEl = el('div', 'vb-buy-wname', cardBody);
      nameEl.textContent = WEAPON_NAMES[wid] || def.name || wid.toUpperCase();

      const classEl = el('div', 'vb-buy-wclass', cardBody);
      classEl.textContent = WEAPON_CLASSES[wid] || 'TACTICAL WEAPON';

      const statsEl = el('div', 'vb-buy-wstats', cardBody);
      const dmg = Array.isArray(def.damage) ? def.damage[0] : (def.damage || 0);
      const rpm = def.rpm || 0;
      const mag = def.magSize || 0;
      const reserve = def.reserveMax || 0;
      statsEl.textContent = `DMG ${dmg} · ${rpm ? `${rpm} RPM · ` : ''}${mag}/${reserve} RDS`;

      const cardBottom = el('div', 'vb-buy-card-bottom', card);
      const buyBtn = el('button', 'vb-btn vb-buy-btn', cardBottom, `buy-btn-${wid}`);
      buyBtn.type = 'button';
      buyBtn.textContent = `BUY $${price.toLocaleString()}`;
      buyBtn.dataset.wid = wid;

      buyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.triggerPurchase(wid);
      });

      cards[wid] = {
        card,
        priceBadge,
        buyBtn,
        price,
      };
    });

    const footer = el('div', 'vb-buy-footer', panel);
    const hint = el('span', 'vb-buy-footer-hint', footer);
    hint.textContent = 'PRESS [1-6] TO BUY · [ESC] TO CLOSE · UI UPDATES ON SERVER CONFIRMATION';
    this.buyDom = {
      root,
      panel,
      credVal,
      phaseVal,
      closeBtn,
      cards,
    };

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggleBuyMenu(false);
    });

    if (!this._onBuyKeyDown) {
      this._onBuyKeyDown = (e) => {
        if (!this._buyMenuOpen) return;

        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.toggleBuyMenu(false);
          return;
        }

        // Keys 1..6 or numpad 1..6
        let digitIdx = -1;
        if (e.code >= 'Digit1' && e.code <= 'Digit6') {
          digitIdx = parseInt(e.code.replace('Digit', ''), 10) - 1;
        } else if (e.code >= 'Numpad1' && e.code <= 'Numpad6') {
          digitIdx = parseInt(e.code.replace('Numpad', ''), 10) - 1;
        }

        if (digitIdx >= 0 && digitIdx < WEAPON_BUY_ORDER.length) {
          e.preventDefault();
          e.stopPropagation();
          const targetWid = WEAPON_BUY_ORDER[digitIdx];
          this.triggerPurchase(targetWid);
        }
      };
      document.addEventListener('keydown', this._onBuyKeyDown, true);
    }

    this.syncBuyMenuUI();
    return root;
  }

  setupBuyMenu({ onBuy, onClose } = {}) {
    this._buyMenuCallbacks = { onBuy, onClose };
    this.ensureBuyMenu();
  }

  setBuyMenuState({ open, phase, credits, owned } = {}) {
    if (phase !== undefined) this._buyMenuState.phase = phase;
    if (credits !== undefined) this._buyMenuState.credits = Number(credits) || 0;
    if (owned !== undefined) this._buyMenuState.owned = Array.isArray(owned) ? owned.slice() : [];

    const isSnd = this._latestMatch ? this._latestMatch.mode === 'snd' : true;
    const isPrep = this._buyMenuState.phase === 'prep';
    const isAlive = !this.dead && (this._latestSelfRow ? (this._latestSelfRow.hp > 0 && this._latestSelfRow.state !== 'dead') : true);

    const admitted = isSnd && isPrep && isAlive && !this._settingsOpen && !this.isLobbyOpen();
    if (open !== undefined) {
      if (open && admitted && !this._buyMenuOpen && !this._isClosingBuyMenu) {
        this.toggleBuyMenu(true);
      } else if ((!open || !admitted) && this._buyMenuOpen) {
        this.toggleBuyMenu(false);
      }
    } else if (this._buyMenuOpen && !admitted) {
      this.toggleBuyMenu(false);
    }

    this.syncBuyMenuUI();
  }

  toggleBuyMenu(force) {
    this.ensureBuyMenu();
    const shouldOpen = force !== undefined ? !!force : !this._buyMenuOpen;

    if (shouldOpen) {
      if (this._isClosingBuyMenu) return false;
      const isSnd = this._latestMatch ? this._latestMatch.mode === 'snd' : true;
      const phase = this._buyMenuState.phase;
      const isPrep = phase === 'prep';
      const isAlive = !this.dead && (this._latestSelfRow ? (this._latestSelfRow.hp > 0 && this._latestSelfRow.state !== 'dead') : true);

      if (!isSnd || !isPrep || !isAlive || this._settingsOpen || this.isLobbyOpen()) {
        return false;
      }

      this.closeSettings();
      this._buyMenuOpen = true;
      const root = this.buyDom.root;
      if (root) {
        root.classList.remove('hidden');
        root.style.display = 'flex';
        root.setAttribute('aria-hidden', 'false');
      }

      this._buyPreviousFocus = document.activeElement;
      this.syncBuyMenuUI();

      this.defer(() => {
        try {
          if (this._buyMenuOpen && this.buyDom.closeBtn) {
            this.buyDom.closeBtn.focus();
          }
        } catch (_) {}
      });

      return true;
    } else {
      if (this._isClosingBuyMenu) return false;
      const wasOpen = this._buyMenuOpen;
      this.closeBuyMenuDirect();
      if (wasOpen && this._buyMenuCallbacks && typeof this._buyMenuCallbacks.onClose === 'function') {
        this._isClosingBuyMenu = true;
        try {
          this._buyMenuCallbacks.onClose();
        } finally {
          this._isClosingBuyMenu = false;
        }
      }
      return false;
    }
  }

  closeBuyMenuDirect() {
    this._buyMenuOpen = false;
    if (this.buyDom.root) {
      this.buyDom.root.classList.add('hidden');
      this.buyDom.root.style.display = 'none';
      this.buyDom.root.setAttribute('aria-hidden', 'true');
    }
    const previousFocus = this._buyPreviousFocus;
    this._buyPreviousFocus = null;
    if (
      previousFocus &&
      !this.buyDom.root?.contains(previousFocus) &&
      typeof previousFocus.focus === 'function'
    ) {
      try { previousFocus.focus(); } catch (_) {}
    }
  }

  isBuyMenuOpen() {
    return !!this._buyMenuOpen;
  }

  triggerPurchase(wid) {
    if (!wid) return;
    const cardData = this.buyDom.cards && this.buyDom.cards[wid];
    if (!cardData) return;

    const isSnd = this._latestMatch ? this._latestMatch.mode === 'snd' : true;
    const isPrep = this._buyMenuState.phase === 'prep';
    const isAlive = !this.dead && (this._latestSelfRow ? (this._latestSelfRow.hp > 0 && this._latestSelfRow.state !== 'dead') : true);

    if (!isSnd || !isPrep || !isAlive || !this._buyMenuOpen) return;

    const credits = this._buyMenuState.credits;
    const price = cardData.price;

    if (credits < price) return;

    if (this._buyMenuCallbacks && typeof this._buyMenuCallbacks.onBuy === 'function') {
      this._buyMenuCallbacks.onBuy(wid);
    }
  }
  syncBuyMenuUI() {
    const d = this.buyDom;
    if (!d || !d.root) return;

    const credits = this._buyMenuState.credits;
    const owned = this._buyMenuState.owned || [];
    const phase = this._buyMenuState.phase;
    const isPrep = phase === 'prep';
    const isAlive = !this.dead && (this._latestSelfRow ? (this._latestSelfRow.hp > 0 && this._latestSelfRow.state !== 'dead') : true);

    if (d.credVal) {
      d.credVal.textContent = `$ ${Number(credits).toLocaleString()}`;
    }

    if (d.phaseVal) {
      d.phaseVal.textContent = isPrep ? 'PREP (BUY OPEN)' : 'CLOSED (LOCKED)';
      d.phaseVal.classList.toggle('is-open', isPrep);
      d.phaseVal.classList.toggle('is-closed', !isPrep);
    }

    if (d.cards) {
      for (const wid of WEAPON_BUY_ORDER) {
        const item = d.cards[wid];
        if (!item) continue;

        const isOwned = owned.includes(wid);
        const canAfford = credits >= item.price;
        const btn = item.buyBtn;
        const card = item.card;
        const weaponName = WEAPON_NAMES[wid] || wid.toUpperCase();

        card.classList.toggle('is-owned', isOwned);
        card.classList.toggle('is-unaffordable', !isOwned && !canAfford);
        card.classList.toggle('can-buy', !isOwned && canAfford && isPrep && isAlive);
        card.classList.toggle('is-locked', !isPrep || !isAlive);

        if (!isAlive) {
          btn.textContent = 'ELIMINATED';
          btn.disabled = true;
          btn.setAttribute('aria-disabled', 'true');
          btn.title = `Armory locked · Player eliminated (${weaponName})`;
        } else if (!isPrep) {
          btn.textContent = item.price > 0 ? `LOCKED · $${item.price.toLocaleString()}` : 'LOCKED · FREE';
          btn.disabled = true;
          btn.setAttribute('aria-disabled', 'true');
          btn.title = `Armory locked · ${weaponName} available during prep phase`;
        } else if (!canAfford) {
          btn.textContent = `NEED $${item.price.toLocaleString()}`;
          btn.disabled = true;
          btn.setAttribute('aria-disabled', 'true');
          btn.title = `Insufficient funds: need $${item.price.toLocaleString()} for ${weaponName} (balance $${credits.toLocaleString()})`;
        } else if (isOwned) {
          btn.textContent = item.price > 0 ? `REFILL $${item.price.toLocaleString()}` : 'REFILL FREE';
          btn.disabled = false;
          btn.setAttribute('aria-disabled', 'false');
          btn.title = item.price > 0 ? `Refill ammunition for ${weaponName} ($${item.price.toLocaleString()})` : `Refill free ammunition for ${weaponName}`;
        } else {
          btn.textContent = item.price > 0 ? `BUY $${item.price.toLocaleString()}` : 'CLAIM FREE';
          btn.disabled = false;
          btn.setAttribute('aria-disabled', 'false');
          btn.title = item.price > 0 ? `Purchase ${weaponName} for $${item.price.toLocaleString()}` : `Claim free ${weaponName}`;
        }
      }
    }
  }

  /* ----------------------------------------------------------- hud build */

  buildHUD() {
    for (const timer of this.killfeedTimers) clearTimeout(timer);
    this.killfeedTimers.clear();
    this.built = true;
    if (this.scopeRAF) { cancelAnimationFrame(this.scopeRAF); this.scopeRAF = 0; }
    if (this.flashRAF) { cancelAnimationFrame(this.flashRAF); this.flashRAF = 0; }
    if (this.dmgRAF) { cancelAnimationFrame(this.dmgRAF); this.dmgRAF = 0; }
    if (this.compassRAF) { cancelAnimationFrame(this.compassRAF); this.compassRAF = 0; }
    if (this.hmTimer) { clearTimeout(this.hmTimer); this.hmTimer = 0; }
    clearTimeout(this.deathImpactTimer);
    this.deathImpactTimer = 0;
    this.scopeShown = false;
    this.scopeProgress = 0;
    this.flashV = 0;
    this.painImpulse = 0;
    this.deathBrutality = 0;
    this.ringOn = false;
    this.compassW = 0;
    this.compassPPD = 2;
    this.compassZeroX = 720;
    this.compassMeasured = false;
    this.dmgActive.length = 0;
    this.dmgPool.length = 0;
    this.lastCritAt = -1e9;
    this.lastWepKey = '';
    this.names.clear();
    this.dom = {};
    this.matchDom = {};
    const hud = this.root('hud');
    hud.innerHTML = '';
    const d = this.dom;

    // Top Match Header (compact, authoritative scores/clock/phase)
    const matchHeader = el('div', 'vb-match-header', hud, 'match-header');
    this.matchDom.header = matchHeader;

    // Alpha Block (left)
    const alphaBlock = el('div', 'vb-match-team vb-team-alpha', matchHeader, 'match-team-alpha');
    const alphaLeft = el('div', 'vb-team-details', alphaBlock);
    const alphaName = el('div', 'vb-team-name', alphaLeft);
    alphaName.textContent = 'ALPHA';
    const alphaRole = el('div', 'vb-team-role', alphaLeft, 'match-alpha-role');
    alphaRole.textContent = '';
    const alphaScore = el('div', 'vb-team-score', alphaBlock, 'match-alpha-score');
    alphaScore.textContent = '0';
    this.matchDom.alphaBlock = alphaBlock;
    this.matchDom.alphaRole = alphaRole;
    this.matchDom.alphaScore = alphaScore;

    // Center Match Info (clock, phase, bomb status)
    const centerBlock = el('div', 'vb-match-center', matchHeader, 'match-center');
    const metaBar = el('div', 'vb-match-meta-bar', centerBlock);
    const modeBadge = el('span', 'vb-match-mode-chip', metaBar, 'match-mode-chip');
    modeBadge.textContent = 'SEARCH & DESTROY';
    const mapBadge = el('span', 'vb-match-map-chip', metaBar, 'match-map-chip');
    mapBadge.textContent = 'CITADEL';

    const clockBox = el('div', 'vb-match-clock-box', centerBlock);
    const clock = el('div', 'vb-match-clock', clockBox, 'match-clock');
    clock.textContent = '0:00';
    const phaseLabel = el('div', 'vb-match-phase-label', clockBox, 'match-phase-label');
    phaseLabel.textContent = 'PREP PHASE';

    const bombBanner = el('div', 'vb-match-bomb-banner', centerBlock, 'match-bomb-banner');
    bombBanner.style.display = 'none';

    this.matchDom.modeBadge = modeBadge;
    this.matchDom.mapBadge = mapBadge;
    this.matchDom.clock = clock;
    this.matchDom.phaseLabel = phaseLabel;
    this.matchDom.bombBanner = bombBanner;

    // Bravo Block (right)
    const bravoBlock = el('div', 'vb-match-team vb-team-bravo', matchHeader, 'match-team-bravo');
    const bravoScore = el('div', 'vb-team-score', bravoBlock, 'match-bravo-score');
    bravoScore.textContent = '0';
    const bravoRight = el('div', 'vb-team-details', bravoBlock);
    const bravoName = el('div', 'vb-team-name', bravoRight);
    bravoName.textContent = 'BRAVO';
    const bravoRole = el('div', 'vb-team-role', bravoRight, 'match-bravo-role');
    bravoRole.textContent = '';
    this.matchDom.bravoBlock = bravoBlock;
    this.matchDom.bravoRole = bravoRole;
    this.matchDom.bravoScore = bravoScore;

    // Interaction Progress (Hold E for Plant / Defuse)
    const interactBar = el('div', 'vb-interaction-bar', hud, 'interaction-bar');
    interactBar.style.display = 'none';
    const interactLabel = el('div', 'vb-interaction-label', interactBar, 'interaction-label');
    interactLabel.textContent = 'PLANTING BOMB...';
    const interactTrack = el('div', 'vb-interaction-track', interactBar);
    const interactFill = el('div', 'vb-interaction-fill', interactTrack, 'interaction-fill');
    const interactHint = el('div', 'vb-interaction-hint', interactBar);
    interactHint.textContent = 'HOLD [E]';

    this.matchDom.interactBar = interactBar;
    this.matchDom.interactLabel = interactLabel;
    this.matchDom.interactFill = interactFill;

    // Bottom Economy & S&D Carrier / Prompt Cluster
    const econCluster = el('div', 'vb-econ-cluster', hud, 'econ-cluster');
    const creditsBox = el('div', 'vb-hud-credits', econCluster, 'hud-credits');
    el('span', 'vb-hud-credits-label', creditsBox).textContent = 'CREDITS';
    const creditsVal = el('span', 'vb-hud-credits-val', creditsBox, 'hud-credits-val');
    creditsVal.textContent = '$ 800';

    const carrierBadge = el('div', 'vb-carrier-badge', econCluster, 'hud-carrier-badge');
    carrierBadge.textContent = 'BOMB CARRIER';
    carrierBadge.style.display = 'none';

    const buyPrompt = el('div', 'vb-buy-prompt', econCluster, 'hud-buy-prompt');
    buyPrompt.textContent = '[B] ARMORY OPEN';
    buyPrompt.style.display = 'none';

    this.matchDom.creditsBox = creditsBox;
    this.matchDom.creditsVal = creditsVal;
    this.matchDom.carrierBadge = carrierBadge;
    this.matchDom.buyPrompt = buyPrompt;

    // crosshair: exactly 4 arm children (dot comes from CSS ::after),
    // plus ring + caption nested so they inherit the screen-center origin.
    d.ch = el('div', '', hud, 'crosshair');
    for (let i = 0; i < 4; i++) el('span', 'ch-arm', d.ch);
    d.ring = el('div', 'vb-reload-ring', d.ch);
    d.ring.style.display = 'none';
    d.ringHint = el('div', '', d.ch, 'reload-hint');
    d.ringHint.textContent = 'RELOADING';
    d.ringHint.style.display = 'none';
    if (this.st.crosshairConeDeg != null) {
      this.setSpread(this.spreadFromCone(this.st.crosshairConeDeg));
    } else {
      this.setSpread(this.st.bloomPx);
    }

    // health bar
    d.hb = el('div', '', hud, 'healthbar');
    d.track = el('div', 'hp-track', d.hb);
    d.hpf = el('div', '', d.track, 'hpfill');

    // ammo cluster
    d.ammo = el('div', '', hud, 'ammo');
    d.mag = el('span', '', d.ammo, 'ammocount');
    d.sep = el('span', '', d.ammo);
    d.sep.textContent = '/';
    d.res = el('span', '', d.ammo, 'ammoreserve');
    d.wname = el('div', '', d.ammo, 'weaponname');

    d.kf = el('div', '', hud, 'killfeed');
    d.dmglayer = el('div', '', hud, 'dmglayer');

    // scoreboard (TAB-hold)
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

    // compass strip: three full duplicate cycles (-360..705) for seamless wrap
    d.compass = el('div', '', hud, 'compass');
    d.strip = el('div', '', d.compass, 'compassstrip');
    d.ticks = new Map();
    for (let deg = -360; deg < 720; deg += 15) {
      const norm = ((deg % 360) + 360) % 360;
      let cls = 'minor';
      let label = '';
      if (deg % 90 === 0) { cls = 'deg'; label = CARDINAL[norm]; }
      else if (deg % 45 === 0) { cls = 'deg'; label = String(norm); }
      const tick = el('span', cls, d.strip);
      tick.textContent = label;
      if (!d.ticks.has(norm)) d.ticks.set(norm, tick);
    }

    // Ensure settings & buy dialogs are ready
    this.ensureSettings();
    this.ensureBuyMenu();

    // TAB-hold scoreboard wiring
    if (!this.tabBound) {
      this.tabBound = true;
      this.onKD = (e) => {
        if (e.code === 'Tab') {
          e.preventDefault();
          this.setScoreboard(true);
        }
      };
      this.onKU = (e) => {
        if (e.code === 'Tab') {
          e.preventDefault();
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

  /* --------------------------------------------------- match state clock */

  setMatchState(match, selfRow, players, serverNow) {
    this._latestMatch = match || null;
    this._latestSelfRow = selfRow || null;
    this._latestPlayers = Array.isArray(players) ? players : [];

    const m = this.matchDom;
    if (!m.header) return;

    const curMode = match?.mode || 'fun';
    const curMap = match?.map || 'foundry';
    const phase = match?.phase || 'live';
    const isTeamMode = curMode === 'tdm' || curMode === 'snd';

    // Update Mode & Map Badges
    if (m.modeBadge) {
      m.modeBadge.textContent = MODE_LABELS[curMode] || curMode.toUpperCase();
    }
    if (m.mapBadge) {
      m.mapBadge.textContent = MAP_LABELS[curMap] || curMap.toUpperCase();
    }

    // Update Server Authoritative Clock
    const sNow = Number.isFinite(serverNow) && serverNow > 0 ? serverNow : Date.now();
    let clockText = '--:--';
    let isUrgentBomb = false;

    if (curMode === 'snd' && match?.bomb?.state === 'planted' && Number.isFinite(match.bomb.fuseEndsAt)) {
      const fuseRemSec = Math.max(0, (match.bomb.fuseEndsAt - sNow) / 1000);
      clockText = `${fuseRemSec.toFixed(1)}s`;
      isUrgentBomb = true;
    } else if (Number.isFinite(match?.phaseEndsAt)) {
      const remSec = Math.max(0, (match.phaseEndsAt - sNow) / 1000);
      clockText = formatClock(remSec);
    }

    if (m.clock) {
      m.clock.textContent = clockText;
      m.clock.classList.toggle('vb-clock-urgent', isUrgentBomb);
    }

    // Update Phase & Round Labels
    if (m.phaseLabel) {
      if (curMode === 'snd') {
        const roundNum = match?.round || 1;
        if (phase === 'prep') {
          m.phaseLabel.textContent = `ROUND ${roundNum} / 13 · PREP PHASE`;
        } else if (phase === 'post') {
          const rw = match?.roundWinner ? match.roundWinner.toUpperCase() : 'ROUND';
          m.phaseLabel.textContent = `ROUND ${roundNum} OVER · ${rw} WON`;
        } else {
          m.phaseLabel.textContent = `ROUND ${roundNum} / 13 · OBJECTIVE LIVE`;
        }
      } else if (curMode === 'tdm') {
        m.phaseLabel.textContent = phase === 'post' ? 'MATCH CONCLUDED' : 'TEAM DEATHMATCH · FIRST TO 40';
      } else {
        m.phaseLabel.textContent = 'INSTANT SKIRMISH · FREE FOR ALL';
      }
    }

    // Update Team Scores & Roles
    if (isTeamMode) {
      if (m.alphaBlock) m.alphaBlock.style.display = 'flex';
      if (m.bravoBlock) m.bravoBlock.style.display = 'flex';

      const alphaSc = match?.scores?.alpha ?? 0;
      const bravoSc = match?.scores?.bravo ?? 0;
      if (m.alphaScore) m.alphaScore.textContent = String(alphaSc);
      if (m.bravoScore) m.bravoScore.textContent = String(bravoSc);

      if (curMode === 'snd') {
        const alphaIsAttacker = match?.attackers === 'alpha';
        if (m.alphaRole) {
          m.alphaRole.textContent = alphaIsAttacker ? 'ATTACK' : 'DEFEND';
          m.alphaRole.className = `vb-team-role ${alphaIsAttacker ? 'vb-role-attack' : 'vb-role-defend'}`;
        }
        if (m.bravoRole) {
          m.bravoRole.textContent = alphaIsAttacker ? 'DEFEND' : 'ATTACK';
          m.bravoRole.className = `vb-team-role ${alphaIsAttacker ? 'vb-role-defend' : 'vb-role-attack'}`;
        }
      } else {
        if (m.alphaRole) m.alphaRole.textContent = '';
        if (m.bravoRole) m.bravoRole.textContent = '';
      }
    } else {
      if (m.alphaBlock) m.alphaBlock.style.display = 'none';
      if (m.bravoBlock) m.bravoBlock.style.display = 'none';
    }

    // S&D Bomb Status Banner
    if (m.bombBanner) {
      if (curMode === 'snd' && match?.bomb) {
        const b = match.bomb;
        m.bombBanner.style.display = 'block';
        m.bombBanner.className = `vb-match-bomb-banner state-${b.state || 'none'}`;

        if (b.state === 'carried') {
          m.bombBanner.textContent = 'BOMB: IN POSSESSION';
        } else if (b.state === 'dropped') {
          m.bombBanner.textContent = 'BOMB: DROPPED ON GROUND';
        } else if (b.state === 'planted') {
          m.bombBanner.textContent = `BOMB PLANTED AT SITE ${String(b.site || 'A').toUpperCase()}`;
        } else if (b.state === 'defused') {
          m.bombBanner.textContent = 'BOMB: DEFUSED (DEFENDERS WIN)';
        } else if (b.state === 'exploded') {
          m.bombBanner.textContent = 'BOMB: DETONATED (ATTACKERS WIN)';
        } else {
          m.bombBanner.textContent = 'BOMB OBJECTIVE';
        }
      } else {
        m.bombBanner.style.display = 'none';
      }
    }

    // Interaction Progress (Hold E)
    if (m.interactBar) {
      const isDead = this.dead || (selfRow && (selfRow.hp <= 0 || selfRow.state === 'dead'));
      const isPhaseValid = curMode === 'snd' && phase === 'live';
      const interaction = selfRow?.interaction;
      const progress = Number(interaction?.progress);
      const hasProgress = Number.isFinite(progress) && progress > 0;

      if (!isDead && isPhaseValid && interaction && hasProgress) {
        m.interactBar.style.display = 'block';
        const kind = String(interaction.kind || '').toLowerCase();
        const type = kind === 'plant' ? 'PLANTING BOMB' : (kind === 'defuse' ? 'DEFUSING BOMB' : 'INTERACTING');
        const site = interaction.site ? ` [SITE ${String(interaction.site).toUpperCase()}]` : '';
        if (m.interactLabel) {
          m.interactLabel.textContent = `${type}${site}...`;
        }
        if (m.interactFill) {
          const pct = clamp01(progress);
          m.interactFill.style.width = `${Math.round(pct * 100)}%`;
        }
      } else {
        m.interactBar.style.display = 'none';
        if (m.interactFill) {
          m.interactFill.style.width = '0%';
        }
      }
    }

    // Economy & Carrier State
    if (selfRow) {
      if (m.creditsBox) {
        m.creditsBox.style.display = curMode === 'snd' ? 'flex' : 'none';
      }
      if (m.creditsVal) {
        m.creditsVal.textContent = `$ ${Number(selfRow.credits || 0).toLocaleString()}`;
      }
      if (m.carrierBadge) {
        m.carrierBadge.style.display = (curMode === 'snd' && selfRow.bomb) ? 'inline-block' : 'none';
      }
      if (m.buyPrompt) {
        const canBuy = curMode === 'snd' && phase === 'prep' && !this.dead && selfRow.hp > 0 && selfRow.state !== 'dead';
        m.buyPrompt.style.display = canBuy ? 'block' : 'none';
      }

      // Sync buy menu state with authoritative snapshot
      this.setBuyMenuState({
        phase: match?.phase || 'live',
        credits: selfRow.credits || 0,
        owned: selfRow.owned || [],
      });
    } else {
      if (m.creditsBox) m.creditsBox.style.display = 'none';
      if (m.carrierBadge) m.carrierBadge.style.display = 'none';
      if (m.buyPrompt) m.buyPrompt.style.display = 'none';
      this.setBuyMenuState({
        open: false,
        phase: match?.phase || 'live',
        credits: 0,
        owned: [],
      });
    }

    // Update scoreboard
    if (this._latestPlayers) {
      this.setPlayers(this._latestPlayers);
    }
  }

  /* ---------------------------------------------------------- per-frame */

  setState(s) {
    Object.assign(this.st, s || {});
    if (!this.built) return;
    this.apply();
  }

  apply() {
    const s = this.st;
    const d = this.dom;
    if (!d.hpf) return;
    const alive = s.alive !== false && !this.dead;

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

    const key = this.resolveKey(s.wid);
    if (key && key !== this.lastWepKey) {
      const tint = WEAPON_IDS.includes(key) ? `vb-w-${key}` : '';
      d.wname.className = tint;
      d.ammo.className = tint;
      this.lastWepKey = key;
      this.updateAmmoLow();
    }

    if (s.crosshairConeDeg != null) {
      this.setSpread(this.spreadFromCone(s.crosshairConeDeg));
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
    magEl.classList.toggle('vb-low', Number.isFinite(mag) && mag <= Math.max(1, Math.round(def.magSize * 0.22)));
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
    const stress = alive ? Math.min(1, panic * 0.72 + pain * 0.82 + this.painImpulse * 0.48) : 0;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const amplitude = stress * (0.45 + this.painImpulse * 1.35);
    const jx = amplitude * Math.sin(now * 0.041 + pain * 5.1);
    const jy = amplitude * Math.sin(now * 0.053 + panic * 4.3 + 1.7);
    const pulse = stress * (0.5 + 0.5 * Math.sin(now * 0.019));
    ch.style.setProperty('--ch-jx', `${jx.toFixed(2)}px`);
    ch.style.setProperty('--ch-jy', `${jy.toFixed(2)}px`);
    ch.style.setProperty('--ch-rot', `${(jx * 0.85).toFixed(2)}deg`);
    ch.style.setProperty('--ch-arm-opacity', (0.78 + pulse * 0.22).toFixed(3));
    ch.style.setProperty('--ch-glow', `${(4 + stress * 7).toFixed(2)}px`);
  }

  hideCrosshairForAds(b) {
    if (!this.dom.ch) return;
    this.dom.ch.style.opacity = b ? '0' : '1';
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

  /* ------------------------------------------------------------- events */

  pushEvent(ev) {
    if (!ev || !this.built) return;
    switch (ev.kind) {
      case 'kill':
        this.killfeed(ev);
        break;
      case 'hit':
        this.hitmark(!!ev.hs);
        if (typeof ev.sx === 'number' && typeof ev.sy === 'number' && !ev.behind) {
          this.spawnDamage(ev.dmg, ev.sx, ev.sy, true, !!ev.hs);
        }
        break;
    }
  }

  killfeed(ev) {
    if (!ev) return;
    this.killRow({
      killer: this.nameFor(ev.killer),
      victim: this.nameFor(ev.victim),
      glyphKey: this.resolveKey(ev.w),
      hs: !!ev.hs,
    });
  }

  nameFor(id) {
    return this.names.get(String(id)) ?? String(id);
  }

  killRow(entry) {
    const kf = this.dom.kf;
    if (!kf) return;
    const row = el('div', entry.hs ? 'kf-row kf-hs' : 'kf-row');
    const k = el('b', '', row);
    k.textContent = entry.killer;
    const g = el('span', 'kf-w', row);
    g.textContent = GLYPH[entry.glyphKey] || '?';
    const v = el('span', '', row);
    v.textContent = entry.victim;
    if (typeof kf.insertBefore === 'function') {
      kf.insertBefore(row, kf.firstChild);
    } else {
      kf.appendChild(row);
    }
    while (kf.children.length > 5) {
      const oldest = kf.lastChild;
      if (oldest) oldest.remove();
    }
    const fadeTimer = setTimeout(() => {
      this.killfeedTimers.delete(fadeTimer);
      if (!row.isConnected) return;
      row.style.transition = 'opacity 300ms linear';
      row.style.opacity = '0';
      const removeTimer = setTimeout(() => {
        this.killfeedTimers.delete(removeTimer);
        row.remove();
      }, 320);
      this.killfeedTimers.add(removeTimer);
    }, 4000);
    this.killfeedTimers.add(fadeTimer);
  }

  hitmark(hs) {
    const hm = this.dom.hitmarker;
    if (!hm) return;
    clearTimeout(this.hmTimer);
    hm.classList.remove('vb-show', 'show', 'pop', 'on');
    void hm.offsetWidth;
    hm.classList.add('vb-show');
    hm.classList.toggle('vb-hs', !!hs);
    hm.classList.toggle('hs', !!hs);
    this.hmTimer = setTimeout(() => {
      hm.classList.remove('vb-show', 'show', 'pop', 'on', 'vb-hs', 'hs');
      this.hmTimer = 0;
    }, 210);
  }

  /* -------------------------------------------- own damage / death state */

  setOwnDamage(intensity01) {
    this.setPainImpulse(intensity01);
  }

  setPainImpulse(value) {
    const detail = value && typeof value === 'object' ? value : null;
    const raw = detail ? (detail.intensity ?? detail.value ?? detail.damage ?? 0) : value;
    const intensity = clamp01(raw);
    if (intensity === 0) {
      this.clearOwnDamage();
      return;
    }

    let x = detail ? Number(detail.x) : NaN;
    let y = detail ? Number(detail.y) : NaN;
    if (detail && Number.isFinite(Number(detail.angleDeg))) {
      const a = Number(detail.angleDeg) * Math.PI / 180;
      x = Math.sin(a);
      y = -Math.cos(a);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < 0.001) {
      this.painDirectionSeed = (this.painDirectionSeed + 137.508) % 360;
      const a = this.painDirectionSeed * Math.PI / 180;
      x = Math.cos(a);
      y = Math.sin(a);
    } else {
      const len = Math.hypot(x, y);
      x /= len;
      y /= len;
    }

    this.flashV = Math.max(this.flashV, intensity);
    this.painImpulse = Math.max(this.painImpulse, intensity);
    if (this.dom.flash) {
      this.dom.flash.style.setProperty('--pain-x', `${(50 + x * 48).toFixed(2)}%`);
      this.dom.flash.style.setProperty('--pain-y', `${(50 + y * 48).toFixed(2)}%`);
      this.dom.flash.style.setProperty('--pain-rotation', `${(Math.atan2(y, x) * 180 / Math.PI).toFixed(2)}deg`);
      this.dom.flash.style.opacity = String(this.flashV);
    }
    if (!this.built || this.flashRAF) return;

    let last = performance.now();
    const tick = () => {
      const nowT = performance.now();
      const dt = Math.min(0.12, (nowT - last) / 1000);
      last = nowT;
      this.flashV = Math.max(0, this.flashV * Math.exp(-dt * 6.5) - dt * 0.22);
      this.painImpulse = Math.max(0, this.painImpulse * Math.exp(-dt * 4.8) - dt * 0.1);
      if (this.dom.flash) this.dom.flash.style.opacity = Math.min(1, this.flashV).toFixed(3);
      this.updateCrosshairStress(this.st.panic, this.st.pain, !this.dead && this.st.alive !== false);
      if (this.flashV <= 0.001 && this.painImpulse <= 0.001) {
        this.flashV = 0;
        this.painImpulse = 0;
        if (this.dom.flash) this.dom.flash.style.opacity = '0';
        this.flashRAF = 0;
        return;
      }
      this.flashRAF = requestAnimationFrame(tick);
    };
    this.flashRAF = requestAnimationFrame(tick);
  }

  clearOwnDamage() {
    this.flashV = 0;
    this.painImpulse = 0;
    if (this.flashRAF) {
      cancelAnimationFrame(this.flashRAF);
      this.flashRAF = 0;
    }
    if (this.dom.flash) {
      this.dom.flash.style.opacity = '0';
    }
    this.updateCrosshairStress(this.st.panic, this.st.pain, !this.dead && this.st.alive !== false);
  }

  clearDamage() {
    this.clearOwnDamage();
    for (const rec of this.dmgActive) {
      if (rec && rec.node) {
        rec.node.style.opacity = '0';
        this.dmgPool.push(rec.node);
      }
    }
    this.dmgActive.length = 0;
    if (this.dmgRAF) {
      cancelAnimationFrame(this.dmgRAF);
      this.dmgRAF = 0;
    }
  }

  resetDamage() {
    this.clearDamage();
  }

  ensureDeathNote() {
    if (this.dom.deathnote) return this.dom.deathnote;
    const hud = this.root('hud');
    const dn = el('div', '', hud, 'deathnote');
    this.dom.deathnote = dn;
    return dn;
  }

  showDeathNote(killerName) {
    const dn = this.ensureDeathNote();
    dn.textContent = killerName ? `eliminated by ${killerName}` : 'eliminated';
    dn.style.display = 'block';
  }

  hideDeathNote() {
    const dn = this.dom.deathnote;
    if (dn) dn.style.display = 'none';
  }

  styleDeathTreatment(force) {
    const fx = this.dom.deathFx;
    if (!fx) return;
    const strength = clamp01(force);
    fx.style.setProperty('--death-opacity', (0.58 + strength * 0.18).toFixed(3));
    fx.style.setProperty('--death-blood-opacity', (0.38 + strength * 0.34).toFixed(3));
  }

  setDeathBrutality(value) {
    this.deathBrutality = clamp01(value);
    this.styleDeathTreatment(this.deathBrutality);
    if (this.dead && this.deathBrutality > 0) this.activateDeathTreatment();
  }

  activateDeathTreatment() {
    const fx = this.dom.deathFx;
    if (!fx) return;
    const force = this.deathBrutality || 0.85;
    this.deathBrutality = force;
    this.styleDeathTreatment(force);
    fx.classList.add('vb-active');
    fx.classList.remove('vb-impact');
    void fx.offsetWidth;
    fx.classList.add('vb-impact');
    clearTimeout(this.deathImpactTimer);
    this.deathImpactTimer = setTimeout(() => {
      this.deathImpactTimer = 0;
      if (this.dom.deathFx) this.dom.deathFx.classList.remove('vb-impact');
    }, 420);
  }

  resetDeathTreatment() {
    this.deathBrutality = 0;
    if (this.deathImpactTimer) {
      clearTimeout(this.deathImpactTimer);
      this.deathImpactTimer = 0;
    }
    if (this.dom.deathFx) {
      this.dom.deathFx.classList.remove('vb-active', 'vb-impact');
      this.styleDeathTreatment(0);
    }
  }

  setDead(dead, killerName = '') {
    this.dead = !!dead;
    if (!this.dead) this.resetDeathTreatment();
    else if (this.deathBrutality <= 0) this.deathBrutality = 0.85;
    if (this.dead) {
      this.closeBuyMenuDirect();
      if (this.matchDom?.interactBar) {
        this.matchDom.interactBar.style.display = 'none';
        if (this.matchDom.interactFill) {
          this.matchDom.interactFill.style.width = '0%';
        }
      }
    }
    if (!this.built) return;
    const d = this.dom;
    d.ch.classList.toggle('vb-dead', this.dead);
    if (this.dead) {
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
      this.setReloadProgress(null);
      this.clearOwnDamage();
      d.lowhp.style.opacity = '0';
      this.activateDeathTreatment();
      this.showDeathNote(killerName);
    } else {
      this.hideDeathNote();
      this.hideCrosshairForAds((Number(this.st.adsT01) || 0) > 0.35);
      this.updateCrosshairStress(this.st.panic, this.st.pain, this.st.alive !== false);
    }
  }

  /* ------------------------------------------------------ damage numbers */

  spawnDamage(amount, sx, sy, visible = true, hs = false) {
    if (!this.built || visible === false) return;
    const crit = !!hs;
    const now = performance.now();
    let jx = (Math.random() * 16 - 8);
    if (crit) {
      jx *= 1.8;
      if (now - this.lastCritAt < 280) jx += (Math.random() * 18 - 9);
      this.lastCritAt = now;
    }
    const rec = this.takeDmgNode();
    if (!rec) return;
    rec.node.textContent = String(Math.round(amount));
    rec.node.classList.toggle('vb-crit', crit);
    rec.node.style.opacity = '1';
    rec.sx = sx; rec.sy = sy; rec.jx = jx; rec.t0 = now;
    this.placeDmg(rec, 0);
    this.dmgActive.push(rec);
    if (!this.dmgRAF) this.dmgStep();
  }

  takeDmgNode() {
    const layer = this.dom.dmglayer;
    if (!layer) return null;
    if (this.dmgPool.length) {
      return { node: this.dmgPool.pop() };
    }
    if (layer.children.length < DMG_MAX_POOL) {
      return { node: el('div', 'dmgnum', layer) };
    }
    const old = this.dmgActive.shift();
    if (old) return { node: old.node };
    return null;
  }

  placeDmg(rec, e) {
    const rise = 46 * (1 - Math.pow(1 - e, 3));
    const drift = rec.jx * (1 - Math.pow(1 - e, 2));
    const skew = rec.node.classList.contains('vb-crit') ? ' skewX(-6deg)' : '';
    rec.node.style.transform = `translate3d(${rec.sx + drift}px,${rec.sy - rise}px,0)${skew}`;
  }

  dmgStep() {
    const tick = () => {
      const now = performance.now();
      for (let i = this.dmgActive.length - 1; i >= 0; i--) {
        const rec = this.dmgActive[i];
        const e = Math.min(1, (now - rec.t0) / DMG_MS);
        this.placeDmg(rec, e);
        rec.node.style.opacity = e > 0.62 ? String((1 - (e - 0.62) / 0.38).toFixed(3)) : '1';
        if (e >= 1) {
          this.dmgActive.splice(i, 1);
          rec.node.style.opacity = '0';
          this.dmgPool.push(rec.node);
        }
      }
      if (this.dmgActive.length) {
        this.dmgRAF = requestAnimationFrame(tick);
      } else {
        this.dmgRAF = 0;
      }
    };
    this.dmgRAF = requestAnimationFrame(tick);
  }

  /* ----------------------------------------------------------- scoreboard */

  setScoreboard(on) {
    const sb = this.dom.sb;
    if (!sb) return;
    sb.style.display = on ? 'block' : 'none';
  }

  setPlayers(arr) {
    const body = document.getElementById('scores');
    if (!body || !Array.isArray(arr)) return;

    for (const p of arr) {
      if (p && p.id != null) this.names.set(String(p.id), String(p.name || p.id));
    }

    const rows = arr.slice().sort((a, b) => {
      const scoreA = (a.score | 0);
      const scoreB = (b.score | 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return (b.kills | 0) - (a.kills | 0);
    });

    body.innerHTML = '';
    for (const p of rows) {
      const me = p.local === true;
      const dead = p.state === 'dead';
      const team = p.team === 'alpha' || p.team === 'bravo' ? p.team : null;

      const classes = [
        me ? 'vb-me' : '',
        dead ? 'dead' : '',
        team ? `vb-team-${team}` : '',
      ].filter(Boolean).join(' ');

      const tr = el('tr', classes);
      tr.dataset.pid = String(p.id ?? '');

      // Team badge cell
      const teamTd = el('td', 'vb-sb-team', tr);
      if (team) {
        const teamBadge = el('span', `vb-sb-team-badge vb-badge-${team}`, teamTd);
        teamBadge.textContent = team.toUpperCase();
      } else {
        teamTd.textContent = 'FFA';
      }

      el('td', '', tr).textContent = String(p.score | 0);
      el('td', '', tr).textContent = String(p.kills | 0);
      el('td', '', tr).textContent = String(p.deaths | 0);

      const nameTd = el('td', 'vb-sb-name', tr);
      nameTd.textContent = String(p.name || 'OPERATOR');
      if (p.bomb) {
        const bBadge = el('span', 'vb-sb-bomb-badge', nameTd);
        bBadge.textContent = '[BOMB]';
      }

      body.appendChild(tr);
    }
  }

  /* -------------------------------------------------------- sniper scope */

  ensureScope() {
    if (this.dom.scope) return this.dom.scope;
    const hud = this.root('hud');
    const sc = el('div', '', hud, 'sniper-scope');
    sc.style.pointerEvents = 'none';

    el('div', '', sc, 'scope-vignette');

    el('div', 'scope-line h', sc);
    el('div', 'scope-line v', sc);

    el('div', 'scope-duplex scope-duplex-left', sc);
    el('div', 'scope-duplex scope-duplex-right', sc);
    el('div', 'scope-duplex scope-duplex-top', sc);
    el('div', 'scope-duplex scope-duplex-bottom', sc);

    const rings = el('div', '', sc);
    rings.style.position = 'absolute';
    rings.style.inset = '0';
    rings.style.pointerEvents = 'none';

    // Mil estimation concentric rings
    for (const vmin of [22, 44]) {
      const r = el('div', '', rings);
      r.style.position = 'absolute';
      r.style.left = '50%';
      r.style.top = '50%';
      r.style.width = `${vmin}vmin`;
      r.style.height = `${vmin}vmin`;
      r.style.margin = `-${vmin / 2}vmin 0 0 -${vmin / 2}vmin`;
      r.style.borderRadius = '50%';
      r.style.border = '1px solid rgba(160, 185, 210, 0.18)';
    }

    // Horizontal mil dots / hash ticks
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

    // Vertical elevation drop ticks (below center)
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
    el('div', '', sc, 'scope-zoom-label').textContent = `${zoomVal.toFixed(1)}×`;
    el('div', 'scope-model-label', sc).textContent = 'LONGSHOT MK-II · OPTIC 5×42';

    this.dom.scope = sc;
    return sc;
  }

  setScope(on) {
    if (!this.built) return;
    if (on === this.scopeShown && (this.scopeRAF !== 0 || (on ? this.scopeProgress >= 1 : this.scopeProgress <= 0))) {
      return;
    }
    const sc = on ? this.ensureScope() : this.dom.scope;
    if (!sc) return;

    this.scopeShown = !!on;
    if (this.scopeRAF) {
      cancelAnimationFrame(this.scopeRAF);
      this.scopeRAF = 0;
    }

    if (this.scopeShown) {
      sc.classList.add('active');
      sc.classList.remove('exiting');
    } else {
      sc.classList.remove('active');
      if (this.scopeProgress > 0) {
        sc.classList.add('exiting');
      }
    }

    if (this.scopeShown && this.scopeProgress >= 1) {
      sc.style.opacity = '1';
      sc.style.transform = 'scale(1)';
      return;
    }
    if (!this.scopeShown && this.scopeProgress <= 0) {
      sc.classList.remove('exiting', 'active');
      sc.style.opacity = '';
      sc.style.transform = '';
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
      sc.style.opacity = p.toFixed(4);
      sc.style.transform = `scale(${scale.toFixed(4)})`;

      if (this.scopeShown && p >= 1) {
        this.scopeRAF = 0;
        sc.classList.remove('exiting');
        sc.classList.add('active');
        sc.style.opacity = '1';
        sc.style.transform = 'scale(1)';
      } else if (!this.scopeShown && p <= 0) {
        this.scopeRAF = 0;
        sc.classList.remove('exiting', 'active');
        sc.style.opacity = '';
        sc.style.transform = '';
      } else {
        this.scopeRAF = requestAnimationFrame(tick);
      }
    };

    this.scopeRAF = requestAnimationFrame(tick);
  }

  dispose() {
    if (this.scopeRAF) { cancelAnimationFrame(this.scopeRAF); this.scopeRAF = 0; }
    if (this.flashRAF) { cancelAnimationFrame(this.flashRAF); this.flashRAF = 0; }
    if (this.dmgRAF) { cancelAnimationFrame(this.dmgRAF); this.dmgRAF = 0; }
    if (this.compassRAF) { cancelAnimationFrame(this.compassRAF); this.compassRAF = 0; }
    if (this.hmTimer) { clearTimeout(this.hmTimer); this.hmTimer = 0; }
    if (this.deathImpactTimer) {
      clearTimeout(this.deathImpactTimer);
      this.deathImpactTimer = 0;
    }
    if (this._deferredTimers instanceof Set) {
      for (const timer of this._deferredTimers) clearTimeout(timer);
      this._deferredTimers.clear();
    } else {
      this._deferredTimers = new Set();
    }
    if (this.killfeedTimers instanceof Set) {
      for (const timer of this.killfeedTimers) clearTimeout(timer);
      this.killfeedTimers.clear();
    } else {
      this.killfeedTimers = new Set();
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
    if (this._onLobbyKeyDown) {
      if (doc) doc.removeEventListener('keydown', this._onLobbyKeyDown);
      this._onLobbyKeyDown = null;
    }
    if (this._onBuyKeyDown) {
      if (doc) doc.removeEventListener('keydown', this._onBuyKeyDown, true);
      this._onBuyKeyDown = null;
    }

    if (doc) this.hideLobby();
    else this._lobbyCallbacks = null;
    this.closeSettings();
    this.closeBuyMenuDirect();

    const ownedRoots = this._ownedRoots instanceof Set ? this._ownedRoots : new Set();
    const clearOrRemove = (root) => {
      if (!root) return;
      if (ownedRoots.has(root)) root.remove();
      else root.innerHTML = '';
    };
    clearOrRemove(doc ? doc.getElementById('menu') : null);
    clearOrRemove(doc ? doc.getElementById('hud') : null);
    clearOrRemove(this.lobbyDom?.root);
    clearOrRemove(this.buyDom?.root);
    clearOrRemove(this.settingsDom?.root);
    for (const root of ownedRoots) root.remove();
    ownedRoots.clear();
    this._ownedRoots = ownedRoots;

    this.onMenuAction = null;
    this._lobbyCallbacks = null;
    this._buyMenuCallbacks = null;
    this._settingsOnChange = null;
    this._settingsOnResume = null;
    this.joinStatus = null;
    this.lobbyDom = {};
    this.buyDom = {};
    this.settingsDom = {};
    this.dom = {};
    this.matchDom = {};
    this.st = {};
    this._buyMenuState = { phase: 'idle', credits: 0, owned: [] };
    this._latestMatch = null;
    this._latestSelfRow = null;
    this._latestPlayers = [];
    this._isClosingBuyMenu = false;
    this._isClosingSettings = false;
    this._buyMenuOpen = false;
    this._buyPreviousFocus = null;
    this._settingsOpen = false;
    this._settingsPreviousFocus = null;

    if (Array.isArray(this.dmgActive)) this.dmgActive.length = 0;
    else this.dmgActive = [];
    if (Array.isArray(this.dmgPool)) this.dmgPool.length = 0;
    else this.dmgPool = [];
    if (this.names instanceof Map) this.names.clear();
    else this.names = new Map();

    this.dead = false;
    this.flashV = 0;
    this.painImpulse = 0;
    this.painDirectionSeed = 0;
    this.deathBrutality = 0;
    this.scopeShown = false;
    this.scopeProgress = 0;
    this.ringOn = false;
    this.compassW = 0;
    this.compassPPD = 2;
    this.compassZeroX = 720;
    this.compassMeasured = false;
    this.lastCritAt = -1e9;
    this.lastWepKey = '';
    this.chGap = undefined;
    this.built = false;
  }
}
