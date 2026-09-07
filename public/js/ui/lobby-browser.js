import { cleanCode, el, MAP_LABELS, MODE_LABELS } from './hud-support.js';

/** Code entry and a read-only room directory. Admission remains server-owned. */
export class LobbyBrowser {
  constructor(parent, onJoin) {
    this.onJoin = onJoin;
    this.request = null;
    this.retry = null;
    this.returnFocus = null;
    this.dialog = el('dialog', 'vb-lobby-browser', parent, 'lobby-browser');
    this.dialog.setAttribute('aria-labelledby', 'lobby-browser-title');
    const header = el('div', 'vb-browser-header', this.dialog);
    el('h2', '', header, 'lobby-browser-title').textContent = 'FIND A LOBBY';

    const codeForm = el('form', 'vb-browser-code-form', this.dialog);
    const codeLabel = el('label', 'vb-label', codeForm);
    codeLabel.textContent = 'JOIN WITH CODE';
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
    this.joinStatus = el('div', 'vb-status vb-browser-join-status', this.dialog, 'lobby-browser-join-status');
    this.joinStatus.setAttribute('role', 'status');
    this.joinStatus.setAttribute('aria-live', 'polite');

    const directoryHeader = el('div', 'vb-browser-directory-header', this.dialog);
    el('h3', '', directoryHeader).textContent = 'OR BROWSE LOBBIES';
    this.refresh = el('button', 'vb-btn', directoryHeader, 'lobby-browser-refresh');
    this.refresh.type = 'button';
    this.refresh.textContent = 'REFRESH';
    this.refresh.addEventListener('click', () => void this.load());
    this.status = el('p', 'vb-browser-status', this.dialog);
    this.status.setAttribute('role', 'status');
    this.rows = el('div', 'vb-browser-rows', this.dialog, 'lobby-browser-rows');
    const close = el('button', 'vb-btn', this.dialog, 'lobby-browser-close');
    close.type = 'button';
    close.textContent = 'BACK';
    close.addEventListener('click', () => this.dialog.close());
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
    this.codeInput.focus();
    if (this.codeInput.value) this.codeInput.select();
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
    this.refresh.disabled = true;
    this.rows.replaceChildren();
    this.status.textContent = 'Looking for lobbies…';
    try {
      const response = await fetch('/api/lobbies', { cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error('Directory unavailable');
      const { lobbies } = await response.json();
      if (!Array.isArray(lobbies)) throw new Error('Invalid directory');
      if (this.request !== request || !this.dialog.open) return;
      this.status.textContent = lobbies.length
        ? `${lobbies.length} ${lobbies.length === 1 ? 'lobby' : 'lobbies'} · No room code needed`
        : 'No lobbies yet. Create one and invite your friends.';
      for (const lobby of lobbies) this.renderLobby(lobby);
    } catch (_) {
      if (this.request === request && this.dialog.open) {
        this.status.textContent = 'Could not load lobbies. Try refreshing.';
      }
    } finally {
      clearTimeout(timeout);
      if (this.request === request) this.refresh.disabled = false;
    }
  }

  renderLobby(lobby) {
    const row = el('form', 'vb-browser-room', this.rows);
    const info = el('div', 'vb-browser-room-info', row);
    el('h3', '', info).textContent = `${lobby.host}'s lobby`;
    el('p', '', info).textContent = `${MODE_LABELS[lobby.gameMode] || lobby.gameMode} · ${MAP_LABELS[lobby.map] || lobby.map}`;
    el('p', 'vb-browser-room-meta', info).textContent =
      `${lobby.players}/${lobby.capacity} players · ${lobby.phase === 'live' ? 'In progress' : 'Waiting'} · ${lobby.passwordRequired ? 'Password required' : 'Open'}`;
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
