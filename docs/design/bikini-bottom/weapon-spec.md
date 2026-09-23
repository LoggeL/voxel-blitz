# SB-1 SUDSBLASTER: final weapon build spec (Bikini Bottom themed weapon)

Status: DESIGN, no repo files changed. Verified against the dirty working tree on 2026-09-22:
`shared/combatmath.js`, `server/sim/{combat,projectiles,context,chaos-combat,movement}.js`, `server/bots.js`,
`shared/{rocket-rules,chaos,modes,player-hitboxes,avatar-hands,weapon-handling}.js`,
`public/js/weapons/{projectiles,effects}.js`, `public/js/guns/{kit,defs,actions,assemble,weapon-state,viewmodel}.js`,
`public/js/audio/{sfx,reports}.js`, `public/js/player-physics.js`, `tools/{smoke,glaive-test,weapon-balance-test}.mjs`,
`tools/lib/ttk-simulation.mjs` and `.artifacts/ttk/current/summary.md`.

A reference implementation of the rules module has already been written and checked numerically:
`shared/bubble-rules.js` (shipped verbatim).
The fixed-step integration equals the closed form to 1e-3 m at 60 Hz, and one 2.2 s step gives the same result.

**IP:** the name, model, textures, audio and VFX are all original procedural work inspired by the show's underwater bubble motif. Do not copy any asset, logo, character likeness or sound. Say so in `docs/weapon-design/bubble.md`.

---

## 0. Judging

Each concept is scored 1-10 on each criterion. The last column is the sum out of 50.

| Criterion | Signature: SB-1 charge (tap and Big Bubble) | Alt: JF-5 JELLYZAPPER (hitscan with sting arc) | Presentation: SB-1 auto (juice-first) |
|---|---|---|---|
| Fun and distinctness | **9**: the only rising projectile; ceiling pops, door curtains, bubble jumps and the soap trampoline | 5: chain arcs already exist (rifle T1 "Tesla", revolver T1, lance T2); only wet conduction is new | 7: rising lob and bubble hop, but a single mode |
| Thematic fit | **9**: bubbles are the show's defining visual motif | 6: jellyfishing is iconic, but pink lightning reads as sci-fi | **9** |
| Balance sanity | 6: 4 taps are too slow (0.85 s at 5 m, 1.66 s at 15 m); the `damage:[34,34,18]` with `falloffStart:18` divides by zero in `damageAtDistance` (buy-menu NaN) | **8**: clean 3-tap at 0.46 s, correct thresholds | 6: good 3-tap at 0.59 s, but 33.8 m reach with drag 0.35 makes a cross-map lob; `selfKnockback 8` everywhere |
| Implementation risk in the dirty tree (10 = safest) | 4: about 650 LOC; projectiles on both sides, bots, TTK sim, charge audio; cling adds a stuck state | **8**: about 130 gameplay LOC in a new file plus 2 hooks | 5: about 550 LOC; auto mode avoids the charge path, but a heavy presentation class and a shader in the dirty `kit.js` |
| Presentation charm | 7 | 6 | **10**: soap-film shader, bulb squash, suds level from the authoritative mag, pop lines, rise ladder |
| **Total** | **35** | 33 | 37 |

**Winner: SB-1 SUDSBLASTER, synthesised from two concepts.**
- **From the signature:** the gameplay core. That is tap versus hold (Big Bubble) on the existing `charge` trigger path, the drag-to-terminal-rise flight, the owner-chain exclusion, bullets popping bubbles, gun-game damage gates, per-owner cap, bots and movement tech.
- **From the presentation concept:** the model part list, sights and anchors, the soap-film material, the fire, reload and idle choreography, pop VFX, the audio recipes and the HUD rise ladder.
- **Re-tuned to a 3-tap Soap Shot.** 16 + 26 = 42 raw becomes 33.6 effective, and three hits deal 100.8. The weapon becomes a real buy while staying the slowest duelist among the guns.

The alt stays the documented fallback. If the bubble must be cut, ship the JELLYZAPPER exactly as specified in its concept (id `jelly`). The two do not conflict.

**Fixes to the source concepts, found while verifying:**
1. **Display damage divides by zero.** `damage: [34,34,18]` with `falloffStart: 18` makes `damageAtDistance` divide by zero (`combatmath.js:465`, denominator `damage[2] - falloffStart`). Use `[42, 42, 19]` with `falloffStart: 18`.
2. **Sight height 0.100 is blocked.** With a 0.100 sight height, the signature's wand ring (R 0.055 + tube 0.009, centred at y 0.05) crosses the ADS centre ray (`viewmodel-contracts.mjs:~574`). Use the presentation geometry: sight 0.140, ring centre y 0.030.
3. **Clingfilm must reset the fuse.** `explodeAt = min(explodeAt, now+5000)` would cut a tap bubble's cling to its remaining 2.2 s life. Set `explodeAt = now + cling.ms`.
4. **Pops soak only when they deal damage.** Otherwise the new `evHit.soak` signal would miss zero-damage edge pops, and the client prediction would rubber-band.
5. **Remote players cannot hear a charge.** `weaponCharge` is local-only today; a third-person tell needs the optional snapshot byte (§13, P2). The Big Bubble in flight is the readable threat.
6. **The Double-bubble twin must not be adopted.** Its launch event carries `twin: 1`, and the client adoption guard skips it. Otherwise it would steal the local prediction's adoption slot (`projectiles.js:564`).
7. **Keep `soak-film.js` out of `kit.js`.** Put the soap-film shader in a new `public/js/guns/soap-film.js` instead of the dirty `kit.js`.

---

## 1. Identity

| Field | Value |
|---|---|
| id | `bubble` (lowercase; Bastion purchase regex safe). It is also the projectile type, the chaos key, the audio key `weapons.bubble.fire`, the CSS class `vb-w-bubble`, the icon `hud/bubble.png` and the model `models/bubble.js` |
| Slot | Appended: `WEAPON_IDS[13]`. Reached through the wheel and scroll only |
| Name | `SB-1 SUDSBLASTER` |
| Class line | `BUBBLE LAUNCHER · TAP OR HOLD · FLOATS UP` |
| Glyph | `SB` |
| Accent | `#9fe9ff` (`GLOW_ACCENT.bubble = 0x9fe9ff`, `--w-bubble: #9fe9ff`) |
| Price | 2200. That is above the shotgun (1800) and below the flamethrower (2400) and rifle (2700), because the duel TTK is worse than the rifle's and it has group and utility value |
| Gun game | Insert after `glaive`: `…'longarc','glaive','bubble','lance','revolver','minigun','knife'` |
| Duel, TTT, Bastion | Not in `DUEL_WEAPONS` or `TTT_WEAPONS`. Bastion is unchanged |

### 1.1 One-sentence pitch

Every other launcher makes things fall down; the SUDSBLASTER makes them fall **up**. The weapon has two shots:
- **Tap: Soap Shot.** A quick bubble that reads as straight up to about 8 m, then hooks upward. Three direct hits kill.
- **Hold (up to 0.9 s): Big Bubble.** A wobbling film swells on the wand ring. On release a big, slow bubble drifts out, hovers and rises. It works as a shove, a floating mine, a ceiling bomb and a trampoline in one.

Every pop does four things:
- soft splash damage;
- an always-upward shove;
- a "soaked" slow (the existing `concussedUntil`, ×0.6 move speed);
- **no terrain damage**.

---

## 2. Rules module: new `shared/bubble-rules.js`

Copy it verbatim from `scratchpad/bubble-rules.ref.js`. The content is authoritative and shown here in summary. Server, client, bots, HUD and the TTK sim all import it. **Do not** import it from `combatmath.js`: that keeps the preload graph small, since only the files listed in §4-§9 import it.

```js
export const BUBBLE_RULES = Object.freeze({
  small: { speed: 24, drag: 1.2, rise: 3.0, radius: 0.24, lifetimeMs: 2200,
    directDamage: 16, splashDamage: 26, damageRadius: 2.2, damageFalloffExponent: 1.0,
    knockback: 3.5, selfKnockback: 2.0, knockbackRadius: 2.8, concussMs: 500 },
  big:   { speed: 13, drag: 1.0, rise: 1.4, radius: 0.60, lifetimeMs: 4200,
    directDamage: 20, splashDamage: 50, damageRadius: 4.2, damageFalloffExponent: 0.9,
    knockback: 13,  selfKnockback: 8,   knockbackRadius: 4.6, concussMs: 1800 },
  chargeCurve: 2, knockbackFalloff: 0.65, selfDamage: 0,
  muzzleForward: 0.55, muzzleDrop: 0.16, bodyHalfWidth: 0.32,
  maxPerOwner: 16, soakSpeedMult: 0.6,
  twin:  { yawRad: 0.14 },                                               // chaos 1
  cling: { ms: 5000, perOwner: 8, reachSmall: 1.4, reachBig: 2.2 },       // chaos 2
  foam:  { count: 5, speed: 6, up: 1.5, drag: 1.2, rise: 3.0, radius: 0.18, lifetimeMs: 900, stepMs: 60,
           directDamage: 5, splashDamage: 9, damageRadius: 2.0, damageFalloffExponent: 1.0,
           knockback: 2.5, selfKnockback: 0, knockbackRadius: 2.4, concussMs: 500 },   // chaos 3
  color: '#9fe9ff',
});
export function bubbleMix(charge01)                   // clamp01(c)^2
export function bubbleProfile(charge01 = 0, child = false)   // lerp all 13 numeric fields small→big by mix; child → foam
export function bubbleBlastRules(profile)             // generic-explode rules: splash→damage, terrain 0, selfDamage 0
export function bubbleLaunch({ x, y, z, dir, charge01, child, raycast })
  // origin = eye - 0.16 y + dir*0.55; with `raycast` clamps to (hit.t - radius) and sets blocked:true
  // returns { type:'bubble', x,y,z, vx,vy,vz, drag, rise, radius, lifetimeMs, charge, child, blocked }
export function stepBubble(b, dt, raycast)
  // exact: e=exp(-drag*dt), g=(1-e)/drag; dx=vx*g, dz=vz*g, dy=rise*dt+(vy-rise)*g;
  // vx*=e, vz*=e, vy=rise+(vy-rise)*e; sweep length+radius; stop at hit.t-radius;
  // b.hit = {x,y,z,nx,ny,nz,t}
export function bubbleFlight(profile, distance, launchVy = 0)   // → {t, rise} | null (out of reach or lifetime)
export function bubbleAimDrop(profile, distance)                // → radians to aim below the target (HUD ladder, bots)
export function bubbleMaxRange(profile)
```

