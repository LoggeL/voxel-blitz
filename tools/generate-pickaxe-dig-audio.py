#!/usr/bin/env python3
"""Generate IRON PICK dig and attack candidates with the existing ElevenLabs client.

Original blocky-game Foley: one dig contact per block material group (the same
recording plays low/quiet while mining and full on the break) and one cue per
melee attack kind. Defaults to a dry run. --generate spends credits, retains
originals/receipts, and resumes completed requests without paying again.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-pickaxe-dig-2026-09-22'
DIG = {
    'stone': 'solid stone: a crisp gritty rock tick and a short dry crumble of tiny stone grit',
    'wood': 'a solid wooden block: a hollow woody knock with a faint dry splinter crackle',
    'gravel': 'loose gravel and packed dirt: a crunchy grainy scrunch of small pebbles and soil',
    'grass': 'grassy turf: a soft dull earth thud with a brief rustle of grass blades',
    'sand': 'dry loose sand: a soft sandy hiss and small muffled crunch of shifting grains',
    'cloth': 'a thick wool bundle: a muffled soft padded fabric puff, low and cushioned',
    'glass': 'a thick glass block: a single small bright hard glassy tink, clean and short',
    'metal': 'a solid iron block: a hard ringing metallic clank with a short bright steel ring',
}
BREAK = {
    'glass': 'Exactly ONE small glass pane shattering: a bright sharp crash of glass breaking '
             'into shards with a short tinkle of falling fragments, then silence.',
}
ATTACK = {
    'strong': 'an iron pickaxe hitting a game character: one meaty punchy body thud with a short '
              'hard iron edge knock on top',
    'crit': 'a critical pickaxe hit on a game character: a sharp heavy crunching thud with a bright '
            'short metallic sparkle shimmer on top',
    'knockback': 'a heavy shove hit: a solid body thud followed right after by a quick short whoosh '
                 'of air as the target flies back',
    'armor': 'an iron pickaxe glancing off a steel armour plate: a dull heavy muted metal clank, '
             'no long ringing',
    'backstab': 'a brutal pickaxe hit from behind: a deep heavy wet crunch with a hard bone crack',
}
DURATION = {'dig': .5, 'break': .8, 'attack': .5, 'attack-knockback': .7}


def plan_for(cue_filter):
    plan = []
    for material, text in DIG.items():
        plan.append(('dig-' + material, (
            'Exactly ONE isolated iron pickaxe dig contact into ' + text + '. Close dry Foley for a '
            'blocky voxel mining game, crunchy and slightly lo-fi. Immediate attack, decays within '
            '300 milliseconds, then silence. One hit only. No repeated hits, voices, music, '
            'ambience or reverberation.'), DURATION['dig']))
    for material, text in BREAK.items():
        plan.append(('break-' + material, text + ' Close dry Foley for a blocky voxel game. No voices, '
                     'music, ambience or reverberation.', DURATION['break']))
    for kind, text in ATTACK.items():
        plan.append(('attack-' + kind, (
            'Exactly ONE isolated melee impact: ' + text + '. Close dry punchy Foley for a blocky '
            'first-person game, compact and clear. Immediate attack, over within 350 milliseconds, '
            'then silence. No voices, grunts, music, ambience or reverberation.'),
            DURATION.get('attack-' + kind, DURATION['attack'])))
    return [entry for entry in plan if not cue_filter or entry[0] in cue_filter]


def main():
    cues = [cue for cue, _, _ in plan_for(None)]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate', action='store_true')
    parser.add_argument('--variants', type=int, default=3)
    parser.add_argument('--cue', choices=cues, action='append')
    parser.add_argument('--start-variant', type=int, default=1)
    parser.add_argument('--prompt', help='Custom prompt for exactly one selected cue.')
    args = parser.parse_args()
    if not 1 <= args.variants <= 8:
        parser.error('--variants must be between 1 and 8')
    if args.start_variant < 1:
        parser.error('--start-variant must be positive')
    if args.prompt and (len(args.cue or []) != 1 or len(args.prompt) > 450):
        parser.error('--prompt requires one cue and at most 450 characters')
    spec = importlib.util.spec_from_file_location('eleven', ROOT / 'tools/generate-elevenlabs-effects.py')
    eleven = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(eleven)
    plan = [dict(cue=cue, body={'text': args.prompt or text, 'duration_seconds': seconds,
                                'prompt_influence': .5, 'model_id': eleven.MODEL, 'loop': False})
            for cue, text, seconds in plan_for(set(args.cue or []))]
    for entry in plan:
        assert len(entry['body']['text']) <= 450, entry['cue']
    variants = range(args.start_variant, args.start_variant + args.variants)
    if not args.generate:
        # The API bills 10 credits per requested second.
        credits = sum(round(entry['body']['duration_seconds'] * 10) for entry in plan) * len(variants)
        print(json.dumps(dict(requests=len(plan) * len(variants), estimated_credits=credits,
                              variants=list(variants), plan=plan), indent=2))
        return
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise SystemExit('ffmpeg required')
    key = None
    for entry in plan:
        for variant in variants:
            if eleven.resume_saved(*eleven.candidate_paths(WORK, entry['cue'], variant), entry['body'], ffmpeg):
                continue
            if key is None:
                key = eleven.read_api_key()
            print(f'{entry["cue"]}-{variant}: generating', flush=True)
            eleven.generate(entry['cue'], variant, WORK, entry['body'], key, ffmpeg)


if __name__ == '__main__':
    main()
