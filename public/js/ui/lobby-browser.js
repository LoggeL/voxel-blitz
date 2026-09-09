import { cleanCode, el, MAP_LABELS, MAP_PREVIEWS, MODE_LABELS } from './hud-support.js';

/** Code entry and a read-only room directory. Admission remains server-owned. */
export class LobbyBrowser {
  constructor(parent, onJoin, onCreate) {
    this.onJoin = onJoin;
    this.lobbies = [];
    this.loaded = false;
    this.request = null;
    this.retry = null;
    this.returnFocus = null;
    this.dialog = el('dialog', 'vb-lobby-browser', parent, 'lobby-browser');
    this.dialog.setAttribute('aria-labelledby', 'lobby-browser-title');
    const topbar = el('div', 'vb-browser-topbar', this.dialog);
    const brand = el('span', 'vb-brand-lockup', topbar);
    el('span', 'vb-brand-voxel', brand).textContent = 'VOXEL';
    el('span', 'vb-brand-blitz', brand).textContent = 'BLITZ';
    const close = el('button', 'vb-btn', topbar, 'lobby-browser-close');
    close.type = 'button';
    close.textContent = '← MAIN MENU';
    close.addEventListener('click', () => this.dialog.close());
    const header = el('div', 'vb-browser-header', this.dialog);
    el('span', 'vb-step-kicker', header).textContent = 'MULTIPLAYER / ROOM DIRECTORY';
    el('h2', '', header, 'lobby-browser-title').textContent = 'FIND A LOBBY';

    el('p', '', header).textContent = 'Find your arena. Join the fight.';
    const content = el('div', 'vb-browser-content', this.dialog);
    const directory = el('section', 'vb-browser-directory', content);
    directory.setAttribute('aria-label', 'Available lobbies');
    const sidebar = el('aside', 'vb-browser-sidebar', content);
    const codeForm = el('form', 'vb-browser-code-form', sidebar);
    el('h3', '', codeForm).textContent = 'JOIN WITH CODE';
    el('p', 'vb-browser-aside-copy', codeForm).textContent = 'Have an invite? Enter your 5-character room code.';
    const codeLabel = el('label', 'vb-label', codeForm);
    codeLabel.textContent = 'ROOM CODE';
    codeLabel.htmlFor = 'join-code-input';
    const codeRow = el('div', 'vb-browser-code-row', codeForm);
    this.codeInput = el('input', '', codeRow, 'join-code-input');
    this.codeInput.maxLength = 5;
    this.codeInput.autocomplete = 'off';
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.spellcheck = false;
    this.codeInput.placeholder = 'ROOM CODE';
    this.codeInput.setAttribute('aria-describedby', 'lobby-browser-join-status');
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = cleanCode(this.codeInput.value);
      this.showJoinState('');
    });
    const codeJoin = el('button', 'vb-btn vb-browser-code-join', codeRow, 'join-lobby-btn');
    codeJoin.type = 'submit';
    codeJoin.textContent = 'JOIN';
    this.passwordOption = el('details', 'vb-password-option', codeForm);
    el('summary', '', this.passwordOption).textContent = 'This lobby has a password';
    const passwordLabel = el('label', '', this.passwordOption);
    el('span', '', passwordLabel).textContent = 'LOBBY PASSWORD';
    this.codePassword = el('input', '', passwordLabel, 'join-password-input');
    this.codePassword.type = 'password';
    this.codePassword.maxLength = 64;
    this.codePassword.autocomplete = 'off';
    this.codePassword.placeholder = 'Enter the lobby password';
    codeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = cleanCode(this.codeInput.value);
      if (code.length !== 5) {
        this.showJoinState(code ? 'ROOM CODE MUST BE 5 CHARACTERS' : 'ENTER 5-CHARACTER ROOM CODE', 'err');
        this.codeInput.focus();
        return;
      }
      this.join(code, this.codePassword.value, this.passwordOption.open);
    });
    this.joinStatus = el('div', 'vb-status vb-browser-join-status', sidebar, 'lobby-browser-join-status');
    this.joinStatus.setAttribute('role', 'status');
    this.joinStatus.setAttribute('aria-live', 'polite');

    const hostCard = el('div', 'vb-browser-host-card', sidebar);
    el('h3', '', hostCard).textContent = 'YOUR ARENA. YOUR RULES.';
    el('p', '', hostCard).textContent = 'Choose a map and mode, then bring your friends.';
    const create = el('button', 'vb-btn', hostCard, 'browser-create-lobby-btn');
    create.type = 'button';
    create.textContent = 'CREATE LOBBY';
    create.addEventListener('click', () => { this.dialog.close(); onCreate?.(); });
    const directoryHeader = el('div', 'vb-browser-directory-header', directory);
    el('h3', '', directoryHeader).textContent = 'AVAILABLE LOBBIES';
    this.refresh = el('button', 'vb-btn', directoryHeader, 'lobby-browser-refresh');
    this.refresh.type = 'button';
    this.refresh.textContent = 'REFRESH';
    this.refresh.addEventListener('click', () => void this.load());
    const filters = el('div', 'vb-browser-filters', directory);
    const searchLabel = el('label', '', filters);
    searchLabel.textContent = 'SEARCH';
    this.search = el('input', '', searchLabel, 'lobby-search-input');
    this.search.type = 'search';
    this.search.placeholder = 'Host, map or room code';
    const modeLabel = el('label', '', filters);
    modeLabel.textContent = 'GAME MODE';
    this.mode = el('select', '', modeLabel, 'lobby-mode-filter');
    for (const [value, text] of [['', 'All modes'], ...Object.entries(MODE_LABELS)]) {
      const option = el('option', '', this.mode); option.value = value; option.textContent = text;
    }
    const availableLabel = el('label', 'vb-browser-available', filters);
    this.available = el('input', '', availableLabel, 'lobby-available-filter');
    this.available.type = 'checkbox';
    el('span', '', availableLabel).textContent = 'Hide full rooms';
    this.search.addEventListener('input', () => this.renderResults());
    this.mode.addEventListener('change', () => this.renderResults());
    this.available.addEventListener('change', () => this.renderResults());
    this.status = el('p', 'vb-browser-status', directory);
    this.status.setAttribute('role', 'status');
    this.rows = el('div', 'vb-browser-rows', directory, 'lobby-browser-rows');
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return; // A queued close event must not cancel a newly reopened directory.
      this.request?.abort();
      this.rows.replaceChildren(); // Discard any password as soon as the dialog closes.
      this.codePassword.value = '';
      if (this.returnFocus?.isConnected) this.returnFocus.focus();
    });
  }

  show({ code, passwordRequired = false } = {}, returnFocus = document.activeElement) {
    this.retry = null;
    this.returnFocus = returnFocus;
    this.showJoinState('');
    if (code) this.codeInput.value = cleanCode(code);
    this.codePassword.value = '';
    this.passwordOption.open = passwordRequired;
    this.dialog.showModal();
    if (code) { this.codeInput.focus(); this.codeInput.select(); }
    else this.search.focus();
    void this.load();
  }

  showJoinState(message, tone = '') {
    this.joinStatus.textContent = message || '';
    this.joinStatus.classList.toggle('ok', tone === 'ok');
    this.joinStatus.classList.toggle('err', tone === 'err');
    this.codeInput.setAttribute('aria-invalid', String(tone === 'err'));
  }

  join(code, password, passwordRequired) {
    // Admission rebuilds the menu on failure. Keep the room for a retry, never its secret.
    this.retry = { code, passwordRequired };
    this.dialog.close();
    this.onJoin(code, password);
  }

  async load() {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const timeout = setTimeout(() => request.abort(), 8000);
    this.loaded = false;
    this.refresh.disabled = true;
    this.rows.replaceChildren();
    this.status.textContent = 'Looking for lobbies…';
    try {
      const response = await fetch('/api/lobbies', { cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error('Directory unavailable');
      const { lobbies } = await response.json();
      if (!Array.isArray(lobbies)) throw new Error('Invalid directory');
      if (this.request !== request || !this.dialog.open) return;
      this.lobbies = lobbies;
      this.loaded = true;
      this.renderResults();
    } catch (_) {
      if (this.request === request && this.dialog.open) {
        this.status.textContent = 'Could not load lobbies. Try refreshing.';
      }
    } finally {
      clearTimeout(timeout);
      if (this.request === request) this.refresh.disabled = false;
    }
  }

  renderResults() {
    if (!this.loaded) return;
    const query = this.search.value.trim().toLowerCase();
    const rooms = this.lobbies.filter((room) =>
      (!this.mode.value || room.gameMode === this.mode.value)
      && (!this.available.checked || room.players < room.capacity)
      && [room.host, room.code, MAP_LABELS[room.map] || room.map, MODE_LABELS[room.gameMode] || room.gameMode]
        .some((value) => String(value).toLowerCase().includes(query)));
    rooms.sort((a, b) => Number(a.players >= a.capacity) - Number(b.players >= b.capacity) || b.players - a.players);
    this.rows.replaceChildren();
    this.status.textContent = this.lobbies.length
      ? `${rooms.length} of ${this.lobbies.length} lobbies · Join a room below`
      : 'No lobbies yet. Create one and invite your friends.';
    if (!rooms.length) {
      const empty = el('div', 'vb-browser-empty', this.rows);
      el('span', 'vb-browser-empty-mark', empty).textContent = '⌕';
      el('h3', '', empty).textContent = this.lobbies.length ? 'NO MATCHING LOBBIES' : 'THE ARENA IS YOURS';
      el('p', '', empty).textContent = this.lobbies.length
        ? 'Try another search or change your filters.' : 'Start a lobby, share the code, and get a match going.';
      const action = el('button', 'vb-btn', empty);
      action.type = 'button';
      action.textContent = this.lobbies.length ? 'CLEAR FILTERS' : 'CREATE LOBBY';
      action.addEventListener('click', () => {
        if (!this.lobbies.length) { this.dialog.querySelector('#browser-create-lobby-btn').click(); return; }
        this.search.value = ''; this.mode.value = ''; this.available.checked = false; this.renderResults();
      });
    }
    for (const room of rooms) this.renderLobby(room);
  }

  renderLobby(lobby) {
    const row = el('form', 'vb-browser-room', this.rows);
    const preview = el('img', 'vb-browser-map', row);
    preview.src = MAP_PREVIEWS[lobby.map] || MAP_PREVIEWS.foundry;
    preview.alt = MAP_LABELS[lobby.map] || 'Arena';
    preview.loading = 'lazy';
    const info = el('div', 'vb-browser-room-info', row);
    el('h3', '', info).textContent = `${lobby.host}'s lobby`;
    el('p', '', info).textContent = `${MODE_LABELS[lobby.gameMode] || lobby.gameMode} · ${MAP_LABELS[lobby.map] || lobby.map}`;
    const meta = el('p', 'vb-browser-room-meta', info);
    el('span', '', meta).textContent = `${lobby.players}/${lobby.capacity} players`;
    const phase = el('span', 'vb-browser-phase', meta);
    phase.dataset.phase = lobby.phase;
    phase.textContent = lobby.phase === 'live' ? 'In progress' : 'Waiting';
    el('span', '', meta).textContent = lobby.passwordRequired ? 'Password required' : 'Open';
    let password = null;
    if (lobby.passwordRequired) {
      const label = el('label', 'vb-browser-password', row);
      el('span', '', label).textContent = 'Lobby password';
      password = el('input', '', label);
      password.type = 'password';
      password.maxLength = 64;
      password.required = true;
      password.autocomplete = 'off';
    }
    const join = el('button', 'vb-btn', row);
    join.type = 'submit';
    join.disabled = lobby.players >= lobby.capacity;
    join.textContent = join.disabled ? 'FULL' : 'JOIN';
    join.setAttribute('aria-label', `Join ${lobby.host}'s lobby`);
    row.addEventListener('submit', (event) => {
      event.preventDefault();
      if (join.disabled) return;
      const secret = password?.value || '';
      this.join(lobby.code, secret, lobby.passwordRequired);
    });
  }

  dispose() {
    this.request?.abort();
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
  }
}
