import { MODE_IDS } from '../../shared/modes.js';
import { makeSnapshot } from '../../server/protocol/snapshot.js';

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
        this.body = new FakeElement(this, 'body');
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
      ok(hud._settingsConfig.sensitivity === 0.0021
        && hud._settingsConfig.volume === 0.42
        && hud._settingsConfig.fov === 86,
      'HUD loads all persisted settings into its initial configuration');

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

      hud.settingsDom.sensSlider.value = '0.0047';
      hud.settingsDom.sensSlider.dispatchEvent(event('input'));
      hud.settingsDom.volSlider.value = '0.63';
      hud.settingsDom.volSlider.dispatchEvent(event('input'));
      hud.settingsDom.fovSlider.value = '98';
      hud.settingsDom.fovSlider.dispatchEvent(event('input'));
      const lastChange = changes.at(-1);
      const DEVICE_KEYS = ['adsMode', 'aimAssist', 'padSensitivity', 'pointerMode',
        'touchHand', 'touchSensitivity', 'touchSize'];
      ok(changes.length === 3
        && changes.every((change) =>
          Object.keys(change).sort().join(',')
            === ['fov', 'sensitivity', 'volume', ...DEVICE_KEYS].sort().join(','))
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
      const desktopRows = rowShown(hud.settingsDom.pointerModeRow)
        && rowShown(hud.settingsDom.adsModeRow)
        && !rowShown(hud.settingsDom.padSensRow)
        && !rowShown(hud.settingsDom.touchSizeRow)
        && hud.settingsDom.adsModeHint.textContent.startsWith('HOLD');
      hud.setDeviceInfo({ touch: false, pointerKind: 'trackpad', trackpadDetected: true, padActive: true });
      const trackpadRows = hud.settingsDom.pointerModeHint.textContent === 'TRACKPAD DETECTED'
        && hud.settingsDom.adsModeHint.textContent.startsWith('TOGGLE')
        && rowShown(hud.settingsDom.padSensRow)
        && rowShown(hud.settingsDom.aimAssistRow);
      hud.setDeviceInfo({ touch: true, pointerKind: 'mouse', trackpadDetected: false, padActive: false });
      const touchRows = !rowShown(hud.settingsDom.pointerModeRow)
        && rowShown(hud.settingsDom.touchSizeRow)
        && rowShown(hud.settingsDom.touchHandRow)
        && rowShown(hud.settingsDom.touchSensRow);
      hud.settingsDom.adsModeSelect.value = 'toggle';
      hud.settingsDom.adsModeSelect.dispatchEvent(event('change'));
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
        && hud.settingsDom.root.style.display === 'flex'
        && hud.settingsDom.root.getAttribute('aria-hidden') === 'false',
      'HUD settings open state makes the dialog visible and accessible');
      hud.closeSettings();
      ok(!hud.settingsOpen
        && hud.settingsDom.root.style.display === 'none'
        && hud.settingsDom.root.classList.contains('hidden'),
      'HUD closeSettings hides the dialog and clears its open state');

      hud.openSettings();
      hud.settingsDom.resumeBtn.dispatchEvent(event('click'));
      ok(!hud.settingsOpen && resumes === 1,
        'HUD resume button closes settings and invokes onResume once');
      hud.openSettings();
      const escape = event('keydown', { key: 'Escape' });
      hud.settingsDom.root.dispatchEvent(escape);
      ok(!hud.settingsOpen
        && resumes === 2
        && escape.defaultPrevented
        && escape.propagationStopped,
      'HUD Escape resume closes, consumes the key, and invokes onResume once');

      const menuActions = [];
      hud.buildMenu((action) => menuActions.push(action));
      const modeSelect = document.getElementById('game-mode-select');
      const mapSelect = document.getElementById('map-select');
      ok(modeSelect && mapSelect
        && modeSelect.options.map((option) => option.value).join(',') === MODE_IDS.join(','),
      'HUD menu exposes every canonical game mode');
      modeSelect.value = 'snd';
      modeSelect.dispatchEvent(event('change'));
      ok(mapSelect.options.map((option) => option.value).join(',') === 'foundry,citadel,solstice,caldera'
        && !mapSelect.options.some((option) => option.value === 'depot'),
      'HUD menu removes maps incompatible with the selected mode');
      modeSelect.value = 'tdm';
      modeSelect.dispatchEvent(event('change'));
      mapSelect.value = 'depot';
      document.getElementById('name-input').value = 'HOST';
      document.getElementById('bot-count').value = '3';
      document.getElementById('create-lobby-btn').click();
      document.getElementById('create-lobby-confirm-btn').click();
      ok(menuActions.length === 1
        && menuActions[0].mode === 'create'
        && menuActions[0].name === 'HOST'
        && menuActions[0].bots === 3
        && menuActions[0].gameMode === 'tdm'
        && menuActions[0].map === 'depot',
      'HUD create action carries the selected compatible mode-map pair');

      hud.buildMenu((action) => menuActions.push(action));
      document.getElementById('game-mode-select').value = 'snd';
      document.getElementById('game-mode-select').dispatchEvent(event('change'));
      document.getElementById('map-select').value = 'citadel';
      document.getElementById('play-btn').click();
      const quickButton = document.getElementById('play-btn');
      const quickTelemetry = document.querySelectorAll('.vb-telemetry-value');
      ok(menuActions.length === 2
        && menuActions[1].mode === 'quick'
        && menuActions[1].bots >= 5
        && !Object.hasOwn(menuActions[1], 'gameMode')
        && !Object.hasOwn(menuActions[1], 'map')
        && /auto arena/i.test(quickButton.parentNode.querySelector('.vb-action-hint').textContent)
        && /auto rotation/i.test(quickTelemetry[0]?.textContent)
        && !Object.hasOwn(globalThis, 'location'),
      'HUD quick action leaves arena selection to truthful server rotation telemetry');

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
      ok(!Object.hasOwn(globalThis, 'location'),
        'HUD invite fixture restores detached global location state');
      hud.updateLobby({ ...lobbyState, gameMode: 'tdm', map: 'depot' });
      ok(!Object.hasOwn(globalThis, 'location')
        && document.getElementById('lobby-invite-input').value === '?lobby=ZX9Q2'
        && /team|deathmatch|tdm/i.test(document.getElementById('lobby-mode-val').textContent)
        && /depot/i.test(document.getElementById('lobby-map-val').textContent),
      'HUD lobby chips update when a replacement lobby state arrives');

      hud.hideLobby();

      hud.buildHUD();
      hud.setState({ wid: 'sniper', adsT01: 0.7199, alive: true, hp: 100 });
      ok(!hud.scopeShown && !hud.dom.scope,
        'sniper scope stays absent immediately below the ADS threshold');
      hud.setState({ adsT01: 0.72 });
      ok(hud.scopeShown && hud.dom.scope.classList.contains('active'),
        'sniper scope enters exactly at the ADS threshold');
      flushRaf();
      ok(hud.scopeProgress === 1
        && hud.dom.scope.style.opacity === '1'
        && !hud.dom.scope.classList.contains('exiting'),
      'sniper scope RAF reaches its fully active live state');

      hud.setState({ adsT01: 0.7199 });
      ok(!hud.scopeShown
        && !hud.dom.scope.classList.contains('active')
        && hud.dom.scope.classList.contains('exiting'),
      'dropping below the threshold begins the scope exit transition');
      flushRaf();
      ok(hud.scopeProgress === 0
        && !hud.dom.scope.classList.contains('active')
        && !hud.dom.scope.classList.contains('exiting')
        && hud.dom.scope.style.opacity === ''
        && hud.dom.scope.style.transform === '',
      'scope exit removes transition classes and inline animation residue');

      hud.setState({ adsT01: 0.9, alive: true });
      flushRaf();
      hud.setState({ alive: false });
      ok(!hud.scopeShown && hud.dom.ch.classList.contains('vb-dead'),
        'live-to-dead state immediately suppresses the scope and marks the crosshair dead');
      flushRaf();
      ok(!hud.dom.scope.classList.contains('active')
        && !hud.dom.scope.classList.contains('exiting'),
      'live-to-dead scope exit leaves no active or exiting class');

      hud.setState({ alive: true, adsT01: 0.2 });
      hud.setDead(true, 'RIVAL');
      ok(hud.dom.ch.classList.contains('vb-dead')
        && hud.dom.deathnote.textContent === 'eliminated by RIVAL'
        && hud.dom.deathnote.style.display === 'block',
      'explicit death state shows the killer note and dead crosshair');
      hud.setDead(false);
      hud.setState({ alive: true });
      ok(!hud.dom.ch.classList.contains('vb-dead')
        && hud.dom.deathnote.style.display === 'none',
      'HUD revival clears explicit death presentation');

      hud.setDead(true, 'RIVAL', 'HORNET SMG · 8 M · KILLER AT 41 HP');
      const recapShown = hud.dom.deathnote.textContent === 'eliminated by RIVAL'
        && hud.dom.deathrecap?.textContent === 'HORNET SMG · 8 M · KILLER AT 41 HP'
        && hud.dom.deathrecap.style.display === 'block';
      hud.setDead(false);
      ok(recapShown && hud.dom.deathrecap.style.display === 'none',
        'death recap line shows under the note and hides with revival');

      hud.hitmark('kill');
      const killShown = hud.dom.hitmarker.classList.contains('vb-kill')
        && hud.dom.hitmarker.classList.contains('vb-show')
        && !hud.dom.hitmarker.classList.contains('vb-hs');
      hud.hitmark(false);
      ok(killShown && hud.dom.hitmarker.classList.contains('vb-kill'),
        'a kill mark is distinct and a trailing body hit cannot downgrade it');

      hud.setState({ alive: true, adsT01: 1, holdingBreath: true, breath01: 0.5, canHoldBreath: true });
      const breathHolding = hud.dom.breath.style.display === 'block'
        && hud.dom.breath.classList.contains('is-holding')
        && hud.dom.breathFill.style.transform === 'scaleX(0.500)';
      hud.setState({ holdingBreath: false, breath01: 1 });
      const breathHidden = hud.dom.breath.style.display === 'none';
      hud.setState({ adsT01: 0, holdingBreath: true, breath01: 0.4 });
      ok(breathHolding && breathHidden && hud.dom.breath.style.display === 'none',
        'breath meter appears only while aiming and the window is draining or spent');

      hud.setState({ wid: 'sniper', adsT01: 0.9, alive: true, scopeZoom: 2.5 });
      const zoomLabel = hud.dom.scope?.querySelector('#scope-zoom-label');
      ok(zoomLabel?.textContent === '2.5×',
        'scope overlay label follows the live zoom step');
      hud.setState({ wid: 'rifle', adsT01: 0 });

      const visible = (element) => !!element
        && element.style.display !== 'none'
        && !element.classList.contains('hidden')
        && element.getAttribute('aria-hidden') !== 'true';
      const players = [
        {
          id: 17, name: 'HOST', team: 'alpha', score: 12,
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
      ok(!Object.hasOwn(globalThis, 'location')
        && visible(document.getElementById('match-header'))
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
        && /12/.test(statusStrip.textContent)
        && /8/.test(statusStrip.textContent),
      'top status strip renders both teams, alive/dead state, and authoritative points');

      hud.setState({ grenades: [1, 1, 0], grenadeType: 0, grenadeCharge: 0.5 });
      const fragChip = hud.dom.grenadeTypeChips[0];
      const pulseChip = hud.dom.grenadeTypeChips[2];
      ok(hud.dom.grenadeTypeChips.length === 3
        && fragChip.classList.contains('is-selected')
        && fragChip.pips.filter((slot) => !slot.classList.contains('is-spent')).length === 1
        && pulseChip.classList.contains('is-empty')
        && hud.dom.grenades.dataset.type === 'frag'
        && hud.dom.grenades.classList.contains('is-charging')
        && !hud.dom.grenades.classList.contains('is-full')
        && hud.dom.grenadeChargeFill.style.transform === 'scaleX(0.5)',
      'grenade HUD renders one chip per throwable with remaining pips, the selection, and live hold charge');
      hud.setState({ grenades: [1, 1, 0], grenadeType: 1, grenadeCharge: 1 });
      const fullState = hud.dom.grenades.classList.contains('is-full')
        && hud.dom.grenadeHint.textContent === 'MAX · RELEASE'
        && hud.dom.grenades.dataset.type === 'limpet'
        && hud.dom.grenadeTypeChips[1].classList.contains('is-selected')
        && hud.dom.grenadeName.textContent === 'LIMPET CHARGE';
      hud.setState({ grenades: [1, 1, 0], grenadeType: 0, grenadeCharge: 0, grenadeCharging: true });
      const heldState = hud.dom.grenades.classList.contains('is-charging')
        && hud.dom.grenadeHint.textContent === 'HOLD · RELEASE';
      hud.setState({
        grenades: [1, 1, 0], grenadeType: 0, grenadeCharge: 1, grenadeCharging: true,
        grenadeCook01: 0.75, grenadeCookLeftMs: 650,
      });
      ok(fullState && heldState
        && hud.dom.grenades.classList.contains('is-cooking')
        && hud.dom.grenades.classList.contains('is-critical')
        && hud.dom.grenadeHint.textContent === 'COOKING · 0.7s'
        && hud.dom.grenadeChargeFill.style.transform === 'scaleX(0.25)',
      'grenade HUD flags a maxed charge, the held state from the first frame, and a burning cook');
      hud.setState({ charge01: 0.4, chainAt: 0.85 });
      const chargingMeter = hud.dom.chargeMeter.classList.contains('is-visible')
        && hud.dom.chargeMeter.classList.contains('is-charging')
        && !hud.dom.chargeMeter.classList.contains('is-chain')
        && hud.dom.chargeMeterFill.style.transform === 'scaleX(0.4)'
        && hud.dom.chargeMeterLabel.textContent === 'CHARGING';
      hud.setState({ charge01: 0.9, chainAt: 0.85 });
      const chainMeter = hud.dom.chargeMeter.classList.contains('is-chain')
        && hud.dom.chargeMeterLabel.textContent === 'CHAIN ARC READY';
      hud.setState({ charge01: null });
      ok(chargingMeter && chainMeter && !hud.dom.chargeMeter.classList.contains('is-visible'),
        'the coil meter shows the live LONGARC charge, flags chain readiness, and hides for other weapons');
      hud.setState({ charge01: 0.5, chainAt: null });
      const chainlessMeter = hud.dom.chargeMeter.classList.contains('is-visible')
        && !hud.dom.chargeMeter.classList.contains('is-chain')
        && hud.dom.chargeMeterChain.style.display === 'none'
        && hud.dom.chargeMeterLabel.textContent === 'CHARGING';
      hud.setState({ charge01: 1 });
      ok(chainlessMeter && !hud.dom.chargeMeter.classList.contains('is-chain')
        && hud.dom.chargeMeterLabel.textContent === 'CHARGED',
      'a chainAt-null charge weapon hides the chain mark and settles on CHARGED at full');
      hud.setState({ charge01: null });

      hud.setState({ wid: 'knife', wname: 'K-7 RIPPER', mag: 0, reserve: 0 });
      const meleeAmmo = hud.dom.mag.textContent === '∞'
        && hud.dom.sep.style.display === 'none'
        && hud.dom.res.style.display === 'none'
        && !hud.dom.mag.classList.contains('vb-low');
      hud.setState({ wid: 'rifle', mag: 24, reserve: 3 });
      ok(meleeAmmo && hud.dom.mag.textContent === '24'
        && hud.dom.sep.style.display !== 'none'
        && hud.dom.res.style.display !== 'none',
      'melee ammo renders an infinite magazine with no reserve and a gun restores the readout');

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
          === 'BOMB PLANTED AT SITE A'
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
        && document.getElementById('match-result-score').textContent.replace(/\s/g, '') === '7—4'
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
      hud.setPlayers(players);
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
      const smgButton = document.getElementById('buy-btn-smg');
      const sniperButton = document.getElementById('buy-btn-sniper');
      ok(!Object.hasOwn(globalThis, 'location')
        && hud.isBuyMenuOpen()
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
      hud.triggerPurchase('smg');
      hud.triggerPurchase('laser');
      hud.triggerPurchase('sniper');
      ok(purchases.join(',') === 'smg'
        && [
          buyCredits.textContent,
          ownedCard.className,
          ownedCard.textContent,
          smgButton.className,
          smgButton.textContent,
        ].join('|') === authoritativeBuyView,
      'buy requests reject unknown and unaffordable weapons without local purchase optimism');

      hud.setBuyMenuState({
        open: true,
        phase: 'prep',
        credits: 2000,
        owned: ['revolver', 'smg'],
      });
      hud.triggerPurchase('smg');
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

      const assertDisposed = (instance, ownedRoots, ownerDocument, ownerWindow, label) => {
        ok(!instance.built
          && instance.names.size === 0
          && instance.killfeedTimers.size === 0
          && instance._deferredTimers.size === 0
          && instance._ownedRoots.size === 0
          && instance.dmgActive.length === 0
          && instance.dmgPool.length === 0
          && instance._latestPlayers.length === 0
          && instance._latestMatch === null
          && instance._latestSelfRow === null
          && instance._buyMenuState.owned.length === 0,
        `${label} clears every initialized HUD collection and built state`);
        ok(Object.keys(instance.dom).length === 0
          && Object.keys(instance.matchDom).length === 0
          && Object.keys(instance.lobbyDom).length === 0
          && Object.keys(instance.buyDom).length === 0
          && Object.keys(instance.settingsDom).length === 0,
        `${label} releases all retained DOM collections`);
        ok(instance.onMenuAction === null
          && instance._lobbyCallbacks === null
          && instance._buyMenuCallbacks === null
          && instance._settingsOnChange === null
          && instance._settingsOnResume === null,
        `${label} releases lifecycle callback references`);
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
        assertDisposed(instance, ownedRoots, ownerDocument, ownerWindow, label);
        const callbacksAfterDispose = timerCallbacksFired;
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));
        ok(timerCallbacksFired === callbacksAfterDispose && timers.size === 0,
          `${label} leaves no deferred callback able to run after disposal`);
        instance.dispose();
        assertDisposed(instance, ownedRoots, ownerDocument, ownerWindow,
          `${label} second disposal`);
      };

      hud.openSettings();
      hud.hitmark(true);
      hud.killRow({
        killer: 'HOST',
        victim: 'RIVAL',
        weapon: 'smg',
        hs: false,
      });
      hud.killRow({
        killer: 'NEWEST',
        victim: 'LATEST',
        weapon: 'sniper',
        hs: true,
        longRange: true,
        noScope: true,
      });
      ok(hud.dom.kf.children.map((row) => row.children[0]?.textContent).join(',')
        === 'NEWEST,HOST',
      'killfeed inserts the newest row before the prior row');
      ok(hud.dom.kf.children[0].children.map((node) => node.textContent).join('|')
        === 'NEWEST|LONGSHOT MK-II|HEADSHOT|LONG RANGE|NO-SCOPE|LATEST'
        && hud.dom.kf.children[0].querySelector('.kf-weapon-icon')?.src.endsWith('/sniper.png'),
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
        && hud.killfeedTimers.size > 0
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
    } finally {
      hud?.dispose();
      restore();
    }
  }

}
