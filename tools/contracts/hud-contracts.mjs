import { MODE_IDS, GUN_GAME_WEAPON_ORDER } from '../../shared/modes.js';
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
      document.getElementById('play-btn').click();
      ok(menuActions.length === 2 && menuActions[1].mode === 'quick'
        && !Object.hasOwn(menuActions[1], 'gameMode'), 'Quick Play keeps server map rotation');

      document.getElementById('training-btn').click();
      const trainingAction = menuActions.at(-1);
      ok(trainingAction.mode === 'create' && trainingAction.gameMode === 'training'
        && trainingAction.map === 'killhouse' && trainingAction.bots === 0
        && trainingAction.name === document.getElementById('name-input').value,
      'the main-menu Killhouse entry creates a training lobby with the current identity and no combat bots');

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
      hud.setState({ wid: 'sniper', adsT01: 0.7199, alive: true, hp: 100 });
      ok(!document.getElementById('sniper-scope'),
        'sniper scope stays absent immediately below the ADS threshold');
      hud.setState({ adsT01: 0.72 });
      ok(document.getElementById('sniper-scope').classList.contains('active'),
        'sniper scope enters exactly at the ADS threshold');
      flushRaf();
      ok(document.getElementById('sniper-scope').style.opacity === '1'
        && !document.getElementById('sniper-scope').classList.contains('exiting'),
      'sniper scope RAF reaches its fully active live state');

      hud.setState({ adsT01: 0.7199 });
      ok(!document.getElementById('sniper-scope').classList.contains('active')
        && document.getElementById('sniper-scope').classList.contains('exiting'),
      'dropping below the threshold begins the scope exit transition');
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
      const breathHidden = document.getElementById('breath-meter').style.display === 'none';
      hud.setState({ adsT01: 0, holdingBreath: true, breath01: 0.4 });
      ok(breathHolding && breathHidden && document.getElementById('breath-meter').style.display === 'none',
        'breath meter appears only while aiming and the window is draining or spent');

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

      hud.setState({ grenades: [1, 1, 0], grenadeType: 0, grenadeCharge: 0.5 });
      const fragChip = document.querySelectorAll('.vb-grenade-type')[0];
      const pulseChip = document.querySelectorAll('.vb-grenade-type')[2];
      ok(document.querySelectorAll('.vb-grenade-type').length === 3
        && fragChip.classList.contains('is-selected')
        && fragChip.querySelectorAll('.vb-grenade-icon').filter((slot) => !slot.classList.contains('is-spent')).length === 1
        && pulseChip.classList.contains('is-empty')
        && document.getElementById('grenade-count').dataset.type === 'frag'
        && document.getElementById('grenade-count').classList.contains('is-charging')
        && !document.getElementById('grenade-count').classList.contains('is-full')
        && document.querySelector('.vb-grenade-charge').children[0].style.transform === 'scaleX(0.5)',
      'grenade HUD renders one chip per throwable with remaining pips, the selection, and live hold charge');
      hud.setState({ grenades: [1, 1, 0], grenadeType: 1, grenadeCharge: 1 });
      const fullState = document.getElementById('grenade-count').classList.contains('is-full')
        && document.querySelector('.vb-grenade-hint').textContent === 'MAX · RELEASE'
        && document.getElementById('grenade-count').dataset.type === 'limpet'
        && document.querySelectorAll('.vb-grenade-type')[1].classList.contains('is-selected')
        && document.querySelector('.vb-grenade-name').textContent === 'LIMPET CHARGE';
      hud.setState({ grenades: [1, 1, 0], grenadeType: 0, grenadeCharge: 0, grenadeCharging: true });
      const heldState = document.getElementById('grenade-count').classList.contains('is-charging')
        && document.querySelector('.vb-grenade-hint').textContent === 'HOLD · RELEASE';
      hud.setState({
        grenades: [1, 1, 0], grenadeType: 0, grenadeCharge: 1, grenadeCharging: true,
        grenadeCook01: 0.75, grenadeCookLeftMs: 650,
      });
      ok(fullState && heldState
        && document.getElementById('grenade-count').classList.contains('is-cooking')
        && document.getElementById('grenade-count').classList.contains('is-critical')
        && document.querySelector('.vb-grenade-hint').textContent === 'COOKING · 0.7s'
        && document.querySelector('.vb-grenade-charge').children[0].style.transform === 'scaleX(0.25)',
      'grenade HUD flags a maxed charge, the held state from the first frame, and a burning cook');
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
      hud.setState({ wid: 'knife', wname: 'K-7 RIPPER', mag: 0, reserve: 0 });
      const meleeAmmo = document.getElementById('ammocount').textContent === '∞'
        && document.getElementById('ammo').children[2].style.display === 'none'
        && document.getElementById('ammoreserve').style.display === 'none'
        && !document.getElementById('ammocount').classList.contains('vb-low');
      hud.setState({ wid: 'rifle', mag: 24, reserve: 3 });
      ok(meleeAmmo && document.getElementById('ammocount').textContent === '24'
        && document.getElementById('ammo').children[2].style.display !== 'none'
        && document.getElementById('ammoreserve').style.display !== 'none' && document.getElementById('ammoreserve').textContent === '3',
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
          ok(headers.join(',') === '#,PLAYER,KILLS,DEATHS'
            && document.getElementById('match-phase-label').textContent === '#1 · 5 KILLS'
            && document.getElementById('scores').querySelectorAll('.vb-sb-bomb-badge').length === 0,
          'FFA shows local rank and kills with a ranked K/D table and no objective baggage');
        } else if (mode === 'tdm') {
          ok(headers.join(',') === 'PLAYER,KILLS,DEATHS,PLAYER,KILLS,DEATHS'
            && document.getElementById('scores').querySelectorAll('.vb-scoreboard-team').length === 2,
          'TDM groups players into two team tables with only relevant combat stats');
        } else if (mode === 'gungame') {
          ok(headers.join(',') === '#,PLAYER,WEAPON'
            && /12 \/ 12/.test(document.getElementById('match-phase-label').textContent)
            && /12\/12/.test(document.getElementById('scores').textContent),
          'Gun Game clamps authoritative weapon progression to the final weapon');
        } else {
          ok(!visible(document.getElementById('match-header')) && headers.join(',') === 'PLAYER',
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
      ok(minigunCard.querySelector('.vb-buy-key-badge').textContent !== 'GRENADE',
        'minigun armory card is labelled as a weapon');
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
    } finally {
      hud?.dispose();
      restore();
    }
  }

}
