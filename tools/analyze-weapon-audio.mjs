import { spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';
import { DEFAULT_MENU_TRACK, MENU_GAIN } from '../public/js/audio/music.js';
import { fireReportProfile } from '../public/js/audio/reports.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 48_000;
const WINDOW_MS = 5;
const ALIGNMENT_LIMIT_MS = 15;
const MAX_RUNTIME_PEAK_DBFS = -0.05;
const MAX_CLIPPED_SAMPLE_RATIO = 0.005;
const MIN_RUNTIME_RMS_DBFS = -48;
const MAX_RUNTIME_RMS_DBFS = -3;

function assetKind(slot) {
  if (slot.endsWith('.fire')) return 'fire';
  if (slot.includes('.reload.')) return 'reload';
  return 'sample';
}

function bundledAssets() {
  const assets = Object.entries(BUILTIN_SAMPLE_MANIFEST).map(([slot, url]) => {
    const kind = assetKind(slot);
    const weapon = kind === 'fire' ? slot.split('.')[1] : null;
    const profile = weapon ? fireReportProfile(weapon) : null;
    return Object.freeze({
      slot,
      url,
      kind,
      weapon,
      gain: profile?.sampleGain ?? 1,
      rate: profile?.sampleRate ?? 1,
    });
  });
  assets.push(Object.freeze({
    slot: 'music.menu',
    url: DEFAULT_MENU_TRACK,
    kind: 'music',
    weapon: null,
    gain: MENU_GAIN,
    rate: 1,
  }));
  return Object.freeze(assets);
}

function assetPath(assetsRoot, url) {
  return path.join(assetsRoot, url.replace(/^\/assets\/audio\//, ''));
}

function outputSlug(slot) {
  return slot.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

async function listOggFiles(directory) {
  const files = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.ogg')) files.push(candidate);
    }
  };
  await visit(directory);
  return files.sort();
}

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
  let clippedSamples = 0;
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
      if (absolute >= 0.9999) clippedSamples++;
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
    clippedSampleRatio: clippedSamples / Math.max(1, samples.length),
  });
}

function renderPlot(input, output, filter) {
  run('ffmpeg', [
    '-v', 'error', '-y', '-i', input,
    '-filter_complex', filter,
    '-frames:v', '1', output,
  ]);
}

function tableRow(asset, metrics, runtime, passed) {
  return `<tr class="${passed ? 'pass' : 'fail'}">
    <th>${asset.slot}</th>
    <td>${asset.kind}</td>
    <td>${metrics.durationMs.toFixed(1)}</td>
    <td>${runtime.durationMs.toFixed(1)}</td>
    <td>${runtime.onsetMs.toFixed(1)}</td>
    <td>${runtime.peakTimeMs.toFixed(1)}</td>
    <td>${runtime.peakDbfs.toFixed(2)}</td>
    <td>${runtime.rmsDbfs.toFixed(2)}</td>
    <td>${runtime.crestDb.toFixed(2)}</td>
    <td>${(metrics.clippedSampleRatio * 1_000_000).toFixed(0)}</td>
    <td>${runtime.brightness.toFixed(3)}</td>
  </tr>`;
}

