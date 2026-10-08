"""Assemble explosions/manifest.json and explosions/CREDITS-CC-BY.txt from parts/*.json (only files that exist)."""
import json, re, html, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, DL
OUT = ROOT / 'explosions'; PARTS = ROOT / 'work-explosions' / 'parts'
order = ['frag_grenade_explosion','tank_he_shell_impact','tank_ap_shell_impact','rocket_missile_explosion','autocannon_round_impact',
 'limpet_c4_explosion','vehicle_destruction','vehicle_cookoff_secondary','distant_explosion_tail','debris_rubble_block_break',
 'bullet_impact_dirt','bullet_impact_stone','bullet_impact_metal','bullet_impact_wood','bullet_impact_water','bullet_ricochet',
 'hull_hit_heavy','hull_hit_small_arms','explosion_water_splash']
def note_for(url):
    for d in DL.iterdir():
        m = d / 'meta.json'
        if m.exists():
            j = json.loads(m.read_text())
            if j['url'] == url:
                t = re.sub(r'<[^>]+>', '', html.unescape(j.get('description', ''))); return ' '.join(t.split())[:300]
        i = d / 'source.info.json'
        if i.exists():
            j = json.loads(i.read_text())
            if j['webpage_url'] == url:
                return ('Official U.S. military channel upload; U.S. federal government work (17 U.S.C. 105, public domain); YouTube license field: '
                        + j['license'] + f"; uploaded {j.get('upload_date')}. " + ' '.join((j.get('description') or '').split())[:220])
entries = []
for p in sorted(PARTS.glob('*.json')):
    e = json.loads(p.read_text())
    if not (OUT / e['file']).exists(): continue
    for s in e['sources']:
        if s.get('url'): s['provenance_note'] = note_for(s['url'])
    entries.append(e)
entries.sort(key=lambda e: (order.index(e['id']), e['file']))
(OUT / 'manifest.json').write_text(json.dumps(entries, indent=1, ensure_ascii=False) + '\n')
by = {}
for e in entries:
    for s in e.get('sources', []):
        if s.get('url') and ('CC BY' in s['license'] or 'Attribution' in s['license']):
            by.setdefault(s['url'], dict(s, files=[]))['files'].append(e['file'])
lines = ['VOXEL BLITZ - explosion and impact sound effects: attribution credits (CC BY)', '',
         'The following recordings are used under Creative Commons Attribution licenses. They were cut, filtered,',
         'level-normalized, limited and/or layered, downmixed to mono and encoded as Opus ("changes were made").', '']
for url, s in by.items():
    lic_url = s.get('license_url') or 'https://creativecommons.org/licenses/by/3.0/legalcode'
    lines.append(f'- "{s["title"]}" by {s["author"]} - {url}')
    lines.append(f'  License: {s["license"]} ({lic_url}). Modified. Used in: {", ".join(sorted(set(s["files"])))}')
lines += ['', 'CC0 / public-domain sources are listed in manifest.json for provenance; no attribution is required for them.']
(OUT / 'CREDITS-CC-BY.txt').write_text('\n'.join(lines) + '\n')
tot = sum((OUT / e['file']).stat().st_size for e in entries)
ids = sorted(set(e['id'] for e in entries))
print(len(entries), 'files', round(tot/1024, 1), 'KiB;', len(by), 'CC-BY sources;', len(ids), 'ids; missing:', [i for i in order if i not in ids])
