"""Search the Freesound website (no credentials) for CC0 / CC BY sounds. Usage: fs_search.py "query" [cc0|by|both]"""
import sys, re, time, urllib.request, urllib.parse, urllib.error, html
def fetch(url):
    for k in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            return urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(15 * (k + 1))
    raise RuntimeError('rate limited')
def search(q, lic, page=1):
    url = 'https://freesound.org/search/?' + urllib.parse.urlencode({'q': q, 'f': f'license:"{lic}"', 'page': page})
    h = fetch(url); out = []
    for m in re.finditer(r'<div\s+class="bw-player"(.*?)tabindex="0">', h, re.S):
        b = m.group(1); g = lambda k: (re.search(k + r'="([^"]*)"', b) or [None, ''])[1]
        out.append(dict(id=g('data-sound-id'), user=g('data-username'), title=html.unescape(g('data-title')),
                        dur=float(g('data-duration') or 0), sr=g('data-samplerate'), dl=int(g('data-num-downloads') or 0)))
    return out
if __name__ == '__main__':
    q = sys.argv[1]; which = sys.argv[2] if len(sys.argv) > 2 else 'both'
    lics = {'cc0': ['Creative Commons 0'], 'by': ['Attribution'], 'both': ['Creative Commons 0', 'Attribution']}[which]
    for lic in lics:
        for r in search(q, lic):
            print(f"{r['id']}|{'CC0' if lic.startswith('Creative') else 'BY'}|{r['dur']:.1f}s|dl{r['dl']}|{r['user']}|{r['title']}")
        time.sleep(4)