The blocked-launch clamp exists because a bubble spawned inside a wall hugged at point blank would pop inside the solid voxel. With the clamp, the launch reports `blocked`, and the server sets `explodeAt = now`, so the bubble pops next tick at a valid point. Bubble jumps against walls need this.

### 2.1 Verified flight table (level launch; the rise is above the launch point, which is 0.16 below the eye)

| Target distance | Soap Shot t / rise / ladder | Big Bubble t / rise / ladder |
|---|---|---|
| 5 m | 0.18 s / +0.05 m / (−1.2°, just aim at the chest) | 0.32 s / +0.06 m |
| 8 m | 0.35 s / +0.19 m / 0.25° | 0.70 s / +0.27 m / 0.8° |
| 10 m | 0.49 s / +0.36 m / **1.1°** | 1.07 s / +0.58 m / **2.4°** |
| 12 m | 0.66 s / +0.60 m / **2.1°** | 1.66 s / +1.19 m / **4.9°** |
| 15 m | 0.99 s / +1.23 m / **4.1°** (aim at the knees) | out of reach |
| Maximum | 18.57 m horizontal, +4.28 m at the 2.2 s pop | 12.81 m, +4.50 m at the 4.2 s pop (it hovers for the last ~1.7 s) |
| 30 m | **no reach** | **no reach** |

Two properties follow from the flight model:
- **Vertical asymmetry.** Bubbles are good against targets level with or above you, and poor against targets far below.
- **Honest range.** The range cap comes from the physics, not from a hidden damage falloff.

### 2.2 Damage (pre-scale; `COMBAT_DAMAGE_SCALE` 0.8)

| Case | Raw | Effective | Kill |
|---|---:|---:|---|
| Soap Shot direct (16 + 26) | 42 | **33.6** | 3 hits = 100.8 |
| Half charge, 0.45 s (mix 0.25): 17 + 32 | 49 | 39.2 | 3 hits (no gain over taps, and slower) |
| Big Bubble direct (20 + 50) | 70 | **56** | Big + 2 taps |
| Chaos-3 foam mini direct (5 + 9) | 14 | 11.2 | — |

**Splash** (effective, measured to the chest at feet + 1.05)

| Pop to chest | 0.5 m | 1 m | 1.5 m | 2 m | 3 m | 4 m |
|---|---:|---:|---:|---:|---:|---:|
| Soap Shot | 16.1 | 11.3 | 6.6 | 1.9 | 0 | 0 |
| Big Bubble | 35.7 | 31.3 | 26.9 | 22.4 | 13.0 | 2.6 |

The kill threshold is deterministic: `_damagePlayers` rounds `42 → 42.0`, and `×0.8 = 33.6`. Any armor breaks the 3-tap, which is intended and the same as for the other guns.

---

## 3. `WEAPONS.bubble` entry (`shared/combatmath.js`, after `glaive`)

```js
  bubble: {
    // Bubble launcher: tap for a quick Soap Shot, hold to blow a Big Bubble (fires on
    // release, lets go on its own at holdMaxMs). Bubbles are buoyant: drag bleeds their
    // speed toward a terminal rise, so every shot hooks upward and nothing flies past
    // ~18.6 m. Pops splash, shove (always upward) and soak (concussion slow); they never
    // hurt terrain or their owner. Flight and blast rules: shared/bubble-rules.js.
    id: 'bubble', name: 'SB-1 SUDSBLASTER', mode: 'charge',
    weightKg: 2.6,
    rpm: 300, magSize: 12, spareMags: 4,
    damage: [42, 42, 19], falloffStart: 18,   // display only: raw direct Soap Shot; real damage is the blast
    headMult: 1, pellets: 1, penetration: 0,
    spreadDeg: { hip: 1.4, ads: 0.5 }, bloomDeg: 0.35, bloomMaxDeg: 2.4,
    bloomRecover: 4.0, moveSpreadDeg: 1.0,
    crouchSpreadMult: 0.8,
    recoil: {
      pitch: 0.9, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 0.3, yawPattern: [0.21, -0.37, 0.44, -0.18],   // unique in the roster (checked)
      jitter: 0.05, resetMs: 420, adsMult: 0.8, recovery: 0.7,   // 420 > 60000/300 = 200
    },
    adsFov: 62, zoom: 1.15, adsTime: 0.15,
    reloadTime: 2.2, tacTime: 1.7, deployTime: 0.36,
    tracer: null,          // the bubble mesh and its rising micro-bubble trail replace a tracer
    sfx: 'bubble',
    projectile: 'bubble',
    charge: {
      ms: 900,             // a full Big Bubble
      holdMaxMs: 1500,     // the film cannot hold more air: auto-release (no corner-camping a charged bubble)
      minDamageMult: 1,    // unused: damage comes from bubbleProfile(charge), not chargeDamageMult
      damageExponent: 2,
    },
  },
```

- **Yaw pattern.** The existing patterns were checked: rifle, smg, shotgun, sniper, lmg, minigun, revolver, longarc, lance `[-0.40,0.50,-0.30,0.60]`, flamethrower, rocket `[0.6,-0.5,0.4,-0.6]` and glaive `[0.4,-0.6,0.2]`. `[0.21,-0.37,0.44,-0.18]` is unique.
- **`WEAPON_IDS` (line 361):** append `'bubble'`.
- **JSDoc:** add `'bubble'` to the id union (~39) and the `projectile` union (~73). At line 82, "thirteen" becomes "fourteen".
- **Charge-mode safety.** These paths were checked for the new charge weapon:
  - `chargeShotProfile` gives hitRadius 0, because the def has no `hitRadius`;
  - `bulletPower` and `chargeDamageMult` are computed but unused, because the bubble branch returns first;
  - the client `_tryChargeFire` and HUD `charge01` are generic;
  - the viewmodel lance orb is id-gated (`viewmodel.js:858`).

**Other shared tables**

| File | Entry |
|---|---|
| `shared/weapon-handling.js` | `bubble: profile(82, 0.26, 0.55)`: a light toy with a floaty, sloshing sway |
| `shared/modes.js` | `WEAPON_PRICES.bubble = 2200`; `GUN_GAME_WEAPON_ORDER` after `'glaive'` |
| `shared/player-hitboxes.js` | `SIGHT_HEIGHT.bubble = 0.140` |
| `shared/avatar-hands.js` | `bubble: { grip: { x: 0, y: -0.050, z: 0.012 }, support: { x: 0, y: -0.058, z: -0.345, on: 'body' } }` (the support hand cups the bamboo pole) |
| `shared/weapon-attachments.js` | add `'bubble'` to the optics exclusion (line 28) and the grips exclusion (line 31) |
| `shared/chaos.js` | `CHAOS_UPGRADES.bubble` (§6). No `chaosWeaponDef` branch is needed |
| `server/sim/movement.js:27` | `export const CONCUSSED_SPEED_MULT = 0.6;` (add `export` only; the file is clean) so `bubble-test` can assert `BUBBLE_RULES.soakSpeedMult` equals it |

---

## 4. Server integration

### 4.1 `server/sim/combat.js` `fireOneShot` (dirty file: two small hunks)

1. **Launch.** Before `if (def.flame)` (≈ line 512, after the glaive branch), add:
   ```js
   if (def.projectile === 'bubble') {
     // Refused launch (projectile budget) keeps the round, like the RIPTIDE disc.
     if (!ctx.launchBubble?.(p, firstDir, charge01)) p.mag[p.weapon]++;
     return;
   }
   ```
   - Charge input already flows through `resolveChargeIntent` (combat.js:208-228), including the vent at `holdMaxMs`. `chaosShot` needs no bubble branch, because the twin lives in `launchBubble`.
   - `shootEvent.charge` is already set for charge weapons (line ~487).
2. **Bullets pop bubbles.** This follows the existing claymore pattern. Inside the hitscan inner loop, directly after `const mine = ctx.nearestClaymore?.(…)` (≈ line 535), add:
   ```js
   ctx.popBubblesOnRay?.(p, origin, d, minT, mine ? mine.t : (tgt?.t ?? wallT), shotProfile.hitRadius);
   ```
   - The ray is **not** stopped, so bubbles give no soap shield. Every interval `[minT, end]` is tested, which also covers pierce weapons; popping is idempotent.
   - Teammates' bullets pass friendly bubbles.
   - An enemy who shoots a bubble 1 m from themselves eats about 11 damage plus a soak. The lesson is to shoot bubbles early.
   - The owner can switch to any hitscan gun and airburst their own floating Big Bubble.

### 4.2 `server/sim/context.js` (combat ctx, next to `launchGlaive`)

```js
launchBubble: (player, dir, charge) => engine.projectiles.launchBubble(player, projectiles, dir, charge),
popBubblesOnRay: (shooter, origin, dir, t0, t1, pad) =>
  engine.projectiles.popBubblesOnRay(shooter, origin, dir, t0, t1, pad, projectiles),
```

### 4.3 `server/sim/projectiles.js` (dirty file: additive hunks)

**Imports:** `import { BUBBLE_RULES, bubbleBlastRules, bubbleLaunch, bubbleProfile, stepBubble } from '../../shared/bubble-rules.js';`

**`PROJECTILE_RULES.bubble`:** `bubbleBlastRules(bubbleProfile(0))`, frozen. This is the static small profile. It is the fallback, and the value `_scatter`/`chaosBlast` spreads fall back to. Every live bubble also carries its own `blastRules`, so `explode` skips the generic rocket/limpet/L3 scaling at lines 1041-1050.

**Step dispatch (lines 210-213):** add `else if (projectile.type === 'bubble') this._flyBubble(projectile, stepSeconds * substeps, ctx);` before the `_flyGrenade` fallthrough.

**`launchBubble(player, ctx, dir, charge01 = 0, twin = false)`** is modelled on `launchRocket` (828-861):
1. Refuse the launch (return `null`) only when the room is full (`this.active.size >= 192`) and none of the owner's own bubbles can be evicted. Otherwise:
   - count this owner's live non-child bubbles;
   - if the count reaches `maxPerOwner` (16), set the oldest one's `explodeAt = ctx.now`, so it airbursts next tick;
   - if the room is at 192, delete the oldest one immediately through `this.explode(oldest, ctx)`.
