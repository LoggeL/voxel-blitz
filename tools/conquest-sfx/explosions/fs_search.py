"""Search Freesound website (no credentials) for CC0 / CC-BY sounds. Prints candidates."""
import sys, re, urllib.request, urllib.error, urllib.parse, html
import time
def fetch(url):
    for k in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            r = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace'); time.sleep(2.5); return r
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(15*(k+1))
    raise RuntimeError('429')
def search(q, lic, page=1):
    f = f'license:"{lic}"'
    url = 'https://freesound.org/search/?' + urllib.parse.urlencode({'q': q, 'f': f, 'page': page})
    h = fetch(url)
    out = []
    for m in re.finditer(r'<div\s+class="bw-player"(.*?)tabindex="0">', h, re.S):
        b = m.group(1)
        g = lambda k: (re.search(k + r'="([^"]*)"', b) or [None, ''])[1]
        out.append(dict(id=g('data-sound-id'), user=g('data-username'), title=html.unescape(g('data-title')),
                        dur=float(g('data-duration') or 0), sr=g('data-samplerate'), dl=int(g('data-num-downloads') or 0),
                        lic=lic, mp3=g('data-mp3').replace('-lq.mp3', '-hq.mp3')))
    return out
if __name__ == '__main__':
    q = sys.argv[1]
    lics = ['Creative Commons 0', 'Attribution']
    seen = set()
    for lic in lics:
        try:
            for r in search(q, lic):
                if r['id'] in seen: continue
                seen.add(r['id'])
                print(f"{r['id']}|{'CC0' if lic.startswith('Creative') else 'BY'}|{r['dur']:.1f}s|{r['sr']}|dl{r['dl']}|{r['user']}|{r['title']}")
        except Exception as e:
            print('ERR', lic, e)
