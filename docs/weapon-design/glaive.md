# GV-4 RIPTIDE

Slot 12 `glaive`, Blender asset SKUA (`skua`), accent magenta `#ff3fd0`.

A forearm-braced launcher throws a toothed magenta disc. The disc cuts out
nearly straight, bending gently onto a body just off its line, loops back and is caught to reload. Both legs pierce bodies. You
hold two discs, so the launcher is empty while both are in the air. R has no
reload meaning on this weapon: it turns every disc still on its out leg home at once.

## Rules

Canonical values live in `WEAPONS.glaive.glaive` (`shared/combatmath.js`). The
flight, damage and ammo rules live in `shared/glaive-rules.js`, which the
server, the client prediction and the balance simulator all use.

- **Throw:** semi-auto, 150 rpm (0.4 s). The disc starts 0.45 m ahead of the eye
  on the aim ray and flies at 34 m/s with no gravity. Its hit radius is 0.22 m.
  You can throw only with a seated disc and fewer than `magSize` discs in the air.
- **Out leg:** lasts 550 ms, which is about 19 m of flight. The first
  wall contact reflects the disc once, deals 24 block damage and turns it home.
- **Seeking (out leg only):** `glaiveSeek` bends the disc toward the damageable,
  visible body closest to its heading, at most 110°/s (`seekDegPerSec`). The body
  must be within 22° of the heading (`seekConeDeg`) and 20 m (`seekRange`), and
  not already cut on this leg. Teammates are never sought, even with friendly
  fire. The disc aims at the body's axis at the height it would already pass, so
  seeking only bends it sideways. A head-height line stays a head cut, and a line
  over the helmet or under the knees (outside 0.1 to 1.8 m above the feet) stays
  a miss. The server is authoritative. The client predicts the same bend onto the
  presented bodies (`getGlaiveSeekBodies`).
- **Return leg:** 30 m/s toward the owner's chest (`eyeY - 0.35`), turning at
  most 540°/s. While the owner is behind the disc it yaws in a level loop, like
  a boomerang, toward the owner's side (left when dead astern). This loop has a
  radius of about 3.2 m.
- **Damage:** base out 54 and back 72, times `COMBAT_DAMAGE_SCALE` (0.8), which
  gives 43.2 out and 57.6 back. A head hit is ×1.5. The zone comes from the
  disc's centre line (`preferCore`), not from its 0.22 m envelope.
  - Each leg cuts each body once and cuts up to 3 bodies, taking ×0.85 per body
    after the first.
  - The same body cannot take its back cut within 120 ms of its out cut.
  - Two out cuts total 86.4 and leave 13.6 HP. Out plus back is 100.8, a kill.
    A head out cut plus an out cut is 108, a kill.
- **Catch:** a disc on the return leg that passes within 1.4 m of its living
  owner goes back into `mag[12]`, whichever weapon is in hand.
- **Lost discs:**
  - A wall hit on the return leg embeds the disc as an owner-only pickup. Walking
    within 1.3 m of it restores the disc. After 4 s the launcher fabricates a
    replacement instead and the pickup despawns.
  - A disc still flying after 3.6 s, or one that leaves the world, fizzles and
    fabricates after 4 s with no pickup.
  - Owner death or disconnect loses the disc; the respawn refills the gun.
- **Ammo invariant:** `mag + inFlight + embedded + fab ≤ magSize`. One normaliser
  in the projectile tick enforces it. Discs in the air outrank discs in hand.
- **Chaos ladder:**
  - Third plate: `magSize` 3.
  - Razor wake: a 2.5 m pulse (20 damage, 12 knockback) at every wall contact and every catch.
  - Long tether: 800 ms out leg and 5-body pierce.
- **Modes:**
  - S&D price 3000.
  - Gun Game places it after LONGARC and before VOLTLANCE.
  - It is not in Duel, TTT or Bastion piercing.
  - The only attachments are the standard optic and grip.

## Network

| Event | Fields |
|---|---|
| `projectileLaunch` | `type:'glaive'`, `bn`, `phase:'out'`, `flip` (out-leg ms), `chaos`, `fuse` = lifetime |
| `projectileUpdate` | `phase`. A leg change adds `flip: 'time'`, `'bounce'` or `'return'`. Returning discs, and out-leg discs once they have sought a body, also resync every 100 ms. |
| `projectileExplode` | `type:'glaive'`, `radius:0`, `caught` (true only on catch), `reason` (`catch`, `embed`, `expire`, `owner` or `clear`). An `embed` explode position is the pickup position, and the pickup keeps the disc `pid`. |
| `glaiveStock` | `id` (owner), `fab` (ms left per queued fabrication), `pickups[{pid,x,y,z,regen}]`, optional `restored` (`pickup` or `fab`). It goes to every client, and only the owner's client shows the pickups. Owner death publishes it with no pickups. |
| `hit` | A disc cut carries `w:'glaive'`, so clients play the slice cue (with the ring on `hs`). A headshot needs the disc's centre line through the head box; a radius-only graze is a body cut. |

There are no new snapshot fields:
- The client counts discs in flight from its own launch and explode events.
- `mag[12]` is the number of seated discs.

