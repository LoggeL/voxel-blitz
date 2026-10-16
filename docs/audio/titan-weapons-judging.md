# Titan weapon sounds: Gemini audio judging

The selected bank contains 58 files. Every shipped file has a Gemini verdict for its exact
encoded bytes. [titan-weapons-verdicts.json](titan-weapons-verdicts.json) preserves the scores, output
SHA-256, measurements and complete latest answer. Gemini received the audio itself through the user-provided
`gemini-audio.py` helper; no human audition or audible in-game playback was performed.

## Method

`gemini-3.8-flash` scores FIT, PUNCH, CLEANLINESS, LENGTH_TAIL, DISTINCTNESS and OVERALL from 1 to 10.
Each prompt names the cue role and target feel and asks for concrete problems and processing fixes.
Requests run sequentially with a 2.5 s pause. The helper reads the Keychain key process-locally.
A verdict is reused only for identical audio SHA-256. Spectrograms are local QA artifacts; the helper
sends audio and text. Short cues use a K-weighted event mean because gated 400 ms LUFS blocks cannot
measure them. Early rounds used a windowed spectral share and 5 ms peak window; final rechecks use
full-event band energy and a 10 ms peak window. The saved prompts retain their original measurements.

## Before and after

The old fire voices were rendered offline from the deterministic TitanSynth tone/hiss recipes and
heard by Gemini. They are reconstructions of the old procedural voice, not browser recordings.
Old charge, mechanics and impact layers were not judged in this baseline. Values below are OVERALL;
a multi-take group shows its mean and range.

| Cue | Old synth | Selected bank | Takes |
|---|---|---|---|
| `tf.splitter.fire` | 2 | 7.2 (7-8) | 4 |
| `tf.splitter.split` | not judged | 7.0 (7-7) | 2 |
| `tf.splitter.tail` | not judged | 7 | 1 |
| `tf.splitter.impact` | not judged | 8.0 (8-8) | 3 |
| `tf.splitter.reload` | not judged | 7 | 1 |
| `tf.t203.fire` | 2 | 7.3 (7-8) | 3 |
| `tf.t203.tail` | not judged | 7 | 1 |
| `tf.t203.mech` | not judged | 7.5 (7-8) | 2 |
| `tf.t203.impact` | not judged | 7.7 (7-8) | 3 |
| `tf.t203.burn` | not judged | 7 | 1 |
| `tf.railgun.charge` | not judged | 8 | 1 |
| `tf.railgun.hold` | not judged | 7 | 1 |
| `tf.railgun.ready` | not judged | 7 | 1 |
| `tf.railgun.fire` | 2 | 7.0 (7-7) | 3 |
| `tf.railgun.tail` | not judged | 8 | 1 |
| `tf.railgun.impact` | not judged | 7 | 1 |
| `tf.leadwall.fire` | 2 | 7.7 (7-8) | 3 |
| `tf.leadwall.tail` | not judged | 7.5 (7-8) | 2 |
| `tf.leadwall.pump` | not judged | 7.0 (7-7) | 2 |
| `tf.leadwall.ricochet` | not judged | 7.3 (7-8) | 3 |
| `tf.leadwall.impact` | not judged | 7.0 (7-7) | 3 |
| `tf.leadwall.reload` | not judged | 7 | 1 |
| `tf.predator.fire` | 2 | 8 | 1 |
| `tf.predator.spinUp` | not judged | 7 | 1 |
| `tf.predator.spin` | not judged | 7 | 1 |
| `tf.predator.spinDown` | not judged | 6 | 1 |
| `tf.predator.casings` | not judged | 7.0 (7-7) | 2 |
| `tf.predator.impact` | not judged | 8 | 1 |
| `tf.predator.tail` | not judged | 7.0 (7-7) | 2 |
| `tf.predator.reload` | not judged | 7 | 1 |
| `tf.hit.confirm` | not judged | 7.7 (7-8) | 3 |
| `tf.hit.doom` | not judged | 8 | 1 |
| `tf.hit.kill` | not judged | 8 | 1 |

