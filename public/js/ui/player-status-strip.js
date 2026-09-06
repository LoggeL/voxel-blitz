import { el } from './hud-support.js';

function isAlive(player) {
  return player?.state !== 'dead' && player?.dead !== true && Number(player?.hp ?? 1) > 0;
}

/** S&D remaining lives. Respawn modes do not need a permanent roster. */
export class PlayerStatusStrip {
  constructor() { this.root = null; this._signature = ''; }

  build(hud) {
    this.dispose();
    this.root = el('div', 'vb-player-status-strip is-team-mode', hud, 'player-status-strip');
    this.root.setAttribute('aria-label', 'Remaining team lives');
    return this.root;
  }

  update(players, mode, selfId) {
    const root = this.root;
    if (!root) return;
    root.style.display = mode === 'snd' ? 'flex' : 'none';
    const roster = mode === 'snd' && Array.isArray(players) ? players.filter(Boolean) : [];
    const signature = JSON.stringify([mode, selfId,
      roster.map((p) => [p.id, p.name, p.team, isAlive(p), p.local])]);
    if (signature === this._signature) return;
    this._signature = signature;
    root.innerHTML = '';
    if (mode !== 'snd') return;
    for (const team of ['alpha', 'bravo']) {
      const members = roster.filter((p) => p.team === team);
      const group = el('div', `vb-player-status-group vb-player-team-${team}`, root);
      group.setAttribute('aria-label', `${team}, ${members.filter(isAlive).length} alive`);
      el('span', 'vb-player-status-summary', group).textContent = `${members.filter(isAlive).length} ALIVE`;
      for (const player of members) {
        const alive = isAlive(player);
        const self = player.local === true || (selfId != null && String(player.id) === String(selfId));
        const card = el('div', `vb-player-status-card vb-player-team-${team} ${alive ? 'is-alive' : 'is-dead'}${self ? ' is-self' : ''}`, group);
        card.dataset.playerId = String(player.id);
        card.title = String(player.name || 'PLAYER');
        card.setAttribute('aria-label', `${card.title}, ${alive ? 'alive' : 'out'}`);
        const dot = el('span', 'vb-player-status-dot', card);
        dot.textContent = alive ? '●' : '×';
        dot.setAttribute('aria-hidden', 'true');
      }
    }
  }

  dispose() { this.root?.remove(); this.root = null; this._signature = ''; }
}
