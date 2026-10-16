"""Ship the built titan bank: python3 -I integrate.py
- verifies every selected TITAN_SAMPLE_GROUPS file, allowing rejected candidates in the external work folder;
- copies them to public/assets/audio/titan/<dir>/<name>.ogg;
- writes public/assets/audio/titan/sources.json (per-file provenance from <work>/parts) and titan/CREDITS.txt;
- rewrites the generated blocks in public/assets/audio/LICENSES.md and docs/audio/titan-sfx.md
  (between <!-- titan-sfx:...:begin --> and <!-- titan-sfx:...:end --> markers)."""
import sys, re, json, shutil, pathlib, datetime, subprocess, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import REPO, ROOT, decode, sha, SR
BANK = REPO / 'public' / 'assets' / 'audio' / 'titan'
LIC = REPO / 'public' / 'assets' / 'audio' / 'LICENSES.md'
DOC = REPO / 'docs' / 'audio' / 'titan-sfx.md'
TODAY = datetime.date.today().isoformat()
groups = json.loads(subprocess.run(['node', '--input-type=module', '-e',
    "import { TITAN_SAMPLE_GROUPS } from './public/js/audio/titan-bank.js'; process.stdout.write(JSON.stringify(TITAN_SAMPLE_GROUPS))"],
    cwd=REPO, capture_output=True, text=True, check=True).stdout)
want = [(group, file) for group, files in groups.items() for file in files]
parts = {json.loads(p.read_text())['file']: json.loads(p.read_text()) for p in (ROOT / 'parts').glob('*.json')}
missing = [f for g, f in want if f not in parts or not (ROOT / 'titan' / f).exists()]
extra = sorted(set(parts) - {f for g, f in want})
if missing: sys.exit(f'bank mismatch: missing {missing}')
if extra: print(f'{len(extra)} rejected candidate takes excluded by TITAN_SAMPLE_GROUPS')
for group, file in want:
    entry = parts[file]
    assert entry['group'] == group and sha(ROOT / 'titan' / file) == entry['output_sha256'], file
    for source in entry['sources']:
        assert source['license'] in ('CC0 1.0', 'CC BY 4.0') and source['author'] and source['url'] and source.get('license_url'), file
entries = []
for group, f in want:
    e = dict(parts[f]); assert e['group'] == group, (f, e['group'], group)
    dst = BANK / f; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT / 'titan' / f, dst)
    assert sha(dst) == e['output_sha256']
    if e['loop']:
        y = decode(dst); st = np.abs(np.diff(y))
        e['loopSeam'] = dict(boundary_step=round(float(abs(y[0] - y[-1])), 5), step_p99=round(float(np.percentile(st, 99)), 5))
    entries.append(e)
# Only remove obsolete audio files in this bank, after every selected take has been verified.
# Rejected candidates and their verdicts remain in the external work folder.
selected = {file for group, file in want}
for path in BANK.glob('*/*.ogg'):
    if path.relative_to(BANK).as_posix() not in selected: path.unlink()
size = sum(e['sizeBytes'] for e in entries); dec = sum(e['durationS'] for e in entries) * SR * 4
doc = dict(bank='titan', title='Titan primary weapon sounds (Splitter, T-203, Railgun, Leadwall, Predator, hit confirms)',
           retrieved=TODAY, integrated=TODAY, format='Ogg Opus mono 48 kHz 96 kbit/s (libopus, -fflags +bitexact)',
           licensePolicy=('CC0 1.0 and CC BY 4.0 recordings from individually checked Freesound or OpenGameArt pages, '
                          'plus original synthesis from the build script (listed under synthLayers, no third-party audio). '
                          'Entry "license" is the most restrictive licence among its sources. CC BY credits: CREDITS.txt, LICENSES.md, docs/audio/titan-sfx.md.'),
           notes=('Freesound items are the public HQ previews (Ogg Vorbis) because original downloads need a login; download_sha256 is the hash of '
                  'that retrieved file. Build: tools/titan-sfx/ (recipes.py lists every cut). Gemini receives and listens to the audio '
                  '(docs/audio/titan-weapons-judging.md); no human audition or audible in-game playback was performed.'),
           budget=dict(files=len(entries), bytes=size, decodedBytesFloat32=int(dec)), files=entries)
(BANK / 'sources.json').write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
# CC BY credits
by = {}; all_sources = {}
for e in entries:
    for s in e['sources']:
        assert s['license'] in ('CC0 1.0', 'CC BY 4.0'), (e['file'], s['license'])
        assert s['author'] and s['url'] and s.get('license_url'), (e['file'], 'incomplete source credit')
        all_sources.setdefault(s['url'], dict(s, files=set()))['files'].add(e['file'])
        if s['license'].startswith('CC BY'):
            by.setdefault(s['url'], dict(s, files=set()))['files'].add(e['file'])