2. Call `const l = bubbleLaunch({ x: eyeX, y: eyeY, z: eyeZ, dir, charge01, raycast })`. The raycast is the same closure as the rocket's.
3. Create the projectile:
   ```js
   { id: `u${this._nextId++}`, type: 'bubble', ownerId, owner: player,
     ...l, launchedAt: now, explodeAt: now + (l.blocked ? 0 : l.lifetimeMs),
     stuck: false, stuckTo: null, hit: null, directVictim: null, twin,
     blastRules: bubbleBlastRules(bubbleProfile(charge01)), raycast }
   ```
4. Call `this._configureChaos(projectile)`. It already resolves `chaosLevel(p, 'bubble')`.
5. Push the launch event:
   ```js
   Object.assign(evProjectileLaunch(player.id, id, 'bubble', o, v, l.lifetimeMs),
     { chaos: level, charge: round3(charge01), ...(twin ? { twin: 1 } : {}) })
   ```
6. **Chaos 1 "Double bubble".** If `!twin && chaosLevel >= 1`, call `this.launchBubble(player, ctx, yawed(dir, side * BUBBLE_RULES.twin.yawRad), charge01, true)`, where `side = player.shotSeq % 2 ? 1 : -1`. The twin costs no ammo, counts toward the owner cap, and is a normal non-child bubble, so it can cling and scatter.
7. Return the projectile, which is truthy.

**`_flyBubble(b, seconds, ctx)`:**
```js
if (b.stuck) return this._stepClungBubble(b, ctx);
const prev = { x: b.x, y: b.y, z: b.z };
stepBubble(b, seconds, b.raycast);
const contact = this._sweepVictim(prev, b, b.radius, ctx, b);   // owner included after OWNER_GRACE_MS (220): soap trampoline
if (contact) { b.x = contact.x; b.y = contact.y; b.z = contact.z; b.directVictim = contact.victim; return this.explode(b, ctx); }
if (b.hit) {
  if (!b.child && (b.chaosLevel || 0) >= 2 && !(b.hit.ny > 0.5)) return this._clingBubble(b, ctx);   // walls and ceilings only
  return this.explode(b, ctx);
}
return false;
```

**Chaos 2 "Clingfilm".** `_clingBubble(b, ctx)`:
- sets `stuck = true`, `vx = vy = vz = 0`, `mount = [hit.x, hit.y, hit.z]` and `explodeAt = ctx.now + BUBBLE_RULES.cling.ms` (the fuse is reset, not a `min`);
- enforces `cling.perOwner` 8 (the oldest stuck bubble of the owner gets `explodeAt = now`);
- pushes `evProjectileStick(ownerId, id, [x,y,z], null, cling.ms)`. The client limpet stick path already exists (`projectiles.js:754`).

`_stepClungBubble(b, ctx)`:
- pops (`explode`) if the mount voxel is AIR (`ctx.getBlock(...mount) === AIR`);
- otherwise finds `v = this._contactVictim(b, lerp(reachSmall, reachBig, bubbleMix(b.charge)), ctx, b, true)`, with `ignoreOwner` so owners never trip their own mines. If `v` exists and `visibleTo(ctx, [b.x,b.y,b.z], [v.x, v.y + 1.05, v.z])`, it calls `explode` (a splash pop, not a direct hit);
- lets bullets pop it (§4.1).

**`explode` (dirty lines 1034-1083), three one-line edits:**
- Suppression gate: `if (ctx.grenadeDamage !== false || projectile.type === 'rocket' || projectile.type === 'pulse' || projectile.type === 'bubble')`.
- Scatter count: extend the expression to `… : projectile.type === 'bubble' && level >= 3 ? BUBBLE_RULES.foam.count : 0`. The block is already guarded by `!projectile.child`.
- No terrain: `rules.terrainRadius` is 0.

**`_damagePlayers` (1085-1146), three edits:**
- `const damageEnabled = ctx.grenadeDamage !== false || projectile.type === 'rocket' || projectile.type === 'bubble';` This keeps gun-game damage alive.
- Soak signal. Replace the plain `ctx.pushEvent(evHit(...))` with:
  ```js
  const hit = evHit(owner?.id || '', victim.id, damage, false, target, victim.lastDamage);
  if (projectile.type === 'bubble' && rules.concussMs > 0 && !isSelf) hit.soak = Math.round(rules.concussMs);
  ctx.pushEvent(hit);
  ```
- Concussion gate: `if (rules.concussMs > 0 && !isSelf && (projectile.type !== 'bubble' || hitVictims.has(victim)))`. A soak therefore always coincides with an `evHit` that carries `soak`.

Kill credit is already `weaponKey = projectile.type`, which gives `'bubble'`. Knockback already bumps `impulseSeq`, clears `grounded` and `vault`, and gives `vy += max(0.8, dy/d + 0.35) * impulse`. Objectives (`victim.objective`) stay unshoved.

**`_chainDetonate` (1196-1208):**
```js
if (other.type === 'bubble' && source.type === 'bubble' && other.ownerId === source.ownerId) continue;
```
- Without this, a tap stream at 15 m (bubbles about 1.6 m apart; chain reach 0.8 × 2.2 = 1.76 m) would pop itself, and the Double-bubble twin would pop at the muzzle.
- Enemy blasts and rival bubbles still chain-pop bubbles.
- Bubbles still set off live grenades and limpets, including the owner's own. Popping a frag mid-air with your own bubble is an intended combo.

**`_scatter` bubble branch.** At the top, add `if (source.type === 'bubble') return this._foamParty(source, ctx);`. `_foamParty` creates `foam.count` children while `this.active.size < 192`:
```js
const a = i / count * 2π; const prof = bubbleProfile(0, true);
{ ...source, id: `u${this._nextId++}`, type: 'bubble', child: true, twin: false, stuck: false, mount: null,
  hit: null, directVictim: null, chained: false,
  x: source.x, y: source.y + 0.1, z: source.z,
  vx: cos(a) * foam.speed, vy: foam.up, vz: sin(a) * foam.speed,
  drag: prof.drag, rise: prof.rise, radius: prof.radius, charge: 0,
  launchedAt: now, explodeAt: now + foam.lifetimeMs + i * foam.stepMs,
  blastRules: bubbleBlastRules(prof) }
```
It pushes a launch event with `{ chaos, child: true, charge: 0 }`. Children never cling, scatter, twin or chain same-owner bubbles, so there is no runaway.

**`popBubblesOnRay(shooter, origin, d, t0, t1, pad, ctx)` (new, about 15 LOC):**
- Loop over `this.active` for `type === 'bubble'` with `explodeAt > ctx.now`, where `owner === shooter || ctx.canDamage(shooter, owner)`.
- Ray-sphere test: `t = dot(c - origin, d)`, clamped to `[t0, t1]`. The bubble is hit when `|c - (origin + d t)| <= radius + pad`.
- On a hit, set `explodeAt = ctx.now` and `chained = true`.
- Return the count.

**Performance.** The worst case per owner is 16 bubbles, up to 8 of them clung, plus 5 children per pop (10 per pull with the chaos-1 twin). Everything stays under the room cap of 192, which is checked in `launchBubble` and `_scatter`. Add a bubble case to `tools/projectile-server-performance-test.mjs`: 12 owners, chaos 3, 5 pulls per second for 10 s. Assert that the tick p99 stays within the existing budget.

### 4.4 `server/sim/chaos-combat.js`

No change.

### 4.5 Bots: `server/bots.js` (dirty file: four hunks)

1. **Import** `bubbleFlight` and `bubbleProfile` from `'../shared/bubble-rules.js'`, and add `const BUBBLE_SLOT = WEAPON_IDS.indexOf('bubble');` next to `GLAIVE_SLOT` (68). Add the constants `BUBBLE_MAX_RANGE = 16` (prefer 2-14 m) and `BUBBLE_SWAP_CD_MS = 2500`.
2. **Aim (745-752).** Next to the glaive lead:
   ```js
   const bubble = p.def.projectile === 'bubble';
   const bubbleFlat = bubble ? Math.hypot(aimX - p.x, aimZ - p.z) : 0;
   const flight = bubble ? bubbleFlight(bubbleProfile(br.bubbleBig ? 1 : 0), bubbleFlat) : null;
   const lead = glaive ? … : flight ? (flight.t > 0 ? projectileLead(enemy, bubbleFlat, bubbleFlat / flight.t, br.skill) : [0, 0]) : …;
   const aim = [aimX + lead[0], aimY - (flight ? (flight.rise - BUBBLE_RULES.muzzleDrop) * br.skill : 0), aimZ + lead[1]];
   ```
   Low-skill bots under-compensate, so their bubbles drift over your head: readable, not frustrating.
3. **Range (after the glaive block, ~808-820).**
   - If `bubble && (!flight || aimDistance > BUBBLE_MAX_RANGE)`, set `canShoot = false`.
   - If also `aimDistance > BUBBLE_MAX_RANGE + 2` and the bot owns a loaded `DEFAULT_WEAPON_SLOT`, switch to it with `br.bubbleSwapAt = now + BUBBLE_SWAP_CD_MS`.
   - Mirror the glaive swap-back block (852-858). Draw the bubble again when `preferredSlot === BUBBLE_SLOT`, it is seated, and the target is within 12 m.
   - Gun game, where the bot owns only the bubble, still fires whenever `flight !== null`.
4. **Trigger (834).** Put this before the generic `mode === 'charge'` branch:
   ```js
   if (p.def.projectile === 'bubble') {
     if (!p.charging && !p.triggerPrev) br.bubbleBig = this.wantsBigBubble(p, enemy, aimDistance);
     const holdMs = br.bubbleBig ? 0.95 * p.def.charge.ms : 0;
     inp.wantFire = p.charging ? p.chargeT < holdMs : !p.triggerPrev;   // holdMs 0 → press one tick, release the next
   } else if (p.def.mode === 'charge') { …existing… }
   ```
   `wantsBigBubble` (new, about 10 LOC) returns true when the target is within 12 m and either of these holds:
   - at least one other damageable enemy stands within 3.5 m of the target;
   - the target is holding interact in S&D.

   A Big-Bubble direct hit lifts about 2.2 m. That exceeds `insideSite`'s `|y − site.y| ≤ 1.5` (`server/modes/snd/objective.js:31-36`), so the plant or defuse clears and restarts.
5. **Not done by bots:** bubble-jumping, shooting bubbles, deliberate cling mines, or dodging. `BUY_PRIORITY` is unchanged, so `tools/bot-mode-smoke.mjs:24` needs no re-pin. In Fun mode, bots rotate owned slots.

