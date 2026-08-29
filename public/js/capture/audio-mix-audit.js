import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { buildEchoGraph, buildMasterGraph } from '../audio/engine.js';
import { createVoices } from '../audio/primitives.js';
import { fireReportProfile, renderFireReport } from '../audio/reports.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../audio/samples.js';

const SAMPLE_RATE = 48_000;
const RENDER_SECONDS = 2;

function deterministicNoise(context) {
  const buffer = context.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  let state = 0x6d2b79f5;
  for (let index = 0; index < data.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = ((state >>> 0) / 0xffffffff) * 2 - 1;
  }
  return buffer;
}

function metricsFor(data) {
  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  let onset = -1;
  let lastAudible = 0;
  for (let index = 0; index < data.length; index++) {
    const absolute = Math.abs(data[index]);
    peak = Math.max(peak, absolute);
    sumSquares += data[index] * data[index];
    if (absolute >= 0.9999) clipped++;
    if (absolute >= 0.002) {
      if (onset < 0) onset = index;
      lastAudible = index;
    }
  }
  return Object.freeze({
    peak,
    rms: Math.sqrt(sumSquares / Math.max(1, data.length)),
    clippedRatio: clipped / Math.max(1, data.length),
    onsetMs: Math.max(0, onset) / SAMPLE_RATE * 1000,
    audibleTailMs: lastAudible / SAMPLE_RATE * 1000,
  });
}

async function renderWeapon(weapon) {
  const context = new OfflineAudioContext(1, SAMPLE_RATE * RENDER_SECONDS, SAMPLE_RATE);
  const master = buildMasterGraph(context, 0.8);
  const echo = buildEchoGraph(context, master.bus);
  const primitives = createVoices({
    ctx: context,
    noiseBuffer: deterministicNoise(context),
  });
  const output = context.createGain();
  output.gain.value = 1.16;
  output.connect(master.bus);

  const profile = fireReportProfile(weapon);
  const response = await fetch(BUILTIN_SAMPLE_MANIFEST[`weapons.${weapon}.fire`]);
  if (!response.ok) throw new Error(`${weapon} sample fetch failed: ${response.status}`);
  const decoded = await context.decodeAudioData(await response.arrayBuffer());
  const source = context.createBufferSource();
  const sampleGain = context.createGain();
  source.buffer = decoded;
  source.playbackRate.value = profile.sampleRate;
  sampleGain.gain.value = profile.sampleGain;
  source.connect(sampleGain).connect(output);
  source.start(0.001);

  const layer = context.createGain();
  layer.gain.value = profile.layerGain;
  layer.connect(output);
  renderFireReport(weapon, layer, primitives, echo.in, () => {}, output, {
    includeMechanics: false,
  });

  const rendered = await context.startRendering();
  return metricsFor(rendered.getChannelData(0));
}

try {
  const entries = await Promise.all(WEAPON_IDS.map(async (weapon) =>
    [weapon, await renderWeapon(weapon)]));
  const metrics = Object.freeze(Object.fromEntries(entries));
  document.documentElement.dataset.audioMixReady = 'true';
  document.documentElement.dataset.audioMixMetrics = JSON.stringify(metrics);
  document.getElementById('status').textContent = 'runtime mix audit ready';
  window.__vbAudioMixAudit = metrics;
} catch (error) {
  document.documentElement.dataset.audioMixError = error?.message || String(error);
  document.getElementById('status').textContent = 'runtime mix audit failed';
  throw error;
}