R is sent as the normal identified reload request. The server acknowledges it
and calls `returnDiscs`, and it never sets `reloading`. The client predicts the
turn locally through `effects.glaiveReturn()`.

## Client

- **Model:**
  - `public/js/guns/models/skua.js` wraps the Blender asset.
  - `models/glaive.js` is the procedural fallback that the Node contracts use.
  - `glaive-presentation.js` drives the throw, return, catch, empty and fabricate states. It also dims the disc glow as discs leave the hand.
  - The throw/catch slide shrinks the disc to 0.25 so it clears the horn hinges; the cassette lift shrinks the spare in its cage and grows the next disc on the seat.
  - Remote avatars clamp on the owner's `projectileExplode` catch and restore on `glaiveStock.restored`, forwarded through `AvatarRoster.glaive`.
  - The SKUA cassette strip is the body's only razor-glow primitive, so `skua.js` treats every body glow as the fabricate strip.
- **Flight:** `public/js/weapons/projectiles.js` flies each disc with the shared
  `stepGlaive` and draws its trail (solid on the out leg, dashed on the return)
  and the embedded disc.
- **HUD:** the disc pips combine the authoritative `mag` with the split from
  `effects.glaiveHudState()` (in flight, out leg, embedded, fabrication progress).
  `main.js` merges the two into the HUD read model.
- **Audio:**
  - `fire.ogg` was synthesized from a fixed seed by `tools/generate-glaive-audio.py`, not recorded through ElevenLabs.
  - The flight whirr, bounce, slice (headshot ring), catch, embed, pickup, fabricate-start hum and fabricated cues are built live in WebAudio.
  - The return leg plays 20% higher.
- **HUD icon:** `public/assets/weapons/hud/glaive.png` is rendered from SKUA by
  `node tools/render-hud-icon.mjs --weapon glaive` (muted CDP capture page).

## Bots

- **Buying:** bots buy it after the lance and before the rifle (3000 against 2700),
  and a survivor that already holds a weapon of that tier or better does not rebuy.
- **Engagement:** they throw only at 4–18 m (scaled by `outMs`), with line of sight and
  a lead of target velocity × distance / 34 × skill.
- **R:** bots press R when an out-leg disc cut someone in the last 250 ms, or
  when the mag is empty and a disc is more than 12 m out, but never while a disc
  thrown under 300 ms ago is still on its out leg (R would turn it home too).
- **Range swap:** out of range, bots switch to the revolver.

## Time to kill

`npm run balance:simulate` gives these medians for a standing target with 100 HP
(full table in `docs/weapon-ttk.md`):

| Scenario | 1 m | 5 m | 10 m | 15 m | 20 m | 30 m+ |
|---|---:|---:|---:|---:|---:|---:|
| body | 1.47 s | 1.58 s | 1.73 s | 1.87 s | 0.95 s | no reach |
| head | 0.42 s | 0.52 s | 0.67 s | 0.82 s | 0.97 s | no reach |
| body, R after each out cut | 0.82 s | 0.92 s | 1.20 s | 1.60 s | 0.95 s | no reach |

In the open the return leg misses the thrower's target:
- The 540°/s turn at 30 m/s loops with a radius of about 3.2 m.
- The disc therefore comes home about 6 m to the side of its out path.
- A body kill up to 15 m therefore takes three out cuts: two discs, a catch and a rethrow.
- At 20 m the out leg ends inside the target, so both discs land back cuts.

The spec's estimates (0.40 s with R, 1.0–1.2 s without) assumed the return
passes back through the target. That only happens after a wall bounce, or to
bodies standing beside the loop. The head numbers match the spec, because a head
out cut plus an out cut kills. Options, if the body TTK should come closer to
the spec:
- a hairpin turn rate for the first 100 ms of the return leg;
- a larger `catchRadius`-style envelope for back cuts;
- `outDamage` 58 or more, so two body out cuts kill.

## Tests

- `npm run weapons:glaive:test` (`tools/glaive-test.mjs`) covers:
  - the scale-derived damage rules and the head zone;
  - the out leg, out-leg seeking (near miss, cone, range, cover, height band,
    turn cap and teammates), the bounce, the 540°/s level return loop and pierce;
  - the leg gap, catch in any hand and the fire gate;
  - R (ack without `reloading`), embed and pickup, fabrication, fizzle and owner loss;
  - the refill invariant, resets and the Chaos ladder.
- Roster pins:
  - `tools/smoke.mjs` (ids, weight 3.1, no tracer);
  - `tools/atlastest.mjs` (Gun Game order, prices);
  - `tools/chaos-test.mjs` (54 rows, ladder values);
  - `tools/contracts/weapon-wheel-contracts.mjs` (13 entries);
  - the list tests `viewmodel-arms`, `reload-animation` and `bullet-flyby`.
- `tools/reload-state-test.mjs` leaves the glaive out of the reload loop, because R is not a reload; a separate block covers the client R request (ack, timeout, switch clear).
- Browser suites are left to the user:
  - `tools/blender-assets-browser-test.mjs`;
  - `tools/weapon-materials-browser-test.mjs`, which maps `skua` to `glaive`.
