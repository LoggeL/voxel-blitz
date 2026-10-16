#!/usr/bin/env node
/**
 * Announcer voices from Gemini TTS (docs/audio/announcer.md).
 *
 * Every line comes from shared/announcer.js (original wording, no game
 * recordings). Per pack: one prebuilt Gemini voice, a director's-notes style
 * prompt, then a deterministic ffmpeg chain (silence trim, pack character,
 * loudness gain to TARGET_LUFS, peak limiter, mono 16-bit 24 kHz WAV).
 * Each processed take is judged by a Gemini audio model (transcript check plus
 * 1-10 scores); a line under --min-score is regenerated with the next seed and
 * a varied direction, up to --max-takes, and the best take ships. sources.json
 * records text, model, voice, prompt, seed, raw and shipped sha256, the filter
 * chain, measured loudness and the judge verdict.
 *
 *   node tools/synthesize-announcer-gemini.mjs --pack titanfall,objective [--cache <dir>]
 *        [--cue <id,...>] [--voice <name>] [--min-score 7] [--max-takes 4] [--out-dir <dir>]
 *        [--shootout N]                      render N takes per --cue line, ship the comparative-judge winner
 *        [--offline]                         reprocess cached raw takes, no API calls (recorded takes)
 *        [--offline --rejudge]               reprocess the recorded takes and judge the result again
 *        [--audition --voices A,B,C --cues x,y --out-dir <dir>]   judge candidate voices
 *
 * The key comes from the macOS keychain (`security find-generic-password -s google-api-key -w`).
 * Raw TTS takes are cached under --cache (default: <tmpdir>/vb-announcer-gemini) by
 * model/voice/prompt/seed, so reruns and --offline reprocessing cost no API calls.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOUNCER_CUES, OBJECTIVE_CUES, TITANFALL_CUES } from '../shared/announcer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const list = value => (value ? String(value).split(',').map(s => s.trim()).filter(Boolean) : null);

export const TTS_MODEL = 'gemini-3.8-flash-tts';
export const JUDGE_MODEL = 'gemini-3.8-flash';
export const SAMPLE_RATE = 24000;
export const TARGET_LUFS = -13;      // the shipped Quake/objective clips measure -11 to -12 LUFS; the limiter keeps this one honest
export const PRE_LUFS = -18;        // trimmed take level before the pack character chain
export const LIMIT = 0.8;            // -1.9 dBFS sample ceiling keeps true peaks under -1 dBFS
const BASE_SEED = 4100;

const TRIM = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,areverse,'
  + 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse';

/**
 * Pack definitions. `character` runs before the loudness stage, `wrap` (optional)
 * builds the final graph around the normalized voice [v] (chirps, squelch).
 */