---

## 5. Client integration

### 5.1 Local soak prediction (this removes the rubber-band)

- **`public/js/combat/feedback.js`:** in the `'hit'` case (221), when `ev.victim === myId && ev.soak > 0`, call `this.localPlayer?.soak?.(ev.soak)` and `this.hud?.soak?.(ev.soak)`.
- **`public/js/player/local-player.js`:**
  - add `soak(ms) { this.soakUntil = Math.max(this.soakUntil || 0, performance.now() + ms); }`;
  - in `_stepPrediction` (≈725), pass `moveSpeedFor(this.keys, this.wantAds) * (performance.now() < (this.soakUntil || 0) ? BUBBLE_RULES.soakSpeedMult : 1)`;
  - reset `soakUntil` on respawn.

### 5.2 `public/js/guns/weapon-state.js`

- Pass the weapon id to charge audio: `this._audio.weaponCharge?.(charge, true, weaponId)` at 681 and 689. The cancel calls stay `(0, false)` and stop every loop.
- `rig.setCharge(charge)` is already called. The viewmodel forwards it to the bubble presentation (§8.3).
- `rig.setBubble?.({ mag, magSize })` is called once per frame from the authoritative ammo, next to the existing HUD sync. It sets the suds level.

### 5.3 `public/js/weapons/projectiles.js` (dirty file)

- `launch()` whitelist (541): add `|| event.type === 'bubble'`.
- `fallbackFuse` (548): `type === 'bubble' ? bubbleProfile(Number(event.charge) || 0, !!event.child).lifetimeMs`.
- After the projectile record is created, or on adoption, set `drag`, `rise` and `radius` from `bubbleProfile(event.charge, event.child)`. Also set `wobblePhase = random` (a visual only, so `Math.random` is fine on the client) and `chargeMix`.
- Adoption guard (564): `if (fromSelf && !event.child && !event.twin && this._adoptLocal(...))`. On adopting a bubble, re-derive the profile from the authoritative `event.charge`, keeping the current position.
- `update()`: before the final `else if (!projectile.stuck) stepGrenade(...)` (1055), add
  `else if (projectile.type === 'bubble') { if (!projectile.stuck) stepBubble(projectile, step, this.raycast); this._poseBubble(projectile, step); if (projectile.hit && !projectile.local && !projectile.chaos) projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25); }`
- `_buildVisual('bubble')` and `_poseBubble` are described in §9.1. Add a `BLAST_STYLE.bubble` entry (§9.2).
- `_updateLights`: add a pop flash only (0x9fe9ff, intensity 0.6, 80 ms). There is no per-bubble light.

### 5.4 `public/js/weapons/effects.js` (clean)

- **Local prediction** next to the rocket branch (111):
  ```js
  } else if (options.local && definition?.projectile === 'bubble' && Array.isArray(event.o)) {
    const l = bubbleLaunch({ x: event.o[0], y: event.o[1], z: event.o[2], dir: direction, charge01: Number(event.charge) || 0 });
    this.projectiles.launch({ type: 'bubble', o: [l.x, l.y, l.z], v: [l.vx, l.vy, l.vz], charge: l.charge }, { local: true });
  }
  ```
  The origin matches the server's. The local `event.o` is the camera eye (`weapon-state.js:751`), and `bubbleLaunch` applies the 0.55/−0.16 offsets itself, the same convention as the rocket. Also pass `raycast: this.projectiles.raycast`, so the point-blank wall clamp matches the server.
- `BLAST_PARTICLES.bubble` and a `projectileExplode` bubble branch are described in §9.2.

### 5.5 Audio

- **`sfx.js`:**
  - `weaponCharge(level, active, weaponId)` routes `'bubble'` to a separate `bubbleChargeLoop` (§10), and `!active` stops both loops;
  - `explosion()` gets an early-return `'bubble'` branch before the frag sample path (1170).
- **`reports.js`:**
  - add `shotBubble(out, primitives, charge)`;
  - route it with `else if (key === 'bubble')` in `renderFireReport`;
  - add `FIRE_REPORT_PROFILES.bubble = { lifetime: 0.4, sampleGain: 0.9, sampleRate: 1.06, layerGain: 0.3 }`.
- **`mechanics.js`:** `WEP_TONE.bubble = 1.35`, `DRAW_LEN.bubble = 0.12`.

---

## 6. Chaos ladder: `CHAOS_UPGRADES.bubble` (prices 300/600/900, cumulative)

```js
bubble: ladder(['Double bubble', 'Every trigger pull blows a free second bubble off to the side.'],
               ['Clingfilm', 'Bubbles that touch a wall or ceiling stick for 5 seconds as proximity mines.'],
               ['Foam party', 'Every pop scatters five mini bubbles.']),
```

Place it after `glaive` (chaos.js:19). The ladder total goes from 54 to 57, so update `tools/chaos-test.mjs:22` and the log string at `:148`. In `README.md:33`, "54 cumulative upgrades" becomes 57.

| Tier | Exact server behaviour | Where |
|---|---|---|
| 1 Double bubble | Each accepted pull calls `launchBubble` twice. The twin uses the same charge, a yaw offset of ±0.14 rad (alternating on `shotSeq`) and `twin: true`. It uses no ammo and counts toward the 16-bubble owner cap. Its launch event carries `twin: 1`, so the client never adopts it as the local prediction. At 5 m the twin lands about 0.7 m off the chest, which is splash, not a direct hit. | `launchBubble` |
| 2 Clingfilm | A terrain contact whose face is not a floor (`hit.ny <= 0.5`), on a non-child bubble, sticks instead of popping. It stays for 5 s, with at most 8 stuck per owner. It pops when the mount voxel is AIR, when an enemy body comes within `lerp(1.4, 2.2, mix)` m with line of sight, when shot, or at the fuse. Floor hits still pop, which keeps bubble jumps. | `_flyBubble`, `_clingBubble`, `_stepClungBubble` |
| 3 Foam party | The `explode()` of a non-child bubble scatters 5 children: radius 0.18, 6 m/s radial plus 1.5 m/s up, drag 1.2, rise 3, life `900 + i·60` ms, 11.2 effective direct damage, 2.0 m splash, knockback 2.5 and a 500 ms soak. Children never scatter or cling. | `explode` count line, `_foamParty` |

---

## 7. Movement tech (self-knockback, selfDamage 0)

The formula is `vy += max(0.8, dy/d + 0.35) · selfKB · (1 − d/R)^0.65`, with gravity 24 and a plain jump of 8.2 m/s (apex 1.4 m).

| Action | Pop to chest | Δvy | Apex |
|---|---|---:|---:|
| Soap Shot at the feet | about 0.9 m | +2.0 | +0.08 m (nothing) |
| Soap Shot at jump takeoff | about 1.0 m | +2.0 | about 2.1 m (+0.7 over a jump) |
| Big Bubble at the feet, standing | 0.45-1.0 m | +8.9 to +10.1 | 1.65-2.1 m: a 2-block ledge with a mantle |
| Big Bubble at jump takeoff | about 0.8 m | +9.5 on top of about 7.4 | **about 6 m**: rooftops and the Chum Bucket deck without stairs |
| Walking or jumping into your own floating Big Bubble (a direct hit after the 220 ms grace) | 0 | +6.4 to +10.8 | soap trampoline |
| Big Bubble direct hit on an enemy | 0 | +10.4 up, 13 m/s outward | about 2.2 m up, about 4 m displacement: ledge and Goo Lagoon shoves, plant and defuse resets |

The cost is a 0.9 s visible charge plus a round. Casual players lose nothing, because tap-hopping adds only 0.7 m.

---

## 8. Viewmodel: new `public/js/guns/models/bubble.js` (procedural kit only)

### 8.1 Anchors (`public/js/guns/models/common.js` and `defs.js`; both files must agree)

| Constant | Value | Notes |
|---|---|---|
| `T.muzzle` | `[0, 0.030, -0.540]` | nozzle bell lip = wand ring centre |
| `BREACH_Z.bubble` | `-0.30` | nozzle tube start, so barrelLen 0.24 |
| `BARREL_R.bubble` | `0.0235` | nozzle r 0.022 plus clearance |
| `BOLT_HOME.bubble` | `0.045` | plunger rod under the bulb |
| `TRIGGER_Z.bubble` | `-0.035` | |
| `SIGHT_HEIGHT.bubble` | `0.140` | spatula notch plus ring-post front sight |
| `GLOW_ACCENT.bubble` | `0x9fe9ff` | `kit.js:15`, a one-key edit in a dirty file |

`assemble.js`:
- import `build as buildBubble`;
- add `MODELS.bubble`;
- bolt-cap exclusion at line 110: `id !== 'revolver' && id !== 'glaive' && id !== 'bubble'`, because the plunger sits outside any receiver.

```js
TIMERS.bubble = {
  // SB-1 SUDSBLASTER: the "barrel" is the teal nozzle; the "bolt" is the bulb plunger; the
  // "mag" is the screw-in soap tank. Fire/charge/idle choreography lives in bubble-presentation.js.
  tbase: -0.01, rof: WEAPONS.bubble.rpm, adsTime: WEAPONS.bubble.adsTime,
  deployTime: WEAPONS.bubble.deployTime, weightKg: WEAPONS.bubble.weightKg,
  viewKick: { pitchDeg: WEAPONS.bubble.recoil.pitch, yawDeg: WEAPONS.bubble.recoil.yaw },
  bursts: [[0]], anglesRad: [-0.0014], interval: 0, clip: 999,
  muzzle: [0, 0.030, -0.540], portY: 0.09, ejectRight: 0,
  barrelLen: 0.24, heatLen: [0.80, 1.0],     // fx sleeve = cyan sheen on the bell on fire
  boltTravel: 0.008, rechargeDur: 0.06, pumpMag: 0, cycleBack: false, cycleKind: null,
  ejectOnFire: false,                        // soap, no brass
  magTimeline: { start: 0.16, home: 0.80, clickAt: 0.90, type: 'mag' },
  adsOffset: { x: 0, y: -0.140, z: -0.42 },
  kick: { stiffness: 150, damping: 14, yawWobble: 0.55 },   // soft, wobbly spring
};
```

`public/js/guns/actions.js` `RELOAD_STYLES`:
```js
bubble: { pose: [0.050, 0.30, -0.060, 0.030, 0.18, -0.46], exit: [-0.30, -1.10, 0.30],
          entry: [-0.24, -1.05, 0.26], twist: [0.10, 0, 0.45], socket: [-0.10, 0.02, -0.17] },
```