def credit(s):
    lic = s['license']
    url = s.get('license_url') or ('https://creativecommons.org/licenses/by/4.0/' if '4.0' in s['license'] else 'https://creativecommons.org/licenses/by/3.0/')
    return (f'"{s["title"]}" by {s["author"]} ({s["url"]}), {lic}, {url}. Cut, filtered, pitched, level-normalized and/or layered '
            f'and encoded as Opus. Used in: {", ".join(sorted(s["files"]))}.')
credits = [credit(s) for s in sorted(all_sources.values(), key=lambda s: (s['author'].lower(), s['url']))]
(BANK / 'CREDITS.txt').write_text('\n'.join([
    'VOXEL BLITZ - titan weapon sound effects: attribution credits', '',
    'These recordings are used under CC0 or Creative Commons Attribution licenses (changes were made: cut, filtered,',
    'pitched, level-normalized, looped and/or layered, encoded as Opus). Full provenance: sources.json in this',
    'folder and docs/audio/titan-sfx.md.', ''] + credits + ['',
    'All third-party sources are credited above; the sub thumps, ready ping partials and hold-loop hum are',
    'original synthesis from tools/titan-sfx/recipes.py.']) + '\n')
def block(path, name, body, anchor):
    """Replace the marked block, or insert it before the anchor line the first time."""
    t = path.read_text(); b, e = f'<!-- titan-sfx:{name}:begin -->', f'<!-- titan-sfx:{name}:end -->'
    new = f'{b}\n{body.rstrip()}\n{e}'
    if b in t: t = t[:t.index(b)] + new + t[t.index(e) + len(e):]
    else:
        i = t.index(anchor); t = t[:i] + new + '\n\n' + t[i:]
    path.write_text(t)
authors = sorted({s['author'] for e in entries for s in e['sources']}, key=str.lower)
block(LIC, 'licenses', '\n'.join([
    '## Titan weapon sound bank', '',
    f'- Folder: `titan/` ({len(entries)} files in `splitter/`, `t203/`, `railgun/`, `leadwall/`, `predator/`, `common/`). Loaded only by',
    '  the Titanfall client (`TITAN_SAMPLE_MANIFEST` in `public/js/audio/titan-bank.js`), never at boot.',
    '- Sources: individually checked CC0 1.0 and CC BY 4.0 recordings from Freesound (HQ previews) or OpenGameArt,',
    '  plus original synthesis by the build script. No BBC, game or film recordings. The inherited YouTube take',
    '  was replaced because its licence could not be reverified without signing in.',
    '- `titan/sources.json` records per file: source URL, title, author, license, retrieval date, the sha256 of the',
    '  downloaded source, the in/out cut, the processing chain, the output sha256 and decoded measurements.',
    '- Build scripts: `tools/titan-sfx/`. Details and the per-file table: `docs/audio/titan-sfx.md`.', '',
    'Credits for every source, including CC0 (also served at `/assets/audio/titan/CREDITS.txt`):', ''] + ['- ' + c for c in credits]), '## CC BY credits')
# docs tables
rows = ['| File | Group | Length | LUFS | Peak | Licence | Sources (cut) |', '|---|---|---|---|---|---|---|']
for e in entries:
    src = '; '.join(f"[{s['title']}]({s['url']}) by {s['author']} ({s['cut']})" for s in e['sources'])
    if e.get('synthLayers'): src += '; synth: ' + '; '.join(l['description'] for l in e['synthLayers'])
    rows.append(f"| `{e['file']}` | `{e['group']}` | {e['durationS']:.2f} s{' loop' if e['loop'] else ''} | {e['loudnessLUFS']:.1f} | "
                f"{e['peakDb']:.1f} dB | {e['license']} | {src.replace('|', '/')} |")
srcs = {}
for e in entries:
    for s in e['sources']: srcs.setdefault(s['url'], dict(s, files=set()))['files'].add(e['file'])
srow = ['| Source | Author | Licence | Used in |', '|---|---|---|---|']
for s in sorted(srcs.values(), key=lambda s: (s['author'].lower(), s['title'])):
    srow.append(f"| [{s['title'].replace('|', '/')}]({s['url']}) | {s['author']} | {s['license']} | {', '.join(f'`{f}`' for f in sorted(s['files']))} |")
if DOC.exists():
    block(DOC, 'files', '\n'.join(rows), '## Licensing')
    block(DOC, 'sources', '\n'.join(srow), '## Build')
    block(DOC, 'credits', '\n'.join('- ' + c for c in credits), '## Build')
print(f'{len(entries)} files, {size/1048576:.3f} MiB on disk, {dec/1e6:.1f} MB decoded (float32 mono 48 kHz); '
      f'{len(srcs)} sources, {len(by)} CC BY: {", ".join(sorted({s["author"] for s in by.values()}))}')
