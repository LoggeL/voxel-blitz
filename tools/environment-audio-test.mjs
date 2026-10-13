import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

// Render the production graph in a real browser, including the voxel model,
// distance panner, filtering, shared room responses and master limiter.
async function browserChecks() {
  const { AudioEngine, buildMasterGraph } = await import('/js/audio/engine.js');
  const { VoicePool } = await import('/js/audio/voices.js');
  const { STONE } = await import('/shared/world/blocks.js');
  function world(enclosed = true) {
    return { mutationCount: 0, breached: false, enclosed,
      getBlock(x, y, z) {
        if (y === 0) return STONE;
        if (!this.enclosed) return 0;
        if (x < 0 || x > 10 || y < 0 || y > 8 || z < 0 || z > 10) return 0;
        if (x === 0 || x === 10 || z === 0 || z === 10 || y === 8) return STONE;
        return x === 4 && !(this.breached && y >= 1 && y <= 4 && z >= 4 && z <= 6) ? STONE : 0;
      },
    };
  }
  function rig(terrain) {
    const ctx = new OfflineAudioContext(2, 48000 * 2.5, 48000);
    const engine = new AudioEngine();
    const { bus, limiter } = buildMasterGraph(ctx, 0.9);
    engine._ctx = ctx;
    engine._bus = bus;
    engine._masterLimiter = limiter;
    engine.setWorld(terrain);
    engine.setListener({ pos: [1.5, 2.5, 5.5], fwd: [1, 0, 0] });
    ctx.listener.positionX.value = 1.5;
    ctx.listener.positionY.value = 2.5;
    ctx.listener.positionZ.value = 5.5;
    return { ctx, engine, pool: new VoicePool(engine) };
  }
  async function render(kind, master = 0.9) {
    const terrain = world(kind !== 'outdoor');
    terrain.breached = kind === 'open';
    const { ctx, engine, pool } = rig(terrain);
    engine.setMasterVolume(master);
    const defer = () => ({ ...engine._acoustics.sample([7.5, 2.5, 5.5], [1.5, 2.5, 5.5]),
      gain: 0, wet: 0, deferred: true, budgetLimited: true });
    if (kind === 'deferred') engine.sampleAcoustics = defer;
    const out = pool.acquire({ pos: [7.5, 2.5, 5.5], acousticKind: 'test' }, 0.2);
    if (kind === 'obsolete') {
      engine.sampleAcoustics = defer;
      terrain.mutationCount++;
      pool.updateAcoustics(true);
    }
    if (kind === 'movedSource' || kind === 'movedListener') {
      engine._acoustics._frameReads = engine._acoustics.limits.maxReadsPerFrame;
      if (kind === 'movedSource') pool.refresh(out, { pos: [8.5, 2.5, 1.5] }, 0.2);
      else engine.setListener({ pos: [1.5, 2.5, 1.5] });
      pool.updateAcoustics(true);
    }
    const data = ctx.createBuffer(1, 4800, 48000);
    const pcm = data.getChannelData(0);
    let seed = 41;
    for (let i = 0; i < pcm.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pcm[i] = (seed / 2147483648 - 1) * 0.18 * Math.min(1, i / 100);
    }
    const source = ctx.createBufferSource();
    source.buffer = data;
    source.connect(out);
    source.start(0.01);
    const sample = engine.acousticsDiagnostics().active[0].sample;
    const rendered = await ctx.startRendering();
    const channel = rendered.getChannelData(0);
    const rms = (from, to) => {
      let power = 0;
      for (let i = Math.floor(from * 48000); i < Math.floor(to * 48000); i++) power += channel[i] ** 2;
      return Math.sqrt(power / ((to - from) * 48000));
    };
    let peak = 0, onset = -1;
    for (let i = 0; i < channel.length; i++) {
      peak = Math.max(peak, Math.abs(channel[i]));
      if (onset < 0 && Math.abs(channel[i]) > 1e-5) onset = i / 48000;
    }
    const result = { sample, rms: rms(0.01, 0.13), tail: rms(0.2, 0.6), peak, onset };
    pool.disposeAll();
    engine.setWorld(null);
    return result;
  }

  const terrain = world();
  const { engine, pool, ctx } = rig(terrain);
  const voice = pool.acquire({ pos: [7.5, 2.5, 5.5] }, 2);
  const entry = pool._byOutput.get(voice);
  const graph = engine._environment;
  const closed = entry.environment.sample;
  const originalGain = entry.environment.gain;
  terrain.breached = true;
  terrain.mutationCount++;
  engine.invalidateAcoustics();
  const breached = entry.environment.sample;
  pool.refresh(voice, { pos: [2.5, 2.5, 5.5] }, 2);
  engine.invalidateAcoustics();
  const moved = entry.environment.sample;
  // Exhaust this audio frame's actual model budget. Same-path cached results
  // remain valid, while new source/listener paths wait silently for their DDA.
  engine._acoustics._frameReads = engine._acoustics.limits.maxReadsPerFrame;
  pool.updateAcoustics(true);
  const retainedTrustedPath = entry.environment.sample === moved && !entry.acousticDeferred;
  pool.refresh(voice, { pos: [7.5, 2.5, 1.5] }, 2);
  pool.updateAcoustics(true);
  const movedSourceMuted = entry.acousticDeferred && entry.environment.sample.gain === 0;
  pool.refresh(voice, { pos: [2.5, 2.5, 5.5] }, 2);
  pool.updateAcoustics(true);
  engine.setListener({ pos: [7.5, 2.5, 1.5] });
  pool.updateAcoustics(true);
  const movedListenerMuted = entry.acousticDeferred && entry.environment.sample.gain === 0;
  engine.setListener({ pos: [1.5, 2.5, 5.5] });
  pool.updateAcoustics(true);
  terrain.mutationCount++;
  pool.updateAcoustics(true);
  const obsoletePathMuted = entry.environment.sample.deferred && entry.environment.sample.gain === 0;
  const deferredVoice = pool.acquire({ pos: [8.5, 2.5, 5.5] }, 0.2);
  const deferredStartsSilent = pool._byOutput.get(deferredVoice).environment.sample.gain === 0;
  pool.release(deferredVoice);
  engine._acoustics._frameReads = 0;
  engine._acoustics._optionalFrameReads = 0;
  pool.updateAcoustics(true);
  const pendingRecovers = !entry.acousticDeferred && !entry.environment.sample.deferred
    && entry.environment.sample.gain === 1;
  const self = pool.acquire({ environment: true, acousticKind: 'fire' }, 0.3);
  const selfEntry = pool._byOutput.get(self);
  const ui = pool.acquire(null, 0.3);
  const uiEntry = pool._byOutput.get(ui);
  const sharedBefore = engine._environment;
  for (let i = 0; i < 90; i++) pool.acquire({ pos: [7.5, 2.5, 5.5] }, 0.2);
  const status = {
    closed, breached, moved, retainedTrustedPath, movedSourceMuted, movedListenerMuted,
    obsoletePathMuted, deferredStartsSilent, pendingRecovers,
    sameGain: entry.environment.gain === originalGain,
    sameSharedGraph: graph === sharedBefore && graph === engine._environment,
    convolverCount: graph.nodes.filter(node => node instanceof ConvolverNode).length,
    positional: pool._positional.length, total: pool._voices.length,
    timers: pool._cleanupTimers.size,
    selfDry: selfEntry.environment.gain.gain.value,
    selfPositional: !!selfEntry.panner, uiDry: uiEntry.environment === null,
    echoDisabled: engine.echoIn === null,
    directDelay: entry.environment.gain.constructor.name,
  };
  engine.setWorld(null);
  status.afterLeave = engine.acousticsDiagnostics();
  status.uiSurvivesLeave = pool._byOutput.has(ui);
  status.environmentVoicesAfterLeave = pool._voices.filter(v => v.environment).length;
  pool.disposeAll();
  status.timersAfterDispose = pool._cleanupTimers.size;
  // Leave a suspended offline context unrendered: no source was started in it.
  return { status, renders: {
    closed: await render('closed'), open: await render('open'),
    outdoor: await render('outdoor'), mute: await render('open', 0),
    deferred: await render('deferred'), obsolete: await render('obsolete'),
    movedSource: await render('movedSource'), movedListener: await render('movedListener'),
  } };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = startServer({ cwd: root, entry: 'tools/capture-server.mjs', failureContext: 'environment audio test' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port, { path: '/audio-preview.html' });
  browser = await launchCdpSession(`http://127.0.0.1:${port}/audio-preview.html`);
  const { status: s, renders: r } = await browser.page.evaluate(`(${browserChecks.toString()})()`);
  assert.ok(s.closed.gain < 0.5 && s.closed.lowpassHz < 6000, 'wall attenuates and muffles an active source');
  assert.ok(s.breached.gain > s.closed.gain * 1.5, 'destroyed wall immediately opens an existing voice');
  assert.ok(s.breached.lowpassHz > s.closed.lowpassHz * 1.5, 'destroyed wall immediately restores high frequencies');
  assert.equal(s.moved.gain, 1, 'moving a sustained source updates its path');
  assert.ok(s.retainedTrustedPath, 'model cache preserves a trusted path with the same source, listener and voxel revision');
  assert.ok(s.movedSourceMuted, 'moving a source across existing cover cannot reuse its old clear path under load');
  assert.ok(s.movedListenerMuted, 'moving the listener across existing cover cannot reuse an old clear path under load');
  assert.ok(s.obsoletePathMuted, 'budget deferral never keeps an old open path across voxel revisions');
  assert.ok(s.deferredStartsSilent, 'a new unresolved source starts silent instead of guessing its cover');
  assert.ok(s.pendingRecovers, 'deferred source resumes once its real path is computed');
  assert.ok(s.sameGain && s.sameSharedGraph, 'refresh and destruction reuse existing graphs');
  assert.equal(s.convolverCount, 3, 'only three shared convolution responses exist under fire');
  assert.equal(s.positional, 24, 'positional budget remains bounded');
  assert.ok(s.total <= 48 && s.timers <= 48, 'global voices and cleanup timers remain bounded');
  assert.equal(s.selfDry, 1, 'local weapon direct gain is preserved');
  assert.equal(s.selfPositional, false, 'local report remains centered');
  assert.ok(s.uiDry && s.uiSurvivesLeave, 'UI sounds bypass world acoustics and survive map teardown');
  assert.ok(s.echoDisabled, 'legacy echo cannot bypass obstruction or double the reflection tail');
  assert.equal(s.afterLeave.enabled, false);
  assert.equal(s.afterLeave.profiles, 0, 'map teardown releases shared reverbs');
  assert.equal(s.environmentVoicesAfterLeave, 0);
  assert.equal(s.timersAfterDispose, 0);
  assert.ok(r.open.rms > r.closed.rms * 2, 'real rendered PCM is louder through a destroyed wall');
  assert.ok(r.open.tail > r.outdoor.tail * 2, 'an enclosed room has a stronger real reflection tail than outdoors');
  assert.ok(Math.abs(r.open.onset - r.outdoor.onset) < 0.002, 'room reflections do not add direct travel delay');
  assert.equal(r.mute.peak, 0, 'master zero mutes direct and reflected sound');
  assert.equal(r.deferred.peak, 0, 'unresolved new paths produce no audible PCM');
  assert.equal(r.obsolete.peak, 0, 'a deferred trace after a voxel change immediately mutes obsolete path PCM');
  assert.equal(r.movedSource.peak, 0, 'a deferred moved source emits no audio from an untraced path');
  assert.equal(r.movedListener.peak, 0, 'a deferred moved listener hears no audio from an untraced path');
  assert.ok(Object.values(r).every(row => row.peak <= 1), 'all room profiles remain limiter bounded');
  assert.equal(browser.page.errors.length, 0, browser.page.errors.join('\n'));
  console.log('Environment audio: live graph refresh, shared reverb budget, lifecycle and actual WebAudio PCM passed.');
  console.log(JSON.stringify({ closed: r.closed, breached: r.open, outdoor: r.outdoor }, null, 2));
} finally {
  await browser?.close();
  await stopServer(server);
}
