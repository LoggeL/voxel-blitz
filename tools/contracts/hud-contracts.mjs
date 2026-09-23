import { MODE_IDS, GUN_GAME_WEAPON_ORDER } from '../../shared/modes.js';
import { makeSnapshot } from '../../server/protocol/snapshot.js';
import { WEAPONS } from '../../shared/combatmath.js';
import { combatDamage } from '../../shared/combat-balance.js';
import { ROCKET_RULES } from '../../shared/rocket-rules.js';
import { glaiveDiscSlots } from '../../public/js/ui/hud-support.js';
import { grenadePouchSlotFromVector } from '../../public/js/ui/grenade-pouch.js';

export async function runHudContracts(ok, installGlobals) {
  // HUD: just enough DOM to execute the shipped settings and scope paths.
  {
    class FakeEventTarget {
      constructor() {
        this.listeners = new Map();
      }
      addEventListener(type, fn) {
        let listeners = this.listeners.get(type);
        if (!listeners) this.listeners.set(type, listeners = new Set());
        listeners.add(fn);
      }
      removeEventListener(type, fn) {
        this.listeners.get(type)?.delete(fn);
      }
      dispatchEvent(event) {
        if (!event || !event.type) throw new Error('fake event requires a type');
        if (!event.target) event.target = this;
        event.currentTarget = this;
        for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event);
        this[`on${event.type}`]?.(event);
        return !event.defaultPrevented;
      }
      listenerCount(type) {
        if (type) return this.listeners.get(type)?.size || 0;
        let count = 0;
        for (const listeners of this.listeners.values()) count += listeners.size;
        return count;
      }
    }

    class FakeClassList {
      constructor(owner) {
        this.owner = owner;
      }
      add(...names) {
        for (const name of names) this.owner.classes.add(name);
      }
      remove(...names) {
        for (const name of names) this.owner.classes.delete(name);
      }
      contains(name) {
        return this.owner.classes.has(name);
      }
      toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : !!force;
        if (on) this.add(name);
        else this.remove(name);
        return on;
      }
    }

    class FakeStyle {
      setProperty(name, value) {
        this[name] = String(value);
      }
      getPropertyValue(name) {
        return this[name] || '';
      }
      removeProperty(name) {
        const old = this[name] || '';
        delete this[name];
        return old;
      }
    }

    class FakeElement extends FakeEventTarget {
      constructor(ownerDocument, tagName) {
        super();
        this.ownerDocument = ownerDocument;
        this.tagName = String(tagName).toUpperCase();
        this.parentNode = null;
        this.children = [];
        this.classes = new Set();
        this.classList = new FakeClassList(this);
        this.style = new FakeStyle();
        this.dataset = {};
        this.attributes = new Map();
        this._textContent = '';
        this._innerHTML = '';
        this.value = '';
        this.type = '';
        this.disabled = false;
        this.checked = false;
        this.clientWidth = 340;
        this._id = '';
      }
      dispatchEvent(event) {
        const allowed = super.dispatchEvent(event);
        if (!event.propagationStopped) this.parentNode?.dispatchEvent(event);
        return allowed;
      }
      set id(value) {
        if (this._id) this.ownerDocument.ids.delete(this._id);
        this._id = String(value || '');
        if (this._id) this.ownerDocument.ids.set(this._id, this);
      }
      get id() {
        return this._id;
      }
      set className(value) {
        this.classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
      }
      get className() {
        return [...this.classes].join(' ');
      }
      set textContent(value) {
        for (const child of this.children) child.parentNode = null;
        this.children.length = 0;
        this._textContent = String(value ?? '');
        this._innerHTML = '';
      }
      get textContent() {
        return this._textContent + this.children.map((child) => child.textContent).join('');
      }
      set innerHTML(value) {
        for (const child of this.children) child.parentNode = null;
        this.children.length = 0;
        this._textContent = '';
        this._innerHTML = String(value ?? '');
        const stack = [this];
        const tokens = this._innerHTML.match(/<[^>]+>|[^<]+/g) || [];
        for (const token of tokens) {
          if (token.startsWith('</')) {
            if (stack.length > 1) stack.pop();
            continue;
          }
          if (!token.startsWith('<')) {
            const text = token.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
            if (text) stack.at(-1)._textContent += text;
            continue;
          }
          if (/^<!/.test(token)) continue;
          const match = token.match(/^<\s*([a-zA-Z0-9-]+)([^>]*)>/);
          if (!match) continue;
          const child = this.ownerDocument.createElement(match[1]);
          const attrs = match[2];
          const attrRe = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
          let attr;
          while ((attr = attrRe.exec(attrs))) {
            child.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
          }
          stack.at(-1).appendChild(child);
          if (!/\/\s*>$/.test(token)
            && !/^(?:INPUT|BR|HR|IMG|META|LINK)$/.test(child.tagName)) {
            stack.push(child);
          }
        }
      }
      get innerHTML() {
        return this._innerHTML;
      }
      get parentElement() {
        return this.parentNode;
      }
      get options() {
        return this.children.filter((child) => child.tagName === 'OPTION');
      }
      get firstChild() {
        return this.children[0] ?? null;
      }
      get lastChild() {
        return this.children.at(-1) ?? null;
      }
      appendChild(child) {
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        this._innerHTML = '';
        return child;
      }
      insertBefore(child, referenceChild) {
        if (referenceChild === null) return this.appendChild(child);
        const referenceIndex = this.children.indexOf(referenceChild);
        if (referenceIndex < 0) {
          throw new Error('insertBefore reference is not a child');
        }
        if (child === referenceChild) return child;
        child.parentNode?.removeChild(child);
        const insertIndex = this.children.indexOf(referenceChild);
        child.parentNode = this;
        this.children.splice(insertIndex, 0, child);
        this._innerHTML = '';
        return child;
      }
      append(...children) {
        for (const child of children) {
          this.appendChild(typeof child === 'string'
            ? Object.assign(this.ownerDocument.createElement('span'), { textContent: child })
            : child);
        }
      }
      replaceChildren(...children) {
        for (const child of this.children) child.parentNode = null;
        this.children.length = 0;
        for (const child of children) this.appendChild(child);
      }
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      }
      remove() {
        this.parentNode?.removeChild(this);
      }
      contains(node) {
        return node === this || this.children.some((child) => child.contains(node));
      }
      setAttribute(name, value) {
        const text = String(value);
        this.attributes.set(name, text);
        if (name === 'id') this.id = text;
        else if (name === 'class') this.className = text;
        else if (name === 'value') this.value = text;
        else if (name === 'type') this.type = text;
        else if (name === 'disabled') this.disabled = true;
        else if (name.startsWith('data-')) {
          const key = name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
          this.dataset[key] = text;
        }
      }
      getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
      }
      hasAttribute(name) {
        return this.attributes.has(name);
      }
      removeAttribute(name) {
        if (!this.attributes.delete(name)) return;
        if (name === 'id') this.id = '';
        else if (name === 'class') this.className = '';
        else if (name === 'value') this.value = '';
        else if (name === 'type') this.type = '';
        else if (name === 'disabled') this.disabled = false;
        else if (name.startsWith('data-')) {
          const key = name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
          delete this.dataset[key];
        }
      }
      matches(selector) {
        return selector.split(',').some((part) => {
          const candidate = part.trim();
          const attrs = [...candidate.matchAll(/\[([^\]=]+)(?:=["']?([^"'\]]+)["']?)?\]/g)];
          const withoutAttrs = candidate.replace(/\[[^\]]+\]/g, '');
          const id = withoutAttrs.match(/#([\w-]+)/)?.[1];
          const classes = [...withoutAttrs.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
          const tag = withoutAttrs.match(/^[a-zA-Z][\w-]*/)?.[0];
          return (!id || this.id === id)
            && (!tag || this.tagName === tag.toUpperCase())
            && classes.every((name) => this.classList.contains(name))
            && attrs.every(([, name, expected]) => {
              const actual = this.getAttribute(name)
                ?? (name.startsWith('data-')
                  ? this.dataset[name.slice(5).replace(/-([a-z])/g,
                    (_all, letter) => letter.toUpperCase())]
                  : null);
              return actual != null && (expected === undefined || String(actual) === expected);
            });
        });
      }
      closest(selector) {
        for (let node = this; node; node = node.parentNode) {
          if (node.matches?.(selector)) return node;
        }
        return null;
      }
      querySelectorAll(selector) {
        const found = [];
        const visit = (node) => {
          for (const child of node.children) {
            if (child.matches(selector)) found.push(child);
            visit(child);
          }
        };
        visit(this);
        return found;
      }
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      }
      click() {
        if (!this.disabled) this.dispatchEvent({
          type: 'click',
          target: this,
          currentTarget: this,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
        });
      }
      focus() {
        this.ownerDocument.activeElement = this;
      }
      select() {}
      setSelectionRange() {}
      getBoundingClientRect() {
        return { left: 0, top: 0, width: this.clientWidth, height: 40 };
      }
    }

    class FakeDocument extends FakeEventTarget {
      constructor() {
        super();
        this.ids = new Map();
        this.hidden = false;
        this.activeElement = null;
        this.documentElement = new FakeElement(this, 'html');
        this.body = new FakeElement(this, 'body');
      }
      createElementNS(namespace, tagName) {
        const element = this.createElement(tagName);
        element.namespaceURI = namespace;
        return element;
      }
      createElement(tagName) {
        return new FakeElement(this, tagName);
      }
      getElementById(id) {
        return this.ids.get(id) || null;
      }
      querySelectorAll(selector) {
        const found = [];
        if (this.body.matches(selector)) found.push(this.body);
        return found.concat(this.body.querySelectorAll(selector));
      }
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      }
      execCommand() {
        return true;
      }
    }

    class FakeStorage {
      constructor(entries) {
        this.values = new Map(entries);
      }
      getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
      }
      setItem(key, value) {
        this.values.set(key, String(value));
      }
    }

    const document = new FakeDocument();
    const window = new FakeEventTarget();
    const localStorage = new FakeStorage([
      ['vb-sens-v2', '0.0021'],
      ['vb-volume', '0.42'],
      ['vb-fov', '86'],
    ]);
    let nowMs = 1000;
    let nextRaf = 1;
    const rafs = new Map();
    const requestAnimationFrame = (fn) => {
      const id = nextRaf++;
      rafs.set(id, fn);
      return id;
    };
    const cancelAnimationFrame = (id) => {
      rafs.delete(id);
    };
    const flushRaf = (limit = 40) => {
      for (let turn = 0; turn < limit && rafs.size; turn++) {
        const batch = [...rafs.values()];
        rafs.clear();
        nowMs += 50;
        for (const fn of batch) fn(nowMs);
      }
    };
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const timers = new Set();
    let timerCallbacksFired = 0;
    const setTimeout = (fn, delay = 0, ...args) => {
      let timer;
      timer = nativeSetTimeout(() => {
        timers.delete(timer);
        timerCallbacksFired++;
        fn(...args);
      }, delay);
      timers.add(timer);
      return timer;
    };
    const clearTimeout = (timer) => {
      timers.delete(timer);
      nativeClearTimeout(timer);
    };
    const event = (type, extra = {}) => ({
      type,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...extra,
    });

    const restore = installGlobals({
      document,
      window,
      localStorage,
      requestAnimationFrame,
      cancelAnimationFrame,
      setTimeout,
      clearTimeout,
      performance: { now: () => nowMs },
    });
    let hud = null;
    try {
      const { HUD } = await import('../../public/js/ui/hud.js');
      hud = new HUD();
      hud.openSettings();
      ok(document.getElementById('settings-sens-slider').value === '0.0021'
        && document.getElementById('settings-vol-slider').value === '0.42'
        && document.getElementById('settings-fov-slider').value === '86',
      'HUD settings controls show persisted sensitivity, volume, and FOV');
      hud.closeSettings();

      const changes = [];
      let resumes = 0;
      hud.setupSettings({
        sensitivity: 0.0028,
        volume: 0.55,
        fov: 91,
        onChange: (settings) => changes.push(settings),
        onResume: () => { resumes++; },
      });
      ok(localStorage.getItem('vb-sens-v2') === '0.0028'
        && localStorage.getItem('vb-volume') === '0.55'
        && localStorage.getItem('vb-fov') === '91',
      'HUD setup persists the complete settings triplet');

      document.getElementById('settings-sens-slider').value = '0.0047';
      document.getElementById('settings-sens-slider').dispatchEvent(event('input'));
      document.getElementById('settings-vol-slider').value = '0.63';
      document.getElementById('settings-vol-slider').dispatchEvent(event('input'));
      document.getElementById('settings-fov-slider').value = '98';
      document.getElementById('settings-fov-slider').dispatchEvent(event('input'));
      const lastChange = changes.at(-1);
      ok(changes.length === 3
        && lastChange.sensitivity === 0.0047
        && lastChange.volume === 0.63
        && lastChange.fov === 98
        && lastChange.adsMode === ''
        && lastChange.pointerMode === 'auto'
        && lastChange.aimAssist === true,
      'every HUD slider emits a full current settings object');

      // Device rows: desktop shows pointer/ADS rows, touch shows the layout rows, and a
      // live pad reveals its sensitivity; the trackpad hint follows detection.
      hud.setDeviceInfo({ touch: false, pointerKind: 'mouse', trackpadDetected: false, padActive: false });
      const rowShown = (row) => row.style.display !== 'none';
      const desktopRows = rowShown(document.getElementById('settings-pointer-mode').parentNode)
        && rowShown(document.getElementById('settings-ads-mode').parentNode)
        && !rowShown(document.getElementById('settings-pad-sens').parentNode)
        && !rowShown(document.getElementById('settings-touch-size').parentNode)
        && document.getElementById('settings-ads-mode-hint').textContent.startsWith('HOLD');
      hud.setDeviceInfo({ touch: false, pointerKind: 'trackpad', trackpadDetected: true, padActive: true });
      const trackpadRows = document.getElementById('settings-pointer-mode-hint').textContent === 'TRACKPAD DETECTED'
        && document.getElementById('settings-ads-mode-hint').textContent.startsWith('TOGGLE')
        && rowShown(document.getElementById('settings-pad-sens').parentNode)
        && rowShown(document.getElementById('settings-aim-assist').parentNode);
      hud.setDeviceInfo({ touch: true, pointerKind: 'mouse', trackpadDetected: false, padActive: false });
      const touchRows = !rowShown(document.getElementById('settings-pointer-mode').parentNode)
        && rowShown(document.getElementById('settings-touch-size').parentNode)
        && rowShown(document.getElementById('settings-touch-hand').parentNode)
        && rowShown(document.getElementById('settings-touch-sens').parentNode);
      document.getElementById('settings-ads-mode').value = 'toggle';
      document.getElementById('settings-ads-mode').dispatchEvent(event('change'));
      ok(desktopRows && trackpadRows && touchRows
        && changes.at(-1).adsMode === 'toggle'
        && localStorage.getItem('vb-ads-mode') === 'toggle',
      'settings shows device rows by capability and persists the ADS mode choice');
      hud.setDeviceInfo({ touch: false, pointerKind: 'mouse', trackpadDetected: false, padActive: false });
      ok(localStorage.getItem('vb-sens-v2') === '0.0047'
        && localStorage.getItem('vb-volume') === '0.63'
        && localStorage.getItem('vb-fov') === '98',
      'HUD slider changes persist all three live values');

      hud.openSettings();
      ok(hud.settingsOpen
        && document.getElementById('settings-overlay').style.display === 'flex'
        && document.getElementById('settings-overlay').getAttribute('aria-hidden') === 'false',
      'HUD settings open state makes the dialog visible and accessible');
      hud.closeSettings();
      ok(!hud.settingsOpen
        && document.getElementById('settings-overlay').style.display === 'none'
        && document.getElementById('settings-overlay').classList.contains('hidden'),
      'HUD closeSettings hides the dialog and clears its open state');

      hud.openSettings();
      document.getElementById('settings-resume-btn').dispatchEvent(event('click'));
      ok(!hud.settingsOpen && resumes === 1,
        'HUD resume button closes settings and invokes onResume once');
      hud.openSettings();
      const escape = event('keydown', { key: 'Escape' });
      document.getElementById('settings-overlay').dispatchEvent(escape);
      ok(!hud.settingsOpen
        && resumes === 2
        && escape.defaultPrevented
        && escape.propagationStopped,
      'HUD Escape resume closes, consumes the key, and invokes onResume once');

      const menuActions = [];
      hud.buildMenu((action) => menuActions.push(action));
      document.getElementById('name-input').value = 'HOST';
      ok(document.getElementById('play-btn').disabled === true
        && document.getElementById('menu-load-bar').hidden === false,
      'menu play actions stay gated behind the asset load bar until the match set is ready');
      hud.menu.setPlayReady(true);
      document.getElementById('create-lobby-btn').click();
      ok(menuActions.length === 1 && menuActions[0].mode === 'create'
        && menuActions[0].name === 'HOST',
      'HUD creates the lobby immediately from the main menu');
      const edits = [];
      hud.showLobby({ code: 'ABCDE', selfId: 'host', host: 'host', phase: 'waiting',
        gameMode: 'fun', map: 'foundry', bots: 3,
        members: [{ id: 'host', name: 'HOST', ready: false, bot: false }],
      }, { onConfigure: (settings) => edits.push(settings) });
      const modeSelect = document.getElementById('game-mode-select');
      const mapSelect = document.getElementById('map-select');
      ok(modeSelect.options.map((option) => option.value).join(',') === MODE_IDS.join(','),
        'Waiting lobby exposes all modes');
      modeSelect.value = 'snd';
      modeSelect.dispatchEvent(event('change'));
      ok(!mapSelect.options.some((option) => option.value === 'depot')
        && edits.at(-1).gameMode === 'snd', 'Host sends settings with compatible maps');
      modeSelect.value = 'training';
      modeSelect.dispatchEvent(event('change'));
      ok(mapSelect.value === 'killhouse' && edits.at(-1).bots === 0,
        'Training configuration selects Killhouse without bots');
      hud.hideLobby();
      hud.buildMenu((action) => menuActions.push(action));
      hud.menu.setPlayReady(true);
      document.getElementById('play-btn').click();
      ok(menuActions.length === 2 && menuActions[1].mode === 'quick'
        && !Object.hasOwn(menuActions[1], 'gameMode'), 'Quick Play keeps server map rotation');

      document.getElementById('training-btn').click();
      const trainingAction = menuActions.at(-1);
      ok(trainingAction.mode === 'create' && trainingAction.gameMode === 'training'
        && trainingAction.map === 'killhouse' && trainingAction.bots === 0
        && trainingAction.directStart === true
        && trainingAction.name === document.getElementById('name-input').value,
      'the main-menu Killhouse entry starts solo training with the current identity and no combat bots');

      const lobbyState = {
        code: 'ZX9Q2',
        host: 17,
        selfId: 17,
        phase: 'waiting',
        bots: 1,
        gameMode: 'snd',
        map: 'citadel',
        members: [
          { id: 17, name: 'HOST', ready: true, bot: false, team: 'alpha' },
        ],
      };
      const inviteLocation = Object.freeze({
        origin: 'https://play.voxel.test',
        pathname: '/arena/index.html',
        search: '?stale=query',
        hash: '#stale-hash',
      });
      const restoreLocation = installGlobals({ location: inviteLocation });
      try {
        hud.showLobby(lobbyState, {
          onReady() {},
          onStart() {},
          onLeave() {},
        });
        ok(/search|destroy|s&d/i.test(document.getElementById('lobby-mode-val').textContent)
          && /citadel/i.test(document.getElementById('lobby-map-val').textContent),
        'HUD lobby renders immutable mode and map identity chips');
        ok(globalThis.location === inviteLocation
          && document.getElementById('lobby-invite-input').value
            === 'https://play.voxel.test/arena/index.html?lobby=ZX9Q2',
        'HUD lobby derives the exact absolute invite from origin and path only');
      } finally {
        restoreLocation();
      }
      hud.updateLobby({ ...lobbyState, gameMode: 'tdm', map: 'depot' });
      ok(document.getElementById('lobby-invite-input').value === '?lobby=ZX9Q2'
        && /team|deathmatch|tdm/i.test(document.getElementById('lobby-mode-val').textContent)
        && /depot/i.test(document.getElementById('lobby-map-val').textContent),
      'HUD lobby chips update when a replacement lobby state arrives');

      hud.hideLobby();

      hud.buildHUD();
      {
        // Grenade hints follow custom bindings through device changes, and a
        // rebind keeps the pad labels while a pad is active.
        const { setKeybinding, resetKeybindings } = await import('../../public/js/keybindings.js');
        const grenadeKey = document.querySelector('.vb-grenade-key');
        const pouchKey = document.querySelector('.vb-grenade-pouch-key');
        const pouchHint = document.querySelector('.vb-grenade-pouch');
        const mouse = { touch: false, pointerKind: 'mouse', trackpadDetected: false, padActive: false };
        setKeybinding('grenade', 'KeyU');
        setKeybinding('grenadeType', 'KeyY');
        hud.setDeviceInfo(mouse);
        const keyboardLabels = grenadeKey.textContent === 'U'
          && pouchKey.textContent === 'Y'
          && pouchHint.title === 'Tap Y for the next grenade, hold for the pouch';
        hud.setDeviceInfo({ ...mouse, padActive: true });
        setKeybinding('grenade', 'KeyI');
        const padLabels = grenadeKey.textContent === 'RB' && pouchKey.textContent === 'D▼';
        hud.setDeviceInfo(mouse);
        resetKeybindings();
        ok(keyboardLabels && padLabels && grenadeKey.textContent === 'G' && pouchKey.textContent === 'H',
          'grenade key hints follow custom bindings across device changes and keep pad labels on rebind');
      }
      hud.setState({ wid: 'sniper', adsT01: 0.7199, alive: true, hp: 100 });
      ok(!document.getElementById('sniper-scope'),
        'sniper scope stays absent immediately below the ADS threshold');
      hud.setState({ adsT01: 0.72 });
      ok(document.getElementById('sniper-scope').classList.contains('active'),
        'sniper scope enters exactly at the ADS threshold');
      flushRaf();
      ok(document.getElementById('sniper-scope').style.opacity === '1'
        && !document.getElementById('sniper-scope').classList.contains('exiting'),
      'sniper scope is fully active without a second animation clock');

      hud.setState({ adsT01: 0.7199 });
      ok(!document.getElementById('sniper-scope').classList.contains('active')
        && !document.getElementById('sniper-scope').classList.contains('exiting'),
      'dropping below the threshold removes the scope immediately');
      flushRaf();
      ok(!document.getElementById('sniper-scope').classList.contains('active')
        && !document.getElementById('sniper-scope').classList.contains('exiting')
        && document.getElementById('sniper-scope').style.opacity === ''
        && document.getElementById('sniper-scope').style.transform === '',
      'scope exit removes transition classes and inline animation residue');

      hud.setState({ adsT01: 0.9, alive: true });
      flushRaf();
      hud.setState({ alive: false });
      ok(document.getElementById('crosshair').classList.contains('vb-dead'),
        'live-to-dead state immediately suppresses the scope and marks the crosshair dead');
      flushRaf();
      ok(!document.getElementById('sniper-scope').classList.contains('active')
        && !document.getElementById('sniper-scope').classList.contains('exiting'),
      'live-to-dead scope exit leaves no active or exiting class');

      hud.setState({ alive: true, adsT01: 0.2 });
      hud.setDead(true, 'RIVAL');
      ok(document.getElementById('crosshair').classList.contains('vb-dead')
        && document.getElementById('deathnote').textContent === 'eliminated by RIVAL'
        && document.getElementById('deathnote').style.display === 'block',
      'explicit death state shows the killer note and dead crosshair');
      hud.setDead(false);
      hud.setState({ alive: true });
      ok(!document.getElementById('crosshair').classList.contains('vb-dead')
        && document.getElementById('deathnote').style.display === 'none',
      'HUD revival clears explicit death presentation');

      hud.setDead(true, 'RIVAL', 'HORNET SMG · 8 M · KILLER AT 41 HP');
      const recapShown = document.getElementById('deathnote').textContent === 'eliminated by RIVAL'
        && document.getElementById('deathrecap')?.textContent === 'HORNET SMG · 8 M · KILLER AT 41 HP'
        && document.getElementById('deathrecap').style.display === 'block';
      hud.setDead(false);
      ok(recapShown && document.getElementById('deathrecap').style.display === 'none',
        'death recap line shows under the note and hides with revival');

      hud.hitmark('kill');
      const killShown = document.getElementById('hitmarker').classList.contains('vb-kill')
        && document.getElementById('hitmarker').classList.contains('vb-show')
        && !document.getElementById('hitmarker').classList.contains('vb-hs');
      hud.hitmark(false);
      ok(killShown && document.getElementById('hitmarker').classList.contains('vb-kill'),
        'a kill mark is distinct and a trailing body hit cannot downgrade it');

      hud.setPainImpulse({ intensity: 0.8, angleDeg: 90 });
      const hitFlash = document.getElementById('hitflash');
      const flashShown = Number(hitFlash.style.opacity) === 0.8
        && hitFlash.style.getPropertyValue('--pain-x') === '98.00%';
      hud.spawnDamage(25, 100, 100, true, false, 'target');
      hud.spawnDamage(15, 100, 100, true, true, 'target');
      const damageLayer = document.getElementById('dmglayer');
      const damageStacked = damageLayer.children.length === 1
        && damageLayer.firstChild.textContent === '40'
        && damageLayer.firstChild.classList.contains('vb-crit');
      flushRaf();
      ok(flashShown && hitFlash.style.opacity === '0',
        'directional pain feedback appears and fades without a later state update');
      ok(damageStacked && damageLayer.firstChild.style.opacity === '0',
        'rapid hits combine into one critical damage number and fade after their lifetime');

      hud.setState({ alive: true, adsT01: 1, holdingBreath: true, breath01: 0.5, canHoldBreath: true });
      const breathHolding = document.getElementById('breath-meter').style.display === 'block'
        && document.getElementById('breath-meter').classList.contains('is-holding')
        && document.getElementById('breath-meter').children[0].style.transform === 'scaleX(0.500)';
      hud.setState({ holdingBreath: false, breath01: 1 });
      const breathReady = document.getElementById('breath-meter').style.display === 'block'
        && document.getElementById('breath-meter').parentElement.id !== 'crosshair';
      hud.setState({ adsT01: 0, holdingBreath: true, breath01: 0.4 });
      ok(breathHolding && breathReady && document.getElementById('breath-meter').style.display === 'none',
        'breath meter remains visible while aiming, including ready state, outside the hidden crosshair');

      hud.setState({ wid: 'sniper', adsT01: 0.9, alive: true, scopeZoom: 2.5 });
      const zoomLabel = document.getElementById('sniper-scope')?.querySelector('#scope-zoom-label');
      ok(zoomLabel?.textContent === '2.5×',
        'scope overlay label follows the live zoom step');
      hud.setState({ wid: 'rifle', adsT01: 0 });

      const visible = (element) => !!element
        && element.style.display !== 'none'
        && !element.classList.contains('hidden')
        && element.getAttribute('aria-hidden') !== 'true';
      const players = [
        {
          // Score past the last Gun Game level, so the clamp check survives roster growth.
          id: 17, name: 'HOST', team: 'alpha', score: 99,
          kills: 5, deaths: 1, bomb: true, state: 'alive', local: true,
        },
        {
          id: 23, name: 'RIVAL', team: 'bravo', score: 8,
          kills: 3, deaths: 2, state: 'dead', dead: true,
        },
      ];
      const prepTick = makeSnapshot([], [], [], 20000, {
        mode: 'snd',
        map: 'citadel',
        phase: 'prep',
        phaseEndsAt: 25000,
        scores: { alpha: 4, bravo: 3 },
        winner: null,
        round: 8,
        roundWinner: null,
        attackers: 'alpha',
        defenders: 'bravo',
        bomb: {
          state: 'carried', carrier: '17', site: null,
          x: 10, y: 3, z: 12, explodeAt: null,
        },
      });
      const prepMatch = prepTick.match;
      const selfRow = {
        id: 17,
        team: 'alpha',
        credits: 2100,
        owned: ['revolver', 'smg'],
        bomb: true,
        hp: 100,
        state: 'alive',
        interaction: null,
      };
      hud.setMatchState(prepMatch, selfRow, players, 20000);
      ok(visible(document.getElementById('match-header'))
        && /snd|search|destroy/i.test(document.getElementById('match-mode-chip').textContent)
        && /citadel/i.test(document.getElementById('match-map-chip').textContent)
        && document.getElementById('match-clock').textContent.length > 0,
      'HUD match header renders mode, map, and a server-clocked phase timer');
      ok(document.getElementById('hud-credits-val').textContent.replace(/\D/g, '') === '2100'
        && visible(document.getElementById('hud-carrier-badge'))
        && visible(document.getElementById('hud-buy-prompt')),
      'S&D prep HUD renders authoritative credits, carrier state, and buy prompt');
      const statusStrip = document.getElementById('player-status-strip');
      ok(statusStrip.querySelectorAll('.vb-player-status-card').length === 2
        && statusStrip.querySelectorAll('.is-alive').length === 1
        && statusStrip.querySelectorAll('.is-dead').length === 1
        && statusStrip.querySelectorAll('.vb-player-team-alpha').length > 0
        && statusStrip.querySelectorAll('.vb-player-team-bravo').length > 0
        && /1 ALIVE/.test(statusStrip.textContent)
        && /0 ALIVE/.test(statusStrip.textContent),
      'S&D status strip shows remaining lives without repeating names and scores');

      hud.setState({ grenades: [1, 1, 0], grenadeType: 0, grenadeReady: 0, grenadeCharge: 0.5 });
      const card = document.getElementById('grenade-count');
      const dots = card.querySelectorAll('.vb-grenade-dot');
      ok(card.querySelectorAll('.vb-grenade-type').length === 0
        && dots.length === 5
        && dots[0].classList.contains('is-stocked') && dots[0].classList.contains('is-ready')
        && dots[1].classList.contains('is-stocked') && !dots[1].classList.contains('is-ready')
        && !dots[2].classList.contains('is-stocked')
        && dots[2].dataset.role === 'tactical' && dots[1].dataset.role === 'gadget' && dots[3].dataset.role === 'lethal'
        && card.dataset.type === 'frag'
        && card.querySelector('.vb-grenade-card-icon').src === './assets/grenades/hud/frag.png'
        && card.querySelector('.vb-grenade-name').textContent === 'M-4 FRAG'
        && card.querySelector('.vb-grenade-ammo').textContent === '×1'
        && card.querySelector('.vb-grenade-key').textContent === 'G'
        && card.querySelector('.vb-grenade-pouch-key').textContent === 'H'
        && /POUCH/.test(card.querySelector('.vb-grenade-pouch').textContent)
        && card.classList.contains('is-charging')
        && !card.classList.contains('is-full')
        && card.querySelector('.vb-grenade-charge').children[0].style.transform === 'scaleX(0.5)',
      'grenade Ready Card shows the ready type icon, name, count, role-tinted pouch dots and live power');
      hud.setDeviceInfo({ padActive: true });
      const padLabels = card.querySelector('.vb-grenade-key').textContent === 'RB'
        && card.querySelector('.vb-grenade-pouch-key').textContent === 'D▼';
      hud.setDeviceInfo({ touch: true });
      const touchLabels = card.querySelector('.vb-grenade-key').hidden === true
        && card.querySelector('.vb-grenade-pouch').hidden === true
        && card.querySelector('.vb-grenade-card-icon').dataset.touchCompact === ''
        && card.querySelector('.vb-grenade-ammo').dataset.touchCompact === '';
      hud.setDeviceInfo({});
      ok(padLabels && touchLabels && card.querySelector('.vb-grenade-key').hidden === false,
        'setDeviceInfo relabels the card badges for pad and hides them on touch, keeping the compact icon and count');
      hud.setState({ grenades: [1, 1, 0, 1, 0], grenadeType: 3, grenadeReady: 3, grenadeCharge: 0, grenadeCharging: true, grenadePower: 1, grenadePowerIndex: 4 });
      const aim = document.getElementById('grenade-aim');
      const fullState = card.classList.contains('is-full')
        && card.querySelector('.vb-grenade-hint').textContent === 'RELEASE · THROW'
        && card.dataset.type === 'molotov'
        && card.querySelectorAll('.vb-grenade-dot')[3].classList.contains('is-ready')
        && card.querySelector('.vb-grenade-name').textContent === 'MOLOTOV COCKTAIL'
        && aim.classList.contains('is-visible') && !aim.classList.contains('is-cook')
        && aim.querySelectorAll('.vb-aim-notch').length === 5
        && aim.querySelectorAll('.vb-aim-notch')[4].classList.contains('is-lit')
        && aim.querySelector('.vb-aim-power-label').textContent === '100%'
        && aim.querySelector('.vb-aim-hint').textContent === 'RELEASE · THROW   SCROLL · RANGE   R · PIN BACK'
        && document.getElementById('grenade-readied').classList.contains('is-visible');
      hud.setState({ grenades: [1, 1, 0], grenadeType: 0, grenadeReady: 0, grenadeCharge: 0, grenadeCharging: true, grenadePower: 0.2, grenadePowerIndex: 0 });
      const heldState = card.classList.contains('is-charging')
        && card.querySelector('.vb-grenade-hint').textContent === 'RELEASE · THROW'
        && aim.querySelector('.vb-aim-power-label').textContent === 'LOB'
        && aim.classList.contains('is-cook')
        && aim.querySelector('.vb-aim-fuse-label').textContent === '5.0s';
      hud.setState({
        grenades: [1, 1, 0], grenadeType: 0, grenadeReady: 0, grenadeCharge: 1, grenadeCharging: true,
        grenadeCook01: 0.75, grenadeCookLeftMs: 650,
      });
      ok(fullState && heldState
        && card.classList.contains('is-cooking')
        && card.classList.contains('is-critical')
        && card.querySelector('.vb-grenade-hint').textContent === 'COOKING · 0.7s'
        && card.querySelector('.vb-grenade-charge').children[0].style.transform === 'scaleX(0.25)'
        && aim.classList.contains('is-critical')
        && aim.querySelector('.vb-aim-fuse-label').textContent === '0.7s'
        && aim.querySelector('.vb-aim-fuse-ring').style['--fuse'] === '0.250',
      'aim reticle shows the lit power step, LOB, and a fuse ring that drains from the pin with the cook left');
      hud.setState({
        grenades: [0, 1, 0], grenadeType: 1, grenadeReady: 1, grenadeCharge: 0, grenadeCharging: true,
        grenadeCook01: 0, grenadeCookLeftMs: null, claymorePlacementValid: false,
      });
      const noWall = card.querySelector('.vb-grenade-hint').textContent === 'NO WALL · MAX 2.2m'
        && aim.classList.contains('is-wallmine')
        && aim.querySelector('.vb-aim-mount').textContent === '[ NO WALL · 2.2m ]'
        && aim.querySelector('.vb-aim-hint').textContent === 'RELEASE · MOUNT   R · PIN BACK';
      hud.setState({ claymorePlacementValid: true });
      ok(noWall && aim.classList.contains('is-valid')
        && aim.querySelector('.vb-aim-mount').textContent === '[ MOUNT ]'
        && card.querySelector('.vb-grenade-hint').textContent === 'RELEASE · MOUNT',
      'claymore aim shows a MOUNT bracket on a valid wall and NO WALL with the reach otherwise');
      hud.setState({ grenadeCharging: false, claymorePlacementValid: false, grenades: [0, 0, 0, 0, 0], grenadeReady: -1, grenadeType: 1 });
      const emptyPouch = card.classList.contains('is-empty-pouch')
        && card.querySelector('.vb-grenade-name').textContent === 'POUCH EMPTY'
        && !aim.classList.contains('is-visible')
        && !document.getElementById('grenade-readied').classList.contains('is-visible');
      hud.setState({ grenadeDenied: 1 });
      const denied = card.classList.contains('is-denied');
      hud.setState({ grenades: [0, 0, 0, 0, 1], grenadeReady: 4, grenadeType: 4, grenadeAdvancedTo: 4, grenadeReadiedAt: performance.now() });
      ok(emptyPouch && denied
        && card.classList.contains('is-advanced')
        && card.querySelector('.vb-grenade-flash').textContent === 'NEXT · M-18 SMOKE'
        && document.getElementById('grenade-readied').classList.contains('is-visible')
        && document.getElementById('grenade-readied').textContent.includes('→ M-18 SMOKE')
        && document.getElementById('grenade-readied').querySelector('img').src === './assets/grenades/hud/smoke.svg',
      'the card dims for an empty pouch, shakes on a denied press, and flashes NEXT plus the readied tag on auto-advance');
      hud.setState({ grenades: [0, 1, 0, 0, 1], grenadeReady: 1, grenadeType: 1, grenadePinBackAt: 1, grenadePinBackReason: 'noWall' });
      const noWallNote = document.getElementById('grenade-readied').textContent.includes('NO WALL')
        && !document.getElementById('grenade-readied').textContent.includes('PIN BACK');
      hud.setState({ grenadePinBackAt: 2, grenadePinBackReason: 'pinBack' });
      ok(noWallNote && document.getElementById('grenade-readied').classList.contains('is-pinback')
        && document.getElementById('grenade-readied').textContent.includes('PIN BACK'),
      'a claymore let go off a wall reads NO WALL on the readied tag; a real pin back reads PIN BACK');
      hud.setState({ grenadePouchOpen: true, grenadePouchHover: 2, grenades: [2, 0, 0, 1, 1], grenadeReady: 0 });
      const pouch = document.getElementById('grenade-pouch');
      const pouchSlots = pouch.querySelectorAll('.vb-pouch-slot');
      const pouchOpen = pouch.getAttribute('aria-hidden') === 'false'
        && pouchSlots.length === 5
        && pouchSlots.map((slot) => slot.dataset.type).join(',') === 'frag,limpet,pulse,molotov,smoke'
        && pouchSlots[0].style['--vb-pouch-angle'] === '270deg'
        && pouchSlots[1].classList.contains('is-empty') && pouchSlots[2].classList.contains('is-empty')
        && pouchSlots[0].classList.contains('is-ready')
        && pouchSlots[0].querySelector('.vb-pouch-count').textContent === '×2'
        && pouchSlots[3].classList.contains('is-hl') && !pouchSlots[2].classList.contains('is-hl')
        && pouch.querySelector('.vb-pouch-hub-name').textContent === 'MOLOTOV COCKTAIL'
        && pouch.querySelector('.vb-pouch-hub-role').textContent === 'Impact · 3.2 m fire';
      hud.setState({ grenadePouchHover: 0 });
      const fragRole = pouch.querySelector('.vb-pouch-hub-role').textContent === 'Timed fuse · cookable · 7.5 m blast';
      hud.setState({ grenadePouchOpen: false });
      ok(pouchOpen && fragRole && pouch.getAttribute('aria-hidden') === 'true' && !hud.isGrenadePouchOpen(),
        'pouch radial lays five fixed wedges, snaps hover off empty slots, and generates the role line from the rules');
      // Down-right points at the empty pulse slot and snaps to molotov; the dead zone picks nothing.
      ok(grenadePouchSlotFromVector(0, -1, [1, 0, 0, 1, 1]) === 0
        && grenadePouchSlotFromVector(0.8, 0.6, [1, 0, 0, 1, 1]) === 3
        && grenadePouchSlotFromVector(0.1, 0, [1, 1, 1, 1, 1]) === -1
        && grenadePouchSlotFromVector(1, 0, [0, 0, 0, 0, 0]) === -1,
      'pouch vector picks never land on an empty slot');
      hud.killfeed({ killer: 'a', victim: 'b', w: 'molotov' });
      hud.killfeed({ killer: 'a', victim: 'b', w: 'grenade' });
      const feedIcons = document.getElementById('killfeed').querySelectorAll('.kf-grenade-icon');
      const feedSources = feedIcons.map((icon) => icon.src);
      ok(feedSources.includes('./assets/grenades/hud/molotov.png') && feedSources.includes('./assets/grenades/hud/frag.png')
        && !document.getElementById('killfeed').textContent.includes('◆'),
      'kill feed throwables use the shared GRENADE_HUD_ICONS artwork');
      hud.combat.clearKillfeed();
      hud.setState({ grenadeDenied: undefined, grenadeAdvancedTo: undefined, grenadeReadiedAt: undefined, grenadePinBackAt: undefined, grenadePinBackReason: undefined, grenadePouchOpen: undefined, grenadePouchHover: undefined });
      hud.setState({ charge01: 0.4 });
      const chargingMeter = document.getElementById('charge-meter').classList.contains('is-visible')
        && document.getElementById('charge-meter').classList.contains('is-charging')
        && document.querySelector('.vb-charge-track').children[0].style.transform === 'scaleX(0.4)'
        && document.querySelector('.vb-charge-label').textContent === 'CHARGING';
      hud.setState({ charge01: 0.9 });
      const midMeter = document.getElementById('charge-meter').classList.contains('is-charging')
        && !document.getElementById('charge-meter').classList.contains('is-full')
        && document.querySelector('.vb-charge-label').textContent === 'CHARGING';
      hud.setState({ charge01: null });
      ok(chargingMeter && midMeter && !document.getElementById('charge-meter').classList.contains('is-visible'),
        'the coil meter shows the live LONGARC charge and hides for other weapons');
      hud.setState({ charge01: 1 });
      ok(document.getElementById('charge-meter').classList.contains('is-full')
        && document.querySelector('.vb-charge-label').textContent === 'CHARGED',
      'a full charge cell settles on CHARGED');

      hud.setState({ charge01: null, heat01: 0.75, spin01: 1, overheated: false, heatDamageMult: 1.65 });
      ok(document.querySelector('.vb-charge-label').textContent === 'SWEET SPOT 75% · +65% DMG'
        && document.querySelector('.vb-charge-track').children[0].style.transform === 'scaleX(0.75)', 'minigun HUD shows heat sweet spot and damage bonus');
      hud.setState({ charge01: null, heat01: 0.75, spin01: 0.85, minigunSpinningUp: false,
        overheated: false, heatDamageMult: 1.65 });
      ok(document.querySelector('.vb-charge-label').textContent === 'SWEET SPOT 75% · +65% DMG',
        'coasting rotor keeps the sweet spot visible during trigger pauses');
      hud.setState({ charge01: null, heat01: 0.75, spin01: 0.85, minigunSpinningUp: true,
        overheated: false, heatDamageMult: 1.65 });
      ok(document.querySelector('.vb-charge-label').textContent === 'SPIN UP · 85%', 'held trigger displays actual spin-up');
      hud.setState({ charge01: null, heat01: 0.8, spin01: 0, overheated: true });
      ok(document.querySelector('.vb-charge-label').textContent === 'OVERHEATED · COOLING', 'minigun HUD keeps the lock visible while cooling');
      hud.setState({ heat01: 0.1, spin01: 1, overheated: false, minigunSpinningUp: false, minigunPrimed: true });
      ok(document.querySelector('.vb-charge-label').textContent === 'ROTOR READY · PULL TRIGGER', 'pre-spun rotor has a ready cue');
      hud.setState({ heat01: 0.94, minigunPrimed: false });
      ok(document.querySelector('.vb-charge-label').textContent.includes('RELEASE TO COOL')
        && document.getElementById('charge-meter').classList.contains('is-critical'), 'critical heat gives an actionable warning');
      hud.setState({ charge01: null, heat01: null });
      ok(!document.getElementById('charge-meter').classList.contains('is-visible'), 'switching away hides the thermal meter');
      hud.setState({ fuel01: 0.5, fuelSeconds: 4, flameFiring: true });
      ok(document.querySelector('.vb-charge-label').textContent === 'FUEL 4.0s · IGNITING'
        && document.querySelector('.vb-charge-track').children[0].style.transform === 'scaleX(0.5)', 'flame tank shows remaining firing time');
      hud.setState({ fuel01: null, flameFiring: false });
      ok(!document.getElementById('charge-meter').classList.contains('is-visible')
        && !document.getElementById('charge-meter').classList.contains('is-fuel'), 'switching away clears the tank meter');
      hud.setState({ wid: 'knife', wname: 'IRON PICK', mag: 0, reserve: 0 });
      const meleeAmmo = document.getElementById('ammocount').textContent === '∞'
        && document.getElementById('ammo').children[2].style.display === 'none'
        && document.getElementById('ammoreserve').style.display === 'none'
        && !document.getElementById('ammocount').classList.contains('vb-low');
      hud.setState({ wid: 'rifle', mag: 24, reserve: 3 });
      ok(meleeAmmo && document.getElementById('ammocount').textContent === '24'
        && document.getElementById('ammo').children[2].style.display !== 'none'
        && document.getElementById('ammoreserve').style.display !== 'none' && document.getElementById('ammoreserve').textContent === '3',
      'melee ammo renders an infinite magazine with no reserve and a gun restores the readout');
      // IRON PICK attack indicator: a 16-step bar while recharging, one ready pop on full.
      const meleeMeter = document.getElementById('melee-meter');
      hud.setState({ wid: 'knife', melee01: 1 });
      const drawnFull = !meleeMeter.classList.contains('is-charging') && !meleeMeter.classList.contains('is-ready');
      hud.setState({ melee01: 0.52 });
      const charging = meleeMeter.classList.contains('is-charging')
        && meleeMeter.querySelector('.vb-melee-track').children[0].style.transform === 'scaleX(0.5)';
      hud.setState({ melee01: 1 });
      const popped = !meleeMeter.classList.contains('is-charging') && meleeMeter.classList.contains('is-ready');
      hud.setState({ wid: 'rifle', melee01: null });
      ok(drawnFull && charging && popped && !meleeMeter.classList.contains('is-ready')
        && meleeMeter.parentNode === document.getElementById('crosshair'),
      'the pickaxe attack indicator steps with the swing cadence, pops once when ready and hides for guns');

      const discStates = (slots) => slots.map((slot) => slot.state).join(',');
      ok(discStates(glaiveDiscSlots({ magSize: 2, mag: 2 })) === 'hand,hand'
        && discStates(glaiveDiscSlots({ magSize: 3, mag: 1, inFlight: 1, fab01: [0.5] })) === 'hand,flight,fab'
        && glaiveDiscSlots({ magSize: 3, mag: 1, inFlight: 1, fab01: [0.5] })[2].fill01 === 0.5
        && discStates(glaiveDiscSlots({ magSize: 2, mag: 2, inFlight: 1, embedded: 1, fab01: [0.2] })) === 'hand,flight'
        && discStates(glaiveDiscSlots({ magSize: 2, mag: 0, embedded: 1 })) === 'embedded,empty',
      'RIPTIDE disc slots follow the server trim order: flight, hand, embedded, then fabricating');

      const discPips = () => document.getElementById('disc-pips').children.map((pip) => [...pip.classes].find((name) => name.startsWith('is-')));
      const glaiveDef = WEAPONS.glaive;
      hud.setState({ wid: 'glaive', wname: glaiveDef.name, mag: glaiveDef.magSize, reserve: 0,
        glaive: { magSize: glaiveDef.magSize, inFlight: 0, outLeg: 0, embedded: 0, fab01: [] } });
      const discAmmo = document.getElementById('ammo');
      const discReturn = document.querySelector('.vb-disc-return');
      const fullDiscs = discAmmo.classList.contains('is-discs') && discAmmo.classList.contains('vb-w-glaive')
        && !document.getElementById('disc-pips').hidden && discPips().join(',') === 'is-hand,is-hand'
        && document.querySelectorAll('.vb-ch-disc.is-ready').length === 2
        && discReturn.textContent.endsWith('RETURN') && !discReturn.classList.contains('is-ready');
      hud.setState({ mag: 0, glaive: { magSize: 2, inFlight: 1, outLeg: 1, embedded: 1, fab01: [] } });
      const thrownDiscs = discPips().join(',') === 'is-flight,is-embedded'
        && document.querySelectorAll('.vb-ch-disc.is-ready').length === 0
        && discReturn.classList.contains('is-ready') && discAmmo.classList.contains('is-disc-empty')
        && document.getElementById('disc-pips').getAttribute('aria-label') === 'Discs: 0 ready, 1 in flight, 1 embedded';
      hud.setState({ mag: 1, glaive: { magSize: 3, inFlight: 1, outLeg: 0, embedded: 0, fab01: [0.25] } });
      const chaosDiscs = discPips().join(',') === 'is-hand,is-flight,is-fab'
        && document.getElementById('disc-pips').children[2].style['--fill'] === '25%'
        && !discReturn.classList.contains('is-ready');
      hud.setState({ wid: 'rifle', wname: 'VK-77 RAPTOR', mag: 24, reserve: 3, glaive: null });
      ok(fullDiscs && thrownDiscs && chaosDiscs
        && !discAmmo.classList.contains('is-discs') && document.getElementById('disc-pips').hidden
        && discReturn.hidden && document.querySelector('.vb-ch-discs').hidden
        && document.getElementById('ammocount').textContent === '24',
      'RIPTIDE ammo shows one pip per disc from the authoritative split, a live R return cue, and restores the readout on switch');

      const liveTick = makeSnapshot([], [], [], 20000, {
        ...prepMatch,
        phase: 'live',
        phaseEndsAt: 90000,
        bomb: {
          state: 'planted',
          carrier: null,
          site: 'A',
          x: 14,
          y: 3,
          z: 18,
          explodeAt: 28000,
        },
      });
      const liveMatch = liveTick.match;
      hud.setMatchState(liveMatch, {
        ...selfRow,
        bomb: false,
        interaction: { kind: 'defuse', site: 'A', progress: 0.4 },
      }, players, 20000);
      const interactionFill = document.querySelector('#interaction-bar .vb-interaction-fill')
        || document.querySelector('.vb-interaction-fill');
      ok(document.getElementById('match-alpha-score').textContent.trim() === '4'
        && document.getElementById('match-bravo-score').textContent.trim() === '3'
        && /attack/i.test(document.getElementById('match-alpha-role').textContent)
        && /defend/i.test(document.getElementById('match-bravo-role').textContent),
      'HUD renders authoritative team scores and current S&D roles');
      ok(document.getElementById('match-bomb-banner').textContent.trim()
          === 'BOMB · SITE A'
        && document.getElementById('match-clock').textContent === '8.0s'
        && Object.keys(liveMatch.bomb).sort().join(',') === 'carrier,explodeAt,site,state,x,y,z'
        && visible(document.getElementById('interaction-bar'))
        && document.getElementById('interaction-label').textContent.trim()
          === 'DEFUSING BOMB [SITE A]...'
        && interactionFill?.style.width === '40%',
      'HUD renders the real server bomb schema, fuse clock, and exact 40% defuse progress');

      hud.setMatchState({
        ...liveMatch,
        phase: 'post',
        phaseEndsAt: 25000,
        scores: { alpha: 7, bravo: 4 },
        winner: 'alpha',
        roundWinner: 'alpha',
      }, selfRow, players, 22000);
      const resultScreen = document.getElementById('match-result-screen');
      ok(visible(resultScreen)
        && resultScreen.classList.contains('is-victory')
        && document.getElementById('match-result-title').textContent === 'VICTORY'
        && document.getElementById('match-result-score').textContent.replace(/\s/g, '') === '7:4'
        && document.getElementById('match-result-countdown').textContent.endsWith('0:03'),
      'final team winner snapshot renders a server-clocked victory screen');

      hud.setMatchState({
        mode: 'gungame', map: 'foundry', phase: 'post', phaseEndsAt: 26000,
        scores: null, winner: 23,
      }, selfRow, players, 23000);
      ok(resultScreen.classList.contains('is-defeat')
        && document.getElementById('match-result-title').textContent === 'DEFEAT'
        && /RIVAL/.test(document.getElementById('match-result-detail').textContent),
      'free-for-all winner identity renders the local defeat state');

      hud.setMatchState(liveMatch, selfRow, players, 23000);
      ok(!visible(resultScreen), 'the result screen clears on the next live snapshot');

      hud.setScoreboard(true);
      const scoreboard = document.getElementById('scores');
      ok(scoreboard.querySelectorAll('tr.vb-team-alpha').length === 1
        && scoreboard.querySelectorAll('tr.vb-team-bravo').length === 1
        && scoreboard.querySelectorAll('tr.vb-me').length === 1
        && scoreboard.querySelectorAll('tr.dead').length === 1,
      'scoreboard rows receive stable team, local-player, and death classes');
      ok(scoreboard.querySelectorAll('.vb-badge-alpha').length === 1
        && scoreboard.querySelectorAll('.vb-badge-bravo').length === 1
        && scoreboard.querySelectorAll('.vb-sb-bomb-badge').length === 1,
      'scoreboard renders team badges and objective-carrier badge');

      for (const mode of ['fun', 'tdm', 'gungame', 'training']) {
        hud.setMatchState({ mode, map: mode === 'training' ? 'killhouse' : 'foundry',
          phase: 'live', phaseEndsAt: 50000, scores: { alpha: 5, bravo: 3 } }, players[0], players, 23000);
        const headers = Array.from(document.getElementById('scores').querySelectorAll('th'), (th) => th.textContent);
        ok(!visible(document.getElementById('match-clock'))
          && document.getElementById('match-clock').textContent === ''
          && !visible(document.getElementById('player-status-strip')),
        `${mode} never shows an irrelevant clock or permanent roster`);
        if (mode === 'fun') {
          ok(headers.join(',') === '#,PLAYER,KILLS,DEATHS,PING'
            && document.getElementById('match-phase-label').textContent === '#1 · 5 KILLS'
            && document.getElementById('scores').querySelectorAll('.vb-sb-bomb-badge').length === 0,
          'FFA shows local rank and kills with a ranked K/D table and no objective baggage');
        } else if (mode === 'tdm') {
          ok(headers.join(',') === 'PLAYER,KILLS,DEATHS,PING,PLAYER,KILLS,DEATHS,PING'
            && document.getElementById('scores').querySelectorAll('.vb-scoreboard-team').length === 2,
          'TDM groups players into two team tables with only relevant combat stats');
        } else if (mode === 'gungame') {
          ok(headers.join(',') === '#,PLAYER,WEAPON,PING'
            && document.getElementById('match-phase-label').textContent.includes(`${GUN_GAME_WEAPON_ORDER.length} / ${GUN_GAME_WEAPON_ORDER.length}`)
            && document.getElementById('scores').textContent.includes(`${GUN_GAME_WEAPON_ORDER.length}/${GUN_GAME_WEAPON_ORDER.length}`),
          'Gun Game clamps authoritative weapon progression to the final weapon');
        } else {
          ok(!visible(document.getElementById('match-header')) && headers.join(',') === 'PLAYER,PING',
          'Training has a participant list without competitive counters or a match header');
        }
      }
      hud.setMatchState(liveMatch, selfRow, players, 23000);
      ok(visible(document.getElementById('match-clock'))
        && visible(document.getElementById('player-status-strip')),
      'returning from Training restores the S&D clock and remaining lives');

      const purchases = [];
      let buyCloses = 0;
      hud.setupBuyMenu({
        onBuy: (weapon) => purchases.push(weapon),
        onClose: () => { buyCloses++; },
      });
      hud.setBuyMenuState({
        open: true,
        phase: 'prep',
        credits: 2000,
        owned: ['revolver'],
      });
      const buyCredits = document.getElementById('buy-credits-val');
      const ownedCard = document.getElementById('buy-card-revolver');
      const minigunCard = document.getElementById('buy-card-minigun');
      ok(minigunCard.querySelector('.vb-buy-key-badge').textContent === 'CLICK'
        && document.getElementById('buy-grid').children[9].querySelector('.vb-buy-key-badge').textContent === '[0]'
        && document.querySelector('.vb-buy-footer-hint').textContent.startsWith('[1-9, 0] FIRST 10 ITEMS'),
      'armory key badges and footer match the ten digit shortcuts; later cards read CLICK');
      const cardStats = wid => document.getElementById(`buy-card-${wid}`).querySelector('.vb-buy-wstats').textContent;
      const cardDamage = amount => Number(combatDamage(amount).toFixed(1));
      ok(cardStats('rocket').startsWith(`DMG ${cardDamage(ROCKET_RULES.directDamage + ROCKET_RULES.splashDamage)} ·`)
        && cardStats('shotgun').startsWith(`DMG ${cardDamage(WEAPONS.shotgun.damage[0])}×${WEAPONS.shotgun.pellets} ·`)
        && cardStats('knife') === `DMG ${cardDamage(WEAPONS.knife.damage[0])} · ${WEAPONS.knife.rpm} RPM`,
      'armory stats follow the damage rules: rocket direct hit, shotgun pellets, melee without ammunition');
      const smgButton = document.getElementById('buy-btn-smg');
      const sniperButton = document.getElementById('buy-btn-sniper');
      ok(hud.isBuyMenuOpen()
        && /prep|buy/i.test(document.getElementById('buy-phase-val').textContent)
        && buyCredits.textContent.replace(/\D/g, '') === '2000'
        && (/owned|refill/i.test(ownedCard.textContent)
          || ownedCard.classList.contains('owned')
          || ownedCard.classList.contains('vb-owned'))
        && !smgButton.disabled
        && smgButton.getAttribute('aria-disabled') === 'false'
        && sniperButton.disabled
        && sniperButton.getAttribute('aria-disabled') === 'true',
      'buy dialog renders prep phase, credits, ownership, and affordability guards');

      const authoritativeBuyView = [
        buyCredits.textContent,
        ownedCard.className,
        ownedCard.textContent,
        smgButton.className,
        smgButton.textContent,
      ].join('|');
      document.getElementById('buy-btn-smg').click();
      document.getElementById('buy-btn-sniper').click();
      ok(purchases.join(',') === 'smg'
        && [
          buyCredits.textContent,
          ownedCard.className,
          ownedCard.textContent,
          smgButton.className,
          smgButton.textContent,
        ].join('|') === authoritativeBuyView,
      'shop controls reject unaffordable purchases without changing authoritative balance or ownership');

      hud.setBuyMenuState({
        open: true,
        phase: 'prep',
        credits: 2000,
        owned: ['revolver', 'smg'],
      });
      document.getElementById('buy-btn-smg').click();
      ok(purchases.join(',') === 'smg,smg',
        'an affordable owned weapon remains requestable as an authoritative refill');

      const buyKeyTarget = window.listeners.has('keydown')
        ? window
        : document.listeners.has('keydown') ? document : document.getElementById('buy-menu');
      buyKeyTarget.dispatchEvent(event('keydown', {
        key: '3',
        code: 'Digit3',
        repeat: false,
      }));
      ok(purchases.at(-1) === 'shotgun',
        'buy dialog maps weapon digits to guarded purchase requests');
      const buyB = event('keydown', { key: 'b', code: 'KeyB', repeat: false });
      buyKeyTarget.dispatchEvent(buyB);
      ok(hud.isBuyMenuOpen()
        && purchases.length === 3
        && !buyB.defaultPrevented
        && !buyB.propagationStopped,
      'HUD neither handles nor consumes B, leaving the toggle exclusively to Input and Main');
      const buyEscape = event('keydown', { key: 'Escape', code: 'Escape', repeat: false });
      buyKeyTarget.dispatchEvent(buyEscape);
      ok(!hud.isBuyMenuOpen() && buyCloses === 1 && buyEscape.defaultPrevented,
        'buy dialog consumes Escape and closes through its owner callback');

      hud.setBuyMenuState({
        open: true,
        phase: 'live',
        credits: 16000,
        owned: ['revolver'],
      });
      ok(!hud.isBuyMenuOpen(),
        'buy dialog refuses to stay open outside the authoritative prep phase');

      await new Promise((resolve) => setTimeout(resolve, 0));

      const assertDisposed = (ownedRoots, ownerDocument, ownerWindow, label) => {
        ok(ownedRoots.every((root) => !ownerDocument?.body.contains(root)),
          `${label} removes every DOM root it owns`);
        ok((!ownerDocument || ownerDocument.listenerCount() === 0)
          && (!ownerWindow || ownerWindow.listenerCount() === 0),
        `${label} removes document and window listeners`);
        ok(timers.size === 0 && rafs.size === 0,
          `${label} cancels every pending timer and animation frame`);
      };
      const disposeTwice = async (
        instance,
        ownedRoots,
        ownerDocument,
        ownerWindow,
        label,
      ) => {
        instance.dispose();
        assertDisposed(ownedRoots, ownerDocument, ownerWindow, label);
        const callbacksAfterDispose = timerCallbacksFired;
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));
        ok(timerCallbacksFired === callbacksAfterDispose && timers.size === 0,
          `${label} leaves no deferred callback able to run after disposal`);
        instance.dispose();
        ok(timers.size === 0 && rafs.size === 0, `${label} remains inert on repeated disposal`);
      };

      hud.openSettings();
      hud.hitmark(true);
      hud.killfeed({
        killer: 'HOST',
        victim: 'RIVAL',
        w: 'smg',
        hs: false,
      });
      hud.killfeed({
        killer: 'NEWEST',
        victim: 'LATEST',
        w: 'sniper',
        hs: true,
        lr: true,
        ns: true,
      });
      ok(document.getElementById('killfeed').children.map((row) => row.children[0]?.textContent).join(',')
        === 'NEWEST,HOST',
      'killfeed inserts the newest row before the prior row');
      ok(document.getElementById('killfeed').children[0].children.map((node) => node.textContent).join('|')
        === 'NEWEST|LONGSHOT MK-II|HEADSHOT|LONG RANGE|NO-SCOPE|LATEST'
        && document.getElementById('killfeed').children[0].querySelector('.kf-weapon-icon')?.src.endsWith('/sniper.png'),
      'killfeed renders weapon identity plus authoritative HEADSHOT, LONG RANGE, and NO-SCOPE markers');
      hud.setState({ wid: 'sniper', adsT01: 0.9, alive: true, hp: 100 });
      hud.setPainImpulse(0.8);
      const fullRoots = [
        document.getElementById('menu'),
        document.getElementById('lobby'),
        document.getElementById('settings-overlay'),
        document.getElementById('hud'),
        document.getElementById('buy-menu'),
      ].filter(Boolean);
      ok(fullRoots.length === 5
        && fullRoots.every((root) => document.body.contains(root))
        && timers.size >= 3
        && rafs.size > 0
        && document.listenerCount() > 0
        && window.listenerCount() > 0,
      'full HUD lifecycle fixture owns DOM, listeners, timers, RAFs, and collections');
      await disposeTwice(hud, fullRoots, document, window, 'full HUD disposal');
      hud = null;

      const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
      delete globalThis.document;
      try {
        const detachedHud = new HUD();
        await disposeTwice(detachedHud, [], null, window,
          'constructor-only detached HUD disposal');
      } finally {
        if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      }

      const runPartialLifecycle = async (label, setup, expectsDocumentListener = false) => {
        const partialDocument = new FakeDocument();
        const partialWindow = new FakeEventTarget();
        const restorePartial = installGlobals({
          document: partialDocument,
          window: partialWindow,
        });
        let partialHud = null;
        try {
          partialHud = new HUD();
          const ownedRoots = setup(partialHud, partialDocument);
          ok(ownedRoots.length > 0
            && ownedRoots.every((root) => partialDocument.body.contains(root))
            && timers.size > 0,
          `${label} fixture owns DOM and a deferred callback`);
          if (expectsDocumentListener) {
            ok(partialDocument.listenerCount() > 0,
              `${label} fixture registers its document listener`);
          }
          await disposeTwice(
            partialHud,
            ownedRoots,
            partialDocument,
            partialWindow,
            label,
          );
          partialHud = null;
        } finally {
          partialHud?.dispose();
          restorePartial();
        }
      };

      await runPartialLifecycle('menu-only HUD disposal', (partialHud, partialDocument) => {
        partialHud.buildMenu(() => {});
        return [partialDocument.getElementById('menu')];
      });
      await runPartialLifecycle('lobby-only HUD disposal', (partialHud, partialDocument) => {
        partialHud.showLobby({
          code: 'LIFE1',
          gameMode: 'fun',
          map: 'foundry',
          members: [],
        }, {
          onReady() {},
          onStart() {},
          onLeave() {},
        });
        return [partialDocument.getElementById('lobby')];
      }, true);
      await runPartialLifecycle('settings-only HUD disposal', (partialHud, partialDocument) => {
        partialHud.setupSettings({
          onChange() {},
          onResume() {},
        });
        partialHud.openSettings();
        return [partialDocument.getElementById('settings-overlay')];
      });

      // Every shop mode reuses #buy-menu. After snd -> bastion -> ttt -> bastion,
      // Tab belongs to the Bastion trap alone: the S&D capture handler must let it
      // through and no earlier builder's root handler may still run.
      {
        const shopDocument = new FakeDocument();
        const restoreShop = installGlobals({ document: shopDocument, window: new FakeEventTarget() });
        let shopMode = null;
        let shop = null;
        try {
          const { BuyMenuController } = await import('../../public/js/ui/buy-menu.js');
          shop = new BuyMenuController({ mode: () => shopMode, isAlive: () => true });
          shop.setupBuyMenu({ onBuy() {}, onClose() {} });
          const bastion = { credits: 0, upgrades: {}, budget: {}, ready: 0, defenders: 1, wave: 0, waves: 8 };
          shopMode = 'bastion';
          shop.setBuyMenuState({ phase: 'prep', bastion, bastionSelf: {} });
          shopMode = 'ttt';
          shop.setBuyMenuState({ phase: 'live' });
          shopMode = 'bastion';
          shop.setBuyMenuState({ open: true, phase: 'prep' });
          const captureTab = event('keydown', { key: 'Tab', code: 'Tab' });
          shopDocument.dispatchEvent(captureTab);
          const shopRoot = shopDocument.getElementById('buy-menu');
          shop.buyDom.closeBtn.focus();
          shop.buyDom.closeBtn.dispatchEvent(event('keydown', { key: 'Tab', code: 'Tab' }));
          ok(shop.isBuyMenuOpen()
            && !captureTab.defaultPrevented && !captureTab.propagationStopped
            && shopDocument.activeElement === shop.buyDom.selectors.loadout
            && shopRoot.listenerCount('keydown') === 0,
          'Bastion shop owns Tab after mode switches: one step from CLOSE reaches the loadout select');
          const captureEscape = event('keydown', { key: 'Escape', code: 'Escape' });
          shopDocument.dispatchEvent(captureEscape);
          ok(!shop.isBuyMenuOpen() && captureEscape.defaultPrevented,
            'document Escape still closes a Bastion shop');
        } finally {
          shop?.dispose();
          restoreShop();
        }
      }

      // #weaponname and buy glyphs carry vb-w-<id> for every weapon; each needs a tint.
      {
        const { readFileSync } = await import('node:fs');
        const { WEAPON_IDS } = await import('../../shared/combatmath.js');
        const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8');
        const untinted = WEAPON_IDS.filter((id) => !css.includes(`--w-${id}:`)
          || !css.includes(`.vb-w-${id} `) || !css.includes(`#weaponname.vb-w-${id} `));
        ok(untinted.length === 0, `every weapon has a HUD tint token and weapon-name colour (${untinted.join(', ') || 'all tinted'})`);
      }
    } finally {
      hud?.dispose();
      restore();
    }
  }

}
