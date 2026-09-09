import { el } from './hud-support.js';

function isAlive(player) {
  return player?.state !== 'dead' && player?.dead !== true && Number(player?.hp ?? 1) > 0;
}

/** Remaining lives in elimination rounds and cooperative waves. */
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
    const display = mode === 'snd' || mode === 'bastion' ? 'flex' : 'none';
    if (root.style.display !== display) root.style.display = display;
    if (mode !== 'snd' && mode !== 'bastion') {
      if (this._signature) root.innerHTML = '';
      this._signature = '';
      return;
    }
    const roster = Array.isArray(players) ? players.filter(Boolean) : [];
    const signature = JSON.stringify([mode, selfId,
      roster.map((p) => [p.id, p.name, p.team, isAlive(p), p.local])]);
    if (signature === this._signature) return;
    this._signature = signature;
    root.innerHTML = '';
    for (const team of mode === 'bastion' ? ['alpha'] : ['alpha', 'bravo']) {
      const members = roster.filter((p) => p.team === team);
      const group = el('div', `vb-player-status-group vb-player-team-${team}`, root);
      const aliveCount = members.reduce((total, player) => total + Number(isAlive(player)), 0);
      group.setAttribute('aria-label', `${team}, ${aliveCount} alive`);
      el('span', 'vb-player-status-summary', group).textContent = `${aliveCount} ALIVE`;
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
