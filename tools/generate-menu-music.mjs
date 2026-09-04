// Original, deterministic 32-bar industrial loop. No third-party samples.
// Run: node tools/generate-menu-music.mjs (requires ffmpeg).
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const rate = 44100, bpm = 120, beat = 60 / bpm, duration = 32 * 4 * beat;
const frames = rate * duration;
const mix = new Float32Array(frames * 2);
let seed = 73021;
const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2147483648 - 1);
const tau = Math.PI * 2;
function voice(start, length, sample, pan = 0) {
  const first = Math.round(start * rate), count = Math.round(length * rate);
  for (let i = 0; i < count; i++) {
    const t = i / rate, value = sample(t, i / count);
    const at = ((first + i) % frames) * 2;
    mix[at] += value * Math.sqrt((1 - pan) / 2);
    mix[at + 1] += value * Math.sqrt((1 + pan) / 2);
  }
}
const roots = [41.2034, 41.2034, 48.9994, 43.6535];
for (let bar = 0; bar < 32; bar++) {
  const root = roots[Math.floor(bar / 2) % roots.length];
  for (let step = 0; step < 16; step++) {
    const at = bar * 4 * beat + step * beat / 4;
    if ([0, 6, 8, 14].includes(step)) voice(at, .34, (t) =>
      .65 * Math.sin(tau * (48 * t + 8 * (1 - Math.exp(-t * 35)))) * Math.exp(-t * 17));
    if (step === 4 || step === 12) voice(at, .22, (t) =>
      (.27 * noise() + .15 * Math.sin(tau * 182 * t)) * Math.exp(-t * 23));
    if (step % 2 === 0 || bar % 4 === 3) voice(at, .065, (t) =>
      noise() * .07 * Math.exp(-t * 80), step % 4 ? -.45 : .45);
    if ([0, 2, 3, 6, 8, 10, 14].includes(step)) {
      const hz = root * (step === 14 ? 2 : 1);
      voice(at, .19, (t) => {
        const wave = Math.sin(tau * hz * t) + .35 * Math.sin(tau * hz * 2 * t);
        return .24 * Math.tanh(wave * 2.7) * Math.min(1, t * 250) * Math.exp(-t * 16);
      });
    }
    if (bar >= 8 && step % 4 === 2) {
      const hz = root * [8, 12, 16, 9][Math.floor(step / 4)];
      voice(at, .65, (t) => .055 * (Math.sin(tau * hz * t) + .25 * Math.sin(tau * hz * 3 * t))
        * Math.min(1, t * 150) * Math.exp(-t * 8), .5);
      voice(at + beat * .75, .6, (t) => .018 * Math.sin(tau * hz * t)
        * Math.min(1, t * 150) * Math.exp(-t * 8), -.6);
    }
  }
  voice(bar * 4 * beat, 4 * beat, (t, u) => .035 * Math.sin(Math.PI * u) ** 2 *
    (Math.sin(tau * root * 4 * t) + Math.sin(tau * root * 6.003 * t)), -.2);
}
let peak = 0;
for (const value of mix) peak = Math.max(peak, Math.abs(value));
const wav = Buffer.alloc(44 + frames * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40);
for (let i = 0; i < mix.length; i++) wav.writeInt16LE(Math.round(mix[i] / peak * 28000), 44 + i * 2);
const temp = mkdtempSync(path.join(tmpdir(), 'vb-music-'));
try {
  const source = path.join(temp, 'loop.wav');
  writeFileSync(source, wav);
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-c:a', 'libopus', '-b:a', '128k', '-metadata', 'title=Foundry Aftermath',
    'public/assets/audio/music/menu-industrial.ogg'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('ffmpeg encoding failed');
  console.log(`Generated ${duration}s stereo loop, ${bpm} BPM`);
} finally { rmSync(temp, { recursive: true, force: true }); }
