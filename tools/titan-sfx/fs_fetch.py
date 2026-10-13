"""Fetch Freesound CC0 / CC BY HQ previews (no credentials), each into <TITAN_SFX_DL>/fs-<id>/ (source.ogg + meta.json).
Refuses anything that is not CC0 or CC BY (NC, ND, sampling+). Usage: fs_fetch.py id [id...]"""
import sys, re, json, html, hashlib, urllib.request, urllib.error, datetime, time, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import DL
BANNED = ('craigsmith',)
def fetch(url, binary=False):
    for k in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            r = urllib.request.urlopen(req, timeout=60)
            out = (r.geturl(), r.read() if binary else r.read().decode('utf-8', 'replace')); time.sleep(3); return out
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(15 * (k + 1))
    raise RuntimeError('rate limited')
for sid in sys.argv[1:]:
    d = DL / f'fs-{sid}'
    if (d / 'meta.json').exists():
        m = json.loads((d / 'meta.json').read_text()); print('have', sid, m['license'], m['author'], '|', m['title']); continue
    url, h = fetch(f'https://freesound.org/s/{sid}/')
    lic = sorted(set(re.findall(r'creativecommons\.org/(?:licenses|publicdomain)/[^"\s]+', h)))
    ok = [l for l in lic if '/by/' in l or 'zero' in l]
    bad = [l for l in lic if '-nc' in l or 'sampling' in l or '-nd' in l]
    if bad or not ok: print('SKIP license', sid, lic); continue
    l = ok[0].split('creativecommons.org/')[1]
    name = 'CC0 1.0' if 'zero' in l else 'CC BY ' + l.split('/by/')[1].strip('/')
    m = lambda p: html.unescape((re.search(p, h, re.S) or [None, ''])[1]).strip()
    desc = m(r'name="twitter:description" content="([^"]*)"')
    title = m(r'og:audio:title" content="([^"]*)"'); author = m(r'og:audio:artist" content="([^"]*)"')
    if author.lower() in BANNED: print('SKIP author', sid, author); continue
    ogg = m(r'data-static-file-url="([^"]*)"').replace('-hq.mp3', '-hq.ogg')
    d.mkdir(parents=True, exist_ok=True)
    _, data = fetch(ogg, True)
    (d / 'source.ogg').write_bytes(data)
    meta = dict(source='freesound', id=sid, url=url, title=title, author=author, license=name,
                license_url='https://creativecommons.org/' + l, description=desc, file_url=ogg,
                note='Freesound HQ preview (Ogg Vorbis ~192 kbit/s); original download needs login.',
                retrieved=datetime.date.today().isoformat(), sha256=hashlib.sha256(data).hexdigest())
    (d / 'meta.json').write_text(json.dumps(meta, indent=1))
    print('got', sid, name, author, '|', title, '|', desc[:200].replace('\n', ' '))
