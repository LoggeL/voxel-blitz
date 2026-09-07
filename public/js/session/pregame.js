/**
 * Owns admission attempts, their NetClient, and lobby presentation.
 * The Session facade supplies the small set of lifecycle transitions that cross
 * into live play; no gameplay resource is owned here.
 */
export class PregameFlow {
  constructor({
    hud,
    makeNet,
    getPhase,
    setPhase,
    isTornDown,
    unlockAudio,
    connectUrl,
    closeNet,
    writeName,
    enterMenu,
    detachGameplay,
    enterLive,
    location = null,
    history = null,
  } = {}) {
    this._hud = hud;
    this._makeNet = makeNet;
    this._getPhase = getPhase;
    this._setPhase = setPhase;
    this._isTornDown = isTornDown;
    this._unlockAudio = unlockAudio;
    this._connectUrl = connectUrl;
    this._closeNet = closeNet;
    this._writeName = writeName;
    this._enterMenu = enterMenu;
    this._detachGameplay = detachGameplay;
    this._enterLive = enterLive;
    this._location = location;
    this._history = history;

    this._recoveryGeneration = 0;
    this._rejoin = null;
    this._generation = 0;
    this._attempt = null;
    this._net = null;
    this._unsubs = [];
  }

  get net() { return this._net; }
  get attempt() { return this._attempt; }

  resetAttempt() {
    this._attempt = null;
  }

  invalidate() {
    this._recoveryGeneration++;
    this._generation++;
    this._attempt = null;
    this.detachListeners();
  }

  replaceNet() {
    this._generation++;
    this.detachListeners();
    this._detachGameplay();

    const previous = this._net;
    if (previous) this._closeNet(previous);

    const net = this._makeNet();
    if (!net || typeof net.on !== 'function' || typeof net.close !== 'function') {
      throw new TypeError('Session makeNet must return a NetClient-compatible object');
    }
    this._net = net;
    this._unsubs = [
      net.on('lobby', (state) => this._handleLobbyState(net, state)),
      net.on('serverError', (error) => this._handleServerError(net, error)),
      net.on('close', () => this._handleClose(net)),
    ];
    return net;
  }

  closeCurrentNet() {
    const net = this._net;
    this._net = null;
    if (net) this._closeNet(net);
  }

  detachListeners() {
    for (const unsubscribe of this._unsubs) unsubscribe();
    this._unsubs = [];
  }

  async begin(action, recoveryToken = null) {
    if (this._isTornDown() || this._getPhase() !== 'menu' || !action) return;
    if (recoveryToken === null) {
      this._recoveryGeneration++;
      this._rejoin = null;
    }
    const audioReady = this._unlockAudio();

    const mode = action.mode === 'create' || action.mode === 'join' ? action.mode : 'quick';
    const name = String(action.name || '').trim().slice(0, 16) || 'Rookie';
    const requestedBots = Number(action.bots);
    const fallbackBots = mode === 'quick' ? 5 : 3;
    const normalizedBots = Number.isFinite(requestedBots)
      ? Math.max(0, Math.min(7, Math.round(requestedBots)))
      : fallbackBots;
    const bots = mode === 'quick' ? Math.max(5, normalizedBots) : normalizedBots;
    const sensitivity = Number(action.sensitivity);
    const code = String(action.code || '').trim().toUpperCase();
    const net = this._net;
    const attempt = {
      recoveryToken,
      generation: this._generation,
      net,
      mode,
      name,
      bots,
      sensitivity,
      code,
      welcome: null,
      mapBytes: null,
      lobbyState: null,
      lobbyShown: false,
      liveStarted: false,
      bootCompleted: false,
    };

    this._attempt = attempt;
    this._setPhase('connecting');
    this._writeName(name);
    this._hud.showJoinState('connecting…');

    net.onMap = (bytes) => {
      if (!this.isActive(attempt)) return;
      attempt.mapBytes = bytes;
      if (attempt.welcome && net.welcome) attempt.welcome = net.welcome;
      this.maybeEnterLive(attempt);
    };

    await audioReady;
    if (!this.isActive(attempt)) return;

    const password = typeof action.password === 'string' ? action.password : '';
    const opts = { mode };
    if (mode !== 'quick') opts.password = password;
    if (mode === 'quick' || mode === 'create') opts.bots = bots;
    if (mode === 'create') {
      opts.gameMode = action.gameMode;
      opts.map = action.map;
    }
    if (mode === 'join') opts.lobby = code;

    try {
      const welcome = await net.connect(this._connectUrl(), name, opts);
      if (!this.isActive(attempt)) {
        this._closeNet(net);
        return;
      }
      attempt.welcome = welcome;
      attempt.recoveryToken = null;
      this._rejoin = { mode: mode === 'quick' ? 'quick' : 'join', code: welcome.lobby?.code, name, sensitivity, bots, password };
      if (net.latestLobbyState) attempt.lobbyState = net.latestLobbyState;
      if (this.maybeEnterLive(attempt)) return true;
      if (attempt.lobbyState?.phase === 'waiting') {
        this._presentLobby(attempt, attempt.lobbyState);
      } else if (mode !== 'quick') {
        this._hud.showJoinState('waiting for lobby…');
      }
      return true;
    } catch (error) {
      if (!this.isActive(attempt)) return;
      const detail = error && error.message ? error.message : 'try again';
      if (recoveryToken === null) this._enterMenu(`connection failed — ${detail}`);
      return false;
    }
  }

