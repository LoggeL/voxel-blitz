export async function runAudioContracts(ok, installGlobals) {
  // Audio: install the recording context before module evaluation so every
  // graph edge, source start, voice steal, and lifecycle transition is real.
  {
    class FakeListenerTarget {
      constructor() {
        this.listeners = new Map();
        this.addedListeners = [];
        this.removedListeners = [];
        this.unmatchedRemovals = [];
      }
      addEventListener(type, fn, options) {
        const capture = options === true || options?.capture === true;
        this.addedListeners.push({ type, fn, capture });
        let listeners = this.listeners.get(type);
        if (!listeners) this.listeners.set(type, listeners = []);
        if (!listeners.some((entry) => entry.fn === fn && entry.capture === capture)) {
          listeners.push({ fn, capture });
        }
      }
      removeEventListener(type, fn, options) {
        const capture = options === true || options?.capture === true;
        const listeners = this.listeners.get(type);
        const index = listeners?.findIndex((entry) =>
          entry.fn === fn && entry.capture === capture) ?? -1;
        const removal = { type, fn, capture };
        this.removedListeners.push(removal);
        if (index < 0) {
          this.unmatchedRemovals.push(removal);
          return;
        }
        listeners.splice(index, 1);
        if (!listeners.length) this.listeners.delete(type);
      }
      dispatch(type) {
        const event = { type, target: this };
        for (const { fn } of [...(this.listeners.get(type) || [])]) {
          fn.call(this, event);
        }
      }
      listenerCount(type) {
        if (type) return this.listeners.get(type)?.length || 0;
        return [...this.listeners.values()]
          .reduce((total, listeners) => total + listeners.length, 0);
      }
      addCount(type) {
        return this.addedListeners.filter((entry) => entry.type === type).length;
      }
    }

    class FakeAudioParam {
      constructor(value = 0) {
        this.value = value;
        this.events = [];
      }
      setValueAtTime(value, time) {
        this.value = value;
        this.events.push(['set', value, time]);
        return this;
      }
      linearRampToValueAtTime(value, time) {
        this.value = value;
        this.events.push(['linear', value, time]);
        return this;
      }
      exponentialRampToValueAtTime(value, time) {
        this.value = value;
        this.events.push(['exponential', value, time]);
        return this;
      }
      cancelScheduledValues(time) {
        this.events.push(['cancel', time]);
        return this;
      }
    }

    class FakeAudioNode {
      constructor(context, kind) {
        this.context = context;
        this.kind = kind;
        this.connections = [];
        this.disconnectCount = 0;
        context.nodes.push(this);
      }
      connect(target) {
        this.connections.push(target);
        return target;
      }
      disconnect() {
        this.disconnectCount++;
      }
      get disconnected() {
        return this.disconnectCount > 0;
      }
    }

    class FakeScheduledNode extends FakeAudioNode {
      constructor(context, kind) {
        super(context, kind);
        this.starts = [];
        this.stops = [];
      }
      start(time = 0) {
        this.starts.push(time);
        this.context.starts.push({ node: this, time });
      }
      stop(time = 0) {
        this.stops.push(time);
      }
    }

    class FakeAudioContext extends FakeListenerTarget {
      static instances = [];

      constructor() {
        super();
        this.state = 'suspended';
        this.currentTime = 0;
        this.sampleRate = 64;
        this.nodes = [];
        this.starts = [];
        this.closeCount = 0;
        this.resumeCount = 0;
        this.resumeSucceeds = true;
        this.destination = new FakeAudioNode(this, 'destination');
        const param = () => new FakeAudioParam();
        this.listener = {
          forwardX: param(), forwardY: param(), forwardZ: param(),
          upX: param(), upY: param(), upZ: param(),
          positionX: param(), positionY: param(), positionZ: param(),
        };
        FakeAudioContext.instances.push(this);
      }
      _emit(type) {
        this.dispatch(type);
      }
      async resume() {
        this.resumeCount++;
        if (this.resumeSucceeds) {
          this.state = 'running';
          this._emit('statechange');
        }
      }
      async close() {
        this.closeCount++;
        this.state = 'closed';
        this._emit('statechange');
      }
      createGain() {
        const node = new FakeAudioNode(this, 'gain');
        node.gain = new FakeAudioParam(1);
        return node;
      }
      createDynamicsCompressor() {
        const node = new FakeAudioNode(this, 'compressor');
        node.threshold = new FakeAudioParam();
        node.knee = new FakeAudioParam();
        node.ratio = new FakeAudioParam();
        node.attack = new FakeAudioParam();
        node.release = new FakeAudioParam();
        return node;
      }
      createBiquadFilter() {
        const node = new FakeAudioNode(this, 'biquad');
        node.frequency = new FakeAudioParam();
        node.Q = new FakeAudioParam();
        return node;
      }
      createWaveShaper() {
        return new FakeAudioNode(this, 'waveshaper');
      }
      createDelay() {
        const node = new FakeAudioNode(this, 'delay');
        node.delayTime = new FakeAudioParam();
        return node;
      }
      createOscillator() {
        const node = new FakeScheduledNode(this, 'oscillator');
        node.frequency = new FakeAudioParam();
        node.detune = new FakeAudioParam();
        return node;
      }
      createBufferSource() {
        const node = new FakeScheduledNode(this, 'buffer-source');
        node.playbackRate = new FakeAudioParam(1);
        return node;
      }
      createStereoPanner() {
        const node = new FakeAudioNode(this, 'stereo-panner');
        node.pan = new FakeAudioParam();
        return node;
      }
      createPanner() {
        const node = new FakeAudioNode(this, 'panner');
        node.positionX = new FakeAudioParam();
        node.positionY = new FakeAudioParam();
        node.positionZ = new FakeAudioParam();
        return node;
      }
      createBuffer(channels, length) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return { getChannelData: (channel) => data[channel] };
      }
      async decodeAudioData(data) {
        return { decoded: data, duration: 0.25 };
      }
    }

    const audioDocument = new FakeListenerTarget();
    audioDocument.visibilityState = 'visible';
    const audioWindow = new FakeListenerTarget();
    audioWindow.AudioContext = FakeAudioContext;
    const restore = installGlobals({
      document: audioDocument,
      window: audioWindow,
    });
    let sfx = null;
    try {
      ({ sfx } = await import('../../public/js/audio/sfx.js'));
      sfx.setMasterVolume(9);
      await sfx.init();
      await sfx.init();
      await sfx.unlock();

      ok(FakeAudioContext.instances.length === 1,
        'audio init and unlock reuse one live AudioContext');
      const audio = FakeAudioContext.instances[0];
      ok(audioDocument.addCount('visibilitychange') === 1
          && audioWindow.addCount('pageshow') === 1
          && audioDocument.listenerCount('visibilitychange') === 1
          && audioWindow.listenerCount('pageshow') === 1
          && audio.listenerCount('statechange') === 1,
      'repeated audio init arms each lifecycle callback exactly once');

      const gestureAddBaseline = new Map(
        ['pointerdown', 'touchend', 'keydown']
          .map((type) => [type, audioDocument.addCount(type)]));
      audio.resumeSucceeds = false;
      audio.state = 'suspended';
      audio._emit('statechange');
      await sfx.init();
      audio._emit('statechange');
      await sfx.init();
      ok(['pointerdown', 'touchend', 'keydown'].every((type) =>
        audioDocument.listenerCount(type) === 1
          && audioDocument.addCount(type) === gestureAddBaseline.get(type) + 1),
      'repeated suspended recovery arms at most one gesture callback per event');

      const startsBeforeSuspendedCue = audio.starts.length;
      sfx.fire('rifle');
      await Promise.resolve();
      ok(audio.starts.length === startsBeforeSuspendedCue,
        'a cue requested while audio is suspended remains queued');
      audio.resumeSucceeds = true;
      audioDocument.dispatch('pointerdown');
      await Promise.resolve();
      ok(audio.state === 'running'
          && audio.starts.length > startsBeforeSuspendedCue
          && ['pointerdown', 'touchend', 'keydown'].every((type) =>
            audioDocument.listenerCount(type) === 0),
      'a dispatched recovery gesture resumes audio, flushes the cue, and disarms gesture callbacks');
      const master = audio.nodes.find((node) => node.kind === 'gain');
      const limiter = master?.connections[0];
      ok(master?.gain.value === 1
        && limiter?.kind === 'compressor'
        && limiter.connections.includes(audio.destination),
      'all audio routes through a clamped master gain and terminal limiter');

      sfx.setMasterVolume(-4);
      ok(master.gain.value === 0
        && master.gain.events.some((event) => event[0] === 'set' && event[1] === 0),
      'live master volume clamps low and updates the existing graph');
      sfx.setMasterVolume(0.35);

      const startedBy = (fn) => {
        const before = audio.starts.length;
        fn();
        return audio.starts.length - before;
      };
      ok(startedBy(() => sfx.fire('lmg')) >= 4,
        'LMG fire starts its layered procedural voice');
      ok(startedBy(() => sfx.fire('revolver')) >= 4,
        'revolver fire starts its layered procedural voice');
      ok(startedBy(() => {
        sfx.impact('metal', 0.8);
        sfx.hitmark(true);
      }) >= 7, 'metal impact and headshot hit voices start');
      ok(startedBy(() => {
        sfx.reloadClick(1, 'lmg');
        sfx.reloadClick(2, 'revolver');
      }) >= 5, 'LMG and revolver reload voices start');

      const sampleLoad = await sfx.loadSamples({
        'weapons.rifle.fire': '/assets/audio/weapons/rifle/fire.ogg',
      }, async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
      ok(sampleLoad.loaded === 1 && sampleLoad.failed === 0
          && startedBy(() => sfx.fire('rifle')) === 1,
      'a loaded local sample occupies the fire cue seam without layering procedural sources');

      const liveDirectToMaster = () => audio.nodes.filter((node) =>
        !node.disconnected && node.connections.includes(master));
      const voiceBaseline = liveDirectToMaster().length;
      for (let i = 0; i < 20; i++) sfx.fire('lmg');
      const afterLmg = liveDirectToMaster().length;
      ok(afterLmg - voiceBaseline <= 6,
        'LMG voice stealing keeps at most six live output nodes');
      for (let i = 0; i < 20; i++) sfx.fire('revolver');
      const afterRevolver = liveDirectToMaster().length;
      ok(afterRevolver - afterLmg <= 4,
        'revolver voice stealing keeps at most four live output nodes');

      for (let i = 0; i < 60; i++) sfx.hitmark(false);
      ok(liveDirectToMaster().length <= 49,
        'global voice registry leaves at most 48 live outputs plus the echo bus');
      for (let i = 0; i < 30; i++) {
        sfx.impact('metal', 1, { pos: [i, 0, -i] });
      }
      ok(audio.nodes.filter((node) =>
        node.kind === 'panner' && !node.disconnected).length <= 16,
      'positional voice registry leaves at most sixteen live panner nodes');

      await sfx.dispose();
      ok(audio.state === 'closed'
          && audio.closeCount === 1
          && audio.listenerCount() === 0
          && audioDocument.listenerCount() === 0
          && audioWindow.listenerCount() === 0
          && audio.unmatchedRemovals.length === 0
          && audioDocument.unmatchedRemovals.length === 0
          && audioWindow.unmatchedRemovals.length === 0,
      'audio dispose closes once and removes every exact registered callback');
      await sfx.init();
      const replacementAudio = FakeAudioContext.instances[1];
      ok(FakeAudioContext.instances.length === 2
          && replacementAudio.state === 'running'
          && replacementAudio.nodes.find((node) => node.kind === 'gain')?.gain.value === 0.35,
      'audio dispose permits clean re-init with the persisted clamped master volume');
      await sfx.dispose();
      ok(replacementAudio.listenerCount() === 0
          && audioDocument.listenerCount() === 0
          && audioWindow.listenerCount() === 0
          && replacementAudio.unmatchedRemovals.length === 0
          && audioDocument.unmatchedRemovals.length === 0
          && audioWindow.unmatchedRemovals.length === 0,
      'reinitialized audio also disposes without leaked or mismatched callbacks');

      const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
      const restoreDetachedWindow = installGlobals({
        window: { AudioContext: FakeAudioContext },
      });
      delete globalThis.document;
      try {
        const detachedInstanceCount = FakeAudioContext.instances.length;
        await sfx.init();
        const detachedAudio = FakeAudioContext.instances.at(-1);
        ok(FakeAudioContext.instances.length === detachedInstanceCount + 1
            && detachedAudio.state === 'running'
            && detachedAudio.listenerCount('statechange') === 1,
        'detached audio initializes when window and document expose no listener APIs');
        await sfx.dispose();
        ok(detachedAudio.listenerCount() === 0
            && detachedAudio.unmatchedRemovals.length === 0,
        'detached audio disposes its context callback without browser listener APIs');
      } finally {
        await sfx.dispose();
        restoreDetachedWindow();
        Object.defineProperty(globalThis, 'document', savedDocument);
      }
    } finally {
      if (sfx) await sfx.dispose();
      restore();
    }
  }

}