### 8.2 Palette (local `P` in `bubble.js`) and the soap-film material

| Name | Hex | Surface |
|---|---|---|
| yellow | `0xffe07a` | toy plastic, rg .55, mt .05 |
| yellowShade | `0xf2c65a` | |
| teal | `0x5fd3c6` | |
| tealDark | `0x3fb3a6` | |
| coral | `0xff8fa8` | rubber, rg .92, mt 0 |
| bubblegum | `0xf07aa5` | |
| lilac | `0xb9a4ff` | rg .4 |
| cream | `0xfff4d6` | |
| pole | `0xd9b77a` | rg .8, mt 0 |
| poleNode | `0xb08a4e` | |
| soap | `0xff9fd6` | opaque liquid, rg .3 |
| steel | `0xc9d2da` | rg .35, mt .75 |
| spatHandle | `0x9c3f35` | |
| brass | `COL.brass` | |
| porthole | `0x1d4f5a` | rg .2 |

**New `public/js/guns/soap-film.js`** (instead of the dirty `kit.js`). It exports `makeSoapFilm({ alpha = 0.55, phase = 0 })`, which returns `{ material, uniforms: { uT, uAlpha, uThin } }`.
- Material settings: a `THREE.ShaderMaterial` with `transparent: true`, `depthWrite: false`, `side: DoubleSide` and `toneMapped: false`, and `userData.soapFilm = true`.
- Cosmetic skins and the HUD rasterizer skip `soapFilm` and transparent materials. ShaderMaterial is already used in rigs (`kit.js:310` makeFx).
- The vertex shader outputs `vUv`, a view-space normal `vN` and the view vector `vV`.

```glsl
float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);              // fresnel
float band = f * 1.7 + vUv.y * 0.6 + uT * 0.18 + uThin;
vec3 irid = 0.5 + 0.5 * cos(6.2831 * (band + vec3(0.0, 0.33, 0.67)));           // thin-film hue cycle
float swirl = 0.5 + 0.5 * sin(vUv.x * 18.0 + uT * 3.0 + sin(vUv.y * 11.0 - uT * 2.0));
vec3 col = mix(vec3(0.92, 0.98, 1.0), irid, 0.45 + 0.35 * f) + 0.08 * swirl;
gl_FragColor = vec4(col, uAlpha * (0.12 + 0.75 * f + 0.10 * swirl));
```

The world projectile imports the same module (§9.1), so the viewmodel film and the flying bubble match.

### 8.3 Part list (gun-local metres, −z forward)

`cylZ` puts `rTop` at the rear (+z) after `rotateX`. The ADS ray runs along x = 0, y = 0.140, and only sight parts reach y ≥ 0.124. The film and the charge sphere are transparent, so they pass the opaque-only centre-ray contract.

**`groups.body`: receiver and nozzle**

| # | Part | Kit call / primitive | Size | Position | Colour |
|---|---|---|---|---|---|
| 1 | Receiver shell | `cylZ(body, .046, .26, 0, .030, -.05, yellow, {seg:14})` | | z −.18…+.08 | yellow |
| 2 | Rear dome | `SphereGeometry(.046,14,8,0,2π,0,π/2)`, rx +π/2 (dome toward +z) | | (0, .030, .08) | yellow |
| 3 | Front shoulder | `cylZ(body, .035, .12, 0, .030, -.24, yellowShade, {rTop:.046, rBot:.024})` | | | yellowShade |
| 4 | Racing stripes ×2 | `box(body, .008, .004, .22, ±.020, .0755, -.05, cream)` | | | cream |
| 5 | Portholes ×2 (left flank) | `TorusGeometry(.011,.0028,6,16)` ry π/2 plus a `CircleGeometry(.009)` | | (−.047, .035, .030 / .065) | brass / porthole |
| 6 | Seam rivets ×6 | Sphere r .0035 | | (−.046, −.006, z −.14…+.06) | brass |
| 7 | Nozzle tube | `cylZ(body, .022, .215, 0, .030, -.4075, teal, {seg:12})` | | z −.30…−.515 | teal |
| 8 | Nozzle ribs ×3 | `cylZ(body, .0245, .006, 0, .030, z, cream)` | | z −.33 / −.36 / −.39 | cream |
| 9 | Flared bell | `cylZ(body, .028, .025, 0, .030, -.5275, teal, {rTop:.024, rBot:.032})` | | the tip lands on the muzzle | teal |
| 10 | Bell lip | `TorusGeometry(.032,.004,6,24)` | | (0, .030, −.540) | cream |
| 11 | **Wand ring** | `TorusGeometry(.056,.0075,8,32)` facing −z | | (0, .030, −.540) | lilac |
| 12 | Wand spokes ×4 | `box(.004,.024,.004)`, rz = a + π/2 | | a = 45°, 135°, 225°, 315° at r .044 | lilac |
| 13 | Net sock rim | `TorusGeometry(.034,.003)` | | z −.47 | cream |
| 14 | Net strands ×8 | `box(.0025,.0025,.14)`, each in a Group with rz = i·π/4 and a tilt rx .078 | | (0, .0285, −.40) local | cream |
| 15 | Net cross rings | `TorusGeometry(.0305/.027, .002)` | | z −.43 / −.37 | cream |
| 16 | Bamboo foregrip | `cylZ(body, .016, .17, 0, -.030, -.345, pole, {seg:8, rg:.8, mt:0})` | | | pole |
| 17 | Bamboo nodes ×3 | `cylZ(body, .018, .008, 0, -.030, z, poleNode)` | | z −.29 / −.345 / −.40 | poleNode |
| 18 | Pole hangers ×2 | `box(body, .012, .022, .012, 0, -.003, z, tealDark)` | | z −.28 / −.41 | tealDark |
| 19 | Air line (bulb to nozzle) | `TubeGeometry(CatmullRom[(.018,.086,.05),(.022,.082,-.10),(.020,.062,-.25),(.010,.050,-.30)], 24, .004)` | | | clear glass (opacity .35); keep the curve as `beadCurve` |
| 20 | Soap feed hose | `TubeGeometry(CatmullRom[(-.088,-.020,-.165),(-.070,-.035,-.23),(-.030,-.010,-.285),(-.012,.018,-.30)], 20, .006)` | | | tealDark |
| 21 | Tank cradle clamp | `box(body, .046, .010, .050, -.066, -.015, -.165, lilac)` | | | lilac |
| 22 | Pistol grip | `box(body, .036, .100, .046, 0, -.058, .012, bubblegum, {rx:-.22})` | | | bubblegum |
| 23 | Finger grooves ×4 | `box(.040,.006,.048)` | | y −.03…−.09 | coral |
| 24 | Bubble pommel | Sphere r .022 | | (0, −.112, .024) | lilac |
| 25 | Trigger guard | `TorusGeometry(.024,.004,6,16,π)`, hanging in the YZ plane | | (0, −.012, −.030) | cream |
| 26 | Spatula stock | handle `box(.022,.022,.10)` at (0, −.005, .14), rx .18; blade `box(.008,.075,.10)` at (0, −.02, .23) with 3 dark slot boxes and 2 brass rivets | | | spatHandle / steel |

**`groups.body`: sights** (set `body.userData.sightHeight = SIGHT_HEIGHT.bubble` after building)

| # | Part | Size | Position | Colour |
|---|---|---|---|---|
| 27 | Rear post (spatula handle) plus a brass rivet at y .088 | `box .010×.028×.008` | (0, .090, .020) | spatHandle |
| 28 | Spatula blade ears ×2 | `box .019×.036×.004` | (±.0155, .122, .020); tops at .140, so the notch gap is .012 | steel |
| 29 | Blade bridge | `box .050×.006×.004` | (0, .107, .020) | steel |
| 30 | Spatula slots | `box .0025×.020×.005` | (±.0155, .122, .0205) | `COL.polyDark` |
| 31 | Front post | `box .006×.0712×.006` | (0, .0876, −.36) | lilac |
| 32 | Front blade | `box .006×.0168×.010` | (0, .1316, −.36); top at .140 | coral |
| 33 | Front ring aperture | `TorusGeometry(.014,.0028,6,20)` | (0, .140, −.36); the ray passes through the hole | lilac |

**`groups.mag`: soap tank** (`bubble_tank`, pivot at (−.088, .040, −.165), on the camera-facing left flank)
- **Glass:** `CylinderGeometry(.040,.040,.120,20,1,true)`, MeshStandard `0xe6fbff`, transparent, opacity .28, rg .08, `depthWrite: false`. It is cached per rig and disposed with the rig.
- **Base collar:** cyl r .043, h .014 at y −.053 (yellow), plus a brass nipple r .007, h .012 at y −.066.
- **Cap:** cyl r .042, h .022 at y .071 (lilac), with 12 grip ridges `box(.004,.020,.004)` around r .042, and a coral flip-top `box(.012,.016,.012)` at y .090.
- **Label:** an open partial cylinder r .0405, h .036, thetaLength 1.6, facing −x (cream), with a 5-point `ShapeGeometry` star (r .012, soap pink).
- **`bubble_suds`:** a Group at y −.046. It holds a liquid cyl r .035, h .104 at y .052, soap pink and **opaque**, so the HUD icon shows a pink column. `scale.y` is the level.
- **`bubble_foam`:** a cream disc (cyl r .036, h .008) plus 5 foam spheres (r .006-.010) riding the liquid top.
- **`bubble_tankfizz`:** 5 white spheres (r .003-.006, transparent .7) that rise inside the liquid.

**`groups.bolt`:** `bubble_plunger`, `cylZ(bolt, .006, .03, 0, .080, .045, steel)`. It jerks back 8 mm on fire.

**`groups.trigger`:** a coral `box(.008,.026,.010)` at (0, −.022, −.035), rx −.25, plus a 6 mm sphere tip (the squeeze-bulb trigger).

**`groups.extra`:**
- **`bubble_bulb`:** a pivot at (0, .074, .070). It holds a coral Sphere r .028, scaled (1, .9, 1.3), at y .025 (top at .124), plus a bubblegum neck (cyl r .012, h .012) at y .004.
- **`bubble_film`:** `CircleGeometry(.0485, 24)` at (0, .030, −.541), using `makeSoapFilm({alpha:.55})`.
- **`bubble_bulge`:** a hemisphere `SphereGeometry(.0485,20,10,0,2π,0,π/2)` with rx −π/2 (the dome faces −z) and `scale.z` .001, using the film material.
- **`bubble_charge`:** a film sphere r 1, hidden, driven by `setCharge` (§8.4).
- **`bubble_handoff`:** a film Sphere r .045 (phase .5), hidden. It hides the jump to the world bubble.
- **`bubble_airbead`:** a white Sphere r .005 that runs along `beadCurve`.
- **`bubble_idle` ×3:** film Spheres r .012, hidden (idle drift bubbles).
- `extra.userData.bubble = { bulb, film, bulge, charge, handoff, bead, beadCurve, suds, foam, fizz, tank, idle, filmMats }`.

