# SB-1 SUDSBLASTER

Slot 13 `bubble`, procedural model `public/js/guns/models/bubble.js`, accent
soap blue `#9fe9ff`, S&D price 2200.

Every other launcher makes things fall down; the SUDSBLASTER makes them fall
**up**. A yellow toy launcher with a teal nozzle, a lilac wand ring and a soap
bottle blows bubbles that hook upward, pop, shove and soak. The name, model,
textures, audio and effects are original procedural work inspired by the
cartoon's underwater bubble motif; no asset, logo, character likeness or sound
is copied.

- **Tap: Soap Shot.** A quick bubble that flies nearly straight to about 8 m,
  then hooks upward. Three direct hits kill.
- **Hold (up to 0.9 s): Big Bubble.** A wobbling film swells on the wand ring.
  On release a big, slow bubble drifts out, hovers and rises: a shove, a
  floating mine, a ceiling bomb and a trampoline in one. At 1.5 s the film
  lets go on its own.

## Rules

Canonical values live in `shared/bubble-rules.js` (`BUBBLE_RULES`), which the
server, the client prediction, bots, the HUD rise ladder and the TTK simulator
all import. `WEAPONS.bubble` in `shared/combatmath.js` holds cadence (300 rpm),
the 12-round tank with 4 spares, reload 2.2 s (tactical 1.7 s), spread, recoil
and the charge window (`charge.ms` 900, `holdMaxMs` 1500). Its `damage` array
is display only; the real damage is the pop.

Every profile field is lerped from the tap endpoint to the Big Bubble endpoint
by `mix = charge01²`, so short taps stay Soap Shots.

| Field | Soap Shot (tap) | Big Bubble (full) |
|---|---:|---:|
| Launch speed | 24 m/s | 13 m/s |
| Drag / terminal rise | 1.2 / 3.0 m/s | 1.0 / 1.4 m/s |
| Radius | 0.24 m | 0.60 m |
| Lifetime | 2.2 s | 4.2 s |
| Direct + splash (raw) | 16 + 26 | 20 + 50 |
| Splash radius | 2.2 m | 4.2 m |
| Knockback / self | 3.5 / 2.0 | 13 / 8 |
| Soak | 0.5 s | 1.8 s |

**Flight.** The bubble leaves 0.55 m ahead of and 0.16 m below the eye.
Velocity relaxes exponentially toward `(0, +rise, 0)`; `stepBubble` is the
exact solution for any `dt`, so server ticks, client frames and closed forms
agree. A launch against a wall is clamped and pops on the next tick at a valid
point.

| Target distance | Soap Shot: time / rise / aim under | Big Bubble: time / rise / aim under |
|---|---|---|
| 5 m | 0.18 s / +0.05 m / aim at the chest | 0.32 s / +0.06 m |
| 8 m | 0.35 s / +0.19 m / 0.25° | 0.70 s / +0.27 m / 0.8° |
| 10 m | 0.49 s / +0.36 m / 1.1° | 1.07 s / +0.58 m / 2.4° |
| 12 m | 0.66 s / +0.60 m / 2.1° | 1.66 s / +1.19 m / 4.9° |
| 15 m | 0.99 s / +1.23 m / 4.1° | out of reach |
| Maximum | 18.6 m, +4.3 m at the pop | 12.8 m, +4.5 m (hovers for the last ~1.7 s) |

Bubbles are good against targets level with or above you and poor against
targets far below. The range cap comes from the physics, not from a hidden
falloff.

**Damage.** After `COMBAT_DAMAGE_SCALE` (0.8) a Soap Shot direct hit deals
33.6 (three kill, 100.8), a Big Bubble 56. Splash is measured to the chest
(feet + 1.05 m):

