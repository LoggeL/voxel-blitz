"""Publish byte-matched Gemini verdicts for the selected bank.
Usage: publish_judging.py <baseline-dir> <round-dir> [round-dir ...], oldest round first.
Every selected file must have a genuine verdict for its exact SHA-256; no inferred scores.
"""
import sys, json, pathlib, datetime
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import REPO, sha

baseline_dir = pathlib.Path(sys.argv[1])
rounds = [pathlib.Path(p) for p in sys.argv[2:]]
known = {}
for folder in rounds:
    for line in (folder / 'summary.jsonl').read_text().splitlines():
        row = json.loads(line)
        known[(row['file'], row['sha256'])] = (row, folder)
bank = REPO / 'public/assets/audio/titan'
manifest = json.loads((bank / 'sources.json').read_text())
baseline = {r['group']: r for r in map(json.loads, (baseline_dir / 'summary.jsonl').read_text().splitlines())}
files = []
for entry in manifest['files']:
    digest = sha(bank / entry['file'])
    assert digest == entry['output_sha256'], entry['file']
    row, folder = known[(entry['file'], digest)]
    prefix = entry['file'].replace('/', '__').replace('.ogg', '')
    verdict = (folder / (prefix + '.verdict.txt')).read_text()
    assert row['scores']['OVERALL'] in range(1, 11), entry['file']
    files.append(dict(file=entry['file'], group=entry['group'], sha256=digest, scores=row['scores'],
                      metrics=row['metrics'], judged_in=folder.name, verdict=verdict))
document = dict(model='gemini-3.8-flash', generated=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                audio_input=True, human_audition=False, baseline=list(baseline.values()), files=files)
out = REPO / 'docs/audio'
(out / 'titan-weapons-verdicts.json').write_text(json.dumps(document, indent=2, ensure_ascii=False) + '\n')

groups = {}
for row in files: groups.setdefault(row['group'], []).append(row)
def score(rows):
    values = [r['scores']['OVERALL'] for r in rows]
    return f'{sum(values)/len(values):.1f} ({min(values)}-{max(values)})' if len(values) > 1 else str(values[0])
weak = [r for r in files if r['scores']['OVERALL'] < 7]
lines = ['# Titan weapon sounds: Gemini audio judging', '',
    'The selected bank contains ' + str(len(files)) + ' files. Every shipped file has a Gemini verdict for its exact',
    'encoded bytes. [titan-weapons-verdicts.json](titan-weapons-verdicts.json) preserves the scores, output',
    'SHA-256, measurements and complete latest answer. Gemini received the audio itself through the user-provided',
    '`gemini-audio.py` helper; no human audition or audible in-game playback was performed.', '',
    '## Method', '',
    '`gemini-3.8-flash` scores FIT, PUNCH, CLEANLINESS, LENGTH_TAIL, DISTINCTNESS and OVERALL from 1 to 10.',
    'Each prompt names the cue role and target feel and asks for concrete problems and processing fixes.',
    'Requests run sequentially with a 2.5 s pause. The helper reads the Keychain key process-locally.',
    'A verdict is reused only for identical audio SHA-256. Spectrograms are local QA artifacts; the helper',
    'sends audio and text. Short cues use a K-weighted event mean because gated 400 ms LUFS blocks cannot',
    'measure them. Early rounds used a windowed spectral share and 5 ms peak window; final rechecks use',
    'full-event band energy and a 10 ms peak window. The saved prompts retain their original measurements.', '',
    '## Before and after', '',
    'The old fire voices were rendered offline from the deterministic TitanSynth tone/hiss recipes and',
    'heard by Gemini. They are reconstructions of the old procedural voice, not browser recordings.',
    'Old charge, mechanics and impact layers were not judged in this baseline. Values below are OVERALL;',
    'a multi-take group shows its mean and range.', '',
    '| Cue | Old synth | Selected bank | Takes |', '|---|---|---|---|']
for group, rows in groups.items():
    voice = group.split('.')[1]
    old = str(baseline[voice]['scores']['OVERALL']) if group.endswith('.fire') and voice in baseline else 'not judged'
    lines.append(f'| `{group}` | {old} | {score(rows)} | {len(rows)} |')
lines += ['', '## Iteration and selection', '',
    '- The inherited bank was rechecked; the first comparison run stopped on an upstream HTTP 503.',
    '  The candidate and delivery rounds completed, and every selected byte hash has a valid answer.',
    '- Fire bodies were aligned to the attack, low-mid weight was separated from sub clutter, and',
    '  mechanical cycles were cleaned and synchronized to authoritative charge, spin and reload timing.',
    '- The Railgun tail had a positional-argument bug: its low-pass cutoff became 0.06 Hz. Correct',
    '  argument order restores the recorded thunder, and source-layer notes now reject non-text values.',
    '- Weak variants were removed from the active random pool. Predator uses its twice-rated 8/10',
    '  third autocannon report and the 8/10 armour impact, with per-event pitch variation. Other fire',
    '  banks retain multiple recorded takes. Rejected takes remain in the external work folder.',
    '- The ION split cue is an additive layer mixed with dry fire and the tail. Its final alignment,',
    '  saturated low-mid body and breech snap reached 7 for both selected takes.', '',
    '## Remaining score below 7', '']
if weak:
    for row in weak:
        lines.append(f'- `{row["file"]}`: OVERALL {row["scores"]["OVERALL"]}.')
    lines += ['The Predator spin-down was rebuilt with a wider motor band, more chain friction, bearing',
        'teeth and a timed brake detent. Repeated versions scored 4-6. The retained clean cue still reads',
        'too much like a light servo and lacks heavy rotational inertia. More bass buried the mechanical',
        'rhythm or made it resemble an energy power-down. This remains an explicit exception to the 7',
        'target, not a passed score. A heavier industrial recording or a permitted human playthrough is',
        'the next useful check. Its duration and interruption behavior follow the server spin state.']
else: lines += ['Every selected cue reached OVERALL 7 or higher.']
lines += ['', '## Every shipped file', '',
    '| File | Overall | Fit | Punch | Cleanliness | Length/tail | Distinctness |',
    '|---|---|---|---|---|---|---|']
for row in files:
    s = row['scores']
    lines.append('| `' + row['file'] + '` | ' + ' | '.join(str(s[k]) for k in
        ['OVERALL', 'FIT', 'PUNCH', 'CLEANLINESS', 'LENGTH_TAIL', 'DISTINCTNESS']) + ' |')
(out / 'titan-weapons-judging.md').write_text('\n'.join(lines) + '\n')
print(f'{len(files)} exact-byte verdicts published; {len(weak)} explicit score exceptions')