### 8.4 `public/js/guns/bubble-presentation.js` (new, modelled on glaive-presentation)

**API:**
- `reset(mag, magSize)`, `setMag(mag, magSize)` and `setCharge(c01)`;
- `fire(charge01)`, `dryFire()` and `prime()`;
- `update(dt, { speed01, leanX, adsT })`;
- `bubblePresentationFor(model)`.

**Viewmodel wiring (`viewmodel.js`, dirty):**
- `this._bubble` is created when `setWeapon('bubble')`;
- `setCharge(t)` also calls `this._bubble?.setCharge(t)`;
- in `fire`: `if (this._glaive) … else if (this._bubble) this._bubble.fire(chargeT); else this.revealFlash();`. Keep only `startJerk`; skip the rifle bolt-clack enqueues;
- `onReloadClick(3)` calls `prime()`.

**Charge (Big Bubble):**
- `bubble_charge` becomes visible at c > 0.05. Its radius is `0.02 + 0.14·c²`, centred at `z = −.540 − radius`, so it grows forward off the ring.
- Wobble ±6% at 7 Hz. `uThin` drifts from pink to cyan to gold.
- Above 90% charge, add a tremble (×3 wobble, a 40 Hz jitter of 1.5 mm): the "about to let go" tell.
- The bulb squeezes progressively (scale.y 1 → .7).
- Release hands off to a large `bubble_handoff`.

**Fire (the sequence fits the 200 ms cycle):**

| Time | Event |
|---|---|
| 0–30 ms | The bulb squashes to (1.16, .62, 1.16) |
| 30–170 ms | The bulb springs back with a 1.06 overshoot |
| 0–60 ms | The air bead runs from the bulb to the nozzle |
| 0–45 ms | The film bulges (`bulge.scale.z` .001 → 1, `uThin` +.6) and wobbles ±8% at 40 Hz |
| 45 ms | Release: the film snaps to 0, and the handoff sphere travels −z 0.25 m in 80 ms while it grows from .045 to .06 and fades |
| 60–190 ms | The film regrows with an ease-out-back and a shimmer spike |

- **Suds level:** the target is `0.12 + 0.88·mag/magSize` (the authoritative mag), followed by a critically damped spring. Each shot adds a slosh (foam rot.z ±0.18, 6 Hz decay) and a fizz surge.
- **No muzzle flash.** `onMuzzleFlash` spawns 6 spritz droplets instead: `spawnParticles(n=6, 0xe6f9ff, {speed:1.2, gravity:6, size:.6, life:.3})`.

**Dry fire:** the bulb squashes, the film forms to 30%, wobbles and pops, and a "pfft" plays.

**Idle:**
- the film breathes (0.97-1.03 at 0.8 Hz);
- fizz rises in the tank;
- the liquid tilts with `−leanX·3` (clamped to ±.25);
- every 3-6 s an idle bubble r .012 detaches from the ring top, rises 0.12 m and fades over 1.2 s;
- while sprinting (speed01 > .8): film wobble ×3, and a world micro-bubble every 0.4 s;
- while in ADS: film alpha drops to .35.

**Deploy (0.36 s):** the wand dips (extra rot.x −.5 → 0), then the film forms from 0 to 1 with a draw-shimmer cue.

**Reload (2.2 s; start .16, home .80, click .90):**
1. The gun rolls right to show the tank.
2. The tank unscrews 1.5 turns about its Y axis, with a "squeak-squeak-SHLUP" cue.
3. It drops out lower left, and 3 pink drips fall.
4. The film deflates while there is no tank.
5. A fresh, full tank screws in 1 turn, with a "thunk-glug" cue.
6. At `prime()`, the bulb double-pumps, 3 gulp beads run along the feed hose, and the film re-forms with a bright flash ("squeak-squeak-bloop").

**Third person:** automatic through `buildGun` plus `HANDS.bubble`. The same presentation drives remote avatars: `fire()` on shoot events, with suds estimated from shots since the last reload (cosmetic only).

---

## 9. World projectile and pop

### 9.1 Flying bubble (`public/js/weapons/projectiles.js` `_buildVisual('bubble')` and `_poseBubble`)

- **Shell:** `SphereGeometry(1, 20, 14)` scaled to the physics radius, using the `makeSoapFilm` material at alpha .85. Four phase-shifted materials are shared round-robin, with no per-bubble clone. It spins at `rotation.y += .8·dt`.
- **Inner body:** the same geometry at 0.96 scale with a MeshBasic `0xdff8ff`, opacity .12, `depthWrite: false`.
- **Shine:** a billboard group that copies the camera quaternion, pushed `radius·0.97` toward the camera. It holds two white circles: r .25R scaled (1, .6) at (−.37R, .45R), and r .1R at (−.55R, .2R). MeshBasic, opacity .85, `depthWrite: false`. This is the cartoon window glint.
- **Inflate:** scale .35 → 1 over the first 90 ms.
- **Wobble:**
  - `sx = 1 + A·sin(ω t + φ)`, `sy = 1 − A·sin(ω t + φ)`, `sz = 1 + .7A·sin(1.3ω t + φ + 1)`;
  - ω = 11 for a Soap Shot and 4·2π/7 for a Big Bubble;
  - A decays from .12 to .04 by 0.4 s.
- **Trail:** within 30 m of the camera, emit `impacts.spawnParticles(x,y,z, n, 0xdff8ff, {speed:.4, gravity:-2.5, size:1.1, life:.8, softness:true})`, with n = 1 every 60 ms for small bubbles and n = 3 every 40 ms for big ones. Negative gravity is supported (`impacts.js:369`).
- **Fuse tell:** in the last 250 ms the opacity flickers (1 ↔ .6 at 20 Hz) and `uThin` rises by .8.
- **Clung (chaos 2):** the bubble flattens 15% along its mount normal and pulses slowly (0.8 Hz).
- **Optional (P2): team rim.** In team modes, tint the fresnel toward cyan for alpha and pink for bravo. In FFA, the owner sees a white rim.

### 9.2 Pop VFX (`effects.js` and `projectiles.js`)

- **`BLAST_STYLE.bubble`:** `{ color: 0xe8fbff, grow: 0.30, life: 0.16, wireframe: true, ring: true, ringColor: 0xffc6ec }`, a torn-skin flash. Scale it by `event.radius / 2.2`.
- **`BLAST_PARTICLES.bubble`:** `{ count: 12, tint: 0xe6f9ff, speed: 3.2, size: 0.8, life: 0.45, shake: 0.05, reach: 10 }`. In `projectileExplode`, use gravity 9 for the bubble, not the frag 15, and no dirt burst.
- **Extra foam puffs:** 6 × `{tint:0xffffff, speed:.8, gravity:-1.2, size:1.6, life:.9, softness:true}`. They float up off whatever was hit.
- **Cartoon pop lines:** 6 radial white additive `LineSegments`, billboarded, expanding from r .25-.45 to .5-.9 (times the radius scale) in 110 ms, then fading.
- **Big pops** (radius > 3): a pale-cyan splash decal that fades over 4 s (optional, P2).
- **Chaos-3 minis:** the same recipe at half scale.

---

## 10. Procedural audio (no sample needed for `npm test`)

**Fire, `shotBubble(out, pr, charge = 0)` in `reports.js`.** `r = pr.rnd(.94, 1.08)`, and `m = charge²`:
```js
const t0 = pr.nowT();
pr.tone(out, { t0, type: 'triangle', f0: 1900*r, f1: 2600*r, att: .002, dec: .035, g: .05 });                 // bulb squeak
pr.hiss(out, { t0, filter: 'bandpass', f: 900, sweepTo: 2600, sweepMs: .06, q: 1.6, att: .004, dec: .07 + .1*m, g: .22 }); // air push
pr.tone(out, { t0: t0+.03, type: 'sine', f0: (320 - 140*m)*r, f1: (900 - 380*m)*r, att: .004, dec: .075 + .065*m, g: .38 }); // bloop → bwomp
pr.tone(out, { t0: t0+.036, type: 'sine', f0: 640*r, f1: 1500*r, dec: .05, g: .12*(1-m) });                      // bloop partial
pr.hiss(out, { t0: t0+.05, filter: 'lowpass', f: 1400, sweepTo: 500, dec: .12 + .1*m, g: .10 });                // wet tail
if (m > .5) pr.tone(out, { t0, type: 'sine', f0: 140, f1: 90, dec: .09, g: .2 * m });                           // Big release thump
```

**Charge loop, `bubbleChargeLoop(level, active)` in `sfx.js`.** It is built like `ensureChargeLoop`:
- a band-passed noise source sweeping `600 + 1600·level` Hz (q 1.2);
- a sine at `220 + 420·level` Hz with a 6 Hz vibrato (depth `8 + 30·level` Hz);
- gain `(0.025 + 0.09·level)`;
- above 0.9, a 13 Hz tremolo "creak" (depth 0.25).

**Pop, the `sfx.explosion(pos, 'bubble', detail)` early-return branch.** It uses `pool.acquire({pos, priority: 1}, 0.35)`, `q = pr.rnd(.85, 1.2)` and `big = detail?.radius > 3`:
- sine `700q → 1900q` (att .001, dec .045, g .42): the pop;
- highpass hiss at 3000 Hz (att .0005, dec .025, g .35): the film tearing ("tss");
- sine `180 → 110` (dec .06, g .18): a tiny thump;
- bandpass hiss at 5200 Hz (q 2, t0 +.01, dec .14, g .06): the spritz;
- big pops also get a lowpass-900 splash (dec .2, g .25) and 3 droplet blips (sine 2-4 kHz, dec .03, 40 ms apart);
- children play at ×1.5 pitch and ×0.5 gain ("pip-pip-pip").

`feedback.js` must pass `{ radius: ev.radius }` as the detail. Check the existing call signature at the `projectileExplode` site (≈316).

