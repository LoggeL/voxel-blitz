"""Extract user-selected Free SFX video excerpts; retain pitch and timbre."""
import json,hashlib,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
W=ROOT/'.artifacts/elevenlabs-remaining-2026-09-09'
source=W/'reference/user-reference.mp3'
out=ROOT/'public/assets/audio/combat';out.mkdir(exist_ok=True)
clips=[]
for i,(start,end) in enumerate([(1.80,2.34),(2.34,2.78),(2.78,3.80)],1):
 name='bullet-whiz.ogg' if i==1 else f'bullet-whiz-{i}.ogg'
 duration=end-start
 subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(source),'-t',str(duration),'-ac','1','-ar','48000','-af',f'afade=t=in:d=0.002,afade=t=out:st={duration-.02}:d=0.02','-c:a','libopus','-b:a','96k',str(out/name)],check=True)
 clips.append(dict(file='combat/'+name,start_seconds=start,end_seconds=end,sha256=hashlib.sha256((out/name).read_bytes()).hexdigest()))
meta=json.loads((W/'reference/user-reference.info.json').read_text())
manifest=dict(source_url='https://www.youtube.com/watch?v=8hVB1kChbvA',title=meta['title'],uploader=meta['uploader'],license_statement=meta['description'],source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),processing='Mono 48 kHz Opus. 2 ms entrance and 20 ms exit fades; original speed, pitch, level and tonal balance. Excerpts may contain overlapping passes.',clips=clips)
(ROOT/'public/assets/audio/video-flyby-sources.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(clips,indent=2))
