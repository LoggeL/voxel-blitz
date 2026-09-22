#!/usr/bin/env python3
"""Analyze candidates, then rebuild the IRON PICK dig and attack sets; no API calls.

Requires ffmpeg, numpy, scipy and matplotlib (.artifacts/audio-analysis-venv).
`analyze` plots and measures every candidate (80 Hz high-passed so generated
infrasonic drift cannot hide the contact). `process` follows the reviewed
layer recipes in docs/audio/pickaxe-dig/recipes.json. Every layer is original
ElevenLabs output from this project (receipt- and hash-checked) or a seeded
numpy synthesis layer; no third-party or game recordings. Final measurements
always inspect the decoded Opus files.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / '.artifacts'
WORK = ART / 'elevenlabs-pickaxe-dig-2026-09-22'
DOCS = ROOT / 'docs/audio/pickaxe-dig'
OUT = ROOT / 'public/assets/audio/weapons/knife'
spec = importlib.util.spec_from_file_location('effects', ROOT / 'tools/prepare-elevenlabs-effects.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
np, plt, RATE = fx.np, fx.plt, fx.RATE
# Candidate pools: this set's own generations plus unused/rejected takes that
# earlier sessions generated with the same account (receipts retained).
POOLS = {
    'dig': WORK,
    'footsteps': ART / 'elevenlabs-footsteps-2026-09-16',
    'remaining': ART / 'elevenlabs-remaining-2026-09-09',
    'hits': ART / 'elevenlabs-hits-2026-09-08',
    'pickaxe-impact': ART / 'elevenlabs-pickaxe-2026-09-08/impact',
    'pickaxe-rock': ART / 'elevenlabs-pickaxe-2026-09-08/rock',
    'pickaxe-swing': ART / 'elevenlabs-pickaxe-2026-09-08/swing',
    'pickaxe-swoosh': ART / 'elevenlabs-pickaxe-2026-09-08/swoosh',
}
DIG = ['stone', 'wood', 'gravel', 'grass', 'sand', 'cloth', 'glass', 'metal']
ATTACK = ['strong', 'crit', 'knockback', 'armor', 'backstab']
CANDIDATES = {
    'stone': ['dig/dig-stone-1', 'dig/dig-stone-2', 'dig/dig-stone-3', 'remaining/impact-stone-1',
              'remaining/impact-stone-2', 'footsteps/step-stone-2'],
    'wood': ['dig/dig-wood-1', 'dig/dig-wood-2', 'dig/dig-wood-3', 'remaining/impact-wood-1',
             'remaining/impact-wood-2'],
    'gravel': ['dig/dig-gravel-1', 'dig/dig-gravel-2', 'dig/dig-gravel-3'],
    'grass': ['dig/dig-grass-1', 'dig/dig-grass-2', 'dig/dig-grass-3'],
    'sand': ['dig/dig-sand-1', 'footsteps/step-sand-1', 'footsteps/step-sand-2', 'footsteps/step-sand-5'],
    'cloth': [f'footsteps/step-cloth-{n}' for n in range(1, 7)],
    'glass': [f'remaining/impact-glass-{n}' for n in range(1, 5)],
    'metal': ['remaining/impact-metal-1', 'remaining/impact-metal-2']
             + [f'footsteps/step-metal-{n}' for n in range(1, 7)],
    'attack-body': ['hits/hitbody-1', 'hits/hitbody-2', 'hits/hitbody-3', 'hits/hithead-1',
                    'hits/hithead-2', 'hits/hithead-3'],
    'attack-edge': ['pickaxe-impact/knife-1', 'pickaxe-impact/knife-2', 'pickaxe-impact/knife-3',
                    'pickaxe-rock/pickaxeimpact-1', 'pickaxe-rock/pickaxeimpact-2'],
    'attack-air': ['pickaxe-swing/knife-1', 'pickaxe-swing/knife-2', 'pickaxe-swing/knife-3',
                   'pickaxe-swoosh/knife-1', 'pickaxe-swoosh/knife-2'],
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def paths(source):
    pool, stem = source.split('/')
    base = POOLS[pool]
    return base / 'source' / f'{stem}.wav', base / 'api-source' / f'{stem}.mp3', base / 'api-source' / f'{stem}.json'


def ff(x, filters):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE), '-ac', '1',
        '-i', '-', '-af', filters, '-f', 'f32le', '-'], input=x.astype('<f4').tobytes())
    return np.frombuffer(raw, dtype='<f4').astype(np.float64)


def verified(source):
    wav, mp3, receipt_path = paths(source)
    receipt = json.loads(receipt_path.read_text())
    assert receipt['status'] == 'complete', source
    assert digest(wav) == receipt['decoded_sha256'], source
    assert digest(mp3) == receipt['raw_sha256'], source
    return wav, mp3, receipt


def plot_group(entries, output):
    fig, axes = plt.subplots(len(entries), 2, figsize=(14, 2.7 * len(entries)), squeeze=False)
    for row, (title, pcm, metrics) in enumerate(entries):
        fx.plot_pair(*axes[row], pcm, title, metrics)
        peak = max(metrics['peak'] * 1.15, .001)
        axes[row, 0].set_ylim(-peak, peak)
    fig.tight_layout()
    fig.savefig(output, dpi=90)
    plt.close(fig)


def analyze():
    folder = WORK / 'analysis'
    folder.mkdir(parents=True, exist_ok=True)
    records = {}
    for group, sources in CANDIDATES.items():
        entries = []
        for source in sources:
            wav, _, _ = verified(source)
            pcm = ff(fx.decode(wav), 'highpass=f=80')
            metrics = fx.measure(pcm)
            records[source] = metrics
            entries.append((source, pcm, metrics))
        plot_group(entries, folder / f'raw-{group}.png')
    (folder / 'raw-metrics.json').write_text(json.dumps(records, indent=2) + '\n')
    print(f'Analyzed {len(records)} candidates in {folder}')


# Seeded synthesis layers. Each one adds a physical quality the generated take
# lacks (iron ring, glass partials, a crit sparkle, a body thump, a cloth puff).
def synth(layer, n, seed):
    rng = np.random.default_rng(seed)
    t = np.arange(n) / RATE
    kind = layer['synth']
    if kind == 'ring':  # inharmonic struck-bar partials
        out = np.zeros(n)
        for i, hz in enumerate(layer['partials']):
            out += np.sin(2 * np.pi * hz * t + rng.uniform(0, 6.28)) * np.exp(-t / (layer['decay'] / (1 + .6 * i))) / (1 + i * .7)
        return out * np.minimum(t / .0015, 1)
    if kind == 'sparkle':  # a few bright staggered glints
        out = np.zeros(n)
        for i in range(layer.get('count', 5)):
            at = layer.get('start', .01) + i * layer.get('spacing', .018) + rng.uniform(0, .006)
            hz = rng.uniform(*layer.get('range', (3200, 7200)))
            local = np.maximum(t - at, 0)
            out += np.sin(2 * np.pi * hz * local) * np.exp(-local / .03) * (t >= at) * (.85 ** i)
        return out
    if kind == 'thud':  # pitched-down body thump
        f0, f1 = layer['hz']
        freq = f1 + (f0 - f1) * np.exp(-t / .03)
        phase = 2 * np.pi * np.cumsum(freq) / RATE
        return np.sin(phase) * np.exp(-t / layer['decay']) * np.minimum(t / .002, 1)
    if kind == 'puff':  # lowpassed noise breath of compressed cloth/air
        noise = ff(rng.standard_normal(n) * .3, f'lowpass=f={layer["lowpass"]},lowpass=f={layer["lowpass"]}')
        return noise * np.minimum(t / .004, 1) * np.exp(-t / layer['decay'])
    raise ValueError(kind)


def render(recipe, seed):
    length = round(recipe['length'] * RATE)
    mix = np.zeros(length)
    layers = []
    for layer in recipe['layers']:
        delay = round(layer.get('delay', 0) * RATE)
        if 'source' in layer:
            wav, mp3, receipt = verified(layer['source'])
            original = fx.decode(wav)
            start, end = layer['trim']
            assert 0 <= start < end <= len(original) / RATE + 1e-6, layer
            pcm = original[round(start * RATE):round(end * RATE)]
            filters = 'highpass=f=%d' % layer.get('highpass', 90)
            if layer.get('rate', 1) != 1:  # varispeed: pitch and time together
                filters = f'asetrate={RATE * layer["rate"]:.0f},aresample={RATE},' + filters
            if layer.get('filters'):
                filters += ',' + layer['filters']
            pcm = ff(pcm, filters)
            pcm /= max(np.max(np.abs(pcm)), 1e-9)
            layers.append(dict(source=layer['source'], trim_seconds=[start, end], filters=filters,
                source_sha256=digest(wav), raw_sha256=digest(mp3),
                generation={key: receipt.get(key) for key in
                            ['cue', 'created_at', 'request_body', 'character_cost', 'request_id']}))
        else:
            pcm = synth(layer, length - delay, seed + len(layers))
            pcm /= max(np.max(np.abs(pcm)), 1e-9)
            layers.append(dict(synth=layer))
        pcm = pcm[:length - delay] * layer['gain']
        if layer.get('tau'):
            elapsed = np.maximum(0, np.arange(len(pcm)) / RATE - layer.get('hold', 0))
            pcm *= np.exp(-elapsed / layer['tau'])
        mix[delay:delay + len(pcm)] += pcm
        layers[-1].update(gain=layer['gain'], delay_seconds=layer.get('delay', 0))
    # Start on the contact, decay to silence; short fades remove cut-edge clicks.
    lead = np.flatnonzero(np.abs(mix) > np.max(np.abs(mix)) * .02)
    mix = mix[max(0, lead[0] - round(.0005 * RATE)):] if len(lead) else mix
    tail = np.flatnonzero(np.abs(mix) > np.max(np.abs(mix)) * .004)
    mix = mix[:min(len(mix), tail[-1] + round(.012 * RATE))]
    fade_in, fade_out = round(.0015 * RATE), round(recipe.get('fade_out', .05) * RATE)
    mix[:fade_in] *= np.linspace(0, 1, fade_in)
    mix[-fade_out:] *= np.linspace(1, 0, fade_out) ** 2
    return mix, layers


def process():
    recipes = json.loads((DOCS / 'recipes.json').read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    records, plots = [], {}
    sets = [('dig', m, recipes['dig'][m]) for m in DIG] + [('break', 'glass', recipes['break']['glass'])] \
        + [('attack', k, recipes['attack'][k]) for k in ATTACK]
    for family, name, selections in sets:
        for variant, recipe in enumerate(selections, 1):
            stem = f'{family}-{name}-{variant}' if family != 'break' else f'dig-glass-break-{variant}'
            if family == 'dig':
                slot = f'pickaxe.dig.{name}.{variant}'
            elif family == 'break':
                slot = f'pickaxe.break.glass.{variant}'
            else:
                slot = f'pickaxe.attack.{name}.{variant}'
            seed = int(hashlib.sha256(stem.encode()).hexdigest()[:8], 16)
            pcm, layers = render(recipe, seed)
            peak_target = recipe.get('peak', .6)
            window = round(.04 * RATE)
            cumulative = np.concatenate(([0.], np.cumsum(pcm * pcm)))
            body_rms = np.sqrt(np.max(cumulative[window:] - cumulative[:-window]) / window)
            gain = min(recipe['body_rms'] / max(body_rms, 1e-9), peak_target / np.max(np.abs(pcm)))
            output = OUT / f'{stem}.ogg'
            for _ in range(5):
                fx.encode(pcm * gain, output)
                final = fx.decode(output)
                if np.max(np.abs(final)) <= peak_target + .003:
                    break
                gain *= peak_target * .99 / np.max(np.abs(final))
            m = fx.measure(final)
            limit = .62 if family == 'break' or name == 'knockback' else .46
            assert m['clipping_samples_at_0_999'] == 0, stem
            assert m['peak'] <= peak_target + .003, (stem, m['peak'])
            assert .06 <= m['duration_seconds'] <= limit, (stem, m['duration_seconds'])
            assert m['onset_seconds_2pct_peak'] <= .006, (stem, m['onset_seconds_2pct_peak'])
            assert m['rms_5ms_peak_at_seconds'] <= (.14 if name == 'knockback' else .09), (stem, m)
            assert abs(m['dc_mean']) < .002 and m['last_20ms_rms'] < .004, (stem, m)
            records.append(dict(family=family, set=name, variant=variant, slot=slot,
                output=str(output.relative_to(ROOT)), output_sha256=digest(output),
                layers=layers, length_seconds=recipe['length'], fade_in_seconds=.0015,
                fade_out_seconds=recipe.get('fade_out', .05), fade_out_curve='quadratic',
                target_body_rms_40ms=recipe['body_rms'], peak_target=peak_target,
                normalization_gain=float(gain), synthesis_seed=seed, sample_rate_hz=RATE, channels=1,
                codec='Opus', bitrate='96k', selection_reason=recipe['reason'], final_metrics=m))
            plots.setdefault(f'{family}-{name}' if family != 'dig' else name, []).append(
                (f'{stem} ({", ".join(l.get("source") or l["synth"]["synth"] for l in layers)})', final, m))
            print(f'{stem}: {m["duration_seconds"]:.3f}s peak {m["peak"]:.3f} rms {m["rms"]:.3f} '
                  f'centroid {m["spectral_centroid_hz"]:.0f}Hz attack {m["rms_5ms_peak_at_seconds"] * 1000:.0f}ms '
                  f'e90 {m["energy_seconds"]["90"] * 1000:.0f}ms', flush=True)
    DOCS.mkdir(parents=True, exist_ok=True)
    for group, entries in plots.items():
        plot_group(entries, DOCS / f'{group}-waveforms.png')
    receipts = [json.loads(p.read_text()) for p in (WORK / 'api-source').glob('*.json')]
    completed = [r for r in receipts if r['status'] == 'complete']
    used = sorted({l['source'] for r in records for l in r['layers'] if 'source' in l})
    manifest = dict(service='ElevenLabs Sound Effects', model='eleven_text_to_sound_v2',
        generated='2026-09-22', candidates=len(completed), selected=len(records),
        credits=sum(int(r.get('character_cost') or 0) for r in completed),
        credit_note=recipes['credit_note'], reused_sources=[s for s in used if not s.startswith('dig/')],
        review_basis='Waveform/spectrogram inspection and metric gates (onset, 40 ms body RMS, peak, '
            'spectral centroid, energy decay, tail). No subjective listening approval is asserted.',
        api_reference='https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert',
        source_note='Original generated Foley plus seeded numpy synthesis layers. No game or third-party '
            'recordings used. Generating account terms apply.',
        rebuild='.artifacts/audio-analysis-venv/bin/python tools/prepare-pickaxe-dig-audio.py process',
        rejected=recipes['rejected'], selections=records)
    (ROOT / 'public/assets/audio/elevenlabs-pickaxe-dig-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['analyze', 'process'])
    args = parser.parse_args()
    (analyze if args.action == 'analyze' else process)()