export const PACKS = {
  titanfall: {
    cues: TITANFALL_CUES,
    dir: 'public/assets/audio/announcer/titanfall',
    voice: 'Charon',
    text: cue => `${TITANFALL_CUES[cue].label}.`,
    profile: 'Cockpit tactical AI',
    scene: 'The intercom of a pilot\'s combat mech cockpit during a firefight. The onboard tactical AI reports status over the cockpit radio.',
    style: 'Calm, clipped, precise military intercom voice. Controlled and confident, low emotion, crisp consonants, short decisive delivery with no trailing pauses.',
    notes: {
      titanfall_ready: 'A crisp status report.',
      titan_ready: 'A crisp status report.',
      prepare_titanfall: 'Firm and alert, a heads-up to the pilot.',
      core_online: 'Crisp, with a hint of confidence.',
      titan_doomed: 'An urgent but controlled warning.',
      eject: 'Urgent and rapid: three sharp, evenly spaced commands.',
      enemy_titan: 'An alert threat call.',
      rodeo_warning: 'An urgent warning.',
      battery_acquired: 'A brief confirmation.',
      winning: 'Measured and encouraging.',
      losing: 'Measured and grave.',
      match_win: 'Composed, quietly satisfied.',
      match_lose: 'Composed and grave.',
    },
    // Cockpit intercom: band limit, firm compression, presence and a short cabin reflection.
    character: 'highpass=f=250,lowpass=f=5200,acompressor=threshold=-30dB:ratio=6:attack=1:release=80:makeup=6:knee=4,'
      + 'equalizer=f=2500:t=q:w=1.4:g=3,aecho=0.8:0.6:14:0.12',
    // After the limiter: strips its out-of-band products, which otherwise overshoot as intersample peaks.
    post: 'lowpass=f=5400',
    // Two short sine tones (1320 Hz, then 1760 Hz) as the cockpit chirp before every call.
    wrap: `sine=frequency=1320:sample_rate=${SAMPLE_RATE}:duration=0.05[c1];sine=frequency=1760:sample_rate=${SAMPLE_RATE}:duration=0.06[c2];`
      + `anullsrc=r=${SAMPLE_RATE}:cl=mono:d=0.04[gap];[c1][c2][gap]concat=n=3:v=0:a=1,highpass=f=250,lowpass=f=5200,volume=0.16[chirp];`
      + '[chirp][v]concat=n=2:v=0:a=1,apad=pad_dur=0.08[out]',
  },
  objective: {
    cues: OBJECTIVE_CUES,
    dir: 'public/assets/audio/announcer/objective',
    voice: 'Alnilam',
    text: cue => `${OBJECTIVE_CUES[cue].label}.`,
    profile: 'Battlefield radio operator',
    scene: 'A command post radio on a large battlefield. The operator calls objective changes to the whole team over the field radio, with artillery in the distance.',
    style: 'Commanding battlefield radio operator. Authoritative, clear and punchy, projected over the noise of battle, clipped military cadence, no hesitation.',
    notes: {
      captured: 'A confident, upbeat confirmation.',
      lost: 'Grim and urgent.',
      under_attack: 'An urgent alert, clipped and fast.',
      tickets_low: 'Urgent and serious, a warning to the team.',
      victory: 'Triumphant and proud.',
      defeat: 'Heavy and grave.',
    },
    // Field radio: narrower band, harder compression, a light bit crush and presence.
    character: 'highpass=f=300,lowpass=f=3800,acompressor=threshold=-22dB:ratio=5:attack=3:release=60:makeup=4,'
      + 'acrusher=bits=12:mode=log:aa=1:mix=0.2,equalizer=f=1800:t=q:w=1.2:g=3',
    // Squelch: 60 ms of band-limited static before the voice, 80 ms tail after it (seeded noise).
    wrap: `anoisesrc=color=white:amplitude=0.12:sample_rate=${SAMPLE_RATE}:seed=11:duration=0.06,highpass=f=900,lowpass=f=4200,afade=t=out:st=0.03:d=0.03[a];`
      + `anoisesrc=color=pink:amplitude=0.05:sample_rate=${SAMPLE_RATE}:seed=12:duration=0.08,highpass=f=600,lowpass=f=3000,afade=t=out:st=0.02:d=0.06[c];`
      + '[a][v][c]concat=n=3:v=0:a=1[out]',
  },
  // Multikill calls. Not shipped: the game keeps the classic Quake recordings the user chose
  // (docs/audio/quake-announcer.md); this pack lands next to the earlier auditions.
  arena: {
    cues: ANNOUNCER_CUES,
    dir: 'docs/audio/announcer-samples/2026-10-16/arena',
    voice: 'Fenrir',
    text: cue => `${ANNOUNCER_CUES[cue].label}!`,
    profile: 'Arena announcer',
    scene: 'A huge futuristic deathmatch arena. The announcer booms the kill streak over the stadium speakers as the crowd erupts.',
    style: 'Big, hyped, deep arena announcer. Booming chest voice with grit, explosive energy, a punchy attack on the first syllable and a powerful, slightly drawn out final vowel. Larger than life, but every word perfectly clear.',
    notes: {
      doublekill: 'Strong and punchy.',
      triplekill: 'Louder, rising excitement.',
      multikill: 'Even bigger, thrilled.',
      ultrakill: 'Thunderous.',
      monsterkill: 'Massive and menacing, drawn out.',
      rampage: 'An explosive, roaring call.',
      godlike: 'The biggest call of all: awed, epic and drawn out.',
    },
    // Arena: chest weight, presence, glue compression and a short room.
    character: 'highpass=f=70,bass=g=3:f=110,acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=3,'
      + 'treble=g=2:f=4500,apad=pad_dur=0.35,aecho=1.0:0.7:38|71|113:0.22|0.14|0.08,'
      + 'areverse,silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.03,areverse',
  },
};