| Pop to chest | 0.5 m | 1 m | 1.5 m | 2 m | 3 m | 4 m |
|---|---:|---:|---:|---:|---:|---:|
| Soap Shot | 16.1 | 11.3 | 6.6 | 1.9 | 0 | 0 |
| Big Bubble | 35.7 | 31.3 | 26.9 | 22.4 | 13.0 | 2.6 |

**Every pop** splashes, shoves (always upward), soaks the victim (the existing
`concussedUntil` slow, ×0.6 move speed) and **never damages terrain or its
owner**. Gun Game keeps its player damage. The `hit` event carries `soak` only
when damage was dealt, and the client applies the slow locally so the victim
does not rubber-band.

**Bubble rules on the server** (`server/sim/projectiles.js`):
- an owner's own bubbles never set each other off;
- enemy hitscan pops a bubble without stopping; teammates' bullets pass through;
- walking into your own floating bubble after 220 ms bounces you up without damage;
- each owner keeps at most 16 bubbles; a full room (192 projectiles) evicts that
  owner's oldest;
- a refused launch refunds the round.

## Movement tech

Self-knockback uses `vy += max(0.8, dy/d + 0.35) · selfKB · (1 − d/R)^0.65`
with no self-damage.

| Action | Result |
|---|---|
| Soap Shot at jump takeoff | about 0.7 m over a plain jump |
| Big Bubble at the feet | a 2-block ledge with a mantle |
| Big Bubble at jump takeoff | about 6 m: rooftops and the Chum Bucket deck without stairs |
| Walking or jumping into your own floating Big Bubble | soap trampoline |
| Big Bubble direct hit on an enemy | about 2.2 m up, 4 m outward: ledge and Goo Lagoon shoves, plant and defuse resets |

## Chaos Lab

| Tier | Upgrade | Behaviour |
|---|---|---|
| 1 ($300) | Double bubble | Each pull blows a free twin at the same charge, ±0.14 rad to alternating sides. It uses no ammo, counts toward the cap and carries `twin: 1`, so the client never adopts it as the local prediction. |
| 2 ($600) | Clingfilm | A wall or ceiling contact sticks instead of popping, for 5 s, up to 8 per owner. It pops when its voxel is gone, an enemy comes within 1.4–2.2 m with line of sight, it is shot, or at the fuse. Floor hits still pop, which keeps bubble jumps. |
| 3 ($900) | Foam party | Every non-child pop scatters five mini bubbles (11.2 direct after scale, 2.0 m splash, 0.5 s soak). Minis never twin, stick or scatter. |

## Client

- **Model** (`public/js/guns/models/bubble.js`): yellow receiver with racing
  stripes and brass portholes, teal nozzle and bell, lilac wand ring, bamboo
  foregrip, spatula stock, spatula-notch rear sight and ring front sight
  (`sightHeight` 0.140). The soap bottle sits in a socket under the receiver,
  canted toward the camera, so it keeps the nozzle and support hand visible.
- **Soap film** (`public/js/guns/soap-film.js`): a thin-film shader shared by
  the wand film, the world bubbles and the idle bubbles.
- **Presentation** (`public/js/guns/bubble-presentation.js`): the charge film
  swells and trembles, the bulb squashes, an air bead runs to the nozzle, the
  suds level follows the real ammo count, the bottle unscrews on reload, idle
  bubbles drift off the ring, and an empty tank blows a weak film that pops.
- **World** (`public/js/weapons/projectiles.js`, `effects.js`): a soap-film
  sphere with a camera-facing glint that flickers in the last 250 ms of its
  fuse, a micro-bubble trail, a clung bubble flattened against its mount
  normal, and one pooled burst of cartoon pop strokes per pop (quads, since
  WebGL ignores line widths), scaled by the blast radius and halved for
  Foam-party minis.
- **HUD** (`public/js/ui/bubble-hud.js`): a rise ladder with 10/12/15 m marks
  computed from the shared flight rules and the current field of view (they
  slide toward 8/10/12 m while charging), and a pastel SOAKED vignette.
