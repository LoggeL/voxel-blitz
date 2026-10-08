"""Fetch Freesound CC0/CC-BY HQ previews (no credentials). Each into downloads/fs-<id>/. Usage: fs_fetch.py id [id...]"""
import os, sys, re, json, html, hashlib, urllib.request, datetime, pathlib, time
DL = pathlib.Path(os.environ.get('CONQUEST_SFX_WORK') or pathlib.Path(__file__).resolve().parents[3] / '.conquest-work' / 'wip' / 'sfx') / 'downloads'
def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    r = urllib.request.urlopen(req, timeout=60)
    return r.geturl(), r.read() if binary else r.read().decode('utf-8', 'replace')
for sid in sys.argv[1:]:
    d = DL / f'fs-{sid}'
    if (d / 'meta.json').exists():
        print('have', sid, json.loads((d/'meta.json').read_text())['license']); continue
    url, h = fetch(f'https://freesound.org/s/{sid}/')
    lic = re.findall(r'creativecommons\.org/(?:licenses|publicdomain)/[^"\s]+', h)
    lic = sorted(set(lic))
    licname = {'publicdomain/zero/1.0/': 'CC0 1.0'}
    ok = [l for l in lic if '/by/' in l or 'zero' in l]
    bad = [l for l in lic if '-nc' in l or 'sampling' in l or '-nd' in l]
    if bad or not ok:
        print('SKIP license', sid, lic); continue
    l = ok[0].split('creativecommons.org/')[1]
    name = 'CC0 1.0' if 'zero' in l else 'CC BY ' + l.split('/by/')[1].strip('/')
    m = lambda p: html.unescape((re.search(p, h, re.S) or [None, ''])[1]).strip()
    desc = m(r'name="twitter:description" content="([^"]*)"')
    title = m(r'og:audio:title" content="([^"]*)"'); author = m(r'og:audio:artist" content="([^"]*)"')
    mp3 = m(r'data-static-file-url="([^"]*)"')
    ogg = mp3.replace('-hq.mp3', '-hq.ogg')
    d.mkdir(parents=True, exist_ok=True)
    _, data = fetch(ogg, True)
    (d / 'source.ogg').write_bytes(data)
    meta = dict(source='freesound', id=sid, url=url, title=title, author=author, license=name,
                license_url='https://creativecommons.org/' + l, description=desc, file_url=ogg,
                note='Freesound HQ preview (Ogg Vorbis ~192 kbit/s); original download needs login.',
                retrieved=datetime.date.today().isoformat(), sha256=hashlib.sha256(data).hexdigest())
    (d / 'meta.json').write_text(json.dumps(meta, indent=1))
    print('got', sid, name, author, '|', title, '|', desc[:160].replace('\n', ' '))
    time.sleep(0.7)
