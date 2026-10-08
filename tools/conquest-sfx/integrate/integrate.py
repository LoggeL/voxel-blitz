"""Copy the Conquest SFX banks into public/assets/audio/conquest/<bank>/ and write each bank's sources.json.
Usage: python3 -I integrate.py   (reads ../<bank>/manifest.json; never runs anything from downloads/)."""
import os, json, hashlib, pathlib, re, shutil
REPO = pathlib.Path(__file__).resolve().parents[3]
WIP = pathlib.Path(os.environ.get('CONQUEST_SFX_WORK') or REPO / '.conquest-work' / 'wip' / 'sfx')
DEST = REPO / 'public' / 'assets' / 'audio' / 'conquest'
BANKS = {
    'vehicles': 'Conquest vehicle sounds (engines, rotors, jets, weapons, crew cues)',
    'explosions': 'Conquest explosions, impacts, hull hits and debris',
    'atmosphere': 'Conquest ambience beds, positional emitters, artillery and flag cues',
}
EXCLUDE = {('atmosphere', 'church-bell-toll-3x.ogg'): 'Not shipped: the game schedules the single toll three times for match start and end (saves 3.5 MB of decoded PCM).'}
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def cuts(text):
    if not text: return []
    return [[float(a), float(b)] for a, b in re.findall(r'(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?) s', text)]
total = 0
for bank, title in BANKS.items():
    manifest = json.loads((WIP / bank / 'manifest.json').read_text())
    out = DEST / bank
    out.mkdir(parents=True, exist_ok=True)
    files, skipped = [], []
    for e in manifest:
        if e.get('skipped'):
            skipped.append({'id': e['id'], 'reason': e.get('reason')}); continue
        if (bank, e['file']) in EXCLUDE:
            skipped.append({'id': e['id'], 'file': e['file'], 'reason': EXCLUDE[(bank, e['file'])]})
            (out / e['file']).unlink(missing_ok=True); continue
        src = WIP / bank / e['file']
        digest = sha(src)
        assert digest == e['output_sha256'], f'{bank}/{e["file"]} hash differs from its manifest'
        shutil.copyfile(src, out / e['file'])
        size = (out / e['file']).stat().st_size
        total += size
        entry = {k: v for k, v in e.items() if k not in ('sources',)}
        entry['path'] = f'conquest/{bank}/{e["file"]}'
        entry['sizeBytes'] = size
        entry['sources'] = []
        for s in e.get('sources', []):
            s = {k: v for k, v in s.items() if k != 'download'}
            s['cuts'] = cuts(s.get('cut'))
            entry['sources'].append(s)
        files.append(entry)
    doc = {
        'bank': f'conquest/{bank}', 'title': title, 'retrieved': '2026-10-08', 'integrated': '2026-10-08',
        'format': 'Ogg Opus 48 kHz via libopus (-fflags +bitexact); mono 96 kbit/s, stereo beds 128 kbit/s',
        'licensePolicy': 'CC0 1.0, CC BY 3.0/4.0, U.S. federal government works (YouTube CC BY field verified with yt-dlp) '
                         'and project-original synthesis only. CC BY credits: docs/audio/conquest-sfx.md and LICENSES.md.',
        'notes': 'Freesound items are the public HQ previews (Ogg Vorbis) because original downloads need a login. '
                 'The download_sha256 is the hash of that retrieved file. Build recipes: tools/conquest-sfx/; source downloads and parts stay local in .conquest-work/wip/sfx/.',
        'files': files, 'skipped': skipped,
    }
    (out / 'sources.json').write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(bank, len(files), 'files', round(sum(f['sizeBytes'] for f in files) / 1024, 1), 'KiB')
print('total', round(total / 1048576, 2), 'MiB')