// Retakes keep the voice but vary seed and phrasing direction.
const RETAKE_DIRECTION = [
  '',
  'Tighter and crisper this time, every consonant sharp.',
  'More presence and conviction, a touch slower and fully clear.',
  'Clean single read, natural pacing, no exaggerated breaths.',
  'Very clear diction, controlled energy, end cleanly.',
];

const noteFor = (pack, cue) => {
  const notes = PACKS[pack].notes;
  if (notes[cue]) return notes[cue];
  const prefix = Object.keys(notes).find(k => cue.startsWith(`${k}_`));
  return prefix ? notes[prefix] : '';
};

export function promptFor(pack, cue, take = 0) {
  const p = PACKS[pack];
  const direction = [p.style, noteFor(pack, cue), RETAKE_DIRECTION[take % RETAKE_DIRECTION.length]].filter(Boolean).join(' ');
  return `# AUDIO PROFILE: ${p.profile}\n## THE SCENE: ${p.scene}\n### DIRECTOR'S NOTES\nStyle: ${direction}\n`
    + `Speak only the transcript, once.\n#### TRANSCRIPT\n${p.text(cue)}`;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let apiKey = null;
const key = () => (apiKey ??= execFileSync('security', ['find-generic-password', '-s', 'google-api-key', '-w'], { encoding: 'utf8' }).trim());
const stats = { tts: 0, judge: 0, cached: 0 };

class QuotaError extends Error {}

async function gemini(model, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key() }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    const message = json?.error?.message || `HTTP ${res.status}`;
    if (/billing|exceeded your current quota|quota exceeded/i.test(message) && !/per minute|retry/i.test(message) && attempt > 1) {
      throw new QuotaError(`${model}: ${message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise(r => setTimeout(r, 4000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${model}: ${message}`);
  }
}