  async recover() {
    const action = this._rejoin;
    if (!action?.code || this._isTornDown()) {
      this._enterMenu('connection lost. Please join again.');
      return;
    }
    const token = ++this._recoveryGeneration;
    for (let retry = 0; retry < 6; retry++) {
      if (this._isTornDown() || token !== this._recoveryGeneration) return;
      this._enterMenu(`Connection lost. Reconnecting (${retry + 1}/6)…`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** retry)));
      if (this._isTornDown() || token !== this._recoveryGeneration || this._getPhase() !== 'menu') return;
      const connected = await this.begin(action, token);
      if (connected || token !== this._recoveryGeneration) return;
    }
    if (!this._isTornDown() && token === this._recoveryGeneration) {
      this._enterMenu('Could not reconnect. Your room code is still in the link.');
    }
  }

  isActive(attempt) {
    return !this._isTornDown() &&
      attempt === this._attempt &&
      attempt?.net === this._net &&
      attempt.generation === this._generation;
  }

  async setLobbyReady(attempt, value) {
    await this._unlockAudio();
    if (!this.isActive(attempt) || this._getPhase() !== 'lobby') return;
    attempt.net.setReady(!!value);
  }

  async startLobby(attempt) {
    await this._unlockAudio();
    if (!this.isActive(attempt) || this._getPhase() !== 'lobby') return;
    attempt.net.requestStart();
  }

  leaveLobby(attempt = this._attempt) {
    if (!this.isActive(attempt) || this._getPhase() !== 'lobby') return false;
    this._recoveryGeneration++;
    this._rejoin = null;
    this._setPhase('disconnecting');
    this._attempt = null;
    this.detachListeners();
    this._closeNet(attempt.net);
    this.clearInviteQuery();
    this._enterMenu();
    return true;
  }

  clearInviteQuery() {
    try {
      if (!this._location?.href || !this._history?.replaceState) return;
      const url = new URL(this._location.href);
      if (!url.searchParams.has('lobby')) return;
      url.searchParams.delete('lobby');
      this._history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {}
  }

  maybeEnterLive(attempt) {
    if (!this.isActive(attempt) || attempt.liveStarted) return false;
    const lobbyPhase = attempt.lobbyState?.phase;
    const welcomePhase = attempt.welcome?.phase;
    const isLive = attempt.mode === 'quick' || lobbyPhase === 'live' || welcomePhase === 'live';
    if (!isLive || !attempt.welcome || attempt.mapBytes == null) return false;

    attempt.liveStarted = true;
    this._setPhase('booting');
    this.showBootStatus(attempt, 'streaming arena…', 'ok');
    this.detachListeners();
    attempt.net.onMap = null;
    this._enterLive(attempt);
    return true;
  }

  clearCompletedAttempt(attempt) {
    if (this._attempt === attempt) this._attempt = null;
  }

  showBootStatus(attempt, message, tone = '') {
    if (attempt.lobbyShown) this._hud.showLobbyStatus(message, tone);
    else this._hud.showJoinState(message, tone);
  }

  _handleLobbyState(net, state) {
    const attempt = this._attempt;
    if (!attempt || attempt.net !== net || !this.isActive(attempt) || !state) return;
    attempt.lobbyState = state;
    if (state.phase === 'live') {
      this.maybeEnterLive(attempt);
      return;
    }
    if (state.phase === 'waiting' && !attempt.liveStarted) {
      this._presentLobby(attempt, state);
    }
  }

  _presentLobby(attempt, state) {
    if (!this.isActive(attempt) || attempt.liveStarted) return;
    this._setPhase('lobby');
    try {
      if (this._location?.href && this._history?.replaceState) {
        const url = new URL(this._location.href);
        url.searchParams.set('lobby', state.code);
        this._history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch (_) {}
    if (attempt.lobbyShown) {
      this._hud.updateLobby(state);
      return;
    }

    attempt.lobbyShown = true;
    this._hud.showLobby(state, {
      onConfigure: (settings) => {
        if (this.isActive(attempt) && this._getPhase() === 'lobby') attempt.net.configureLobby(settings);
      },
      onReady: (value) => { void this.setLobbyReady(attempt, value); },
      onStart: () => { void this.startLobby(attempt); },
      onLeave: () => this.leaveLobby(attempt),
    });
  }

  _handleServerError(net, error) {
    const attempt = this._attempt;
    if (!attempt || attempt.net !== net || !this.isActive(attempt)) return;
    if (attempt.recoveryToken !== null && attempt.recoveryToken !== undefined) return;
    const message = error && typeof error.msg === 'string'
      ? error.msg
      : (typeof error === 'string' ? error : 'server rejected request');
    if (this._getPhase() === 'lobby') {
      this._hud.showLobbyStatus(message, 'err');
      return;
    }
    this._enterMenu(message);
  }

  _handleClose(net) {
    const attempt = this._attempt;
    if (!attempt || attempt.net !== net || !this.isActive(attempt)) return;
    const phase = this._getPhase();
    if (phase === 'lobby') {
      void this.recover();
    } else if (phase === 'connecting' && attempt.recoveryToken == null) {
      this._enterMenu('connection lost. Please try again.');
    }
  }
}