## Iteration and selection

- The inherited bank was rechecked; the first comparison run stopped on an upstream HTTP 503.
  The candidate and delivery rounds completed, and every selected byte hash has a valid answer.
- Fire bodies were aligned to the attack, low-mid weight was separated from sub clutter, and
  mechanical cycles were cleaned and synchronized to authoritative charge, spin and reload timing.
- The Railgun tail had a positional-argument bug: its low-pass cutoff became 0.06 Hz. Correct
  argument order restores the recorded thunder, and source-layer notes now reject non-text values.
- Weak variants were removed from the active random pool. Predator uses its twice-rated 8/10
  third autocannon report and the 8/10 armour impact, with per-event pitch variation. Other fire
  banks retain multiple recorded takes. Rejected takes remain in the external work folder.
- The ION split cue is an additive layer mixed with dry fire and the tail. Its final alignment,
  saturated low-mid body and breech snap reached 7 for both selected takes.

## Remaining score below 7

- `predator/spin-down-1.ogg`: OVERALL 6.
The Predator spin-down was rebuilt with a wider motor band, more chain friction, bearing
teeth and a timed brake detent. Repeated versions scored 4-6. The retained clean cue still reads
too much like a light servo and lacks heavy rotational inertia. More bass buried the mechanical
rhythm or made it resemble an energy power-down. This remains an explicit exception to the 7
target, not a passed score. A heavier industrial recording or a permitted human playthrough is
the next useful check. Its duration and interruption behavior follow the server spin state.

## Every shipped file