/** Raw TTS take as a WAV buffer, cached by model/voice/prompt/seed. */
async function rawTake({ cache, pack, cue, voice, take, offline }) {
  const prompt = promptFor(pack, cue, take);
  const seed = BASE_SEED + take;
  const id = sha256(`${TTS_MODEL}|${voice}|${seed}|${prompt}`).slice(0, 16);
  const file = path.join(cache, pack, cue, `${voice}-t${take}-${id}.wav`);
  if (existsSync(file)) { stats.cached++; return { file, prompt, seed }; }
  if (offline) throw new Error(`--offline: no cached take ${path.relative(cache, file)}`);
  const out = await gemini(TTS_MODEL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['AUDIO'], seed, speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  stats.tts++;
  const part = out?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error(`${pack}/${cue} ${voice}: no audio (${out?.candidates?.[0]?.finishReason})`);
  let bytes = Buffer.from(part.inlineData.data, 'base64');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') bytes = pcmToWav(bytes, SAMPLE_RATE); // raw L16 PCM
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { file, prompt, seed };
}

function pcmToWav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Integrated loudness (LUFS) and peak (dBFS) of a file; silence padding keeps short clips measurable. */
function measure(file) {
  const res = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostats -i "${file}" -af apad=pad_dur=0.5,ebur128=peak=true -f null - 2>&1`], { encoding: 'utf8' });
  const summary = res.slice(res.lastIndexOf('Summary:'));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
  return { lufs, peak, duration };
}

/** Deterministic processing: raw take → shipped WAV. Returns the chain and measurements. */
export function processTake(pack, rawFile, outFile, workDir) {
  const p = PACKS[pack];
  mkdirSync(workDir, { recursive: true });
  const stage = path.join(workDir, `${path.basename(outFile, '.wav')}.stage.wav`);
  // Trim, then a fixed pre-level (PRE_LUFS) so every voice hits the pack compressor the same way.
  const trimmed = path.join(workDir, `${path.basename(outFile, '.wav')}.trim.wav`);
  const head = `aresample=${SAMPLE_RATE},aformat=sample_fmts=flt:channel_layouts=mono,${TRIM},afade=t=in:d=0.005`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', rawFile, '-af', head, '-c:a', 'pcm_f32le', trimmed]);
  const speech = measure(trimmed);
  const preGain = Math.round((PRE_LUFS - speech.lufs) * 100) / 100;
  const pre = `${head},volume=${preGain}dB,${p.character}`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', trimmed, '-af', `volume=${preGain}dB,${p.character}`, '-c:a', 'pcm_f32le', stage]);
  rmSync(trimmed, { force: true });
  const before = measure(stage);
  const fmt = `aformat=sample_fmts=s16:sample_rates=${SAMPLE_RATE}:channel_layouts=mono`;
  const render = gainDb => {
    const level = `volume=${gainDb}dB,alimiter=limit=${LIMIT}:attack=2:release=40:level=false,${p.post ? `${p.post},` : ''}areverse,afade=t=in:d=0.02,areverse`;
    const graph = p.wrap ? `[0:a]${level}[v];${p.wrap}` : `[0:a]${level}[out]`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', stage, '-filter_complex', `${graph};[out]${fmt}[final]`, '-map', '[final]',
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-bitexact', '-map_metadata', '-1', outFile]);
    return level;
  };
  // Linear gain to the target, then up to two corrections for what the limiter (and chirp/squelch) took.
  let gain = Math.round((TARGET_LUFS - before.lufs) * 100) / 100;
  let level = render(gain);
  for (let pass = 0; pass < 2; pass++) {
    const miss = TARGET_LUFS - measure(outFile).lufs;
    if (Math.abs(miss) < 0.25) break;
    gain = Math.round((gain + miss) * 100) / 100;
    level = render(gain);
  }
  rmSync(stage, { force: true });
  const after = measure(outFile);
  return { chain: `${pre} | ${level}${p.wrap ? ` | ${p.wrap}` : ''} | ${fmt}`, preGainDb: preGain, gainDb: gain, speechS: speech.duration,
    lufs: after.lufs, peakDb: after.peak, duration: after.duration };
}

const letters = text => String(text).toLowerCase().replace(/[^a-z]/g, '');
const words = text => String(text).trim().split(/\s+/).length;
/** Longest plausible trimmed take: a take that reads its direction aloud runs far past this. */
export const maxSpeechS = text => 2 + 0.5 * words(text);

/**
 * Deterministic guards on top of the model verdict (the judge has missed a 13 s
 * take that read its whole prompt): the transcript must match the line letter
 * for letter, and the trimmed take must fit maxSpeechS. Either failure caps the score.
 */
export function gate(pack, cue, verdict, speechS) {
  const text = PACKS[pack].text(cue);
  const problems = [];
  if (!verdict.words_correct || letters(verdict.transcript) !== letters(text)) problems.push('transcript mismatch');
  if (Number.isFinite(speechS) && speechS > maxSpeechS(text)) problems.push(`take ${speechS.toFixed(2)} s > ${maxSpeechS(text).toFixed(2)} s`);
  return { ...verdict, speech_s: Number.isFinite(speechS) ? Math.round(speechS * 1000) / 1000 : null, problems,
    score: problems.length ? Math.min(verdict.overall, problems.some(p => p.startsWith('take')) ? 1 : 3) : verdict.overall };
}

const JUDGE_BRIEF = {
  titanfall: 'the cockpit tactical AI of a mech shooter: a calm, clipped military intercom voice. The narrow band, short cabin echo and the two-tone chirp before the line are intentional intercom effects.',
  objective: 'a commanding battlefield radio operator in a large-scale war game. The narrow radio band, slight grit and the static squelch at start and end are intentional radio effects.',
  arena: 'a big, hyped, deep arena announcer calling kill streaks in a fast arena shooter. A short room reverb is intentional.',
};

/** Gemini audio judge: transcript check plus 1-10 scores. */
export async function judge(pack, cue, file, speechS) {
  const text = PACKS[pack].text(cue);
  const prompt = `You are a strict game audio director. This clip is one announcer line for ${JUDGE_BRIEF[pack]}\n`
    + `Intended words: "${text}"\nListen carefully and return JSON with: transcript (exact words heard), words_correct (true only if exactly the intended words are spoken, nothing extra or missing, ignoring punctuation), `
    + 'clarity (1-10, intelligibility in a noisy game), energy (1-10, how well the energy suits the role and the line), fit (1-10, how well the voice fits the described role), '
    + 'artifacts (1-10, 10 = clean, no glitches, clicks, cut-offs, robotic warble or distortion beyond the intended effect), '
    + 'overall (1-10, would you ship it in a polished game), notes (one short sentence).';
  const out = await gemini(JUDGE_MODEL, {
    contents: [{ parts: [{ inline_data: { mime_type: 'audio/wav', data: readFileSync(file).toString('base64') } }, { text: prompt }] }],
    generationConfig: {
      temperature: 0, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: {
        transcript: { type: 'STRING' }, words_correct: { type: 'BOOLEAN' }, clarity: { type: 'NUMBER' }, energy: { type: 'NUMBER' },
        fit: { type: 'NUMBER' }, artifacts: { type: 'NUMBER' }, overall: { type: 'NUMBER' }, notes: { type: 'STRING' },
      }, required: ['transcript', 'words_correct', 'clarity', 'energy', 'fit', 'artifacts', 'overall', 'notes'] },
    },
  });
  stats.judge++;
  const verdict = JSON.parse(out.candidates[0].content.parts.map(p => p.text || '').join(''));
  return gate(pack, cue, verdict, speechS);
}

/**
 * Comparative judge: every candidate take of one line in a single request, scored
 * against each other (1-10, spread the scores). Run in two orders to cancel position bias.
 */
export async function compare(pack, cue, entries) {
  const totals = new Map(entries.map(e => [e.voice, []]));
  const notes = [];
  for (const order of [entries, [...entries].reverse()]) {
    const labels = order.map((_, i) => String.fromCharCode(65 + i));
    const parts = order.flatMap((e, i) => [{ text: `Candidate ${labels[i]}:` },
      { inline_data: { mime_type: 'audio/wav', data: readFileSync(e.file).toString('base64') } }]);
    parts.push({ text: `You are a strict game audio director casting ${JUDGE_BRIEF[pack]} Each candidate says "${PACKS[pack].text(cue)}". `
      + 'Compare the candidates against each other on voice fit for the role, delivery and energy, clarity and audio quality. '
      + 'Score each 1-10 and spread the scores so the differences are visible (the best gets the highest, the weakest clearly lower). '
      + 'Return JSON: {"scores": {"A": n, ...}, "best": "<label>", "reason": "<one sentence>"}.' });
    const out = await gemini(JUDGE_MODEL, { contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
    stats.judge++;
    const verdict = JSON.parse(out.candidates[0].content.parts.map(p => p.text || '').join(''));
    order.forEach((e, i) => totals.get(e.voice).push(Number(verdict.scores?.[labels[i]] ?? NaN)));
    notes.push(`${order[labels.indexOf(verdict.best)]?.voice ?? verdict.best}: ${verdict.reason}`);
  }
  return { scores: Object.fromEntries([...totals].map(([v, xs]) => [v, xs.reduce((a, b) => a + b, 0) / xs.length])), notes };
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

async function audition({ pack, voices, cues, outDir, cache }) {
  const jobs = voices.flatMap(voice => cues.map(cue => ({ voice, cue })));
  const rows = await pool(jobs, 3, async ({ voice, cue }) => {
    try {
      const raw = await rawTake({ cache, pack, cue, voice, take: 0 });
      const out = path.join(outDir, pack, `${voice}-${cue}.wav`);
      mkdirSync(path.dirname(out), { recursive: true });
      const processed = processTake(pack, raw.file, out, path.join(cache, 'work'));
      const verdict = await judge(pack, cue, out, processed.speechS);
      console.log(`${pack.padEnd(9)} ${voice.padEnd(13)} ${cue.padEnd(18)} ${String(verdict.score).padStart(4)}  ${verdict.transcript} | ${verdict.notes}`);
      return { pack, voice, cue, file: out, ...processed, verdict };
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      console.log(`${pack.padEnd(9)} ${voice.padEnd(13)} ${cue.padEnd(18)} FAIL ${error.message}`);
      return { pack, voice, cue, error: error.message };
    }
  });
  const comparisons = {};
  for (const cue of cues) {
    const entries = rows.filter(r => r.cue === cue && r.file);
    if (entries.length > 1) comparisons[cue] = await compare(pack, cue, entries);
    console.log(`${pack} ${cue} comparative:`, comparisons[cue]?.scores, comparisons[cue]?.notes.join(' / '));
  }
  const summary = voices.map(voice => {
    const mine = rows.filter(r => r.voice === voice && r.verdict);
    const mean = k => mine.length ? Math.round(mine.reduce((s, r) => s + r.verdict[k], 0) / mine.length * 100) / 100 : null;
    const versus = Object.values(comparisons).map(c => c.scores[voice]).filter(Number.isFinite);
    return { voice, compare: versus.length ? Math.round(versus.reduce((a, b) => a + b, 0) / versus.length * 100) / 100 : null,
      mean: mean('score'), clarity: mean('clarity'), energy: mean('energy'), fit: mean('fit'), artifacts: mean('artifacts'), n: mine.length };
  }).sort((a, b) => (b.compare ?? 0) - (a.compare ?? 0) || (b.mean ?? 0) - (a.mean ?? 0));
  console.table(summary);
  return { pack, model: TTS_MODEL, judge: JUDGE_MODEL, cues, summary, comparisons, rows };
}

async function build({ pack, voice, cues, outDir, cache, minScore, maxTakes, shootout, offline, rejudge }) {
  const p = PACKS[pack];
  const sourcesFile = path.join(outDir, 'sources.json');
  const previous = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, 'utf8')) : null;
  const prevClips = new Map((previous?.generator === 'tools/synthesize-announcer-gemini.mjs' ? previous.clips : []).map(c => [c.id, c]));
  const all = Object.keys(p.cues);
  const work = path.join(cache, 'work', pack);
  mkdirSync(outDir, { recursive: true });
  const clips = await pool(all, 3, async cue => {
    if (!cues.includes(cue) && prevClips.has(cue)) return prevClips.get(cue);
    const recorded = prevClips.get(cue);
    const attempts = [];
    let best = null;
    // --offline replays the recorded take; otherwise takes run until one reaches minScore.
    const takes = offline && recorded ? [recorded.take] : Array.from({ length: Math.max(maxTakes, shootout) }, (_, i) => i);
    const rendered = [];
    for (const take of takes) {
      const raw = await rawTake({ cache, pack, cue, voice, take, offline });
      const candidate = path.join(work, `${cue}.t${take}.wav`);
      const processed = processTake(pack, raw.file, candidate, work);
      const rawSha = sha256(readFileSync(raw.file));
      const verdict = offline && !rejudge && recorded?.raw_sha256 === rawSha ? recorded.judge : await judge(pack, cue, candidate, processed.speechS);
      attempts.push({ take, seed: raw.seed, score: verdict.score });
      console.log(`${pack.padEnd(9)} ${cue.padEnd(18)} take ${take}  ${String(verdict.score).padStart(4)}  ${verdict.transcript} | ${verdict.problems.join(', ') || verdict.notes}`);
      rendered.push({ take, raw, rawSha, candidate, processed, verdict });
      if (!best || verdict.score > best.verdict.score) best = rendered.at(-1);
      // A shootout renders `shootout` takes of the line; otherwise the first take at minScore ships.
      if (verdict.score >= minScore && rendered.length >= (offline ? 1 : shootout)) break;
    }
    let shootoutResult = null;
    const passing = rendered.filter(r => r.verdict.score >= minScore);
    if (!offline && shootout > 1 && passing.length > 1) {
      const result = await compare(pack, cue, passing.map(r => ({ voice: `take ${r.take}`, file: r.candidate })));
      const winner = passing.reduce((a, b) => (result.scores[`take ${b.take}`] > result.scores[`take ${a.take}`] ? b : a));
      shootoutResult = { scores: result.scores, notes: result.notes, winner: winner.take };
      console.log(`${pack.padEnd(9)} ${cue.padEnd(18)} shootout`, result.scores, '->', `take ${winner.take}`);
      best = winner;
    }
    const target = path.join(outDir, `${cue}.wav`);
    writeFileSync(target, readFileSync(best.candidate));
    const bytes = readFileSync(target);
    return {
      id: cue, text: p.text(cue), voice, model: TTS_MODEL, seed: best.raw.seed, take: best.take, prompt: best.raw.prompt,
      raw_sha256: best.rawSha, pre_gain_db: best.processed.preGainDb, gain_db: best.processed.gainDb, lufs: best.processed.lufs, peak_dbfs: best.processed.peakDb,
      duration_s: Math.round(best.processed.duration * 1000) / 1000, bytes: bytes.length, sha256: sha256(bytes),
      judge: { model: JUDGE_MODEL, ...best.verdict }, attempts: offline && recorded ? recorded.attempts : attempts,
      shootout: offline && recorded ? recorded.shootout ?? null : shootoutResult,
    };
  });
  const scores = clips.map(c => c.judge.score);
  writeFileSync(sourcesFile, `${JSON.stringify({
    generator: 'tools/synthesize-announcer-gemini.mjs',
    method: `Gemini TTS (${TTS_MODEL}, prebuilt voice ${voice}) + deterministic ffmpeg chain; original lines from shared/announcer.js`,
    license: 'AI-generated with Google Gemini TTS for this project; no third-party recording (see public/assets/audio/LICENSES.md)',
    format: `WAV PCM s16le mono ${SAMPLE_RATE} Hz`,
    command: `node tools/synthesize-announcer-gemini.mjs --pack ${pack} --voice ${voice}`,
    model: TTS_MODEL, voice, judge_model: JUDGE_MODEL, pre_lufs: PRE_LUFS, target_lufs: TARGET_LUFS, limiter: LIMIT,
    filter: { trim: TRIM, character: p.character, post_limiter: p.post ?? null, wrap: p.wrap ?? null },
    judge_summary: { min: Math.min(...scores), mean: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100) / 100, min_score: minScore },
    clips,
  }, null, 2)}\n`);
  console.log(`${pack}: wrote ${clips.length} clips to ${path.relative(root, outDir) || outDir}; judge min ${Math.min(...scores)}, mean ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}`);
}

async function main() {
  const packs = list(arg('--pack', 'titanfall,objective'));
  const cache = path.resolve(arg('--cache', path.join(os.tmpdir(), 'vb-announcer-gemini')));
  for (const pack of packs) if (!PACKS[pack]) throw new Error(`unknown pack ${pack} (${Object.keys(PACKS).join(', ')})`);
  try {
    if (flag('--audition')) {
      const outDir = path.resolve(arg('--out-dir', path.join(cache, 'auditions')));
      const results = [];
      for (const pack of packs) {
        results.push(await audition({ pack, voices: list(arg('--voices')), cues: list(arg('--cues')) ?? Object.keys(PACKS[pack].cues).slice(0, 3), outDir, cache }));
      }
      writeFileSync(path.join(outDir, `auditions-${packs.join('-')}.json`), `${JSON.stringify(results, null, 2)}\n`);
    } else {
      for (const pack of packs) {
        const p = PACKS[pack];
        await build({
          pack, voice: arg('--voice', p.voice), cues: list(arg('--cue')) ?? Object.keys(p.cues),
          outDir: path.resolve(root, arg('--out-dir', p.dir)), cache,
          minScore: Number(arg('--min-score', 7)), maxTakes: Number(arg('--max-takes', 4)), shootout: Number(arg('--shootout', 1)), offline: flag('--offline'), rejudge: flag('--rejudge'),
        });
      }
    }
  } finally {
    console.log(`API calls: ${stats.tts} TTS, ${stats.judge} judge; ${stats.cached} cached takes reused`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