- **Audio** (`public/js/audio/reports.js`, `sfx.js`): a charge-aware
  `shotBubble` report, a Big Bubble charge loop and a pop that tells a Big
  Bubble from a mini. No sample is needed.
- **HUD icon:** `public/assets/weapons/hud/bubble.png`, rendered by
  `node tools/render-hud-icon.mjs --weapon bubble`.

## Bots

- **Buying:** not in `BUY_PRIORITY`, so S&D bots never buy it; they fight
  with it wherever the loadout hands it to them (Gun Game, full-roster modes).
- **Aim:** they lead by the closed-form flight time and aim under the target
  by the bubble's rise.
- **Big Bubbles:** a bot holds a Big Bubble when a second enemy stands within
  3.5 m of its target inside 12 m, or when the S&D target is planting or
  defusing.
- **Range:** bots hold fire beyond 16 m and swap to the revolver when the
  target is well out of reach.

## Time to kill

`npm run balance:simulate` gives these medians for a standing target with 100 HP
(Soap Shots unless noted; full table in `docs/weapon-ttk.md`):

| Scenario | 1 m | 5 m | 10 m | 15 m | 20 m+ |
|---|---:|---:|---:|---:|---:|
| Soap Shots, perfect body | 0.47 s | 0.62 s | 0.92 s | 1.40 s | no reach |
| Soap Shots, hip fire body | 0.47 s | 0.62 s | 0.92 s | 1.42 s | no reach |
| Big Bubbles only (two, full charge) | 2.05 s | 2.32 s | 3.02 s | no reach | no reach |

Hip and ADS spread barely matter because the 0.24 m bubble plus splash
forgives small misses, and there are no headshots (head ×1). For comparison:
VK-77 RAPTOR 0.35 s, HORNET SMG 0.40 s, F-4 FIRESTORM 1.13 s at 5 m. The
SUDSBLASTER loses straight duels to hitscan and pays that back with group
splash, the soak slow, shoves, ceiling pops and mobility. Ammo is about four
kills per 12-round tank.

## Tuning knobs

In priority order:
1. `small.splashDamage`: the 3-tap needs direct + splash ≥ 41.7 raw; below
   that it becomes a 4-tap at about 0.85 s.
2. `rpm` (300 → 330 gives about 0.58 s at 5 m).
3. `small.speed` and `drag` (effective range).
4. `big.knockback`.
5. `big.selfKnockback` (roof access).
6. `concussMs`.

## Tests

- `npm run weapons:bubble:test` (`tools/bubble-test.mjs`): flight and closed
  forms, wall and body pops, soak, no terrain damage, Gun Game damage, kill
  credit, owner-chain exclusion, bullet pops, the owner cap and eviction, the
  soap trampoline, the chaos ladder (twin, cling on walls and ceilings, foam
  children), bots, and the presentation, viewmodel wiring, ladder and
  vignette.
- `tools/weapon-balance-test.mjs`: the role asserts (3 shots at 5 m, slower
  than the rifle and SMG, no reach at 30 m).
- Roster pins: `tools/smoke.mjs`, `tools/atlastest.mjs` (Gun Game order,
  price), `tools/chaos-test.mjs` (57 rows),
  `tools/contracts/weapon-wheel-contracts.mjs` (14 entries), and the list tests
  `viewmodel-arms`, `reload-animation` and `bullet-flyby`.

## Design record

The build spec and the held, firing, scoped, mobile, avatar and world renders
are in `docs/design/bikini-bottom/` (`weapon-spec.md`, `sudsblaster/`). No
image-generation tool was available when the weapon was built, so the
references are real renders of the implementation.

## Open items

- Third-person avatars do not play the charge presentation, and remote players
  cannot see a charge grow (a snapshot charge byte would add that tell).
- The spray droplets that replace the muzzle flash, the sprint micro-bubble,
  the reload sound cues, a `fire.ogg` sample, a team-coloured rim and a splash
  decal are not built.
