import { el, MAP_LABELS, MODE_LABELS } from './hud-support.js';

/** A read-only room directory. Admission and password checks remain server-owned. */
export class LobbyBrowser {
  constructor(parent, onJoin) {
    this.onJoin = onJoin;
    this.request = null;
    this.dialog = el('dialog', 'vb-lobby-browser', parent, 'lobby-browser');
    this.dialog.setAttribute('aria-labelledby', 'lobby-browser-title');
    const header = el('div', 'vb-browser-header', this.dialog);
    el('h2', '', header, 'lobby-browser-title').textContent = 'FIND A LOBBY';
    this.refresh = el('button', 'vb-btn', header, 'lobby-browser-refresh');
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
      this.request?.abort();
      this.rows.replaceChildren(); // Discard any password as soon as the dialog closes.
    });
  }

  show() {
    this.dialog.showModal();
    void this.load();
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
      this.dialog.close();
      this.onJoin(lobby.code, secret);
    });
  }

  dispose() {
    this.request?.abort();
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
  }
}
