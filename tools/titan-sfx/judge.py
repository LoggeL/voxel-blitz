"""Model judging of one sound (docs/audio/titan-weapons-judging.md) with Google Gemini, which listens to the audio:
the audio file inline through the user-provided helper, plus text measurements (duration, peak, integrated
loudness, loudness range, crest factor, spectral centroid), the intended role and the source description.
The API key is read from the macOS keychain (service `google-api-key`) and never printed or stored.
Usage: python3 -I judge.py <audio> <out-prefix> "<role>" "<source description>" [extra context]
Writes <out-prefix>.spec.png, .wave.png, .prompt.txt, .verdict.txt (the model answer) and prints the verdict."""
import sys, os, re, json, time, subprocess, pathlib, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import decode, SR
from dsp import lufs
MODEL = os.environ.get('TITAN_JUDGE_MODEL', 'gemini-3.8-flash')
AUDIO_HELPER = pathlib.Path(os.environ.get('TITAN_GEMINI_AUDIO_HELPER', '/Users/logge/voxel-blitz-sfx-handoff/gemini-audio.py'))

def metrics(path):
    x = decode(path)
    peak = float(np.abs(x).max()); rms = float(np.sqrt(np.mean(x ** 2)) + 1e-12)
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))); f = np.fft.rfftfreq(len(x), 1 / SR)
    centroid = float((spec * f).sum() / (spec.sum() + 1e-12))
    power = np.abs(np.fft.rfft(x)) ** 2
    lo = float(power[f < 200].sum() / (power.sum() + 1e-12))
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'info', '-i', str(path), '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    tail = r[r.rfind('Summary'):]
    num = lambda k: float((re.search(k + r':\s+(-?[\d.]+|-inf)', tail) or [None, 'nan'])[1].replace('-inf', '-70'))
    env = np.sqrt(np.convolve(x ** 2, np.ones(480) / 480, 'same'))
    t_peak = float(np.argmax(env) / SR)
    head = float(np.abs(x[:96]).max()); end = float(np.abs(x[-96:]).max())
    return dict(duration_s=round(len(x) / SR, 3), peak_dbfs=round(20 * np.log10(peak + 1e-12), 2),
                integrated_lufs=round(lufs(x), 2), loudness_method='BS.1770 gated blocks; K-weighted event mean for cues below 400 ms',
                loudness_range_lu=num('LRA'), true_peak_dbtp=num('Peak'),
                crest_factor_db=round(20 * np.log10(peak / rms), 2), spectral_centroid_hz=round(centroid),
                energy_below_200hz_pct=round(lo * 100, 1), loudest_10ms_at_s=round(t_peak, 3),
                first_2ms_peak=round(head, 4), last_2ms_peak=round(end, 4), dc_offset=round(float(x.mean()), 5))

PROMPT = """You are a senior game sound designer judging one sound effect for a voxel shooter's Titanfall-2-style mech combat
(7 m tall titans, heavy and punchy, each weapon with its own character). Listen to the attached audio (the sound itself).
These measurements provide extra context, but base your judgement on the attached audio:
{metrics}

Intended role: {role}
Other weapons: ION is a crisp electric plasma crack; Scorch is a hollow launcher thump with thermite hiss;
Northstar is a hypervelocity electric rupture with a rolling tail; Ronin is a broad ballistic shotgun slam;
Legion is a tight repeating autocannon hammer with a heavy barrel motor. Judge distinctness against these roles.
Source / construction: {source}
{extra}
Score 1-10 each: FIT (to the role), PUNCH (transient and weight), CLEANLINESS (clipping, noise floor, clicks, DC),
LENGTH_TAIL (length and decay right for the role), DISTINCTNESS (would it read as its own weapon next to the others).
Then OVERALL (1-10). Then list concrete problems and concrete processing suggestions (EQ bands in Hz, envelope/fade times
in ms, layering, pitch, length), max 8 bullets. Answer in this exact format:
FIT: n
PUNCH: n
CLEANLINESS: n
LENGTH_TAIL: n
DISTINCTNESS: n
OVERALL: n
PROBLEMS:
- ...
SUGGESTIONS:
- ..."""

def judge(path, prefix, role, source, extra=''):
    prefix = pathlib.Path(prefix); prefix.parent.mkdir(parents=True, exist_ok=True)
    spec, wave = prefix.with_suffix('.spec.png'), prefix.with_suffix('.wave.png')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-lavfi', 'showspectrumpic=s=1000x400:legend=1:fscale=log:start=20:stop=20000', str(spec)], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-lavfi', 'showwavespic=s=1000x240:split_channels=0:colors=white', str(wave)], check=True)
    m = metrics(path)
    prompt = PROMPT.format(metrics=json.dumps(m, indent=1), role=role, source=source, extra=extra)
    prefix.with_suffix('.prompt.txt').write_text(prompt)
    if not AUDIO_HELPER.is_file(): raise FileNotFoundError(f'Gemini audio helper missing: {AUDIO_HELPER}')
    out = ''
    audio_path = pathlib.Path(path)
    for attempt in range(4):
        result = subprocess.run(['python3', str(AUDIO_HELPER), MODEL, str(audio_path), prompt], capture_output=True, text=True)
        out = result.stdout.strip()
        if result.returncode == 0 and re.search(r'OVERALL:\s*\d', out): break
        # Never copy the helper's traceback or request headers into saved records.
        status = re.search(r'HTTP Error (\d+)', result.stderr)
        out = f'Gemini request failed (exit {result.returncode}' + (f', HTTP {status[1]}' if status else '') + ')'
        if status and status[1] not in ('429', '500', '503'): break
        if status and status[1] == '503' and attempt >= 1 and audio_path.suffix == '.ogg':
            # Some Opus inputs cause repeated upstream 503s. Retry their exact decoded signal as PCM.
            audio_path = prefix.with_suffix('.input.wav')
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(path), '-c:a', 'pcm_s16le', str(audio_path)], check=True)
        time.sleep(min(45, 5 * 2 ** attempt))
    time.sleep(2.5)
    prefix.with_suffix('.verdict.txt').write_text(f'model: {MODEL}\n' + out)
    m['judge_input_format'] = audio_path.suffix[1:]
    scores = {k: int(v) for k, v in re.findall(r'(FIT|PUNCH|CLEANLINESS|LENGTH_TAIL|DISTINCTNESS|OVERALL):\s*(\d+)', out)}
    if set(scores) != {'FIT', 'PUNCH', 'CLEANLINESS', 'LENGTH_TAIL', 'DISTINCTNESS', 'OVERALL'} or not all(1 <= v <= 10 for v in scores.values()):
        raise RuntimeError(f'No valid Gemini verdict for {path}: {out[:180]}')
    return m, scores, out

if __name__ == '__main__':
    path, prefix, role, source = sys.argv[1:5]
    m, s, out = judge(path, prefix, role, source, sys.argv[5] if len(sys.argv) > 5 else '')
    print(json.dumps(m)); print(json.dumps(s)); print(out)
