#!/usr/bin/env node
/**
 * Offline synthesis of the Conquest objective announcer calls (no ElevenLabs).
 * macOS `say` speaks each line, ffmpeg bands it like a field radio (high/low
 * pass, compression, a light bit crush and a squelch click) and writes mono
 * 16-bit 22.05 kHz WAVs to public/assets/audio/announcer/objective/, plus a
 * sources.json with text, voice and sha256 per clip.
 *
 *   node tools/synthesize-objective-announcer.mjs [--voice "Daniel"] [--rate 185]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBJECTIVE_CUES } from '../shared/announcer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'public/assets/audio/announcer/objective');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const voice = arg('--voice', 'Daniel');
const rate = String(arg('--rate', '190'));

// The spoken line per cue: the label from shared/announcer.js, with the radio cadence of a callout.
const spoken = cue => `${OBJECTIVE_CUES[cue].label}.`;
const RADIO = [
  'highpass=f=330', 'lowpass=f=3300', 'acompressor=threshold=-20dB:ratio=5:attack=4:release=60:makeup=4',
  'acrusher=bits=11:mode=log:aa=1:mix=0.35', 'equalizer=f=1700:t=q:w=1.2:g=4', 'alimiter=limit=0.89',
  'aformat=sample_fmts=s16:sample_rates=22050:channel_layouts=mono',
].join(',');

mkdirSync(outDir, { recursive: true });
const temp = mkdtempSync(path.join(os.tmpdir(), 'vb-objective-voice-'));
const clips = [];
try {
  for (const cue of Object.keys(OBJECTIVE_CUES)) {
    const aiff = path.join(temp, `${cue}.aiff`);
    const wav = path.join(outDir, `${cue}.wav`);
    const text = spoken(cue);
    execFileSync('say', ['-v', voice, '-r', rate, '-o', aiff, text]);
    // Squelch: 70 ms of band-limited static before the voice, 90 ms tail after it.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '0.07', '-i', 'anoisesrc=color=white:amplitude=0.18:sample_rate=22050',
      '-i', aiff,
      '-f', 'lavfi', '-t', '0.09', '-i', 'anoisesrc=color=pink:amplitude=0.06:sample_rate=22050',
      '-filter_complex', `[0:a]aformat=sample_rates=22050:channel_layouts=mono,highpass=f=900,lowpass=f=4200[a];[1:a]aresample=22050,silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.18:stop_threshold=-45dB,${RADIO}[b];[2:a]aformat=sample_rates=22050:channel_layouts=mono,highpass=f=600,lowpass=f=3000[c];[a][b][c]concat=n=3:v=0:a=1,${RADIO}[out]`,
      '-map', '[out]', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', wav]);
    const bytes = readFileSync(wav);
    clips.push({ id: cue, text, voice, rate: Number(rate), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    console.log(`${cue.padEnd(18)} ${String(bytes.length).padStart(7)} B  "${text}"`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(path.join(outDir, 'sources.json'), `${JSON.stringify({
  generator: 'tools/synthesize-objective-announcer.mjs',
  method: 'macOS say + ffmpeg radio band (offline, no cloud voice service)',
  format: 'WAV PCM s16le mono 22050 Hz',
  clips,
}, null, 2)}\n`);
console.log(`Wrote ${clips.length} objective calls to ${path.relative(root, outDir)}`);
