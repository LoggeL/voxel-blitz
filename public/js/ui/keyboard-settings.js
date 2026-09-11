import { el } from './hud-support.js';
import { KEYBINDING_ACTIONS, bindingLabel, setKeybinding, resetKeybindings, subscribeKeybindings } from '../keybindings.js';

/** Rebinding is captured before gameplay handlers and cancelled on dialog/tab exit. */
export class KeyboardSettings {
  constructor() {
    this.buttons = new Map();
    this.pending = null;
    this._capture = event => {
      if (!this.pending) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') { this.cancel(); this.status.textContent = 'Binding cancelled.'; return; }
      const result = setKeybinding(this.pending, event.code);
      if (!result.ok) { this.status.textContent = result.error; return; }
      const action = KEYBINDING_ACTIONS.find(item => item.id === this.pending);
      this.cancel();
      this.status.textContent = `${action.label}: ${bindingLabel(action.id)}. Saved.`;
    };
  }

  mount(parent) {
    const root = el('div', 'vb-keyboard-settings', parent);
    el('p', 'vb-settings-hint', root).textContent = 'Choose an action, then press its new key. Escape cancels. Clear a conflicting action before reusing its key. Bindings use physical key positions and are saved on this device.';
    el('p', 'vb-settings-hint', root).textContent = 'Mouse: left click fires, right click aims, wheel switches weapons or scope zoom. Escape always opens or closes menus.';
    this.status = el('p', 'vb-settings-hint', root, 'settings-keybinding-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    const reset = el('button', 'vb-btn', root, 'settings-keybindings-reset');
    reset.type = 'button';
    reset.textContent = 'RESET KEYBOARD DEFAULTS';
    reset.addEventListener('click', () => {
      this.cancel();
      resetKeybindings();
      this.status.textContent = 'Default keyboard bindings restored.';
    });
    for (const action of KEYBINDING_ACTIONS) {
      const row = el('div', 'vb-setting-row', root);
      const header = el('div', 'vb-setting-header', row);
      const label = el('span', 'vb-label', header, `binding-label-${action.id}`);
      label.textContent = action.label;
      const buttons = el('div', '', row);
      buttons.style.display = 'flex'; buttons.style.gap = '8px';
      const button = el('button', 'vb-btn', buttons, `settings-bind-${action.id}`);
      button.type = 'button'; button.style.flex = '1'; button.style.minWidth = '0';
      button.setAttribute('aria-label', `Change ${action.label} key`);
      button.setAttribute('aria-describedby', 'settings-keybinding-status');
      button.addEventListener('click', () => {
        this.cancel();
        this.pending = action.id;
        button.textContent = 'PRESS A KEY…';
        button.setAttribute('aria-pressed', 'true');
        this.status.textContent = `Press a key for ${action.label}. Escape cancels.`;
        document.addEventListener('keydown', this._capture, true);
      });
      const clear = el('button', 'vb-btn', buttons, `settings-clear-${action.id}`);
      clear.type = 'button'; clear.textContent = 'CLEAR';
      clear.style.width = 'auto'; clear.style.flexShrink = '0';
      button.style.fontSize = '12px'; button.style.letterSpacing = '0'; button.style.textIndent = '0';
      clear.style.fontSize = '12px'; clear.style.letterSpacing = '0'; clear.style.textIndent = '0';
      for (const control of [button, clear]) Object.assign(control.style, { margin: '0', color: '#e2e8ee', background: '#0b1218', border: '1px solid #8593a080', boxShadow: 'none' });
      clear.setAttribute('aria-label', `Clear ${action.label} key`);
      clear.addEventListener('click', () => {
        this.cancel();
        setKeybinding(action.id, null);
        this.status.textContent = `${action.label} has no keyboard binding.`;
      });
      this.buttons.set(action.id, button);
    }
    this._unsubscribe = subscribeKeybindings(() => this.sync());
    this.sync();
    return root;
  }

  sync() {
    for (const [id, button] of this.buttons) {
      button.textContent = id === this.pending ? 'PRESS A KEY…' : bindingLabel(id);
      button.setAttribute('aria-pressed', String(id === this.pending));
      button.style.background = id === this.pending ? '#ffcb57' : '#0b1218';
      button.style.color = id === this.pending ? '#15100b' : '#e2e8ee';
    }
  }

  cancel() {
    this.pending = null;
    if (typeof document !== 'undefined') document.removeEventListener('keydown', this._capture, true);
    this.sync();
  }

  dispose() { this.cancel(); this._unsubscribe?.(); this.buttons.clear(); }
}
