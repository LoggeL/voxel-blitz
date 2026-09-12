import { mountMusicControl } from './music-control.js';

const element = (tag, parent, text = '', className = '') => {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  parent.append(node);
  return node;
};

const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;
const EMAIL_MODES = ['forgot', 'reset', 'verify', 'email'];
const safeAccount = payload => ({ user: payload?.user ? {
  id: String(payload.user.id), username: String(payload.user.username),
} : null });

/** Optional account controls. Guest play never depends on this dialog. */
export class AccountMenu {
  constructor({ onChange = () => {}, onOpen = () => {} } = {}) {
    this.onChange = onChange;
    this.onOpen = onOpen;
    this.user = null;
    this.busy = false;
    this.loaded = false;
    this.disposed = false;
    this.requestVersion = 0;
    try { this.guestName = localStorage.getItem('vb-guest-name'); } catch (_) { this.guestName = null; }
    this.mode = 'login';
    this.warning = '';
    this.emailRecovery = { enabled: false, email: null, pendingEmail: null };
    this.emailToken = null;
    this.strip = null;
    this.dialog = element('dialog', document.body, '', 'vb-account-dialog');
    this.dialog.id = 'account-dialog';
    this.dialog.setAttribute('aria-labelledby', 'account-title');
    this.dialog.setAttribute('aria-describedby', 'account-description');
    this.dialog.setAttribute('aria-busy', 'false');
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('close', () => {
      this.recoveryCode = null;
      for (const input of this.dialog.querySelectorAll('#account-form input')) input.value = '';
      const recovery = this.dialog.querySelector('#account-recovery-code');
      if (recovery) recovery.textContent = '';
      if (this.returnFocus?.isConnected && this.returnFocus.getClientRects().length) this.returnFocus.focus();
      else document.getElementById('account-nav-open')?.focus();
    });
    this.onPagehide = event => { if (!event.persisted) this.dispose(); };
    window.addEventListener('pagehide', this.onPagehide);
    this.onHashchange = () => this.consumeEmailLink();
    window.addEventListener('hashchange', this.onHashchange);
    this.render();
  }

  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.mount();
    const menu = document.getElementById('menu');
    if (menu) {
      this.observer = new MutationObserver(() => this.mount());
      this.observer.observe(menu, { childList: true, subtree: true });
    }
    try { await this.refresh(); }
    catch (_) { this.loaded = true; this.mount(); }
    this.consumeEmailLink();
  }

  consumeEmailLink() {
    const match = /^#account-(reset|verify)=(.*)$/.exec(window.location.hash);
    if (!match || this.disposed || this.busy) return;
    this.emailToken = match[2];
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    this.open(match[1]);
  }

  mount() {
    if (this.disposed) return;
    const showcase = document.querySelector('#menu .vb-menu-showcase');
    if (!showcase) return;
    let strip = document.getElementById('account-strip');
    if (!strip) {
      strip = document.createElement('section');
      strip.className = 'vb-account-strip'; strip.id = 'account-strip';
      strip.setAttribute('aria-label', 'Optional player account');
      showcase.prepend(strip);
      element('span', strip, 'YOUR NEXT CHAPTER', 'vb-account-callout-kicker');
      const identity = element('div', strip);
      element('strong', identity).id = 'account-status';
      element('p', identity).id = 'account-summary';
      const button = element('button', strip, '', 'vb-account-button');
      button.id = 'account-open'; button.type = 'button';
      button.setAttribute('aria-haspopup', 'dialog');
      button.addEventListener('click', () => this.open(this.user ? 'account' : 'register'));
      const guest = element('button', strip, 'CONTINUE AS GUEST  ›', 'vb-account-guest-link');
      guest.id = 'menu-continue-guest'; guest.type = 'button';
      guest.addEventListener('click', () => document.getElementById('play-btn')?.click());
    }
    this.strip = strip;
    const accountNavigation = document.querySelector('#menu .vb-main-account-nav');
    if (accountNavigation && !document.getElementById('account-nav-open')) {
      const navButton = element('button', accountNavigation, '', 'vb-main-nav-button');
      this.navButton = navButton;
      navButton.id = 'account-nav-open'; navButton.type = 'button';
      navButton.setAttribute('aria-haspopup', 'dialog');
      navButton.addEventListener('click', () => this.open());
    }
    const playerIdentity = document.querySelector('#menu .vb-player-identity');
    if (playerIdentity && !document.getElementById('account-mobile-prompt')) {
      this.mobilePrompt = document.createElement('div');
      this.mobilePrompt.id = 'account-mobile-prompt'; this.mobilePrompt.className = 'vb-account-mobile-prompt';
      element('span', this.mobilePrompt, 'SAVE YOUR XP');
      const register = element('button', this.mobilePrompt, 'CREATE ACCOUNT', 'vb-account-button');
      register.id = 'account-mobile-open'; register.type = 'button'; register.setAttribute('aria-haspopup', 'dialog');
      register.addEventListener('click', () => this.open('register'));
      playerIdentity.before(this.mobilePrompt);
    }
    const mobilePrompt = document.getElementById('account-mobile-prompt');
    if (mobilePrompt) mobilePrompt.hidden = Boolean(this.user);
    strip.hidden = Boolean(this.user);
    const guest = document.getElementById('menu-continue-guest');
    if (guest) guest.hidden = Boolean(this.user);

    const setText = (id, value) => {
      const target = document.getElementById(id);
      if (target && target.textContent !== value) target.textContent = value;
    };
    setText('account-status', 'MAKE EVERY MATCH COUNT');
    setText('account-summary', 'Save your XP. Unlock your style. Keep your career across devices.');
    setText('account-open', 'CREATE ACCOUNT');
    setText('account-nav-open', this.user ? this.user.username : 'LOG IN');
    const navButton = document.getElementById('account-nav-open');
    if (navButton) {
      navButton.classList.toggle('is-signed-in', Boolean(this.user));
      navButton.setAttribute('aria-label', this.user ? `${this.user.username}, manage account` : 'LOG IN');
      navButton.title = this.user ? this.user.username : 'LOG IN';
    }
    const button = document.getElementById('account-open');
    if (button) button.disabled = this.busy;
    const nameInput = document.getElementById('name-input');
    if (nameInput) {
      if (!nameInput.dataset.accountWatched) {
        nameInput.dataset.accountWatched = 'true';
        nameInput.addEventListener('input', () => { if (!this.user) this.rememberGuest(); });
      }
      if (this.user) {
        if (this.guestName == null) this.rememberGuest();
        nameInput.value = this.user.username;
        nameInput.readOnly = true;
        nameInput.dataset.accountIdentity = 'true';
        nameInput.title = 'Your account username is your player name.';
      } else if (nameInput.dataset.accountIdentity || this.restoreGuest) {
        nameInput.readOnly = false;
        nameInput.value = this.guestName || '';
        delete nameInput.dataset.accountIdentity;
        nameInput.removeAttribute('title');
        this.restoreGuest = false;
        try { localStorage.setItem('vb-name', nameInput.value); } catch (_) {}
      }
    }
  }

  rememberGuest() {
    const nameInput = typeof document === 'undefined' ? null : document.getElementById('name-input');
    if (!nameInput || nameInput.readOnly) return;
    this.guestName = nameInput.value;
    try { localStorage.setItem('vb-guest-name', this.guestName); } catch (_) {}
  }

  open(mode = 'login') {
    if (this.disposed || this.busy) return;
    if (this.onOpen?.() === false) return;
    this.returnFocus = document.activeElement;
    this.mode = EMAIL_MODES.includes(mode) ? mode : this.user ? 'account' : (['login', 'register', 'recover'].includes(mode) ? mode : 'login');
    this.message = ''; this.recoveryCode = null;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
    this.refresh().catch(error => this.setStatus(error.message, true));
  }

  close() { this.dialog.close(); }

  focusFirst() {
    (this.dialog.querySelector('#account-form input:not([hidden])') || this.dialog.querySelector('#account-close'))?.focus();
  }

  async request(action = null, body = null) {
    const version = ++this.requestVersion;
    if (!this.user && (action === 'login' || action === 'register')) this.rememberGuest?.();
    try {
      const response = await fetch(action ? `/api/account/${action}` : '/api/account', {
        method: action ? 'POST' : 'GET', credentials: 'same-origin',
        ...(action ? { headers: { 'Content-Type': 'application/json', 'X-VB-Account': '1' }, body: JSON.stringify(body || {}) } : {}),
        signal: AbortSignal.timeout(8000),
      });
      let payload;
      try { payload = await response.json(); } catch (_) { throw new Error('Account service unavailable. Try again.'); }
      if (version !== this.requestVersion || this.disposed) return null;
      if (!response.ok) throw new Error(payload.error || 'Account request failed. Try again.');
      // Public reset requests carry no identity. Keep the current session intact.
      if (!Object.hasOwn(payload, 'user')) return { message: String(payload.message || '') };
      const account = safeAccount(payload);
      const previousId = this.user?.id || null;
      if (!account.user && (previousId || (!this.loaded && this.guestName != null))) this.restoreGuest = true;
      this.user = account.user;
      if (payload.emailRecovery) this.emailRecovery = payload.emailRecovery;
      else if (!account.user) this.emailRecovery = { ...this.emailRecovery, email: null, pendingEmail: null };
      this.loaded = true;
      this.warning = typeof payload.warning === 'string' ? payload.warning : '';
      this.mount();
      this.syncWarning?.();
      if (previousId !== (account.user?.id || null)) {
        this.onChange?.(account);
        window.dispatchEvent(new CustomEvent('vb-account-change', { detail: account }));
      }
      return { ...account, ...(payload.recoveryCode ? { recoveryCode: String(payload.recoveryCode) } : {}),
        ...(payload.message ? { message: String(payload.message) } : {}),
        ...(this.warning ? { warning: this.warning } : {}) };
    } catch (error) {
      if (version !== this.requestVersion || this.disposed) return null;
      if (error.name === 'TimeoutError') throw new Error('Account request timed out. Try again.');
      throw error;
    }
  }

  async refresh() {
    if (this.busy || this.disposed) return null;
    const previousUser = this.user?.id || null;
    const previousEmail = JSON.stringify(this.emailRecovery);
    const account = await this.request();
    const identityChanged = previousUser !== (this.user?.id || null);
    if (account && this.dialog.open && (identityChanged || previousEmail !== JSON.stringify(this.emailRecovery))) {
      if (identityChanged && !EMAIL_MODES.includes(this.mode)) this.mode = this.user ? 'account' : 'login';
      this.render(); this.focusFirst();
    }
    return account;
  }

  setStatus(text, error = false) {
    this.message = String(text || '');
    const status = this.dialog.querySelector('#account-feedback');
    if (status) { status.textContent = this.message; status.classList.toggle('is-error', error); }
  }

  syncWarning() {
    let warning = this.dialog.querySelector('#account-warning');
    if (!this.warning) { warning?.remove(); return; }
    if (!warning) {
      warning = element('p', this.dialog, '', 'vb-account-warning');
      warning.id = 'account-warning';
      warning.setAttribute('role', 'status');
      warning.setAttribute('aria-live', 'polite');
      this.dialog.querySelector('#account-feedback')?.after(warning);
    }
    warning.textContent = this.warning;
  }

  setBusy(value) {
    this.busy = value;
    this.dialog.setAttribute('aria-busy', String(value));
    for (const control of this.dialog.querySelectorAll('button:not(#account-close), #account-form input')) control.disabled = value || control.dataset.unavailable === 'true';
    this.mount();
  }

  async submit(action, body) {
    if (this.busy || this.disposed) return;
    if (['register', 'login', 'recover'].includes(action) && !USERNAME.test(body.username || '')) {
      this.setStatus('Use 3–20 letters, numbers, underscores or hyphens for your username.', true); return;
    }
    const password = ['password', 'recover', 'reset-password'].includes(action) ? body.newPassword
      : action === 'email' ? body.currentPassword : body.password;
    if (!['logout', 'forgot-password', 'verify-email'].includes(action) && (typeof password !== 'string' || [...password].length < 12 || [...password].length > 128)) {
      this.setStatus('Your password must contain 12–128 characters.', true); return;
    }
    this.setBusy(true);
    this.setStatus('Please wait…');
    try {
      const result = await this.request(action, body);
      if (!result) return;
      this.mode = action === 'forgot-password' ? 'forgot' : this.user ? 'account' : 'login';
      if (['reset-password', 'verify-email'].includes(action)) this.emailToken = null;
      this.recoveryCode = result.recoveryCode || null;
      this.message = result.message || (action === 'logout' ? 'Logged out. You can keep playing as a guest.'
        : action === 'password' ? 'Password changed.'
        : action === 'recover' ? 'Password reset. Save your new recovery code.'
        : `Signed in as ${result.user?.username || 'player'}.`);
      if (!this.dialog.open && this.recoveryCode) this.dialog.showModal();
      this.render(); this.focusFirst();
    } catch (error) { this.setStatus(error.message || 'Account service unavailable. Try again.', true); }
    finally { this.setBusy(false); }
  }

  render() {
    if (this.disposed) return;
    const dialog = this.dialog;
    dialog.replaceChildren();
    const header = element('header', dialog);
    element('span', header, 'VOXEL BLITZ / PLAYER ACCOUNT', 'vb-account-kicker');
    const close = element('button', header, 'BACK', 'vb-account-button');
    close.id = 'account-close'; close.type = 'button'; close.addEventListener('click', () => this.close());
    const titles = { login: 'Log in', register: 'Create an account', recover: 'Use a recovery code', account: 'Your account',
      forgot: 'Forgot your password?', reset: 'Set a new password', verify: 'Confirm your email', email: 'Recovery email' };
    element('h2', header, this.recoveryCode ? 'Save your recovery code' : titles[this.mode]).id = 'account-title';
    element('p', dialog, this.user ? `Signed in as ${this.user.username}. Your career is saved to this account.`
      : 'Accounts keep your XP, levels and purchases across devices. You can always play as a guest.').id = 'account-description';
    const feedback = element('p', dialog, this.message || '', 'vb-account-feedback');
    feedback.id = 'account-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    this.syncWarning();

    if (this.recoveryCode) { this.renderRecovery(); mountMusicControl(dialog); return; }
    if (!this.user && !EMAIL_MODES.includes(this.mode)) {
      const tabs = element('nav', dialog, '', 'vb-account-tabs');
      tabs.setAttribute('aria-label', 'Account action');
      for (const [mode, title] of [['login', 'LOG IN'], ['register', 'REGISTER'], ['recover', 'RECOVER']]) {
        const tab = element('button', tabs, title, 'vb-account-button');
        tab.type = 'button'; tab.id = `account-tab-${mode}`;
        tab.setAttribute('aria-pressed', String(mode === this.mode));
        tab.addEventListener('click', () => { if (this.busy) return; this.mode = mode; this.message = ''; this.render(); this.focusFirst(); });
      }
    }
    const form = element('form', dialog, '', 'vb-account-form');
    form.id = 'account-form';
    const field = (name, label, { autocomplete, type = 'text', minLength, maxLength, value, hint, required = true } = {}) => {
      const wrap = element('div', form, '', 'vb-account-field');
      const labelNode = element('label', wrap, label); labelNode.htmlFor = `account-${name}`;
      const input = element('input', wrap); input.id = `account-${name}`; input.name = name;
      input.type = type; input.required = required; input.autocomplete = autocomplete || 'off';
      if (minLength) input.minLength = minLength;
      if (maxLength) input.maxLength = maxLength;
      if (value) input.value = value;
      if (name === 'username') { input.pattern = '[A-Za-z0-9_\\-]{3,20}'; input.autocapitalize = 'none'; input.spellcheck = false; }
      if (name === 'recoveryCode') { input.autocapitalize = 'none'; input.spellcheck = false; }
      if (hint) { const note = element('small', wrap, hint); note.id = `${input.id}-hint`; input.setAttribute('aria-describedby', note.id); }
      return input;
    };
    if (EMAIL_MODES.includes(this.mode)) {
      this.renderEmailForm(form, field);
      mountMusicControl(dialog);
      return;
    }
    if (!this.user) {
      field('username', 'Username', { autocomplete: 'username', minLength: 3, maxLength: 20, hint: '3–20 letters, numbers, underscores or hyphens.' });
    } else {
      const username = element('input', form); username.name = 'username'; username.value = this.user.username;
      username.autocomplete = 'username'; username.type = 'text'; username.hidden = true;
    }
    if (this.mode === 'recover') field('recoveryCode', 'Recovery code', { maxLength: 128, hint: 'Enter the recovery code you saved when creating your account.' });
    if (this.mode === 'register' && this.emailRecovery.enabled) field('email', 'Recovery email (optional)', {
      type: 'email', autocomplete: 'email', maxLength: 254, required: false, hint: 'Confirm this address to reset a forgotten password by email.',
    });
    if (this.mode === 'account') field('currentPassword', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 });
    const changing = this.mode === 'account' || this.mode === 'recover';
    field(changing ? 'newPassword' : 'password', changing ? 'New password' : 'Password', {
      type: 'password', autocomplete: this.mode === 'login' ? 'current-password' : 'new-password', minLength: 12, maxLength: 256,
      hint: '12–128 characters.',
    });
    if (this.mode !== 'login') field('confirmPassword', 'Confirm password', { type: 'password', autocomplete: 'new-password', minLength: 12, maxLength: 256 });
    const labels = { login: 'LOG IN', register: 'CREATE ACCOUNT', recover: 'RESET PASSWORD', account: 'CHANGE PASSWORD' };
    const submit = element('button', form, labels[this.mode], 'vb-account-button is-primary');
    submit.id = 'account-submit'; submit.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.busy) return;
      const data = Object.fromEntries(new FormData(form));
      const password = data.newPassword || data.password;
      if (this.mode !== 'login' && data.confirmPassword !== password) { this.setStatus('The passwords do not match.', true); return; }
      delete data.confirmPassword;
      if (this.mode === 'register' && !data.email) delete data.email;
      if (this.mode === 'account') delete data.username;
      this.submit(this.mode === 'account' ? 'password' : this.mode, data);
    });
    if (this.user) {
      const recovery = this.emailRecovery;
      element('p', dialog, recovery.email ? `Recovery email: ${recovery.email}` : 'No recovery email added.');
      if (recovery.pendingEmail) element('p', dialog, `Awaiting confirmation: ${recovery.pendingEmail}`);
      if (recovery.enabled) {
        const email = element('button', dialog, 'MANAGE RECOVERY EMAIL', 'vb-account-button');
        email.type = 'button'; email.addEventListener('click', () => this.open('email'));
      }
      const logout = element('button', dialog, 'LOG OUT', 'vb-account-button');
      logout.type = 'button'; logout.id = 'account-logout';
      logout.addEventListener('click', () => this.submit('logout', {}));
    } else {
      const forgot = element('button', dialog, 'FORGOT PASSWORD? EMAIL A RESET LINK', 'vb-account-button');
      forgot.type = 'button'; forgot.id = 'account-forgot'; forgot.addEventListener('click', () => this.open('forgot'));
      const guest = element('button', dialog, 'CONTINUE AS GUEST', 'vb-account-button');
      guest.type = 'button'; guest.id = 'account-guest'; guest.addEventListener('click', () => this.close());
    }
    mountMusicControl(dialog);
  }

  renderEmailForm(form, field) {
    const mode = this.mode;
    const recovery = this.emailRecovery;
    const descriptions = {
      forgot: 'Enter the email address you confirmed for your account. We will send a link valid for 30 minutes.',
      reset: 'Choose a new password. All existing sessions will be signed out.',
      verify: 'Confirm this email address for account recovery. Opening the link alone makes no changes.',
      email: 'Confirm your current password to add or replace your recovery email. Your existing email stays active until you confirm the new address.',
    };
    element('p', form, descriptions[mode]);
    const unavailable = ['forgot', 'email'].includes(mode) && !recovery.enabled;
    if (unavailable) element('p', form, 'Email recovery is currently unavailable. You can still use your private recovery code.', 'vb-account-warning');
    if (mode === 'forgot' || mode === 'email') field('email', 'Email address', { type: 'email', autocomplete: 'email', maxLength: 254,
      value: mode === 'email' ? recovery.pendingEmail || recovery.email || '' : '' });
    if (mode === 'email') field('currentPassword', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 });
    if (mode === 'reset') {
      field('newPassword', 'New password', { type: 'password', autocomplete: 'new-password', minLength: 12, maxLength: 256, hint: '12–128 characters.' });
      field('confirmPassword', 'Confirm password', { type: 'password', autocomplete: 'new-password', minLength: 12, maxLength: 256 });
    }
    const labels = { forgot: 'SEND RESET LINK', reset: 'RESET PASSWORD', verify: 'CONFIRM EMAIL', email: 'SEND CONFIRMATION LINK' };
    const submit = element('button', form, labels[mode], 'vb-account-button is-primary');
    submit.type = 'submit'; submit.id = 'account-submit'; submit.disabled = unavailable;
    if (unavailable) submit.dataset.unavailable = 'true';
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.busy || unavailable) return;
      const data = Object.fromEntries(new FormData(form));
      if (mode === 'reset' && data.newPassword !== data.confirmPassword) { this.setStatus('The passwords do not match.', true); return; }
      delete data.confirmPassword;
      if (mode === 'reset' || mode === 'verify') data.token = this.emailToken || '';
      this.submit({ forgot: 'forgot-password', reset: 'reset-password', verify: 'verify-email', email: 'email' }[mode], data);
    });
    const back = element('button', this.dialog, this.user ? 'BACK TO ACCOUNT' : 'BACK TO LOG IN', 'vb-account-button');
    back.type = 'button'; back.addEventListener('click', () => this.open());
    if (!this.user) {
      const code = element('button', this.dialog, 'USE A RECOVERY CODE', 'vb-account-button');
      code.type = 'button'; code.addEventListener('click', () => this.open('recover'));
    }
    if (mode === 'reset') {
      const retry = element('button', this.dialog, 'REQUEST A NEW RESET LINK', 'vb-account-button');
      retry.type = 'button'; retry.addEventListener('click', () => this.open('forgot'));
    }
  }

  renderRecovery() {
    element('p', this.dialog, 'Save this code somewhere private now. It is shown only once and lets you reset your password even without access to a verified recovery email. Each recovery uses the code once and replaces it.', 'vb-account-recovery-note');
    const code = element('output', this.dialog, this.recoveryCode, 'vb-account-recovery-code');
    code.id = 'account-recovery-code'; code.setAttribute('aria-label', 'Private recovery code');
    const actions = element('div', this.dialog, '', 'vb-account-recovery-actions');
    const copy = element('button', actions, 'COPY CODE', 'vb-account-button');
    copy.type = 'button'; copy.id = 'account-copy-code';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this.recoveryCode); this.setStatus('Recovery code copied. Save it somewhere private.'); }
      catch (_) { this.setStatus('Select the code and copy it manually.', true); }
    });
    const download = element('button', actions, 'SAVE FILE', 'vb-account-button');
    download.type = 'button'; download.id = 'account-save-code';
    download.addEventListener('click', () => {
      const text = `Voxel Blitz recovery code\nUsername: ${this.user?.username || ''}\nServer: ${location.origin}\nRecovery code: ${this.recoveryCode}\n\nKeep this file private. Using this code once replaces it.\n`;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'voxel-blitz-recovery-code.txt';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.setStatus('Recovery file downloaded. Keep it private.');
    });
    const done = element('button', this.dialog, 'I SAVED THE CODE', 'vb-account-button is-primary');
    done.id = 'account-code-done'; done.type = 'button';
    done.addEventListener('click', () => { this.recoveryCode = null; this.render(); this.focusFirst(); });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.requestVersion++;
    this.emailToken = null;
    window.removeEventListener('hashchange', this.onHashchange);
    this.observer?.disconnect();
    window.removeEventListener('pagehide', this.onPagehide);
    this.recoveryCode = null;
    this.dialog.remove(); this.strip?.remove(); this.strip = null;
    this.navButton?.remove(); this.mobilePrompt?.remove();
  }
}
