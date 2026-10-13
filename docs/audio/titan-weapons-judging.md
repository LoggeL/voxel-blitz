# Titan weapon sounds: model judging

The titan weapon bank ([titan-sfx.md](titan-sfx.md)) was built without anyone listening to it. To get
an outside opinion on each file, a model that accepts audio judged every new file and the sounds the
game played before. This page records how, the scores, and what changed because of them.

## Model

- **`gemini-3.8-flash`** (Google Gemini API, `generateContent`), with the audio file as the primary input.
- The request was for "Gemini 3.8 Flash Lite". The only model of that name in the API listing is
  `gemini-3.8-flash-lite-tts`, a text-to-speech model that cannot judge audio, so `gemini-3.8-flash`
  was used instead.
- An earlier attempt with another model (omp / Muse Spark, which saw only spectrogram images) was
  stopped and superseded; its few verdicts are not used here (it gave the old railgun 5/10 overall).

## Method

`tools/titan-sfx/judge.py` sends one request per sound, one at a time with a 2.5 s pause (and back-off
on HTTP 429/5xx). The API key is read from the macOS keychain and never stored. Each request holds:

- the Ogg Opus file itself (inline audio);
- a log-frequency spectrogram PNG (ffmpeg `showspectrumpic`);
- measurements: duration, sample peak, integrated loudness, loudness range and true peak (ffmpeg
  `ebur128`; files under 0.4 s report -70 LUFS there), crest factor, spectral centroid, share of
  energy below 200 Hz, time of the loudest 10 ms, first/last 2 ms peak and DC offset;
- the intended role (weapon, cue, target length and feel; the role texts are in
  `tools/titan-sfx/judge_all.py`) and the construction (sources, cuts, layers and processing).

The model scores FIT, PUNCH, CLEANLINESS, LENGTH_TAIL (length and decay), DISTINCTNESS (reads as its
own weapon) and OVERALL from 1 to 10, then lists problems and concrete processing fixes. Prompts and
answers are kept outside the repository (session scratchpad `judge/<round>/`), one
`.prompt.txt`, `.verdict.txt` and `.spec.png` per file.

The goal was OVERALL ≥ 7 for each weapon's core sounds: the fire takes, the railgun charge, the
Predator spin-up and spin loop, the Leadwall ricochets, the T-203 impacts and the impacts of every
weapon.

## Rounds

- **Baseline**: the sounds the game played before: the synthesized TitanSynth voice of each weapon's fire
  (rendered offline by `tools/titan-sfx/render_synth_baseline.py`) and the frag-grenade sample that every
  titan impact reused.
- **Round 1**: the first build of all 64 files, all judged.
- **Round 2**: every file was reworked from the round-1 remarks. The recurring ones were "infantry scale,
  not a 7 m titan", too little low-mid weight, heavy limiting that flattened the attack, late peaks from
  swelling layers, ringing resonances, and too little sci-fi identity. The fixes: pitching further down
  (0.45-0.72x), pitched-down metal clanks and servo whines for the mechanisms, a soft clipper in place of
  deep limiting, layers cut or decayed so the attack leads, notches on the rings, synthesized plasma/ion
  chirps for the Splitter and the railgun, a turbine hum with a rotation pulse for the Predator, and
  crackle/fizzle layers for the thermite.
- Round 2 was capped to save API quota. All fire takes, the railgun charge and the Leadwall, Predator and
  hit-confirm files were judged again. The other round-2 files (railgun hold, ready, tails and impacts;
  Splitter split, tails, impacts and reload; T-203 tail, mech, impacts and burn) ship with round-2
  processing that was **not re-judged**; their table rows show the round-1 score of the earlier version.
- The bank ships exactly the round-2 files (the build is byte-identical to the judged files). A third
  pass on the Leadwall fire, impacts and ricochets was tried but not shipped, because it was not judged.

## Before and after (core sounds)

OVERALL scores; a group's value is the mean of its takes, with the range in brackets.