**Reload cues (`onReloadClick`):**
1. Two triangle squeaks 1500 → 1900 Hz (dec .04, 80 ms apart), then a suction pop (sine 400 → 180, dec .05).
2. A thunk (sine 160 → 90, dec .08, g .3), then a glug (bandpass hiss at 500 Hz, stepping down twice).
3. Two bulb squeaks, then a soft bloop at g .2.

**Soaked local victim:** squishier footsteps (lowpass 900 plus a short wet hiss) while `soakUntil` is active. This is optional (P2).

**Sample slot (for `npm run audio:audit` only):**
- `tools/generate-bubble-audio.py` is a copy of `generate-glaive-audio.py` that renders the fire recipe × 4 pitch variants as **Ogg Opus**, because local ffmpeg has no libvorbis;
- it writes `public/assets/audio/weapons/bubble/fire.ogg` plus `sources.json` (original, procedural);
- add a `LICENSES.md` row (a dirty file; edit only that row);
- add the `samples.js` slot `'weapons.bubble.fire'` (a dirty file).

---

## 11. HUD and UI

**`public/js/ui/hud-support.js` (dirty):**
- `GLYPH.bubble = 'SB'`;
- `WEAPON_NAMES.bubble = 'SB-1 SUDSBLASTER'`;
- `WEAPON_CLASSES.bubble = 'BUBBLE LAUNCHER · TAP OR HOLD · FLOATS UP'`;
- `WEAPON_BUY_ORDER`: insert `'bubble'` after `'shotgun'`. This is **required**: the buy menu renders only the ids listed there.

**`public/style.css`:**
- `--w-bubble: #9fe9ff;`
- `.vb-w-bubble { --gun-tint: var(--w-bubble); }`
- `#ammo.vb-w-bubble #weaponname, #weaponname.vb-w-bubble { color: var(--w-bubble); }`

**Buy-menu stats:** generic. It shows `DMG 33.6 · 300 RPM · 12 RDS · 4 MAGS` (from `damage[0] = 42`).

**Charge meter:** automatic (`weapon-state.js:194` `charge01`).

**Rise ladder (P1, `gameplay-hud.js`, dirty):**
- While the bubble is equipped, draw 3 hollow 5 px circles **above** the crosshair, at `bubbleAimDrop(profile, d)` for d = 10, 12 and 15 m. Put the matching circle on the target's chest.
- Label them 10/12/15 at 9 px, at 55% opacity.
- The profile is `bubbleProfile(charge01)`. While charging, the ladder slides toward the Big-Bubble angles (8/10/12 m), and a mark disappears when `bubbleFlight` returns null.
- The angles come from `BUBBLE_RULES`, not hard-coded values. Convert them to pixels with the current FOV.

**Soaked vignette (P1):**
- `hud.soak(ms)` shows a `#soap-vignette` overlay: a pastel conic-gradient iridescent edge at opacity .35, with 6 CSS bubbles drifting up the screen edges;
- it lasts `ms` and fades out over the last 250 ms;
- the label is "SOAKED" (small, top centre, 1 s).

**Kill feed:** the HUD icon plus the class tint, generic.

**HUD icon:** run `node tools/render-hud-icon.mjs --weapon bubble` (never `--all`). The profile view is seen from −x, so the tank and portholes face the viewer. The glass and film are skipped automatically; the pink suds column, the bulb, the nozzle with its net, the edge-on wand, the spatula and the bamboo stay visible.

**AGENTS.md workflow (substantial UI):** generate 3 ImageGen alternatives each for the viewmodel look, the soak vignette and the rise ladder, based on current HUD screenshots.
- Save the references and prompts under `docs/design/sudsblaster/`.
- Record the icon prompt only under the `bubble` key of the dirty `public/assets/weapons/hud/imagegen-prompts.json`.
- Verify with muted CDP captures (`node tools/render-weapon-scenes.mjs`; the shots derive from `WEAPON_IDS`) at desktop and mobile sizes.
- No Chromium browser smoke, because it plays audio.
- Reference prompt: "Side-profile game HUD icon of an original toy-like bubble blaster: pastel yellow rounded body with brass portholes, translucent pink soap tank with star label, teal nozzle wrapped in cream netting ending in a lilac bubble-wand ring with iridescent soap film, coral rubber squeeze bulb on top, tiny spatula rear sight, bamboo foregrip; flat cel shading, soft outline, transparent background, 2:1."

---

## 12. Balance vs the roster (100 HP, no armor, standing target, perfect body)

Rifle and SMG figures come from `.artifacts/ttk/current/summary.md`. The bubble figures are hand-computed from the closed forms and a tap cycle of 13 ticks (0.217 s: a 0.2 s cooldown plus a 1-tick release). `npm run balance:simulate` must confirm them within ±1 tick.

| Weapon | 5 m | 10 m | 15 m | 30 m |
|---|---:|---:|---:|---:|
| **SB-1 Soap Shot, 3 direct** | **≈0.63 s** | **≈0.94 s** | **≈1.44 s** | **no reach** (18.6 m cap) |
| SB-1 Big Bubble then 2 taps | ≈1.5 s | ≈2.0 s | Big out of reach | none |
| VK-77 RAPTOR | 0.35 | 0.35 | 0.35 | 0.45 |
| HORNET SMG | 0.40 | 0.40 | 0.40 | 0.53 |
| IRONCLAD .44 | 0.40 | 0.40 | 0.40 | 0.40 |
| F-4 FIRESTORM / GV-4 RIPTIDE (body) | 1.13 / 1.58 | 1.35 / 1.73 | 1.70 / 1.87 | 3.48 / none |

**Reading:**
- It loses every 1v1 duel to hitscan: 1.8× the rifle at 5 m, 4× at 15 m, and nothing at 30 m. It has no headshots and cannot open walls.
- It pays that back in other ways:
  - forgiving hits: a 0.24 m hit sphere plus splash, so a 1 m miss still deals 11.3;
  - groups: a Big Bubble deals 56 direct, plus 22-31 to anyone within 1-2 m, and soaks them all for 1.8 s;
  - the ×0.6 soak stops strafe-outs;
  - ledge and Goo Lagoon shoves;
  - ceiling pops and stairwell rises onto targets it cannot see;
  - mobility.
- **Ammo economy:** 12 × 33.6 = 403 per tank, about 4 kills at best, and the reload takes 2.2 s.
- **Counterplay:**
  - stay beyond 16 m;
  - shotgun at close range;
  - shoot the bubbles: a pop 2.2 m or more away (4.2 m for a Big Bubble) is harmless;
  - frag, pulse and rocket blasts clear bubble fields;
  - fight from below;
  - kelp and glass block splash line of sight;
  - the bubbles themselves are the slowest, biggest, brightest projectile in the game.
- **Tuning knobs, in priority order:**
  1. `small.splashDamage`. The 3-tap needs `direct + splash ≥ 41.7`; below that it becomes a 4-tap at ≈0.85 s.
  2. `rpm` (300 → 330 gives ≈0.58 s).
  3. `small.speed` and `drag` (effective range).
  4. `big.knockback`.
  5. `big.selfKnockback` (roof access).
  6. `concussMs`.
- **Role assertions for `tools/weapon-balance-test.mjs`:**
  - `simulateFight({weapon:'bubble', distance:5}).shots === 3`;
  - `killMs` at 5 m is in [500, 750], and is `> ` the rifle's and the SMG's;
  - `killMs` at 15 m is ≤ 1600;
  - `killMs` at 30 m is `null` (no reach).

---

## 13. TTK simulation (`tools/lib/ttk-simulation.mjs`, clean)

- **Imports:** `bubbleLaunch` and `stepBubble` from `shared/bubble-rules.js`.
- **`ballisticPitch(id, distance, eyeHeight, targetHeight, charge01 = 0)`:**
  - for `id === 'bubble'`, launch with `bubbleLaunch({ …, charge01 })` and step with `stepBubble`;
  - bound the loop by `lifetimeMs / TICK_MS`, not 200 ticks;
  - extend the cache key with `charge01`.
- **Tap policy:** `const holdMs = chargeMs ?? (def.projectile === 'bubble' ? 0 : chargeProfile(def).holdMaxMs);`. The press comes from `fireEdgeQueued` and the release on the next tick. The default rows are therefore Soap-Shot TTK.
- **Aim rule (line 75):** `def.projectile && !def.glaive` already routes the bubble to `ballisticPitch`. Pass `Math.min(1, holdMs / def.charge.ms)` as `charge01`.
- **ctx:** `launchBubble: (p, dir, charge) => projectiles.launchBubble(p, ctx, dir, charge)`.
- **`tools/simulate-ttk.mjs`:** add a supplementary table "SB-1 Big Bubble (voll geladen)" with `chargeMs: 900` for the perfect scenarios (the pattern is at line 77, the lance loop).
- Update `docs/weapon-ttk.md`: line 3 "dreizehn" becomes "vierzehn", and add a SUDSBLASTER section with the tables from §2 and §12.

---

## 14. Test plan

### 14.1 New `tools/bubble-test.mjs` (template: `tools/glaive-test.mjs` harness; add `"weapons:bubble:test": "node tools/bubble-test.mjs"` and put it in the `test` chain next to `weapons:glaive:test`)

**Rules (pure):**
1. `WEAPON_IDS.indexOf('bubble') === 13`, `WEAPONS.bubble.mode === 'charge'` and `projectile === 'bubble'`.
2. `bubbleProfile(0)` deep-equals `small`, `bubbleProfile(1)` deep-equals `big`, and `bubbleProfile(0.5).mix === 0.25`.
3. **Exact integrator:** 132 steps of 1/60 s equal one 2.2 s step within 1e-9. A server step and a client step (both importing the same module) agree bit for bit over 120 steps.
4. **Rise:** a tap is higher than launch + 1.0 m at t = 1 s, and a level tap never descends (`vy` is non-decreasing).
5. **Reach:** `bubbleMaxRange(small)` is ≤ 18.6 and `bubbleMaxRange(big)` is ≤ 12.85. A `bubbleFlight(small, 30)` returns `null`.
6. `bubbleLaunch` with a wall 0.3 m ahead returns `blocked: true`, and its distance to the wall is ≥ the radius.
7. `BUBBLE_RULES.soakSpeedMult === CONCUSSED_SPEED_MULT` (the new export from `server/sim/movement.js`).

