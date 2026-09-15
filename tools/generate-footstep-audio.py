#!/usr/bin/env python3
"""Generate isolated footfall candidates with the existing ElevenLabs client.

Defaults to a dry run. --generate spends credits, retains originals/receipts,
and resumes completed requests without generating or paying for them again.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-footsteps-2026-09-16'
SURFACES = {
    'stone': 'dry rough concrete: a firm rubber sole thock with a tiny gritty sole scrape',
    'wood': 'solid wooden floorboards: a warm hollow wooden knock and short sole friction',
    'metal': 'a thick steel walkway: a firm boot clack with a short low metallic resonance, no high ringing',
    'grass': 'short grass and packed soil: a soft weighty earth thump with a brief leafy crunch',
    'gravel': 'small loose gravel: a weighty crunch with tiny pebbles shifting under the sole',
    'sand': 'dry sand: a soft muffled weighty footfall with a brief sandy compressing scrunch',
    'cloth': 'thick carpet: a muted low padded footfall with a short soft fabric brush',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate', action='store_true')
    parser.add_argument('--variants', type=int, default=3)
    parser.add_argument('--surface', choices=SURFACES, action='append')
    parser.add_argument('--start-variant', type=int, default=1)
    parser.add_argument('--refine', action='store_true', help='One-second source with a short silent lead-in for clean transients.')
    parser.add_argument('--prompt', help='Custom prompt for exactly one selected surface.')
    args = parser.parse_args()
    if not 1 <= args.variants <= 8:
        parser.error('--variants must be between 1 and 8')
    if args.start_variant < 1:
        parser.error('--start-variant must be positive')
    if args.prompt and (len(args.surface or []) != 1 or len(args.prompt) > 450):
        parser.error('--prompt requires one surface and at most 450 characters')
    spec = importlib.util.spec_from_file_location('eleven', ROOT / 'tools/generate-elevenlabs-effects.py')
    eleven = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(eleven)
    plan = []
    for surface in args.surface or SURFACES:
        prompt = ('Exactly ONE isolated natural boot footstep on ' + SURFACES[surface] +
                     '. Close dry Foley for a first-person game. Immediate heel-to-sole contact, '
                     'decays within 250 milliseconds, then silence. One foot landing only. '
                     'No walking sequence, second step, voices, music, ambience or reverberation.')
        if args.refine:
            prompt = ('Studio Foley recording: after a brief silence, ONE boot firmly plants on ' + SURFACES[surface]
                + '. Heel and sole contact together as one compact percussive FOOTFALL, '
                'then quickly decay into silence. Clear tactile attack, realistic shoe texture. '
                'One event only. No walking sequence, dragging, bass drone, electronic tone, music or ambience.')
        plan.append(dict(surface=surface, body={
            'text': args.prompt or prompt,
            'duration_seconds': 1.0 if args.refine else .5, 'prompt_influence': .45,
            'model_id': eleven.MODEL, 'loop': False,
        }))
    if not args.generate:
        print(json.dumps(dict(requests=len(plan) * args.variants, plan=plan), indent=2))
        return
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise SystemExit('ffmpeg required')
    key = None
    for entry in plan:
        cue = 'step-' + entry['surface']
        for variant in range(args.start_variant, args.start_variant + args.variants):
            if eleven.resume_saved(*eleven.candidate_paths(WORK, cue, variant), entry['body'], ffmpeg):
                continue
            if key is None:
                key = eleven.read_api_key()
            print(f'{cue}-{variant}: generating', flush=True)
            eleven.generate(cue, variant, WORK, entry['body'], key, ffmpeg)


if __name__ == '__main__':
    main()
