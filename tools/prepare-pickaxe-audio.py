#!/usr/bin/env python3
"""Rebuild pickaxe foley from retained ElevenLabs responses; no API calls.
Requires ffmpeg, NumPy, SciPy and Matplotlib.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-pickaxe-2026-09-08'
spec = importlib.util.spec_from_file_location('effects', ROOT / 'tools/prepare-elevenlabs-effects.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
np, RATE = fx.np, fx.RATE
RECIPES = [
    dict(source='swoosh/knife-2', trim=[.04,.32], tempo=1, output='fire.ogg', rms=.13, peak=.60),
    dict(source='swing/knife-1', trim=[0,.22], tempo=.8, output='fire-2.ogg', rms=.13, peak=.60),
    dict(source='rock/pickaxeimpact-2', trim=[.012,.242], tempo=1, output='impact.ogg', rms=.13, peak=.65),
    dict(source='rock/pickaxeimpact-1', trim=[.718,.948], tempo=1, output='impact-2.ogg', rms=.13, peak=.65),
]

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    (WORK/'analysis').mkdir(exist_ok=True)
    records=[]
    fig, axes=fx.plt.subplots(4,2,figsize=(15,11))
    for i,recipe in enumerate(RECIPES):
        family,stem=recipe['source'].split('/')
        source=WORK/family/'source'/f'{stem}.wav'
        receipt=json.loads((WORK/family/'api-source'/f'{stem}.json').read_text())
        assert receipt['status']=='complete' and sha(source)==receipt['decoded_sha256']
        assert sha(WORK/family/'api-source'/f'{stem}.mp3')==receipt['raw_sha256']
        x=fx.decode(source)[round(recipe['trim'][0]*RATE):round(recipe['trim'][1]*RATE)]
        impact=recipe['output'].startswith('impact')
        filters=('highpass=f=100,lowpass=f=6000,equalizer=f=1800:t=q:w=0.7:g=4' if impact else
                 'highpass=f=110,lowpass=f=5000,equalizer=f=800:t=q:w=0.7:g=5')
        filters+=f',atempo={recipe["tempo"]}'
        raw=subprocess.check_output(['ffmpeg','-v','error','-f','f32le','-ar',str(RATE),'-ac','1','-i','-',
             '-af',filters,'-f','f32le','-'],input=x.astype('<f4').tobytes())
        x=np.frombuffer(raw,dtype='<f4').astype(np.float64)
        x/=max(np.sqrt(np.mean(x*x)),1e-12)
        if impact:
            # A damped, inharmonic contact body supports the generated steel/grit
            # texture, without adding the previous square-wave mining chirps.
            t=np.arange(len(x))/RATE
            body=(np.sin(2*np.pi*145*t)+.45*np.sin(2*np.pi*237*t)+.25*np.sin(2*np.pi*391*t))
            body*=np.exp(-t/.038)*np.minimum(t/.003,1)
            body/=max(np.sqrt(np.mean(body*body)),1e-12)
            x=.68*x+.65*body
        attack=round((.0007 if impact else .003)*RATE)
        x[:attack]*=np.linspace(0,1,attack)
        release=round(.025*RATE)
        x[-release:]*=np.linspace(1,0,release)
        gain=min(recipe['rms']/np.sqrt(np.mean(x*x)),recipe['peak']/np.max(np.abs(x)))
        output=ROOT/'public/assets/audio/weapons/knife'/recipe['output']
        for _ in range(5):
            fx.encode(x*gain,output)
            decoded=fx.decode(output);m=fx.measure(decoded)
            if m['peak']<=recipe['peak']+.003: break
            gain*=recipe['peak']*.99/m['peak']
        assert m['clipping_samples_at_0_999']==0
        assert m['onset_seconds_2pct_peak'] < (.010 if impact else .050)
        assert .035<m['rms']<.16 and m['duration_seconds']<.34
        record=dict(recipe, filters=filters, output=str(output.relative_to(ROOT)), output_sha256=sha(output),
          generation={k:receipt[k] for k in ['created_at','request_body','raw_sha256','decoded_sha256']},
          source_sha256=sha(source), sample_rate_hz=RATE, codec='Opus', bitrate='96k',
          body_layer='Damped 145/237/391 Hz contact resonances' if impact else None,
          final_metrics=m)
        records.append(record);fx.plot_pair(*axes[i],decoded,recipe['output'],m)
        print(recipe['output'],json.dumps({k:m[k] for k in ['duration_seconds','peak','rms','onset_seconds_2pct_peak']}))
    manifest=dict(service='ElevenLabs Sound Effects',generated='2026-09-08',candidates=10,credits=60,
        selections=records,rebuild='python tools/prepare-pickaxe-audio.py',
        source_note='Original API responses and receipts retained in ignored artifacts. No game recordings used.',
        rejected='Initial impact candidates had insufficient contact texture; three swing candidates were dominated by sub-bass. Rock candidate 1 contains several contacts, so only the final isolated strike is retained.',
        review_basis='Waveform and spectral inspection, decoded levels and onset, native game-mix rendering. No subjective listening claim.')
    (ROOT/'public/assets/audio/elevenlabs-pickaxe-sources.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (WORK/'analysis/final-metrics.json').write_text(json.dumps(manifest,indent=2)+'\n')
    fig.tight_layout();fig.savefig(WORK/'analysis/final-contact-sheet.png',dpi=130);fx.plt.close(fig)

if __name__=='__main__': main()
