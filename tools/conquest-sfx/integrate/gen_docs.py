"""Generate docs/audio/conquest-sfx.md tables and the CC BY credit lists from public/assets/audio/conquest/*/sources.json.
Usage: python3 -I gen_docs.py  -> writes docs/audio/conquest-sfx.sources.md fragment, conquest/CREDITS.txt and prints the LICENSES block."""
import json, pathlib
REPO = pathlib.Path(__file__).resolve().parents[3]
BANK = REPO / 'public' / 'assets' / 'audio' / 'conquest'
def is_by(lic): return 'CC BY' in lic or 'Attribution' in lic
rows, by = [], {}
for bank in ('vehicles', 'explosions', 'atmosphere'):
    doc = json.loads((BANK / bank / 'sources.json').read_text())
    for f in doc['files']:
        for s in f['sources']:
            rows.append((bank, f['file'], f['id'], s))
            if s.get('url') and is_by(s['license']):
                e = by.setdefault(s['url'], dict(title=s['title'], author=s['author'], license=s['license'],
                                                 license_url=s.get('license_url') or ('https://creativecommons.org/licenses/by/3.0/' if '3.0' in s['license'] else 'https://creativecommons.org/licenses/by/4.0/'),
                                                 retrieved=s.get('retrieved'), files=set()))
                e['files'].add(f'{bank}/{f["file"]}')
def esc(t): return str(t).replace('|', '\\|').replace('\n', ' ')
def lic_label(s):
    lic = s['license']
    if 'Creative Commons Attribution license' in lic: return 'CC BY 3.0 (YouTube) + U.S. gov. work'
    return lic
# source table grouped by source URL
srcs = {}
for bank, file, tid, s in rows:
    key = s.get('url') or f'original:{bank}/{file}'
    e = srcs.setdefault(key, dict(s=s, uses=[]))
    e['uses'].append((f'{bank}/{file}', s.get('cut') or '—'))
lines = ['| Source | Author | License | Retrieved | Used in (cut) |', '|---|---|---|---|---|']
for key, e in sorted(srcs.items(), key=lambda kv: (kv[1]['s'].get('author') or '', kv[0])):
    s = e['s']
    title = f"[{esc(s['title'])}]({s['url']})" if s.get('url') else esc(s['title'])
    uses = '; '.join(f"`{u}` ({esc(c)})" for u, c in sorted(e['uses']))
    lines.append(f"| {title} | {esc(s.get('author'))} | {esc(lic_label(s))} | {s.get('retrieved') or '—'} | {uses} |")
(REPO / '.conquest-work' / 'wip' / 'sfx' / 'work-integrate' / 'source-table.md').write_text('\n'.join(lines) + '\n')
credit_lines = []
for url, e in sorted(by.items(), key=lambda kv: kv[1]['author'].lower()):
    lic = 'CC BY 3.0 (YouTube Creative Commons Attribution license)' if 'Creative Commons Attribution license' in e['license'] else e['license']
    note = ' (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY)' if 'Creative Commons Attribution license' in e['license'] else ''
    credit_lines.append(f'- "{e["title"]}" by {e["author"]} ({url}), {lic}{note} — {e["license_url"] if not note else "https://creativecommons.org/licenses/by/3.0/"}. '
                        f'Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: {", ".join(sorted(e["files"]))}.')
(REPO / '.conquest-work' / 'wip' / 'sfx' / 'work-integrate' / 'credits.md').write_text('\n'.join(credit_lines) + '\n')
txt = ['VOXEL BLITZ - Conquest sound effects: attribution credits', '',
       'These recordings are used under Creative Commons Attribution licenses (changes were made:',
       'cut, filtered, level-normalized, looped and/or layered, encoded as Opus). Full provenance:',
       'sources.json in each bank folder and docs/audio/conquest-sfx.md.', '']
for l in credit_lines: txt.append(l[2:])
txt += ['', 'Every other Conquest sound is CC0 1.0, a U.S. federal government work, or original synthesis', 'made for this project; see the bank sources.json files.']
(BANK / 'CREDITS.txt').write_text('\n'.join(txt) + '\n')
print(len(srcs), 'sources;', len(by), 'CC BY sources;', len(rows), 'source uses')
