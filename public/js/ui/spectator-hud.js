import { el } from './hud-support.js';

/** Presentation-only spectator and respawn overlay. */
export class SpectatorHud {
  constructor() {
    this.dom = {};
    this.onCycle = null;
  }

  build(hud) {
    this.dom.root?.remove();
    const root = el('section', 'vb-spectator hidden', hud, 'spectator-overlay');
    root.setAttribute('aria-live', 'polite');

    const respawn = el('div', 'vb-spectator-respawn', root, 'spectator-respawn');
    const label = el('div', 'vb-spectator-label', root);
    label.textContent = 'SPECTATING';
    const target = el('div', 'vb-spectator-target', root, 'spectator-target');
    const hint = el('div', 'vb-spectator-hint', root, 'spectator-hint');

    const controls = el('div', 'vb-spectator-controls', root);
    const previous = el('button', 'vb-spectator-cycle', controls, 'spectator-previous');
    previous.type = 'button';
    previous.textContent = '‹ Q';
    previous.setAttribute('aria-label', 'Spectate previous player');
    const next = el('button', 'vb-spectator-cycle', controls, 'spectator-next');
    next.type = 'button';
    next.textContent = 'E ›';
    next.setAttribute('aria-label', 'Spectate next player');
    previous.addEventListener('click', () => this.onCycle?.(-1));
    next.addEventListener('click', () => this.onCycle?.(1));

    this.dom = { root, respawn, target, hint, controls, previous, next };
    return root;
  }

  setup({ onCycle } = {}) {
    this.onCycle = typeof onCycle === 'function' ? onCycle : null;
  }

  setState(state = {}) {
    const dom = this.dom;
    if (!dom.root) return;
    const active = state.active === true;
    dom.root.classList.toggle('hidden', !active);
    dom.respawn.textContent = String(state.respawnText || 'RESPAWNING');
    dom.target.textContent = state.hasTarget ? String(state.targetName || 'OPERATOR') : 'NO LIVING PLAYERS';
    dom.hint.textContent = state.hasTarget
      ? (state.teamOnly ? 'FOLLOWING LIVING TEAMMATE' : 'FOLLOWING LIVING PLAYER')
      : (state.teamOnly ? 'NO LIVING TEAMMATES' : 'WAITING FOR A LIVING PLAYER');
    dom.controls.style.display = state.canCycle ? 'flex' : 'none';
  }

  reset() {
    this.setState({ active: false });
  }

  dispose() {
    this.dom.root?.remove();
    this.dom = {};
    this.onCycle = null;
  }
}
