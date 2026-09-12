# Cosmetics baseline validation

Validated locally on 2026-09-12. This records the cosmetics work; the shared checkout also contained concurrent unrelated changes. This note describes local qualification; publication is recorded separately in Git history. No production deployment was verified here.

## Automated checks

- `npm test` completed with exit code 0, including all gameplay, account, career, animation, audio, weapon and mode suites.
- `npm run career:test` includes the new authority, UI, runtime and shipped-asset checks. The asset check verifies five real PNG previews and nine Opus files against catalog URLs, provenance hashes and recorded signal limits.
- The authority agent ran `node tools/cosmetics-career-test.mjs --postgres` against isolated PostgreSQL 18: existing v1 migration checksum, migration v2, mastery receipt idempotence, guest transfer, equip/reset and restart persistence passed.
- Runtime checks cover original material restoration, independent rigs, unchanged gun anchors, retained team colors after reassignment, character fades, departed-killer signatures and victory audio surviving a late death/respawn presentation.
- Final focused runtime/asset checks and `git diff --check` passed after the last presentation adjustments.

## Browser checks

The app browser used a separate local server on port 8097, with data restricted to `.artifacts/cosmetics/test-data`. A fresh level-1 guest proved locked rewards and explicit requirements. Only that isolated test fixture was then given level 100 and mastery values for the earned-inventory checks.

- All five skins inspected as their actual Three.js models. Every weapon was also viewed through the game's first-person rig; both character backs were inspected.
- Rifle skin, character skin, death signature and sound kit equipped through the real career UI/API. Standard weapon reset and re-equip worked; equipped state persisted after reload.
- The equipped rifle and character glove palette appeared in a running training session. No browser errors were recorded for that session.
- Actual sound previews played in the browser and displayed their active controls, including the generated Western victory cue. Category changes stopped the preview. No unavailable-file error occurred after all assets were present.
- The career dialog fit a 390-pixel layout: document width 390, open dialog width/scroll width 368/368.
- The real `DeathTreatment` component was rendered in a temporary UI fixture for all three signatures. The final death note ended at y=403.19 and the recap started at y=431.19 in the desktop fixture. This is component presentation evidence, not a claim that a two-player live elimination was manually played.

Screenshots and test output remain in `.artifacts/cosmetics/`, including `career-desktop.png`, `career-mobile.png`, `overdrive-live-training.png`, the weapon first-person images and death-signature images. Inventory artwork under `public/assets/cosmetics/` is rendered from the shipped model modules with a fixed neutral undersuit for comparison.

## Audio provenance and limits

All nine shipped cues came from successful ElevenLabs requests. Ten successful generations, including the discarded first Western victory candidate, reported a total of 200 `character-cost` units. An earlier invalid Arcade prompt returned HTTP 400; no cost was reported for that rejection. These are API-reported units, not a monetary conversion.

Decoded cues use mono Opus at 48 kHz. Their durations fit the runtime limits, all recorded peaks are below 0.75, and the signal checks found no clipped samples. Waveforms, request receipts, original files and mastering metrics were retained locally; shipped `sources.json` files identify the output hashes.

The review checked rendering, playback behavior, signal metrics and waveforms. A subjective listening review of timbre and musical quality was not performed. The collection provides separate kill, death and victory preview controls for that review.
