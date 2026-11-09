# KV-9 VANGUARD — Design Spec

**ID:** `vanguard` · **Name:** `KV-9 VANGUARD` · **Mode:** `semi` (no new mode, no new projectile)
**Class:** Semi-auto precision battle rifle (DMR). Mid-range zone holder + light-vehicle support.
**Kit slot:** Assault variant 1 (replaces `shotgun`). Shotgun survives on Engineer v1 + Pyro v1.
**Damage class:** `hmg` — light vehicles take full damage, aircraft 0.6, heavies scratched (0.03).

## Gap filled
Conquest has a dead zone 40–120 m: `rifle` falls to 12 dmg at 65 m, `sniper` is a 1.43 s bolt.
No primary threatens light vehicles or aircraft. VANGUARD is a 3-shot mid-range tap rifle
that carries its own anti-vehicle tax (0.45 s TTK close, 4-shot at 85 m).

## Stats (canonical `shared/combatmath.js`, applied HP ×0.8)
| Field | Value |
|---|---|
| rpm / mag / spare | 255 / 20 / 5 |
| damage close/far/end | [48, 36, 80], falloffStart 30 |
| head | ×2.0 → 2-head kill (153) |
| penetration | 260 (anti-materiel through cover) |
| spread hip/ads | 1.6° / 0.12° |
| bloom | 0.12° / max 1.2° / recover 5.0 |
| move / crouch | 1.8° / ×0.65 |
| recoil pitch/yaw | 1.15 / 0.42, pattern tight, reset 400 ms |
| ADS | FOV 48 / zoom 1.6× / 0.18 s — LPVO |
| reload / tac / deploy | 2.3 s / 1.8 s / 0.5 s |
| weight | 4.6 kg |
| tracer | `#9fd0ff`, width 1.4, len 34 |
| sfx | `rifle` (reused bank) |
| damageClass | `hmg` |

## Viewmodel feel (`public/js/guns/defs.js`, references only)
muzzle `[0, 0.041, -0.640]`, portY 0.145, barrelLen 0.44, heatLen `[0.45, 0.95]`,
boltTravel 0.09, rechargeDur 0.06, magTimeline mag (0.22/0.78/0.90),
adsOffset `{0, -0.150, -0.70}`, SIGHT_HEIGHT 0.150, kick `{200, 22, 0.8}`.
Hands copied from `rifle`, support on `body`.

## 3D model (Blender, REALISTIC — cylinders/lofts/tori, no boxes)
Author in gun axes, bake to Blender `(x, -game_z, game_y)`. Parts: `body, bolt, trigger, mag, optic`.
- **body:** lofted rounded receiver, free-float fluted barrel (cylinder + longitudinal grooves via bevel),
  octagonal-ish handguard (rounded octagon cylinder) with rail teeth, gas piston block + tube,
  suppressor + muzzle slots, QD cups, ejection port recess, forward assist cylinder, stock with
  cheek riser (rounded bevel), pistol grip (rounded), rail segments.
- **bolt:** bolt carrier + charging handle (T-shape), visible stroke 0.09 m.
- **mag:** curved 20-rd box magazine with ribs and baseplate — `mag` group.
- **optic:** LPVO cylinder 1.6×, objective + ocular bells, turrets, throw lever, two rings — `optic` group.
- Budget: ≤ 30k tris / ≤ 25 draws / > 60 % textured. Planar rest-space UV `scale=4`.
- Build script: `tools/blender/vanguard/build-vanguard.py`, exporter copied from thunderbolt
  (`tools/blender/thunderbolt/export-thunderbolt.py`), validator copied from `validate-torch.py`.

## Materials
New ImageGen albedo tiles (Codex `gpt-image-2.5-flare`, seamless 1024):
`docs/design/blender/textures/vanguard-graphite.png` (brushed gunmetal),
`docs/design/blender/textures/vanguard-polymer.png` (dark earth polymer).
Blender `material()` with tint multiply + bump from albedo + rough map-range (thunderbolt pattern).
Runtime delivery: 1024×1024 JPEG q84 in `public/assets/blender/textures/`.

## Integration (additive, append-only — see WeaponContract2 checklist)
`WEAPONS.vanguard` + `WEAPON_IDS` append (combatmath), handling profile, `TIMERS.vanguard` (defs tail),
`SIGHT_HEIGHT`, `HANDS.vanguard`, `models/vanguard.js` + blender model `models/vanguard-blender.js`,
4× `common.js` rows, assemble import/MODELS, conquest-contract Assault v1, hud-support rows,
`GLOW_ACCENT`, `tools/render-hud-icon.mjs --weapon vanguard`,
`public/js/engine/blender-assets.js` `ASSET_IDS` + `materials.json` assignment for new keys.
