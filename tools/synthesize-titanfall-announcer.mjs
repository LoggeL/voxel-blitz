#!/usr/bin/env node
/**
 * Offline synthesis of the Titanfall (Attrition) announcer calls
 * (docs/titanfall.md §8.4; no cloud voice service, no game recordings).
 * macOS `say` speaks each original line from shared/announcer.js
 * TITANFALL_CUES, ffmpeg shapes it like a cockpit intercom (band limit,
 * compression, a short two-tone chirp in front) and writes mono 16-bit
 * 22.05 kHz WAVs to public/assets/audio/announcer/titanfall/, plus a
 * sources.json with text, voice, filter chain and sha256 per clip.
 *
 *   node tools/synthesize-titanfall-announcer.mjs [--voice "Samantha"] [--rate 185] [--tmp <dir>]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TITANFALL_CUES } from '../shared/announcer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'public/assets/audio/announcer/titanfall');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const voice = arg('--voice', 'Samantha');
const rate = String(arg('--rate', '185'));
const tmpRoot = arg('--tmp', os.tmpdir());

const spoken = cue => `${TITANFALL_CUES[cue].label}.`;
const INTERCOM = [
  'highpass=f=240', 'lowpass=f=4600', 'acompressor=threshold=-22dB:ratio=4:attack=5:release=80:makeup=5',
  'equalizer=f=2400:t=q:w=1.4:g=3', 'aecho=0.8:0.5:18:0.18', 'alimiter=limit=0.89',
  'aformat=sample_fmts=s16:sample_rates=22050:channel_layouts=mono',
].join(',');
// Two short sine tones (1320 Hz, then 1760 Hz) as the cockpit chirp before every call.
const CHIRP = 'sine=frequency=1320:sample_rate=22050:duration=0.05[c1];sine=frequency=1760:sample_rate=22050:duration=0.06[c2];'
  + 'anullsrc=r=22050:cl=mono:d=0.04[gap];[c1][c2][gap]concat=n=3:v=0:a=1,volume=0.22,aformat=sample_rates=22050:channel_layouts=mono[chirp]';

mkdirSync(outDir, { recursive: true });
mkdirSync(tmpRoot, { recursive: true });
const temp = mkdtempSync(path.join(tmpRoot, 'vb-titanfall-voice-'));
const clips = [];
try {
  for (const cue of Object.keys(TITANFALL_CUES)) {
    const aiff = path.join(temp, `${cue}.aiff`);
    const wav = path.join(outDir, `${cue}.wav`);
    const text = spoken(cue);
    execFileSync('say', ['-v', voice, '-r', rate, '-o', aiff, text]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff,
      '-filter_complex', `${CHIRP};[0:a]aresample=22050,silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.2:stop_threshold=-45dB,${INTERCOM}[voice];[chirp][voice]concat=n=2:v=0:a=1,apad=pad_dur=0.08,${INTERCOM}[out]`,
      '-map', '[out]', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', wav]);
    const bytes = readFileSync(wav);
    clips.push({ id: cue, text, voice, rate: Number(rate), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    console.log(`${cue.padEnd(18)} ${String(bytes.length).padStart(7)} B  "${text}"`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(path.join(outDir, 'sources.json'), `${JSON.stringify({
  generator: 'tools/synthesize-titanfall-announcer.mjs',
  method: 'macOS say + ffmpeg cockpit intercom band (offline, no cloud voice service, original lines)',
  license: 'Original synthesis for this project (no third-party recording)',
  format: 'WAV PCM s16le mono 22050 Hz',
  command: `node tools/synthesize-titanfall-announcer.mjs --voice "${voice}" --rate ${rate}`,
  filter: INTERCOM,
  clips,
}, null, 2)}\n`);
console.log(`Wrote ${clips.length} titanfall calls to ${path.relative(root, outDir)}`);
