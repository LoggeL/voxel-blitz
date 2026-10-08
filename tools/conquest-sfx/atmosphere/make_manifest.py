"""Assemble atmosphere/manifest.json and atmosphere/CREDITS-CC-BY.txt from parts/*.json (only files that exist)."""
import json, re, html, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, DL
OUT = ROOT / 'atmosphere'; PARTS = ROOT / 'work-atmosphere' / 'parts'
order = ['distant_battle_bed', 'offmap_artillery_salvo', 'wind_valley', 'river_flow', 'birds_farm_village', 'church_bell',
         'kessler_works_industrial', 'burning_wreck_props', 'radio_chatter', 'flag_capture_cues']
notes = {}
for d in DL.iterdir():
    m = d / 'meta.json'
    if m.exists():
        j = json.loads(m.read_text()); t = re.sub(r'<[^>]+>', '', html.unescape(j.get('description', ''))); notes[j['url']] = ' '.join(t.split())[:300]
entries = []
for p in sorted(PARTS.glob('*.json')):
    e = json.loads(p.read_text())
    if not (OUT / e['file']).exists(): continue
    for s in e['sources']:
        if s.get('url'): s['provenance_note'] = notes.get(s['url'])
    entries.append(e)
entries.sort(key=lambda e: (order.index(e['id']), e['file']))
for e in entries:
    if e['id'] == 'burning_wreck_props':
        e['usage_note'] = 'Dedicated quiet crackle loop; the vehicle_burning loop from the vehicles bank can be used instead at lower gain.'
    if e['id'] == 'offmap_artillery_salvo':
        e['usage_note'] = 'One shot per file, onset at t=0; schedule 3 per salvo and delay each by distance/343 m/s after the flash.'
(OUT / 'manifest.json').write_text(json.dumps(entries, indent=1, ensure_ascii=False) + '\n')
by = {}
for e in entries:
    for s in e.get('sources', []):
        if s.get('url') and ('CC BY' in s['license'] or 'Attribution' in s['license']):
            by.setdefault(s['url'], dict(s, files=[]))['files'].append(e['file'])
lines = ['VOXEL BLITZ - Conquest atmosphere sound effects: attribution credits (CC BY)', '',
         'The following recordings are used under Creative Commons Attribution licenses. They were cut, filtered,',
         'level-normalized, limited, looped and/or layered and encoded as Opus ("changes were made").', '']
for url, s in by.items():
    lines.append(f'- "{s["title"]}" by {s["author"]} - {url}')
    lines.append(f'  License: {s["license"]} ({s.get("license_url")}). Modified. Used in: {", ".join(sorted(set(s["files"])))}')
lines += ['', 'CC0 sources and the procedurally synthesized cues are listed in manifest.json for provenance; no attribution is required for them.']
(OUT / 'CREDITS-CC-BY.txt').write_text('\n'.join(lines) + '\n')
tot = sum((OUT / e['file']).stat().st_size for e in entries)
ids = sorted(set(e['id'] for e in entries))
print(len(entries), 'files', round(tot / 1024, 1), 'KiB;', len(by), 'CC-BY sources;', len(ids), 'ids; missing:', [i for i in order if i not in ids])
