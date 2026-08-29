import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireReportProfile } from '../public/js/audio/reports.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEAPONS = Object.freeze(['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'revolver']);
const SAMPLE_RATE = 48_000;
const WINDOW_MS = 5;
const ALIGNMENT_LIMIT_MS = 15;

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? path.resolve(process.cwd(), process.argv[index + 1])
    : fallback;
}

function run(command, args, { binary = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: binary ? null : 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = binary ? result.stderr?.toString('utf8') : result.stderr;
    throw new Error(`${command} failed: ${detail || result.stdout || result.status}`);
  }
  return result.stdout;
}

function db(value) {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

function analyzePcm(buffer) {
  const samples = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / Float32Array.BYTES_PER_ELEMENT),
  );
  const windowSamples = Math.round(SAMPLE_RATE * WINDOW_MS / 1000);
  const envelope = [];
  let sumSquares = 0;
  let differenceSquares = 0;
  let peak = 0;
  let peakIndex = 0;
  let previous = samples[0] || 0;
  for (let offset = 0; offset < samples.length; offset += windowSamples) {
    const end = Math.min(samples.length, offset + windowSamples);
    let windowSquares = 0;
    for (let index = offset; index < end; index++) {
      const sample = samples[index];
      const absolute = Math.abs(sample);
      if (absolute > peak) {
        peak = absolute;
        peakIndex = index;
      }
      sumSquares += sample * sample;
      const difference = sample - previous;
      differenceSquares += difference * difference;
      previous = sample;
      windowSquares += sample * sample;
    }
    envelope.push(Math.sqrt(windowSquares / Math.max(1, end - offset)));
  }

  const maxWindowRms = Math.max(...envelope);
  const onsetThreshold = maxWindowRms * 10 ** (-18 / 20);
  const onsetWindow = envelope.findIndex((value, index) =>
    value >= onsetThreshold && envelope[index + 1] >= onsetThreshold);
  const overallRms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return Object.freeze({
    durationMs: samples.length / SAMPLE_RATE * 1000,
    onsetMs: Math.max(0, onsetWindow) * WINDOW_MS,
    peakTimeMs: peakIndex / SAMPLE_RATE * 1000,
    peakDbfs: db(peak),
    rmsDbfs: db(overallRms),
    crestDb: db(peak / Math.max(Number.EPSILON, overallRms)),
    brightness: Math.sqrt(differenceSquares / Math.max(Number.EPSILON, sumSquares)),
  });
}

function renderPlot(input, output, filter) {
  run('ffmpeg', [
    '-v', 'error', '-y', '-i', input,
    '-filter_complex', filter,
    '-frames:v', '1', output,
  ]);
}

function tableRow(weapon, metrics, runtime) {
  const aligned = runtime.onsetMs <= ALIGNMENT_LIMIT_MS;
  return `<tr class="${aligned ? 'pass' : 'fail'}">
    <th>${weapon}</th>
    <td>${metrics.durationMs.toFixed(1)}</td>
    <td>${runtime.durationMs.toFixed(1)}</td>
    <td>${runtime.onsetMs.toFixed(1)}</td>
    <td>${runtime.peakTimeMs.toFixed(1)}</td>
    <td>${runtime.peakDbfs.toFixed(2)}</td>
    <td>${metrics.crestDb.toFixed(2)}</td>
    <td>${runtime.brightness.toFixed(3)}</td>
  </tr>`;
}