| Core sound | Baseline (old) | Round 1 | Round 2 (shipped) |
|---|---|---|---|
| Splitter fire (4 takes) | 3 (synth) | 6.0 (5-7) | 6.25 (6-7) |
| T-203 fire (3) | 4 (synth) | 6.0 (5-7) | 6.7 (6-7) |
| Railgun fire (3) | 3 (synth) | 5.0 (4-6) | 6.3 (6-7) |
| Railgun charge (1) | — (synth whine, not judged) | 6 | 8 and 7 (judged twice) |
| Leadwall fire (3) | 3 (synth) | 5.0 (5) | 6.7 (6-8) |
| Predator fire (4) | 2 (synth) | 6.0 (6) | 6.5 (5-8) |
| Predator spin-up (1) | — | 5 | 6 |
| Predator spin loop (1) | — | 5 | 6 |
| Leadwall ricochets (4) | — (none) | 5.25 (5-6) | 5.5 (4-8) |
| Leadwall pellet impacts (3) | 3 (frag blast reused) | 4.3 (4-5) | 6.0 (6) |
| T-203 impacts (3) | 3 (frag blast reused) | 6.0 (6) | not re-judged |
| Splitter impacts (3) | 3 (frag blast reused) | 5.3 (5-6) | not re-judged |
| Railgun impacts (2) | 3 (frag blast reused) | 6.0 (6) | not re-judged |
| Hit confirm (3) | — | 6.7 (5-8) | 7.0 (6-8) |
| Doom confirm (1) | — | 7 | 7 |

The goal of 7 was reached by the railgun charge, one or more takes of every fire group (Leadwall fire-1 8,
Predator fire-3 8, T-203 fire-1/-2 7, railgun fire-3 7, Splitter fire-1 7), ricochet-3 (8), the Leadwall
pumps (7) and the confirms. It was **not** reached for every take: the remaining fire takes sit at 5-6,
the Predator spin-up and spin loop at 6, ricochets 1 and 4 at 4. With the cap, these were not iterated
further. Suggested next steps if they matter in the game: drop the weakest takes from their groups (the
bank keeps at least one take per group that scored 7-8), or rework them along the remarks below.

## Key remarks

Baseline (old synth voices):

- Splitter: "the raw square wave sweep (940 to 420 Hz) reads like an 8-bit arcade laser zap rather than a
  heavy military Titan energy weapon."
- Railgun: "Timbre reads as an arcade retro synth laser zap ("pew") rather than a devastating hypervelocity
  plasma railgun fired by a 7 m titan." Also far too short (0.5 s) and quiet (-24 LUFS).
- Predator: "reads as a retro 8-bit chiptune zap or UI blip rather than an artillery-caliber autocannon
  round."
- Frag sample as titan impact: "Reusing a single full-scale frag explosion for both a 10-pellet shotgun
  spread and a thermite shell creates massive sound design failure on both ends."

Round 1:

- Leadwall fire: "reads distinctly as a standard handheld infantry shotgun recorded outdoors rather than
  an oversized cannon fired by a 7-meter titan"; "Up to 8.0 dB of look-ahead peak limiting severely
  flattens the transient punch."
- Railgun fire: "The loudest energy hits late at 0.253 s (from the thunder body swelling)"; "Almost
  completely lacks sci-fi plasma/railgun identity."
- Predator spin: "Reads distinctly as a handheld workshop power drill or buzzsaw."
- Splitter fire: "The ballistic rifle gunshot dominates the sound, making it read as a conventional
  gunpowder firearm."

Round 2 (shipped):

- Leadwall fire-1 (8): the round-2 layering (pitched shotgun, tank-cannon body, metal strike, HV crack,
  sub thump, soft clipper) was the best-rated fire take. Its remaining note: "Massive sub-energy (82.3%
  below 200 Hz) will crowd engine rumbles."
- Predator fire-3 (8, MK 50 33 mm naval gun); its one note: "Prominent tonal ring around 3.2 kHz ... will
  rapidly stack into an ear-fatiguing whistle when fired 8-17 times per second."
- Railgun charge: rated 8, then 7 on a second run ("Low-end energy is excessive (nearly 79% below
  200 Hz)"). The two runs on the same file differ by one point, so treat single-point differences as noise.
