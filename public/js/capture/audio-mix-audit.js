import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { sfx } from '../audio/sfx.js';
import { BUILTIN_SAMPLE_MANIFEST, LocalSampleBank } from '../audio/samples.js';
import { VoicePool } from '../audio/voices.js';
import { MINIGUN_REPORT_SLOTS } from '../audio/minigun-motor.js';
import { PICKAXE_SWING_SLOTS, PICKAXE_IMPACT_SLOTS } from '../audio/pickaxe.js';
import { auditBufferPeak, recordedTailComplete } from './audio-source-audit.js';

const RATE = 48_000;
const SECONDS = 3.2;
const rawAssets = new Map();
const decodedAssets = new Map();
const rawUrls = new WeakMap();
const decodedLabels = new WeakMap();
const traces = {};
const checks = [];
const failures = [];
const status = document.getElementById('status');
const content = document.createElement('div');
document.body.append(content);
document.head.insertAdjacentHTML('beforeend', `<style>
body{margin:28px auto;padding:0 20px;max-width:1100px;background:#101418;color:#edf2f7;font:15px/1.5 system-ui}
h1{font-size:26px}h2{font-size:18px;margin:0 0 6px}p{color:#bdc6cf}article{padding:16px;margin:14px 0;background:#182129;border:1px solid #394650;border-radius:8px}
canvas{width:100%;height:96px;display:block;background:#11171c;margin:10px 0}audio{width:100%;height:36px}.pass{color:#85e0aa}.fail{color:#ff9090}summary{cursor:pointer}
</style>`);
status.setAttribute('role', 'status');
status.textContent = 'Rendering the actual game audio pipeline…';

function check(condition, message) {
  checks.push({ passed: !!condition, message });
  if (!condition) failures.push(message);
}

function metricsFor(data) {
  let peak = 0, sum = 0, clipped = 0, onset = -1, last = 0;
  for (let i = 0; i < data.length; i++) {
    const absolute = Math.abs(data[i]);
    peak = Math.max(peak, absolute);
    sum += data[i] * data[i];
    if (absolute >= 0.9999) clipped++;
    if (absolute >= 0.002) { if (onset < 0) onset = i; last = i; }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, data.length)),
    clippedRatio: clipped / Math.max(1, data.length),
    onsetMs: onset < 0 ? Infinity : onset / RATE * 1000,
    audibleTailMs: last / RATE * 1000 };
}

function regionRms(data, start, end) {
  return metricsFor(data.subarray(Math.floor(start * RATE), Math.floor(end * RATE))).rms;
}

