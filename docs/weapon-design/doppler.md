# SP-2 DOPPLER

Slot 20 `doppler`, Blender asset `doppler`, UI accent teal `#39cfc0`.

A shifted-pulse battle rifle. The barrel and receiver (the *unit*) recoil
together on a guide rod inside a fixed carrier chassis, so two rounds leave the
muzzle before the unit reaches its buffer. The shooter gets one late kick for
two rounds that land almost on top of each other. Every trigger pull is that
two-round *doublet*; there is no single-shot mode.

It is the long-range answer to the VK-77 RAPTOR: two pulls kill inside about
40 m if all four rounds land, sustained damage is lower than any other automatic
weapon, and it is poor from the hip.

## Rules

Canonical values live in `WEAPONS.doppler` (`shared/combatmath.js`). The
doublet needs three small shared rules, which the server, the client
prediction and the TTK simulator all use:

- **`roundsPerShot: 2`.** `shotRounds(def, mag)` says what the next pull does:
  it spends `min(2, mag)` rounds and launches one projectile per spent round.
  A magazine's last odd round therefore fires alone. Every other weapon
  returns `{spend: 1, pellets: def.pellets}`.
- **`doublet.spreadDeg` (0.07°).** The first round samples the normal cone.
  `samplePelletDirection(..., first)` keeps the second within 0.07° of the
  first instead of sampling the cone again, so the pair is about 12 cm apart
  at 100 m even when the cone is wide.
- **`doublet.gapMs` (33 ms).** Presentation only. Authority resolves both
  rounds in the tick of the pull (one `shoot` event with two `paths`); the rig
  and the report stagger the second round by this gap.

| | |
|---|---|
| Trigger | `auto`: a held trigger repeats doublets at 190 pulls per minute (316 ms) |
| Magazine | 30 rounds (15 pulls), 5 spare magazines |
| Damage per round | 32 to 35 m, falling to 23 at 110 m; ×0.8 combat scale = 25.6 to 18.4 |
| Headshot | ×1.7 (a head pair is 87, never a one-pull kill) |
| Spread | hip 2.1°, ADS 0.10°; bloom +0.42° per pull, moving +2.6° |
| Recoil | 1.35° per pull, reset 420 ms, ADS ×0.66 |
| Optic | factory 1.5× prism, sight line 0.142 m |
| Penetration | 80 |
| Reload | 2.5 s empty, 1.9 s tactical |

Four body hits (102.4) kill a 100 HP target out to about 41 m, where a round
drops below 25 damage; beyond that it takes three pulls.

## Modes

- **Conquest:** the second primary of the Assault (`['rifle', 'doppler']`, a
  base kit, so everyone can deploy with it) and of the Marksman
  (`['lance', 'doppler']`, level 9; every hit of the pair tags for OVERWATCH).
  The M-DOCK 12 stays with the Engineer and the Pyro, the LONGARC with the
  Recon and the Medic.
- **Free rosters** (Quick Play, TDM, Training, Bastion armory): available like
  any free weapon. It sits behind the gadget block in `WEAPON_IDS`, because
  slots are wire indices and never move; the wheel shows it as its sixteenth
  segment and the scroll wheel reaches it, but no digit key does.
- **Search and Destroy:** 3100 credits. **Gun Game:** after the BASTION LMG.
- **Chaos ladder:** *Triplet* (a free third projectile on every pull,
  `bonusRounds`), *Echo* (two ricocheting bolts per pull), *Sonic boom* (a
  forward shockwave every third pull).
- Not in Duel, TTT or the Titanfall pilot primaries.

## Time to kill

`npm run balance:simulate` medians for a standing 100 HP target (measured at
205 pulls per minute; the shipped 190 adds 24 ms per extra pull):

| Scenario | 5 m | 20 m | 40 m | 80 m | 120 m | 160 m |
|---|---:|---:|---:|---:|---:|---:|
| SP-2, ADS body | 0.28 s | 0.28 s | 0.28 s | 0.58 s | 0.58 s | 0.58 s |
| RAPTOR, ADS body | 0.35 s | 0.35 s | 0.53 s | 0.72 s | 0.90 s | 1.35 s |
| SP-2, ADS head | 0.28 s | 0.28 s | 0.28 s | 0.28 s | 0.28 s | 0.58 s |
| RAPTOR, ADS head | 0.17 s | 0.17 s | 0.27 s | 0.82 s | 1.27 s | 2.00 s |
| SP-2, hip body | 0.28 s | 0.58 s | 2.63 s | none | none | none |
| RAPTOR, hip body | 0.35 s | 0.35 s | 1.45 s | 11.1 s | none | none |

The simulator never misses a still target. In play a missed round costs a
whole pull (316 ms) where the RAPTOR loses 91 ms.

## Network

No new message and no new snapshot field. A pull is one `shoot` event whose
`paths` array holds one polyline per round (two, or one for the last odd
round). Clients read `paths.length` to pick the doublet or the single report.
`mag[20]` drops by the rounds spent.

## Client

- **Model:** `public/js/guns/models/doppler.js` wraps the baked Blender asset
  (`docs/design/blender/doppler/README.md`). There is no procedural fallback;
  Node contracts list `doppler` as Blender-only.
- **Presentation:** `doppler-presentation.js` slides the unit 16 mm
  (`dopplerStroke`), compresses the buffer spring against its fixed stop, turns
  both cable sheaves behind the glass ports and shows the cartridge stack
  behind the smoke magazine wall. The stack is one instanced cartridge, so a
  spent round is one instance fewer and the follower rises with it. During a
  reload the fresh magazine arrives full once the spent one is out of sight.
- **Shifted pulse in the rig:** `ViewmodelRig.fire` flashes twice 33 ms apart,
  cycles the carrier twice and ejects two cases, but delivers the recoil
  impulse once, at `DOPPLER_BUFFER_S` (47 ms), when the unit meets its buffer.
  A last single round kicks at once and drives the unit 62 % of the stroke.
- **Audio:** `public/assets/audio/weapons/doppler/fire.ogg` holds both reports
  and the buffer clack; `fire-single.ogg` is the last odd round. Both are
  synthesized from a fixed seed by `tools/generate-doppler-audio.py` and have
  not been auditioned by ear. `shotDoppler` in `audio/reports.js` is the
  procedural layer and fallback.
- **HUD icon:** `node tools/render-hud-icon.mjs --weapon doppler` renders it
  from the delivered model.

## Bots

Bots fire it like any automatic weapon. They buy it after the VOLTLANCE in
Search and Destroy and prefer it over the RAPTOR against hulls. Conquest
Assault and Marksman bots carry it on the second variant (a stable hash of the
bot id).

## Validation

`npm run weapons:doppler:test` (`tools/doppler-test.mjs`) covers the shot
rules, a real `GameEngine` pull, hold and last odd round, the Conquest kits,
the presentation curves and the delivered asset contract.