- Railgun fire-1 (6): "The low end and mid body abruptly choke at ~0.62 s."
- T-203 fire-3 (6) and Splitter fire-2 (6): late peaks ("loudest 10 ms lands at 134 ms", "Peak loudness
  occurs late at ~38 ms").
- Predator spin (6): "abrasive, buzzy mid-range whine (1.2 kHz - 2.5 kHz) that sounds like a slowed hand
  drill"; spin-up (6): "resembles a domestic vacuum cleaner or ventilation fan."

## All files

Overall score per round, and the five sub-scores of the latest judged version. An empty Round 2 cell means
the shipped round-2 file was not re-judged (its sub-scores are from round 1).

| File | Round 1 | Round 2 (shipped) | Fit | Punch | Cleanliness | Length/Tail | Distinctness |
|---|---|---|---|---|---|---|---|
| `common/doom-confirm-1.ogg` | 7 | 7 | 7 | 8 | 8 | 8 | 7 |
| `common/hit-confirm-1.ogg` | 5 | 8 | 9 | 8 | 9 | 9 | 7 |
| `common/hit-confirm-2.ogg` | 7 | 7 | 7 | 6 | 9 | 9 | 5 |
| `common/hit-confirm-3.ogg` | 8 | 6 | 7 | 6 | 8 | 8 | 5 |
| `leadwall/fire-1.ogg` | 5 | 8 | 9 | 9 | 8 | 7 | 8 |
| `leadwall/fire-2.ogg` | 5 | 6 | 6 | 6 | 7 | 7 | 6 |
| `leadwall/fire-3.ogg` | 5 | 6 | 6 | 6 | 8 | 7 | 6 |
| `leadwall/impact-1.ogg` | 4 | 6 | 6 | 6 | 7 | 7 | 5 |
| `leadwall/impact-2.ogg` | 5 | 6 | 7 | 6 | 7 | 8 | 6 |
| `leadwall/impact-3.ogg` | 4 | 6 | 5 | 6 | 8 | 7 | 5 |
| `leadwall/pump-1.ogg` | 4 | 7 | 7 | 7 | 8 | 8 | 7 |
| `leadwall/pump-2.ogg` | 4 | 7 | 8 | 7 | 8 | 6 | 7 |
| `leadwall/reload-1.ogg` | 4 | 6 | 6 | 5 | 8 | 8 | 6 |
| `leadwall/ricochet-1.ogg` | 5 | 4 | 4 | 4 | 6 | 5 | 5 |
| `leadwall/ricochet-2.ogg` | 5 | 6 | 7 | 6 | 6 | 8 | 6 |
| `leadwall/ricochet-3.ogg` | 6 | 8 | 8 | 6 | 9 | 9 | 8 |
| `leadwall/ricochet-4.ogg` | 5 | 4 | 4 | 4 | 8 | 7 | 4 |
| `leadwall/tail-1.ogg` | 6 | 7 | 7 | 6 | 8 | 8 | 5 |
| `leadwall/tail-2.ogg` | 6 | 6 | 6 | 6 | 9 | 8 | 5 |
| `predator/casings-1.ogg` | 4 | 6 | 7 | 7 | 6 | 5 | 7 |
| `predator/casings-2.ogg` | 4 | 5 | 5 | 6 | 6 | 5 | 5 |
| `predator/casings-3.ogg` | 4 | 5 | 5 | 6 | 8 | 4 | 5 |
| `predator/fire-1.ogg` | 6 | 7 | 7 | 7 | 9 | 7 | 6 |
| `predator/fire-2.ogg` | 6 | 6 | 5 | 6 | 8 | 7 | 5 |
| `predator/fire-3.ogg` | 6 | 8 | 8 | 8 | 9 | 8 | 8 |
| `predator/fire-4.ogg` | 6 | 5 | 5 | 6 | 8 | 6 | 5 |
| `predator/reload-1.ogg` | 4 | 5 | 5 | 6 | 5 | 6 | 5 |
| `predator/spin-1.ogg` | 5 | 6 | 6 | 5 | 8 | 8 | 6 |
| `predator/spin-down-1.ogg` | 5 | 4 | 4 | 4 | 5 | 7 | 5 |
| `predator/spin-up-1.ogg` | 5 | 6 | 6 | 5 | 7 | 8 | 5 |
| `predator/tail-1.ogg` | 6 | 6 | 6 | 5 | 6 | 8 | 5 |
| `predator/tail-2.ogg` | 5 | 6 | 7 | 5 | 8 | 8 | 5 |
| `railgun/charge-1.ogg` | 6 | 7 | 7 | 7 | 8 | 9 | 7 |
| `railgun/fire-1.ogg` | 6 | 6 | 6 | 6 | 6 | 5 | 6 |
| `railgun/fire-2.ogg` | 5 | 6 | 6 | 6 | 7 | 7 | 6 |
| `railgun/fire-3.ogg` | 4 | 7 | 7 | 8 | 7 | 6 | 7 |
| `railgun/hold-1.ogg` | 6 |  | 6 | 5 | 7 | 8 | 6 |
| `railgun/impact-1.ogg` | 6 |  | 6 | 6 | 7 | 7 | 6 |
| `railgun/impact-2.ogg` | 6 |  | 6 | 6 | 7 | 7 | 6 |
| `railgun/ready-1.ogg` | 4 |  | 5 | 4 | 4 | 5 | 5 |
| `railgun/tail-1.ogg` | 7 |  | 7 | 6 | 9 | 8 | 5 |
| `railgun/tail-2.ogg` | 6 |  | 6 | 6 | 8 | 8 | 4 |
| `splitter/fire-1.ogg` | 5 | 7 | 7 | 6 | 9 | 8 | 7 |
| `splitter/fire-2.ogg` | 6 | 6 | 6 | 6 | 8 | 6 | 7 |
| `splitter/fire-3.ogg` | 7 | 6 | 6 | 6 | 8 | 7 | 7 |
| `splitter/fire-4.ogg` | 6 | 6 | 6 | 6 | 7 | 7 | 6 |
| `splitter/impact-1.ogg` | 6 |  | 6 | 5 | 6 | 7 | 6 |
| `splitter/impact-2.ogg` | 5 |  | 5 | 5 | 5 | 5 | 6 |
| `splitter/impact-3.ogg` | 5 |  | 5 | 5 | 4 | 4 | 6 |
| `splitter/reload-1.ogg` | 6 |  | 6 | 5 | 6 | 6 | 6 |
| `splitter/split-1.ogg` | 6 |  | 6 | 7 | 8 | 8 | 6 |
| `splitter/split-2.ogg` | 7 |  | 7 | 7 | 8 | 7 | 7 |
| `splitter/tail-1.ogg` | 5 |  | 5 | 5 | 8 | 8 | 4 |
| `splitter/tail-2.ogg` | 6 |  | 6 | 4 | 8 | 8 | 5 |
| `t203/burn-1.ogg` | 5 |  | 5 | 3 | 8 | 8 | 4 |
| `t203/fire-1.ogg` | 6 | 7 | 8 | 7 | 7 | 8 | 8 |
| `t203/fire-2.ogg` | 7 | 7 | 7 | 8 | 7 | 8 | 7 |
| `t203/fire-3.ogg` | 5 | 6 | 6 | 5 | 6 | 7 | 6 |
| `t203/impact-1.ogg` | 6 |  | 6 | 7 | 7 | 5 | 6 |
| `t203/impact-2.ogg` | 6 |  | 6 | 6 | 7 | 7 | 6 |
| `t203/impact-3.ogg` | 6 |  | 7 | 6 | 7 | 6 | 6 |
| `t203/mech-1.ogg` | 5 |  | 5 | 5 | 8 | 8 | 5 |
| `t203/mech-2.ogg` | 5 |  | 5 | 4 | 8 | 8 | 5 |
| `t203/tail-1.ogg` | 6 |  | 7 | 5 | 5 | 8 | 5 |