async function cachedFetch(url) {
  if (!rawAssets.has(url)) rawAssets.set(url, (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Sample unavailable: ${url} (${response.status})`);
    return response.arrayBuffer();
  })());
  const bytes = await rawAssets.get(url);
  rawUrls.set(bytes, url);
  return { ok: true, arrayBuffer: () => Promise.resolve(bytes) };
}

/** Exercise the production facade, voice pool, loops and limiter in a native
 * OfflineAudioContext. Only lifecycle state/resume are adapted. Scheduled
 * suspends advance the native audio clock before gameplay refreshes run. */
async function renderScenario(label, events, seconds = SECONDS, missingHitSamples = false) {
  const context = new OfflineAudioContext(1, Math.ceil(RATE * seconds), RATE);
  const original = Object.getOwnPropertyDescriptor(window, 'AudioContext');
  const originalRandom = Math.random;
  const originalAcquire = VoicePool.prototype.acquire;
  const originalCleanup = VoicePool.prototype._cleanupVoice;
  const originalSamplePlay = LocalSampleBank.prototype.play;
  if (missingHitSamples) LocalSampleBank.prototype.play = function (slot, ...args) {
    if (slot.startsWith('ui.hitmark.') || slot.startsWith('ui.kill.') || slot === 'impact.flesh') return false;
    return originalSamplePlay.call(this, slot, ...args);
  };
  const trace = { acquisitions: [], cleanups: [], sources: [] };
  VoicePool.prototype.acquire = function (...args) {
    const output = originalAcquire.apply(this, args);
    trace.acquisitions.push({ at: context.currentTime, priority: args[0]?.priority || 0,
      positional: Array.isArray(args[0]?.pos), active: this._voices.length,
      activePositional: this._positional.length, admitted: this._byOutput.has(output) });
    return output;
  };
  VoicePool.prototype._cleanupVoice = function (entry) {
    if (entry && !entry.closed) trace.cleanups.push({ at: context.currentTime,
      priority: entry.priority, early: entry.until > context.currentTime });
    return originalCleanup.call(this, entry);
  };
  let noiseState = 0x6d2b79f5;
  // The production noise generator and small pitch variations use Math.random.
  // Fix its seed on this isolated capture page so comparisons are repeatable.
  Math.random = () => {
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    return (noiseState >>> 0) / 0x100000000;
  };
  const adapter = new Proxy(context, {
    get(target, property) {
      if (property === 'state') return 'running';
      if (property === 'resume' || property === 'close') return () => Promise.resolve();
      if (property === 'decodeAudioData') return (bytes) => {
        if (!decodedAssets.has(bytes)) decodedAssets.set(bytes, target.decodeAudioData(bytes).then((buffer) => {
          decodedLabels.set(buffer, rawUrls.get(bytes)); return buffer;
        }));
        return decodedAssets.get(bytes);
      };
      if (property === 'createBufferSource') return () => {
        const source = target.createBufferSource();
        const start = source.start.bind(source), stop = source.stop.bind(source), disconnect = source.disconnect.bind(source);
        let started;
        source.addEventListener('ended', () => {
          if (started) started.endedAt = context.currentTime;
        });
        source.start = (...args) => {
          const buffer = source.buffer;
          const peak = auditBufferPeak(buffer);
          started = { at: args[0] ?? context.currentTime,
            sample: decodedLabels.get(buffer) || 'procedural noise',
            peak, rate: source.playbackRate.value, duration: buffer?.duration || 0,
            disconnectedAt: null, endedAt: null, stopAt: null };
          trace.sources.push(started);
          return start(...args);
        };
        source.stop = (...args) => {
          if (started) started.stopAt = args[0] ?? context.currentTime;
          return stop(...args);
        };
        source.disconnect = (...args) => {
          if (started) started.disconnectedAt = context.currentTime;
          return disconnect(...args);
        };
        return source;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(window, 'AudioContext', {
    configurable: true, writable: true, value: function AuditContext() { return adapter; },
  });
  status.textContent = `Rendering ${label}…`;
  try {
    await sfx.unlock();
    const loaded = await sfx.loadSamples(BUILTIN_SAMPLE_MANIFEST, cachedFetch);
    if (loaded.failed || loaded.loaded !== Object.keys(BUILTIN_SAMPLE_MANIFEST).length) {
      throw new Error(`${label}: ${loaded.failed} samples failed to decode`);
    }
    sfx.setMasterVolume(0.8);
    sfx.setListener({ pos: [0, 0, 0], fwd: [0, 0, -1] });
    const groups = new Map();
    for (const [at, cue] of events) {
      if (!groups.has(at)) groups.set(at, []);
      groups.get(at).push(cue);
    }
    const scheduled = [];
    for (const [at, cues] of [...groups].sort((a, b) => a[0] - b[0])) {
      if (at === 0) { cues.forEach((cue) => cue()); continue; }
      scheduled.push(context.suspend(at).then(async () => {
        try { cues.forEach((cue) => cue()); }
        finally { await context.resume(); }
      }));
    }
    const rendered = context.startRendering();
    await Promise.all(scheduled);
    const data = (await rendered).getChannelData(0).slice();
    const metrics = metricsFor(data);
    const capturedTrace = JSON.parse(JSON.stringify(trace));
    traces[label] = capturedTrace;
    displayScenario(label, data, metrics, capturedTrace);
    return { data, metrics, trace: capturedTrace };
  } finally {
    await sfx.dispose();
    Math.random = originalRandom;
    VoicePool.prototype.acquire = originalAcquire;
    VoicePool.prototype._cleanupVoice = originalCleanup;
    LocalSampleBank.prototype.play = originalSamplePlay;
    if (original) Object.defineProperty(window, 'AudioContext', original);
    else delete window.AudioContext;
  }
}

function waveUrl(data) {
  const buffer = new ArrayBuffer(44 + data.length * 2);
  const view = new DataView(buffer);
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
  view.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) view.setInt16(44 + i * 2,
    Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function displayScenario(label, data, metrics, trace) {
  const article = document.createElement('article');
  const title = document.createElement('h2'); title.textContent = label; article.append(title);
  const numbers = document.createElement('p');
  numbers.textContent = `Peak ${metrics.peak.toFixed(4)} · RMS ${metrics.rms.toFixed(4)} · onset ${metrics.onsetMs.toFixed(2)} ms · audible tail ${metrics.audibleTailMs.toFixed(0)} ms · clipped ${Math.round(metrics.clippedRatio * 1e6)} ppm`;
  article.append(numbers);
  const diagnostic = document.createElement('p');
  const steals = trace.cleanups.filter((entry) => entry.early).length;
  const samples = trace.sources.filter((entry) => entry.sample !== 'procedural noise');
  diagnostic.textContent = `Voice acquisitions ${trace.acquisitions.length} · early evictions ${steals} · recorded sources ${samples.length} · noise sources ${trace.sources.length - samples.length}`;
  if (samples.length) diagnostic.textContent += ` · decoded recording peak ${Math.max(...samples.map((entry) => entry.peak)).toFixed(4)}`;
  article.append(diagnostic);
  const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 96;
  canvas.setAttribute('aria-label', `${label}: rendered game-mix waveform`);
  const pen = canvas.getContext('2d'); pen.fillStyle = '#ffa432';
  for (let x = 0; x < canvas.width; x++) {
    let low = 0, high = 0;
    for (let i = Math.floor(x * data.length / canvas.width); i < (x + 1) * data.length / canvas.width; i++) {
      low = Math.min(low, data[i] || 0); high = Math.max(high, data[i] || 0);
    }
    pen.fillRect(x, 48 - high * 45, 1, Math.max(1, (high - low) * 45));
  }
  article.append(canvas);
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
  audio.src = waveUrl(data); audio.setAttribute('aria-label', `${label}: rendered game mix`);
  article.append(audio); content.append(article);
}

function audible(result, label, onset = 30) {
  const m = result.metrics;
  check(m.peak > 0.015 && m.peak <= 1, `${label}: audible and limiter-bounded peak`);
  check(m.rms > 0.0003 && m.rms < 0.5, `${label}: useful RMS`);
  check(m.clippedRatio <= 0.001, `${label}: no sustained clipping`);
  check(m.onsetMs <= onset, `${label}: onset within ${onset} ms`);
}

function flameEvents(until = 0.6, explicitStop = true) {
  const events = [];
  for (let at = 0; at < until - 0.001; at += 0.05) events.push([Number(at.toFixed(3)), () => sfx.fire('flamethrower')]);
  if (explicitStop) events.push([until, () => sfx.stopFlame()]);
  return events;
}

async function main() {
  const weaponResults = {};
  for (const weapon of WEAPON_IDS) {
    const result = await renderScenario(weapon === 'knife' ? 'Pickaxe swing (knife slot)' : weapon,
      weapon === 'flamethrower' ? flameEvents() : [[0, () => sfx.fire(weapon, { charge: 1 })]]);
    weaponResults[weapon] = result;
    audible(result, weapon, weapon === 'flamethrower' ? 60 : weapon === 'knife' ? 55 : 20);
  }
  const chargeMetrics = {};
  for (const weapon of ['longarc', 'lance']) {
    const levels = [];
    for (const charge of [0, 0.5]) {
      const result = await renderScenario(`${weapon} charge ${charge}`, [[0, () => sfx.fire(weapon, { charge })]]);
      levels.push(result.metrics);
    }
    levels.push(weaponResults[weapon].metrics);
    chargeMetrics[weapon] = levels;
    check(levels[0].rms < levels[1].rms && levels[1].rms < levels[2].rms,
      `${weapon}: charge progressively increases mixed energy`);
  }
  const cues = {};
  const cue = async (name, events, onset = 35) => {
    const result = await renderScenario(name, events); cues[name] = result.metrics;
    audible(result, name, onset); return result;
  };
  const pickaxeSwingUrls = PICKAXE_SWING_SLOTS.map((slot) => BUILTIN_SAMPLE_MANIFEST[slot]);
  const pickaxeImpactUrls = PICKAXE_IMPACT_SLOTS.map((slot) => BUILTIN_SAMPLE_MANIFEST[slot]);
  check(weaponResults.knife.trace.sources.length === 1
    && pickaxeSwingUrls.includes(weaponResults.knife.trace.sources[0].sample),
  'A missed pickaxe swing has one air recording and no impact or synthetic tick');
  for (const [type, material] of [[3, 'stone'], [5, 'wood'], [8, 'metal']]) {
    const strike = await cue(`Pickaxe ${material} contact`, [[0, () => sfx.mine(type, false, [0, 0, -2])]]);
    check(strike.trace.sources.filter((source) => pickaxeImpactUrls.includes(source.sample)).length === 1,
      `Pickaxe ${material} contact starts one recorded impact`);
    check(strike.trace.acquisitions.every((entry) => entry.positional),
      `Pickaxe ${material} contact retains its world position`);
  }
  const pickaxeBreak = await cue('Pickaxe stone break', [[0, () => sfx.mine(3, true, [0, 0, -2])]]);
  check(pickaxeBreak.trace.sources.filter((source) => pickaxeImpactUrls.includes(source.sample)).length === 1
    && pickaxeBreak.trace.sources.filter((source) => source.sample === 'procedural noise').length === 3,
  'A mined block breaks with one recorded contact and three bounded debris grains');
  const miningName = 'Pickaxe, four-second mining at 120 RPM';
  const mining = await renderScenario(miningName, Array.from({ length: 8 }, (_, index) => [index * 0.5, () => {
    sfx.fire('knife'); sfx.mine(3, index === 5, [0, 0, -2]);
  }]), 4.6);
  cues[miningName] = mining.metrics;
  audible(mining, miningName, 55);
  check(pickaxeSwingUrls.every((url) => mining.trace.sources.filter((source) => source.sample === url).length === 4)
    && pickaxeImpactUrls.every((url) => mining.trace.sources.filter((source) => source.sample === url).length === 4),
  'Four seconds of mining plays eight swings and eight contacts across both variations');
  check(mining.trace.sources.filter((source) => source.sample !== 'procedural noise')
    .every((source) => source.rate >= 0.98 && source.rate <= 1.02 && recordedTailComplete(source, RATE)),
  'Mining variations keep natural pitch and finish every recorded tail');
  check(regionRms(mining.data, 4.1, 4.55) < 0.00001,
    'Mining reaches silence after the last contact without a hanging tail');
  for (const headshot of [false, true]) {
    const label = headshot ? 'Headshot' : 'Body';
    const suffix = headshot ? 'head' : 'body';
    const hit = await cue(`${label} hit confirmation`, [[0, () => sfx.hitmark(headshot)]]);
    check(hit.trace.sources.length === 1
      && hit.trace.sources[0].sample === BUILTIN_SAMPLE_MANIFEST[`ui.hitmark.${suffix}`],
    `${label} hit uses one recording with no layered synthetic noise`);
    check(hit.metrics.audibleTailMs < 120, `${label} hit ends inside the compact confirmation budget`);
    const kill = await cue(`${label} lethal hit confirmation`, [[0, () => {
      sfx.hitmark(headshot); sfx.killConfirm(headshot);
    }]]);
    check(kill.trace.sources.length === 2 && kill.trace.sources.every((source) => source.sample !== 'procedural noise'),
      `${label} lethal feedback uses the intended hit and kill recordings`);
    check(kill.metrics.peak < 0.6, `${label} lethal overlap retains headroom`);
    const events = Array.from({ length: 20 }, (_, index) => [index * 0.05, () => {
      sfx.fire('minigun'); sfx.hitmark(headshot);
      if (index === 19) sfx.killConfirm(headshot);
    }]);
    const rapid = await cue(`${label} hits, minigun burst and final kill`, events);
    check(rapid.trace.sources.filter((source) => source.sample === BUILTIN_SAMPLE_MANIFEST[`ui.hitmark.${suffix}`]).length === 20,
      `${label} burst keeps all 20 authoritative hit confirmations`);
    check(regionRms(rapid.data, 1.25, 2) < 0.00001, `${label} burst leaves no ringing hit tail`);
    const fallbackName = `${label} hit burst, missing confirmation samples`;
    const fallback = await renderScenario(fallbackName, events, SECONDS, true);
    cues[fallbackName] = fallback.metrics;
    audible(fallback, fallbackName);
    check(!fallback.trace.sources.some((source) => source.sample.includes('/ui/')),
      `${label} missing-recording audit exercises the procedural fallback`);
    check(regionRms(fallback.data, 1.25, 2) < 0.00001, `${label} fallback burst has no delayed chirp tail`);
  }
  await cue('Incoming flesh impact', [[0, () => sfx.impact('flesh', 0.45)]]);
  await cue('Grenade pin', [[0, () => sfx.grenadePin()]], 75);
  const weakThrow = await cue('Grenade throw, light', [[0, () => sfx.grenadeThrow(0)]], 75);
  const fullThrow = await cue('Grenade throw, full charge', [[0, () => sfx.grenadeThrow(1)]], 75);
  check(fullThrow.metrics.rms > weakThrow.metrics.rms * 1.1, 'Throw strength changes the audible mix');
  const blasts = {};
  for (const type of ['frag', 'limpet', 'pulse', 'rocket']) {
    blasts[type] = await cue(`${type} explosion, 4 m`, [[0, () => sfx.explosion([0, 0, -4], type)]]);
  }
  const distant = await cue('Frag explosion, 35 m', [[0, () => sfx.explosion([0, 0, -35], 'frag')]]);
  check(distant.metrics.rms < blasts.frag.metrics.rms * 0.8,
    'Distant explosions attenuate through the actual positional voice');
  const debris = await cue('Frag explosion plus 32 block impacts', [[0, () => {
    sfx.explosion([0, 0, -4], 'frag');
    for (let i = 0; i < 32; i++) sfx.impact('stone', 0.1, { pos: [i % 3 - 1, 0, -4] });
  }]]);
  check(debris.trace.acquisitions.length === 33
    && debris.trace.acquisitions.every((entry) => entry.positional)
    && debris.trace.cleanups.filter((entry) => entry.early && entry.at === 0).length === 17
    && debris.trace.acquisitions.every((entry) => entry.activePositional <= 16),
  'Debris scenario exercises 33 positional acquisitions and 17 same-frame evictions within the cap');
  const difference = debris.data.map((value, index) => value - blasts.frag.data[index]);
  const differenceRms = regionRms(difference, 0, 0.25);
  check(differenceRms > 0.0001,
    `Debris changes the rendered blast waveform (first-quarter-second difference RMS ${differenceRms.toFixed(6)})`);
  check(regionRms(debris.data, 0.5, 0.9) > regionRms(blasts.frag.data, 0.5, 0.9) * 0.45,
    'Blast tail survives same-frame destruction instead of being stolen by debris');
  const burst = Array.from({ length: 20 }, (_, i) => [i * 0.05, () => {
    sfx.fire('minigun'); sfx.minigunMotor(1, i / 24, true, false);
  }]);
  burst.push([1, () => sfx.minigunMotor(0, 0, false)]);
  const rapid = await cue('Minigun, 20-shot burst at 1200 RPM', burst);
  const rotarySamples = MINIGUN_REPORT_SLOTS.map((slot) => BUILTIN_SAMPLE_MANIFEST[slot]);
  const isRotary = (source) => rotarySamples.includes(source.sample);
  check(weaponResults.minigun.trace.sources.filter(isRotary).length === 1
    && rapid.trace.sources.filter(isRotary).length === 20,
  'Minigun starts its own decoded recording once per discharge');
  check(rotarySamples.every((url) => rapid.trace.sources.some((source) => source.sample === url)),
    'Minigun burst rotates all three authored report variants');
  check(rapid.metrics.rms > weaponResults.minigun.metrics.rms * 1.5
    && regionRms(rapid.data, 0.65, 0.9) > 0.002,
  'Minigun keeps firing audibly through the scheduled burst');
  const rotaryEvents = [], motorEvents = [];
  // Four seconds of 20 Hz reports, preceded by spin-up and followed by coasting.
  for (let frame = 0; frame <= 102; frame++) {
    const at = frame / 20;
    const spin = Math.min(1, at / 0.7, Math.max(0, (5.1 - at) / 0.4));
    const motorEvent = [at, () => sfx.minigunMotor(spin, Math.min(0.95, Math.max(0, at - 0.7) / 4.2), true, false)];
    rotaryEvents.push(motorEvent);
    if (at <= 1.5) motorEvents.push([at, () =>
      sfx.minigunMotor(Math.min(1, at / 0.7, Math.max(0, (1.5 - at) / 0.4)), 0.2, true, false)]);
  }
  for (let shot = 0; shot < 80; shot++) rotaryEvents.push([Number((0.7 + shot / 20).toFixed(3)), () => sfx.fire('minigun')]);
  rotaryEvents.push([5.1, () => sfx.minigunMotor(0, 0, false)]);
  motorEvents.push([1.5, () => sfx.minigunMotor(0, 0, false)]);
  const sustainedName = 'Minigun, spin-up, 80 shots and coast-down';
  const sustained = await renderScenario(sustainedName, rotaryEvents, 5.8);
  cues[sustainedName] = sustained.metrics;
  audible(sustained, sustainedName, 250);
  const sustainedShots = sustained.trace.sources.filter(isRotary);
  const cadenceRatios = sustainedShots.map((source) =>
    regionRms(sustained.data, source.at + .006, source.at + .024)
    / Math.max(1e-9, regionRms(sustained.data, source.at + .034, source.at + .049)));
  document.documentElement.dataset.minigunCadence = JSON.stringify({
    shots: sustainedShots.length, minimumAttackToTail: Math.min(...cadenceRatios),
    meanAttackToTail: cadenceRatios.reduce((a, b) => a + b, 0) / cadenceRatios.length,
  });
  check(cadenceRatios.length === 80 && cadenceRatios.every((ratio) => ratio > 1.3),
    'Every 1200 RPM shot has a distinct attack above its trailing energy');
  check(sustainedShots.length === 80 && rotarySamples.every((url) =>
    sustainedShots.filter((source) => source.sample === url).length >= 26),
  'Four-second fire retains all 80 reports across the three variations');
  check(sustainedShots.every((source) => source.rate >= 0.98 && source.rate <= 1.02),
    'Rotary samples retain their natural pitch and mechanical weight');
  const shortRecords = sustainedShots.filter((source) => source.disconnectedAt != null
    && source.disconnectedAt < source.at + source.duration / source.rate);
  const tailDiagnostic = {
    count: shortRecords.length,
    worstEarlyMs: Math.max(0, ...shortRecords.map((source) =>
      1000 * (source.at + source.duration / source.rate - source.disconnectedAt))),
    naturalEnds: shortRecords.filter((source) => source.endedAt != null && source.stopAt == null).length,
    examples: shortRecords.slice(0, 8),
  };
  document.documentElement.dataset.minigunTailDiagnostic = JSON.stringify(tailDiagnostic);
  check(sustainedShots.every((source) => recordedTailComplete(source, RATE)),
  `Rapid-fire voice recycling never cuts a recorded minigun tail (${tailDiagnostic.naturalEnds} natural ends with native block timestamps, at most ${(128 / RATE * 1000).toFixed(4)} ms)`);
  check(regionRms(sustained.data, 3.7, 4.65) > 0.01,
    'Minigun keeps its body throughout four seconds of continuous firing');
  check(regionRms(sustained.data, 5.3, 5.75) < 0.00001,
    'Minigun coast-down reaches silence without a hanging motor');
  const motorName = 'Minigun rotor, spin-up and coast-down without firing';
  const motorOnly = await renderScenario(motorName, motorEvents, 2.1);
  cues[motorName] = motorOnly.metrics;
  check(regionRms(motorOnly.data, 0.7, 1.1) > 0.001,
    'Mechanical motor remains audible while pre-spinning without shots');
  check(regionRms(motorOnly.data, 1.7, 2.05) < 0.00001,
    'Pre-spin rotor releases cleanly after coasting');
  const flame = await cue('Flamethrower, 2.4-second hold and release', flameEvents(2.4), 60);
  const heldRms = regionRms(flame.data, 0.3, 2.35);
  check(heldRms > 0.01, 'Flame sustains through loop wraps');
  const flameWindows = Array.from({ length: 50 }, (_, i) =>
    regionRms(flame.data, 0.3 + i * 0.04, 0.34 + i * 0.04));
  check(Math.min(...flameWindows) > heldRms * 0.05,
    'Flame has no silent gaps throughout the held loop');
  check(regionRms(flame.data, 2.55, 3.1) < 0.00001, 'Flame release reaches silence after its fade');
  const stalled = await cue('Flamethrower, missing refresh', [[0, () => sfx.fire('flamethrower')]], 60);
  check(regionRms(stalled.data, 0.3, 0.7) < 0.00001, 'Missing flame refresh expires on the audio clock');
  const bolt = await cue('LONGARC bolt fizzle', [[0, () => sfx.explosion([0, 0, -4], 'bolt')]]);
  check(bolt.metrics.audibleTailMs < 700, 'Bolt termination stays a short electric fizzle');

  const metrics = Object.fromEntries(WEAPON_IDS.map((weapon) => [weapon, weaponResults[weapon].metrics]));
  const report = { weapons: metrics, cues, charge: chargeMetrics, traces, checks, failures };
  window.__vbAudioMixAudit = metrics;
  window.__vbAudioCueAudit = report;
  document.documentElement.dataset.audioMixMetrics = JSON.stringify(metrics);
  document.documentElement.dataset.audioChargeMetrics = JSON.stringify(chargeMetrics);
  document.documentElement.dataset.audioCueMetrics = JSON.stringify(cues);
  const details = document.createElement('details'); details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = `${checks.filter((entry) => entry.passed).length}/${checks.length} checks passed`;
  details.append(summary);
  const list = document.createElement('ul');
  for (const result of checks) {
    const item = document.createElement('li'); item.className = result.passed ? 'pass' : 'fail';
    item.textContent = `${result.passed ? 'PASS' : 'FAIL'}: ${result.message}`; list.append(item);
  }
  details.append(list); content.prepend(details);
  if (failures.length) throw new Error(failures.join('; '));
  document.documentElement.dataset.audioMixReady = 'true';
  status.textContent = `PASS: ${checks.length} checks. All weapon, grenade, loop and destruction mixes rendered through game audio.`;
}

main().catch((error) => {
  document.documentElement.dataset.audioMixError = error?.message || String(error);
  status.textContent = `FAIL: ${error?.message || error}`;
  status.className = 'fail';
});
