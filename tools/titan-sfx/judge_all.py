"""Judge built bank files with judge.py (Gemini) in sequence: python3 -I judge_all.py <out-dir> [file-prefix ...].
Role text per group below; the source description is the recipe variant plus its layers (from <work>/parts).
Appends one JSON line per file to <out-dir>/summary.jsonl."""
import sys, json, pathlib, os, shutil
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, sha
from judge import judge
ROLES = {
 'tf.splitter.fire': 'ION Splitter Rifle primary fire: snappy precise energy rifle crack, bright transient, solid low body, 0.25-0.5 s, fires every 0.15 s',
 'tf.splitter.split': 'ION Splitter Rifle split shot (three beams at once): heavier, wider version of the energy rifle crack, 0.5-0.8 s',
 'tf.splitter.tail': 'ION Splitter Rifle outdoor tail layered after the shot: 0.8-1.4 s, no transient of its own, smooth decay',
 'tf.splitter.impact': 'ION Splitter Rifle round hitting a titan/wall: energy hit + sparks, 0.3-0.6 s',
 'tf.splitter.reload': 'ION Splitter Rifle reload: energy cell swap, clunk + whine + lock, 1-1.5 s',
 'tf.t203.fire': 'Scorch T-203 thermite launcher fire: heavy grenade-launcher thump, pitched down, 0.4-0.8 s',
 'tf.t203.tail': 'Scorch T-203 launch tail: 1.5 s low outdoor decay layered after the thump, no transient',
 'tf.t203.mech': 'Scorch T-203 breech cycling a new shell after each shot: big metal clank, 0.4-0.8 s',
 'tf.t203.impact': 'Scorch T-203 thermite grenade impact: explosive whump + flare/fire burst + sizzle, 1-2 s',
 'tf.t203.burn': 'Scorch T-203 thermite pool burning after impact: fading fire sizzle 2.5-3 s',
 'tf.railgun.charge': 'Northstar Plasma Railgun charge: rising electric whine over exactly 1.6 s, ending at its peak (the shot or the hold loop follows)',
 'tf.railgun.hold': 'Northstar Plasma Railgun fully charged hold loop: seamless 1-2 s loop of a tense electric hum, plays while the trigger is held',
 'tf.railgun.ready': 'Northstar Plasma Railgun full-charge ready cue: short clean ping 0.2-0.5 s',
 'tf.railgun.fire': 'Northstar Plasma Railgun shot: massive supersonic crack + electric arc + boom, the heaviest single shot, 0.8-1.5 s',
 'tf.railgun.tail': 'Northstar Plasma Railgun rolling tail after the shot: 2-3 s rolling thunder, no transient',
 'tf.railgun.impact': 'Northstar Plasma Railgun round impact: heavy metal hit + electric discharge, 0.5-1 s',
 'tf.leadwall.fire': 'Ronin Leadwall (titan-sized shotgun) blast: huge 12-gauge boom, pitched down, 0.5-0.9 s',
 'tf.leadwall.tail': 'Ronin Leadwall outdoor tail after the boom: 1-1.5 s decay, no transient',
 'tf.leadwall.pump': 'Ronin Leadwall heavy pump/rack after each shot: pitched-down cha-chock, 0.4-0.7 s',
 'tf.leadwall.ricochet': 'Ronin Leadwall pellet ricochet off armour/ground: distinct whizzing ricochet, 0.3-0.8 s',
 'tf.leadwall.impact': 'Ronin Leadwall single pellet impact (10 per shot, played in a cluster): short heavy hit 0.15-0.4 s',
 'tf.leadwall.reload': 'Ronin Leadwall reload: loading shells and racking, 1.5-2.2 s',
 'tf.predator.fire': 'Legion Predator Cannon single heavy round (plays 8-17 times per second in a stream): punchy 0.15-0.35 s, short decay',
 'tf.predator.spinUp': 'Legion Predator Cannon barrel spin-up: 0.6 s rising motor whir ending at the spin loop pitch',
 'tf.predator.spin': 'Legion Predator Cannon barrel spin loop: seamless 1-2 s heavy motor whir loop',
 'tf.predator.spinDown': 'Legion Predator Cannon barrel spin-down: 1.2 s falling whir with mechanical rattle',
 'tf.predator.casings': 'Legion Predator Cannon big brass casings hitting the ground: 0.3-0.8 s metallic tinkle/clank',
 'tf.predator.impact': 'Legion Predator Cannon heavy autocannon round impacting armour: short kinetic crack and dense metallic crunch, 0.15-0.3 s; repeated often, no explosion or electric zap',
 'tf.predator.tail': 'Legion Predator Cannon burst tail after the last round: 1-1.5 s outdoor decay, no transient',
 'tf.predator.reload': 'Legion Predator Cannon drum reload: heavy clunks and latches, 1.5-2.5 s',
 'tf.hit.confirm': 'Hit confirm when your round hits an enemy titan: very short metallic tick <= 0.15 s, plays often',
 'tf.hit.doom': 'Doom confirm (enemy titan crippled): deep metal clang + crunch, 0.4-0.8 s',
 'tf.hit.kill': 'Confirmed enemy titan destruction: decisive double metal strike and falling short chime, 0.4-0.8 s, distinct from the single doom clang and tiny hit tick',
}
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True); pre = sys.argv[2:]
known = {}
for folder in [pathlib.Path(os.environ.get('TITAN_JUDGE_REUSE', out)), out]:
    summary = folder / 'summary.jsonl'
    if summary.exists():
        for line in summary.read_text().splitlines():
            rec = json.loads(line)
            if rec.get('sha256'): known[(rec['file'], rec['sha256'])] = (rec, folder)
for p in sorted((ROOT / 'parts').glob('*.json')):
    e = json.loads(p.read_text())
    if pre and not any(e['file'].startswith(x) for x in pre): continue
    digest = sha(ROOT / 'titan' / e['file'])
    previous = known.get((e['file'], digest))
    if previous:
        rec, folder = previous
        if folder == out: continue
        rec = dict(rec, reused_from=str(folder))
        name = e['file'].replace('/', '__').replace('.ogg', '')
        for suffix in ['.prompt.txt', '.verdict.txt']:
            if (folder / (name + suffix)).exists(): shutil.copyfile(folder / (name + suffix), out / (name + suffix))
        with open(out / 'summary.jsonl', 'a') as f: f.write(json.dumps(rec) + '\n')
        print(e['file'], rec['scores'], '(identical audio, reused verdict)', flush=True)
        continue
    layers = '; '.join(f"{s['title']} by {s['author']} ({s['layer']}, cut {s['cut']})" for s in e['sources'])
    syn = '; '.join(l['description'] for l in e.get('synthLayers', []))
    src = f"{e['variant']}. Layers: {layers}" + (f"; plus {syn}" if syn else '') + f". Processing: {e['processing']}"
    extra = 'This is a seamless loop: judge the loop seam as if it repeats.' if e['loop'] else ''
    m, s, txt = judge(ROOT / 'titan' / e['file'], out / e['file'].replace('/', '__').replace('.ogg', ''), ROLES[e['group']], src, extra)
    rec = dict(file=e['file'], group=e['group'], scores=s, metrics=m, sha256=digest)
    with open(out / 'summary.jsonl', 'a') as f: f.write(json.dumps(rec) + '\n')
    print(e['file'], s, flush=True)
