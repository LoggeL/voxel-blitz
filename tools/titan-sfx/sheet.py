"""Contact sheet of the built bank: waveform + spectrogram per file, one PNG per weapon directory.
Usage: python3 -I sheet.py <out-dir> [dir ...]  (reads <work>/titan/<dir>/*.ogg)"""
import sys, pathlib, numpy as np, matplotlib
matplotlib.use('Agg'); import matplotlib.pyplot as plt
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import decode, ROOT, SR
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dirs = sys.argv[2:] or ['splitter', 't203', 'railgun', 'leadwall', 'predator', 'common']
for d in dirs:
    files = sorted((ROOT / 'titan' / d).glob('*.ogg'))
    fig, ax = plt.subplots(len(files), 2, figsize=(14, 1.6 * len(files)), squeeze=False, gridspec_kw=dict(width_ratios=[1, 2]))
    for i, f in enumerate(files):
        x = decode(f); t = np.arange(len(x)) / SR
        ax[i, 0].plot(t, x, lw=0.4); ax[i, 0].set_ylim(-1, 1); ax[i, 0].set_title(f.name, fontsize=8, loc='left')
        ax[i, 1].specgram(x, NFFT=1024, Fs=SR, noverlap=768, cmap='magma', vmin=-150, vmax=-60)
        ax[i, 1].set_yscale('symlog', linthresh=200); ax[i, 1].set_ylim(30, 20000); ax[i, 1].tick_params(labelsize=6)
        for a in ax[i]: a.set_xlim(0, max(0.3, len(x) / SR))
    fig.tight_layout(); fig.savefig(out / f'{d}.png', dpi=70); plt.close(fig)
    print(out / f'{d}.png')
