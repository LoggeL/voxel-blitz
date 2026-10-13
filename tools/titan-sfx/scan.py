"""Source survey: list the transients of downloaded sources (time, peak, centroid and -20 dB decay of the next 0.5 s)
and write an overview spectrogram per source. Usage: python3 -I scan.py <png-dir> name [name ...] (names: fs-<id>, yt-<id>)."""
import sys, pathlib, subprocess, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import decode, src, meta, SR
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for name in sys.argv[2:]:
    p = src(name)
    if not p: print(name, 'missing'); continue
    x = decode(p); m = meta(name)
    print(f"== {name} {len(x)/SR:.1f}s peak {20*np.log10(np.abs(x).max()+1e-9):.1f} | {m['license']} | {m['author']} | {m['title'][:70]}")
    env = np.sqrt(np.convolve(x ** 2, np.ones(240) / 240, 'same')) + 1e-9
    db = 20 * np.log10(env / env.max())
    hop = 240; frames = db[::hop]
    on = []
    floor = np.percentile(frames, 30)
    for i in range(3, len(frames)):
        if frames[i] - frames[i - 3] > 12 and frames[i] > max(-30, floor + 15) and (not on or i - on[-1] > 20):
            on.append(i)
    for i in on[:40]:
        t = i * hop / SR; a = int(t * SR); seg = x[a:a + SR // 2]
        if len(seg) < 512: continue
        pk = np.abs(seg).max(); e = np.sqrt(np.convolve(seg ** 2, np.ones(240) / 240, 'same'))
        below = np.where(e < e.max() * 0.1)[0]; below = below[below > np.argmax(e)]
        dec = (below[0] - np.argmax(e)) / SR if len(below) else 0.5
        s = np.abs(np.fft.rfft(seg[:4096] * np.hanning(min(4096, len(seg))))); f = np.fft.rfftfreq(min(4096, len(seg)), 1 / SR)
        print(f"  t={t:7.3f}s pk={20*np.log10(pk+1e-9):6.1f}dB cen={int((s*f).sum()/(s.sum()+1e-9)):5d}Hz dec20={dec*1000:5.0f}ms")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(p), '-lavfi', 'showspectrumpic=s=1600x300:legend=1:fscale=log:start=20:stop=20000', str(out / f'{name}.png')])