function reportHtml(rows) {
  const cards = rows.map(({ weapon }) => `<article>
    <h2>${weapon}</h2>
    <img src="./${weapon}-waveform.png" alt="${weapon} waveform">
    <img src="./${weapon}-spectrogram.png" alt="${weapon} spectrogram">
  </article>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>VOXEL BLITZ Weapon Audio Audit</title>
<style>
body{margin:0;padding:24px;background:#090d12;color:#eaf2f8;font:14px ui-monospace,SFMono-Regular,monospace}
h1{margin:0 0 8px;font-size:24px}p{color:#9cacbb;max-width:80ch}table{border-collapse:collapse;width:100%;margin:24px 0}
th,td{border:1px solid #283746;padding:8px;text-align:right}th:first-child{text-align:left;text-transform:uppercase}.fail{background:#4b1818}.pass{background:#10251c}
.grid{display:grid;grid-template-columns:repeat(2,minmax(320px,1fr));gap:18px}article{border:1px solid #283746;background:#111923;padding:12px}
h2{margin:0 0 10px;text-transform:uppercase;font-size:16px;color:#ff9f32}img{display:block;width:100%;height:auto;margin-top:8px}
@media(max-width:850px){.grid{grid-template-columns:1fr}}
</style></head><body><h1>Weapon audio alignment and spectrum</h1>
<p>Onset is the first pair of 5ms RMS windows within 18dB of the strongest transient. Green rows meet the ${ALIGNMENT_LIMIT_MS}ms muzzle-sync budget.</p>
<table><thead><tr><th>Weapon</th><th>Source ms</th><th>Runtime ms</th><th>Onset ms</th><th>Peak ms</th><th>Runtime peak dBFS</th><th>Crest dB</th><th>Runtime brightness</th></tr></thead>
<tbody>${rows.map(({ weapon, metrics, runtime }) => tableRow(weapon, metrics, runtime)).join('\n')}</tbody></table>
<main class="grid">${cards}</main></body></html>`;
}

async function main() {
  const assetsRoot = optionValue('--assets-root', path.join(ROOT, 'public/assets/audio/weapons'));
  const outDir = optionValue('--out-dir', path.join(ROOT, '.artifacts/audio-audit/current'));
  await mkdir(outDir, { recursive: true });
  const rows = [];
  for (const weapon of WEAPONS) {
    const input = path.join(assetsRoot, weapon, 'fire.ogg');
    const pcm = run('ffmpeg', [
      '-v', 'error', '-i', input, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-',
    ], { binary: true });
    const metrics = analyzePcm(pcm);
    const profile = fireReportProfile(weapon);
    const runtime = Object.freeze({
      durationMs: metrics.durationMs / profile.sampleRate,
      onsetMs: metrics.onsetMs / profile.sampleRate,
      peakTimeMs: metrics.peakTimeMs / profile.sampleRate,
      peakDbfs: metrics.peakDbfs + db(profile.sampleGain),
      brightness: metrics.brightness * profile.sampleRate,
      sampleGain: profile.sampleGain,
      sampleRate: profile.sampleRate,
      layerGain: profile.layerGain,
    });
    rows.push({ weapon, metrics, runtime });
    renderPlot(input, path.join(outDir, `${weapon}-waveform.png`),
      'aformat=channel_layouts=mono,showwavespic=s=1200x260:colors=0xffa432:scale=sqrt');
    renderPlot(input, path.join(outDir, `${weapon}-spectrogram.png`),
      'showspectrumpic=s=1200x360:legend=1:color=fiery:scale=log:fscale=log:gain=4');
  }

  const metrics = Object.fromEntries(rows.map((row) => [row.weapon, {
    source: row.metrics,
    runtime: row.runtime,
  }]));
  await Promise.all([
    writeFile(path.join(outDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`),
    writeFile(path.join(outDir, 'index.html'), reportHtml(rows)),
  ]);

  console.table(rows.map(({ weapon, metrics: item, runtime }) => ({
    weapon,
    runtimeMs: runtime.durationMs.toFixed(1),
    onsetMs: runtime.onsetMs.toFixed(1),
    peakMs: runtime.peakTimeMs.toFixed(1),
    runtimePeakDbfs: runtime.peakDbfs.toFixed(2),
    runtimeBrightness: runtime.brightness.toFixed(3),
    sampleGain: runtime.sampleGain,
    sampleRate: runtime.sampleRate,
  })));

  const failures = rows
    .filter(({ runtime }) => runtime.onsetMs > ALIGNMENT_LIMIT_MS)
    .map(({ weapon, runtime }) => `${weapon} onset ${runtime.onsetMs.toFixed(1)}ms`);
  const durationShape = metrics.sniper.runtime.durationMs > metrics.shotgun.runtime.durationMs
    && metrics.shotgun.runtime.durationMs > metrics.rifle.runtime.durationMs
    && metrics.lmg.runtime.durationMs > metrics.rifle.runtime.durationMs
    && metrics.rifle.runtime.durationMs > metrics.smg.runtime.durationMs
    && metrics.revolver.runtime.durationMs > metrics.rifle.runtime.durationMs;
  if (!durationShape) failures.push('weapon tail lengths do not preserve the intended weight hierarchy');
  const brightnessOrder = ['smg', 'rifle', 'lmg', 'sniper', 'revolver', 'shotgun'];
  const brightness = brightnessOrder.map((weapon) => metrics[weapon].runtime.brightness);
  if (!brightness.every((value, index) => index === 0 || brightness[index - 1] > value)) {
    failures.push('runtime spectral brightness does not descend from SMG to shotgun');
  }
  const peaks = rows.map(({ runtime }) => runtime.peakDbfs);
  if (Math.max(...peaks) - Math.min(...peaks) > 1.25) {
    failures.push('runtime sample peaks exceed the 1.25dB balance window');
  }
  if (failures.length) throw new Error(`audio audit failed: ${failures.join('; ')}`);
  console.log(`audio audit ok -> ${path.join(outDir, 'index.html')}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
