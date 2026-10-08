"""Assemble vehicles/manifest.json and vehicles/CREDITS-CC-BY.txt from parts/*.json (only files that exist)."""
import json, re, html, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, DL
OUT = ROOT / 'vehicles'; PARTS = ROOT / 'work-vehicles' / 'parts'
order = ['tank_engine_loop','tank_tracks_loop','tank_turret_traverse','tank_cannon_fire','tank_breech_reload','vehicle_mg_fire',
 'door_minigun_and_jet_cannon','heli_chin_cannon_fire','tank_shell_flyby','jeep_engine_loop','jeep_tyres_offroad_loop','jeep_horn',
 'helicopter_rotor_loop','transport_rotor_loop','rotor_spool_up_down','jet_engine_loop','jet_afterburner','jet_flyby','rocket_pod_launch',
 'aa_missile_launch_and_flight','lock_and_warning_tones','flares_countermeasure','tank_smoke_launcher','ejection_seat',
 'parachute_deploy_and_descent','vehicle_hatch_enter_exit','vehicle_damage_alarm','vehicle_burning_loop','vehicle_water_wade']
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
                return ('U.S. federal government work (17 U.S.C. 105, public domain); YouTube license field: ' + j['license'] +
                        f"; uploaded {j.get('upload_date')}. " + ' '.join((j.get('description') or '').split())[:220])
entries = []
for p in sorted(PARTS.glob('*.json')):
    e = json.loads(p.read_text())
    if not (OUT / e['file']).exists(): continue
    for s in e['sources']:
        if s.get('url'): s['provenance_note'] = note_for(s['url'])
    entries.append(e)
entries.sort(key=lambda e: (order.index(e['id']), e['file']))
skipped = [dict(id='jeep_horn', skipped=True, reason='No horn input or authoritative event exists; the target says to add it only together with such an event, and game code is out of scope for this task.')]
entries += skipped
(OUT / 'manifest.json').write_text(json.dumps(entries, indent=1, ensure_ascii=False) + '\n')
# credits
by = {}
for e in entries:
    for s in e.get('sources', []):
        if s.get('url') and ('CC BY' in s['license'] or 'Attribution' in s['license']):
            by.setdefault(s['url'], dict(s, files=[]))['files'].append(e['file'])
lines = ['VOXEL BLITZ - vehicle sound effects: attribution credits (CC BY)', '',
         'The following recordings are used under Creative Commons Attribution licenses. They were cut, filtered,',
         'level-normalized, looped and/or layered, downmixed to mono and encoded as Opus ("changes were made").', '']
for url, s in by.items():
    lic = s['license']; lic_url = s.get('license_url') or 'https://creativecommons.org/licenses/by/3.0/legalcode'
    lines.append(f'- "{s["title"]}" by {s["author"]} - {url}')
    lines.append(f'  License: {lic} ({lic_url}). Modified. Used in: {", ".join(sorted(set(s["files"])))}')
lines += ['', 'CC0 / public-domain sources are listed in manifest.json for provenance; no attribution is required for them.']
(OUT / 'CREDITS-CC-BY.txt').write_text('\n'.join(lines) + '\n')
tot = sum((OUT / e['file']).stat().st_size for e in entries if 'file' in e)
print(len([e for e in entries if 'file' in e]), 'files', round(tot/1024, 1), 'KiB;', len(by), 'CC-BY sources')