| File | Overall | Fit | Punch | Cleanliness | Length/tail | Distinctness |
|---|---|---|---|---|---|---|
| `splitter/fire-1.ogg` | 7 | 7 | 7 | 9 | 7 | 8 |
| `splitter/fire-2.ogg` | 7 | 7 | 6 | 9 | 8 | 7 |
| `splitter/fire-3.ogg` | 8 | 8 | 8 | 9 | 8 | 9 |
| `splitter/fire-4.ogg` | 7 | 7 | 7 | 9 | 8 | 8 |
| `splitter/split-1.ogg` | 7 | 7 | 8 | 9 | 7 | 8 |
| `splitter/split-2.ogg` | 7 | 7 | 8 | 9 | 8 | 7 |
| `splitter/tail-1.ogg` | 7 | 7 | 6 | 8 | 9 | 7 |
| `splitter/impact-1.ogg` | 8 | 8 | 8 | 9 | 9 | 8 |
| `splitter/impact-2.ogg` | 8 | 8 | 8 | 9 | 9 | 8 |
| `splitter/impact-3.ogg` | 8 | 8 | 7 | 9 | 9 | 8 |
| `splitter/reload-1.ogg` | 7 | 7 | 6 | 9 | 8 | 7 |
| `t203/fire-1.ogg` | 8 | 8 | 8 | 9 | 8 | 8 |
| `t203/fire-2.ogg` | 7 | 7 | 6 | 8 | 7 | 8 |
| `t203/fire-3.ogg` | 7 | 8 | 6 | 8 | 8 | 8 |
| `t203/tail-1.ogg` | 7 | 7 | 6 | 9 | 8 | 6 |
| `t203/mech-1.ogg` | 8 | 8 | 8 | 9 | 9 | 8 |
| `t203/mech-2.ogg` | 7 | 7 | 7 | 9 | 8 | 7 |
| `t203/impact-1.ogg` | 8 | 8 | 7 | 9 | 9 | 8 |
| `t203/impact-2.ogg` | 7 | 7 | 6 | 8 | 8 | 8 |
| `t203/impact-3.ogg` | 8 | 8 | 6 | 9 | 9 | 9 |
| `t203/burn-1.ogg` | 7 | 7 | 6 | 8 | 8 | 7 |
| `railgun/charge-1.ogg` | 8 | 8 | 7 | 9 | 10 | 9 |
| `railgun/hold-1.ogg` | 7 | 7 | 6 | 8 | 9 | 7 |
| `railgun/ready-1.ogg` | 7 | 6 | 7 | 9 | 8 | 7 |
| `railgun/fire-1.ogg` | 7 | 7 | 6 | 8 | 8 | 7 |
| `railgun/fire-2.ogg` | 7 | 7 | 6 | 8 | 7 | 7 |
| `railgun/fire-3.ogg` | 7 | 7 | 6 | 8 | 8 | 8 |
| `railgun/tail-2.ogg` | 8 | 8 | 6 | 8 | 8 | 8 |
| `railgun/impact-2.ogg` | 7 | 7 | 8 | 8 | 7 | 7 |
| `leadwall/fire-1.ogg` | 8 | 8 | 8 | 9 | 9 | 8 |
| `leadwall/fire-2.ogg` | 7 | 7 | 7 | 9 | 8 | 8 |
| `leadwall/fire-3.ogg` | 8 | 8 | 7 | 9 | 8 | 8 |
| `leadwall/tail-1.ogg` | 7 | 7 | 6 | 8 | 8 | 6 |
| `leadwall/tail-2.ogg` | 8 | 8 | 7 | 9 | 9 | 8 |
| `leadwall/pump-1.ogg` | 7 | 7 | 7 | 8 | 8 | 8 |
| `leadwall/pump-2.ogg` | 7 | 7 | 6 | 9 | 8 | 7 |
| `leadwall/ricochet-1.ogg` | 7 | 7 | 7 | 9 | 8 | 8 |
| `leadwall/ricochet-2.ogg` | 8 | 7 | 7 | 9 | 8 | 8 |
| `leadwall/ricochet-3.ogg` | 7 | 7 | 7 | 9 | 8 | 7 |
| `leadwall/impact-1.ogg` | 7 | 7 | 8 | 9 | 8 | 7 |
| `leadwall/impact-2.ogg` | 7 | 7 | 7 | 8 | 8 | 7 |
| `leadwall/impact-3.ogg` | 7 | 7 | 6 | 8 | 8 | 6 |
| `leadwall/reload-1.ogg` | 7 | 7 | 6 | 8 | 8 | 7 |
| `predator/fire-3.ogg` | 8 | 8 | 7 | 9 | 7 | 8 |
| `predator/spin-up-1.ogg` | 7 | 7 | 7 | 8 | 8 | 8 |
| `predator/spin-1.ogg` | 7 | 7 | 6 | 8 | 8 | 7 |
| `predator/spin-down-1.ogg` | 6 | 6 | 5 | 8 | 8 | 6 |
| `predator/casings-2.ogg` | 7 | 7 | 6 | 9 | 7 | 8 |
| `predator/casings-3.ogg` | 7 | 7 | 6 | 8 | 8 | 7 |
| `predator/impact-2.ogg` | 8 | 8 | 7 | 9 | 9 | 8 |
| `predator/tail-1.ogg` | 7 | 8 | 6 | 8 | 8 | 7 |
| `predator/tail-2.ogg` | 7 | 7 | 6 | 8 | 7 | 7 |
| `predator/reload-1.ogg` | 7 | 7 | 6 | 8 | 9 | 7 |
| `common/hit-confirm-1.ogg` | 7 | 7 | 6 | 9 | 9 | 8 |
| `common/hit-confirm-2.ogg` | 8 | 8 | 7 | 9 | 9 | 8 |
| `common/hit-confirm-3.ogg` | 8 | 9 | 8 | 9 | 9 | 8 |
| `common/doom-confirm-1.ogg` | 8 | 8 | 8 | 8 | 9 | 9 |
| `common/kill-confirm-1.ogg` | 8 | 8 | 8 | 9 | 8 | 9 |