**Authority (`ProjectileSystem` plus `fireOneShot`/`resolveWeaponIntent`):**
8. A tap (press one tick, release the next) launches one `u*` bubble with `blastRules.directDamage === 16`. `evProjectileLaunch` carries `charge` and `chaos`.
9. **Direct Soap Shot** at 5 m: the victim takes 33.6, and 3 taps kill. Kill credit (`killPlayer` weapon) is `'bubble'`.
10. **Big Bubble** (hold 900 ms, then release) direct: 56 damage. The victim's `vy` is ≥ 10 after the hit, and `impulseSeq` increments.
11. **Splash** at 1.0 m from the chest: 11.3 ± 0.05 (small). Behind a voxel wall: 0.
12. **No terrain:** block HP is unchanged after 20 pops against a wall.
13. **Self:** the owner's HP is unchanged. A Big Bubble popped at the feet gives Δvy in [8.5, 10.5].
14. **Soak:** the victim's `concussedUntil ≈ now + 500` (small) / `+1800` (big). `evHit.soak` is present for the victim, absent for the owner, and absent when no damage was applied.
15. **Gun game:** in a `GunGamePolicy` or `grenadeDamage: false` ctx, bubble damage and knockback still apply.
16. **Owner chain:** a same-owner tap stream at 1.6 m spacing does not self-chain (each bubble reaches its own contact). An enemy frag popping within 1.76 m does chain-pop the bubble.
17. **Bullet pop:** an enemy rifle ray through a bubble sets `explodeAt = now` without stopping the ray, so the victim behind is still hit, and the pop credits the bubble owner. A teammate's ray (TDM ctx) does not pop the bubble. The owner's own ray does.
18. **Soap trampoline:** the owner walking into their own floating Big Bubble after 220 ms receives a direct self-knockback, with Δvy ≥ 6.4 and no damage. Before 220 ms, no contact.
19. **Cap:** the 17th live bubble of an owner sets the oldest one's `explodeAt = now`. At a room size of 192, a launch evicts the owner's oldest bubble. A launch with nothing to evict returns null, and the round is refunded (`mag` unchanged).
20. **Charge vent:** a hold of 1500 ms fires on its own at charge 1.

**Chaos:**
21. **L1:** one pull gives 2 launch events (the second with `twin: 1`), ammo −1, and yaw ±0.14.
22. **L2:**
    - a wall contact sticks (`evProjectileStick`, fuse 5000), while a floor contact pops;
    - an enemy at 1.3 m with line of sight pops it, while an enemy at 1.3 m behind glass does not;
    - removing the mount voxel pops it;
    - the 9th stuck bubble evicts the oldest.
23. **L3:** a non-child pop spawns exactly 5 `child:true` bubbles that fly with `stepBubble` (they rise) and do not scatter again. The direct child damage is 11.2.

**Bots:**
24. A bot with only the bubble at 10 m aims below the chest by `rise − 0.16` × skill. It never fires at 25 m. Its trigger alternates press and release for taps, and holds ≈855 ms when a second enemy stands within 3.5 m of the target.

### 14.2 Pins to update (exact)

| File:line | Change |
|---|---|
| `tools/smoke.mjs:151` | `expectedWeaponIds`: append `'bubble'` |
| `tools/smoke.mjs:152` | `expectedWeights`: append `2.6` |
| `tools/smoke.mjs:180` | tracer-null list: add `\|\| def.id === 'bubble'` |
| `tools/smoke.mjs:~188` | yawPattern uniqueness: passes automatically |
| `tools/atlastest.mjs:250` | gun-game `weaponOrder` (after `glaive`) |
| `tools/atlastest.mjs:288-302` | `expectedPrices.bubble = 2200` |
| `tools/chaos-test.mjs:22` and `:148` | 54 becomes 57 |
| `tools/contracts/weapon-wheel-contracts.mjs:55` | 13 becomes 14 |
| `tools/viewmodel-arms-test.mjs:124-125` (dirty) | add `'bubble'` |
| `tools/reload-animation-test.mjs:72` | add `'bubble'` (mag type) |
| `tools/bullet-flyby-test.mjs:81` | add `'bubble'` |
| `tools/weapon-balance-test.mjs` | role assertions from §12 |
| `tools/projectile-server-performance-test.mjs` | the bubble chaos-3 case (§4.3) |
| `package.json:55` | add `npm run weapons:bubble:test` to `test`, plus the script entry |
| `public/index.html` | only if a boot-graph module gains an import: `bubble-rules.js` is imported by `public/js/weapons/{projectiles,effects}.js`, `local-player.js` and `gameplay-hud.js`, so run `node tools/build-module-preload.mjs`, then `--check` (`static:test`) |

**Loops that pick up the id automatically but fail on missing data** (run them all):
- `weapon-handling-test`, `weapon-customization-test` (optics and grips exclusions);
- `viewmodel-contracts` (muzzle on the bell lip, the ADS centre ray, HANDS);
- `hitbox-model-test` (sightHeight 0.140 equals `SIGHT_HEIGHT`);
- `reload-state-test`, `audio-contracts` (profile bounds);
- `audio-mix-smoke`, `bot-mode-smoke:442`, `hud-contracts:1078`;
- `progression-tree-test`, `cosmetics-career-test`, `combat-balance-test`, `ttk-simulation-test`.

### 14.3 Run order

```sh
cd /Users/logge/Documents/Projects/voxel-blitz
node tools/bubble-test.mjs
for t in smoke chaos-test weapon-handling-test weapon-customization-test hitbox-model-test viewmodel-arms-test \
  reload-animation-test reload-state-test bullet-flyby-test projectile-server-performance-test weapon-balance-test \
  combat-balance-test ttk-simulation-test progression-tree-test cosmetics-career-test bot-mode-smoke glaive-test; do
  node tools/$t.mjs >/dev/null 2>&1 || echo "FAIL $t"; done
node tools/atlastest.mjs 2>&1 | grep -E 'FAIL|ALL OK'
node tools/build-module-preload.mjs && node tools/build-module-preload.mjs --check
npm run audio:test && npm run static:test && npm run balance:simulate
node tools/render-hud-icon.mjs --weapon bubble && node tools/render-weapon-scenes.mjs   # muted CDP only
npm test; echo EXIT=$?                                                                  # never pipe to tail
```

---

## 15. Docs

- **New `docs/weapon-design/bubble.md`** (pattern: `glaive.md`). Cover:
  - the fantasy;
  - the rules and flight table (§2);
  - damage and splash;
  - movement tech;
  - bullet pops;
  - the chaos ladder;
  - bot behaviour;
  - the TTK table;
  - the tuning knobs;
  - a note that it is original procedural work inspired by the show, with no copied assets.
- **`docs/weapon-ttk.md`:** "dreizehn" becomes "vierzehn", plus a SUDSBLASTER section. The file is dirty, so edit only those hunks.
- **`BUILD-CONTRACT.md` (dirty):**
  - 180 (buy union);
  - 364 (roster);
  - 367-380 (slot row ``13 `bubble` ``);
  - ~402-414 (a projectile paragraph: drag-to-rise, bullet pops, no terrain);
  - 864/869 ("thirteen");
  - ~875 (gun game);
  - ~895 (prices).
- **`docs/development.md` (dirty):** 74, 315 and 321 ("thirteen"); 377 (gun game); ~580 (table); 584 (rules file `shared/bubble-rules.js`); 592 (weights).
- **`README.md`:** 17 and 25 ("fourteen weapons" and the list); 33 (57 upgrades). **`package.json:6`:** the description count.
- **`docs/progression.md` and `docs/cosmetics.md`:** only if a mastery skin is added. That is optional, and not planned for v1.

---

## 16. Build phases and size

| Phase | Content | About LOC |
|---|---|---:|
| **P0 gameplay** | `bubble-rules.js`; WEAPONS and shared tables; combat.js (2 hunks); context.js; projectiles.js (launch, fly, cap, gates, owner-chain, bullet pop); soak event and client prediction; client projectile, effects and prediction; bots; TTK sim; pins; `bubble-test` | 520 |
| **P0 presentation** | model `bubble.js`, `soap-film.js`, TIMERS, anchors, RELOAD_STYLES, HANDS, `shotBubble` plus pop audio, HUD names, buy order, CSS, HUD icon | 380 |
| **P1 juice** | `bubble-presentation.js` (charge film, bulb, suds, reload beads), charge loop, rise ladder, soak vignette, pop lines, foam puffs | 350 |
| **P1 chaos** | twin, Clingfilm, Foam party, plus their tests | 140 |
| **P2 optional** | team rim; splash decal; a snapshot `ch` charge byte so third-person viewers see the Big Bubble grow (the lance gets the same tell); squishy soaked footsteps; the `fire.ogg` sample | 150 |

**Cheaper fallback v0.** If the charge path must be cut:
- use `mode: 'auto'` at 300 rpm with Soap Shots only;
- keep everything else (flight, soak, shove, bullet pop, owner-chain, chaos);
- movement shrinks to the tap hop (+0.7 m), and the roof routes and the S&D plant-reset are lost.

It saves the charge audio, the charge rig, the bot hold branch and the TTK charge rows, about 80 LOC. It is not recommended: the Big Bubble is what makes the weapon memorable.

**Alternative ship.** If the bubble is dropped entirely, build the JF-5 JELLYZAPPER as specified in the alt concept (hitscan with a sting chain in the new `server/sim/jelly-sting.js`, and 2 hook lines). The rest of this checklist is the same: ids, prices, wheel 14, chaos 57, HUD, model and pins.

---

## 17. Map hooks (for the Bikini Bottom map author)

- **Krusty Krab (site A):** a porch or awning and a low interior ceiling (y ≤ GROUND+4) give ceiling-pop pockets over defenders. Keep one 2-block ledge by the door, which a Big-Bubble hop can reach.
- **Chum Bucket deck (site B, top at GROUND+3):** a deck overhang above the stairs is a bubble-only angle. A jump plus a Big Bubble (about 6 m) reaches the deck rail without the stairs. Keep a rail gap so shoves off the deck are possible.
- **Pineapple:** a 2-floor interior with a floor opening or stairwell, which bubbles float up through.
- **Goo Lagoon (`MC_WATER`, 2 deep):** shove targets and swimming slow. Give the banks cover.
- **Treedome (GLASS) and Jellyfish Fields (kelp and leaves):** safe zones, because splash has no line of sight through solid voxels. Glass is never broken by pops, since terrain damage is 0.
- **Keep roofs at y ≥ GROUND+10**, or make them deliberately reachable (a bubble jump lands on about GROUND+6), so bot roam targets stay sane (`bots.js:106-107`).