function reportHtml(rows) {
  const cards = rows.map(({ asset, slug }) => `<article>
    <h2>${asset.slot}</h2>
    <img src="./${slug}-waveform.png" alt="${asset.slot} waveform">
    <img src="./${slug}-spectrogram.png" alt="${asset.slot} spectrogram">
  </article>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>VOXEL BLITZ Audio Audit</title>
<style>
body{margin:0;padding:24px;background:#090d12;color:#eaf2f8;font:14px ui-monospace,SFMono-Regular,monospace}
h1{margin:0 0 8px;font-size:24px}p{color:#9cacbb;max-width:80ch}table{border-collapse:collapse;width:100%;margin:24px 0}
th,td{border:1px solid #283746;padding:8px;text-align:right}th:first-child{text-align:left;text-transform:uppercase}.fail{background:#4b1818}.pass{background:#10251c}
.grid{display:grid;grid-template-columns:repeat(2,minmax(320px,1fr));gap:18px}article{border:1px solid #283746;background:#111923;padding:12px}
h2{margin:0 0 10px;text-transform:uppercase;font-size:16px;color:#ff9f32}img{display:block;width:100%;height:auto;margin-top:8px}
@media(max-width:850px){.grid{grid-template-columns:1fr}}
</style></head><body><h1>Bundled audio alignment and spectrum</h1>
<p>Every shipped OGG is inventoried. Fire onset is the first pair of 5ms RMS windows within 18dB of the strongest transient and must meet the ${ALIGNMENT_LIMIT_MS}ms muzzle-sync budget. Runtime levels include sample playback gain.</p>
<table><thead><tr><th>Slot</th><th>Kind</th><th>Source ms</th><th>Runtime ms</th><th>Onset ms</th><th>Peak ms</th><th>Peak dBFS</th><th>RMS dBFS</th><th>Crest dB</th><th>Clipped ppm</th><th>Brightness</th></tr></thead>
<tbody>${rows.map(({ asset, metrics, runtime, passed }) => tableRow(asset, metrics, runtime, passed)).join('\n')}</tbody></table>
<main class="grid">${cards}</main></body></html>`;
}

async function main() {
  const assetsRoot = optionValue('--assets-root', path.join(ROOT, 'public/assets/audio'));
  const outDir = optionValue('--out-dir', path.join(ROOT, '.artifacts/audio-audit/current'));
  await mkdir(outDir, { recursive: true });
  const assets = bundledAssets();
  const expectedFiles = assets.map(({ url }) => assetPath(assetsRoot, url)).sort();
  const actualFiles = await listOggFiles(assetsRoot);
  const failures = [];
  if (expectedFiles.join('\n') !== actualFiles.join('\n')) {
    const expected = new Set(expectedFiles);
    const actual = new Set(actualFiles);
    const missing = expectedFiles.filter((file) => !actual.has(file));
    const untracked = actualFiles.filter((file) => !expected.has(file));
    failures.push(`audio inventory drift (missing: ${missing.join(', ') || 'none'}; untracked: ${untracked.join(', ') || 'none'})`);
  }
  const fireWeapons = assets.filter(({ kind }) => kind === 'fire').map(({ weapon }) => weapon);
  const reloadWeapons = assets
    .filter(({ kind }) => kind === 'reload')
    .map(({ slot }) => slot.split('.')[1]);
  if (fireWeapons.join(',') !== WEAPON_IDS.join(',')) {
    failures.push('fire sample roster does not match WEAPON_IDS');
  }
  if (!WEAPON_IDS.every((weapon) => reloadWeapons.includes(weapon))) {
    failures.push('every weapon must ship at least one reload sample');
  }

  const rows = [];
  for (const asset of assets) {
    const input = assetPath(assetsRoot, asset.url);
    const pcm = run('ffmpeg', [
      '-v', 'error', '-i', input, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-',
    ], { binary: true });
    const metrics = analyzePcm(pcm);
    const runtime = Object.freeze({
      durationMs: metrics.durationMs / asset.rate,
      onsetMs: metrics.onsetMs / asset.rate,
      peakTimeMs: metrics.peakTimeMs / asset.rate,
      peakDbfs: metrics.peakDbfs + db(asset.gain),
      rmsDbfs: metrics.rmsDbfs + db(asset.gain),
      crestDb: metrics.crestDb,
      brightness: metrics.brightness * asset.rate,
      sampleGain: asset.gain,
      sampleRate: asset.rate,
    });
    const rowFailures = [];
    if (!(runtime.durationMs >= 20 && Number.isFinite(runtime.durationMs))) {
      rowFailures.push('invalid duration');
    }
    if (asset.kind === 'fire' && runtime.onsetMs > ALIGNMENT_LIMIT_MS) {
      rowFailures.push(`onset ${runtime.onsetMs.toFixed(1)}ms`);
    }
    if (runtime.peakDbfs > MAX_RUNTIME_PEAK_DBFS) rowFailures.push('no peak headroom');
    if (runtime.rmsDbfs < MIN_RUNTIME_RMS_DBFS || runtime.rmsDbfs > MAX_RUNTIME_RMS_DBFS) {
      rowFailures.push(`RMS ${runtime.rmsDbfs.toFixed(1)}dBFS outside useful range`);
    }
    if (metrics.clippedSampleRatio > MAX_CLIPPED_SAMPLE_RATIO) {
      rowFailures.push(`${(metrics.clippedSampleRatio * 100).toFixed(2)}% clipped samples`);
    }
    if (!Number.isFinite(runtime.crestDb) || runtime.crestDb < 2 || runtime.crestDb > 40) {
      rowFailures.push(`crest ${runtime.crestDb.toFixed(1)}dB outside useful range`);
    }
    if (rowFailures.length) failures.push(`${asset.slot}: ${rowFailures.join(', ')}`);

    const slug = outputSlug(asset.slot);
    rows.push({ asset, slug, metrics, runtime, passed: rowFailures.length === 0 });
    renderPlot(input, path.join(outDir, `${slug}-waveform.png`),
      'aformat=channel_layouts=mono,showwavespic=s=1200x260:colors=0xffa432:scale=sqrt');
    renderPlot(input, path.join(outDir, `${slug}-spectrogram.png`),
      'showspectrumpic=s=1200x360:legend=1:color=fiery:scale=log:fscale=log:gain=4');
  }

  const auditedMetrics = Object.fromEntries(rows.map((row) => [row.asset.slot, {
    source: row.metrics,
    runtime: row.runtime,
  }]));
  await Promise.all([
    writeFile(path.join(outDir, 'metrics.json'), `${JSON.stringify(auditedMetrics, null, 2)}\n`),
    writeFile(path.join(outDir, 'index.html'), reportHtml(rows)),
  ]);

  console.table(rows.map(({ asset, runtime }) => ({
    slot: asset.slot,
    kind: asset.kind,
    runtimeMs: runtime.durationMs.toFixed(1),
    onsetMs: runtime.onsetMs.toFixed(1),
    peakMs: runtime.peakTimeMs.toFixed(1),
    runtimePeakDbfs: runtime.peakDbfs.toFixed(2),
    runtimeBrightness: runtime.brightness.toFixed(3),
    sampleGain: runtime.sampleGain,
    sampleRate: runtime.sampleRate,
  })));

  const fireMetrics = Object.fromEntries(rows
    .filter(({ asset }) => asset.kind === 'fire')
    .map((row) => [row.asset.weapon, { source: row.metrics, runtime: row.runtime }]));
  const durationShape = fireMetrics.sniper.runtime.durationMs > fireMetrics.shotgun.runtime.durationMs
    && fireMetrics.shotgun.runtime.durationMs > fireMetrics.rifle.runtime.durationMs
    && fireMetrics.lmg.runtime.durationMs > fireMetrics.rifle.runtime.durationMs
    && fireMetrics.rifle.runtime.durationMs > fireMetrics.smg.runtime.durationMs
    && fireMetrics.revolver.runtime.durationMs > fireMetrics.rifle.runtime.durationMs;
  if (!durationShape) failures.push('weapon tail lengths do not preserve the intended weight hierarchy');
  const brightnessOrder = ['smg', 'rifle', 'lmg', 'sniper', 'revolver', 'shotgun'];
  const brightness = brightnessOrder.map((weapon) => fireMetrics[weapon].runtime.brightness);
  if (!brightness.every((value, index) => index === 0 || brightness[index - 1] > value)) {
    failures.push('runtime spectral brightness does not descend from SMG to shotgun');
  }
  const peaks = rows
    .filter(({ asset }) => asset.kind === 'fire')
    .map(({ runtime }) => runtime.peakDbfs);
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
