# GV-4 RIPTIDE: design alternatives

The repo workflow asks for design alternatives before a substantial visual
change. No image generator is available in this toolset, so each alternative
below was generated as a real-geometry Blender blockout by
`concept-blockouts.py` (flat palette colours, coarse forms) and rendered to
`concept-{1..3}-*.png` (`concept-0-overview.png` shows all three). This is the
same fallback TORCH used. The prompt text is kept verbatim for each
alternative: it is the brief each blockout was built from, and the same text
would drive an image generator if one were used.

Shared frame for all three prompts:

> Forearm-braced disc launcher for a first-person shooter viewmodel, display
> name GV-4 RIPTIDE. It throws a toothed magenta-glowing sawblade disc that
> flies out and curves back to the hand; the player holds two discs and
> reloads by catching them. Overall length about 0.62 m from a rear brace cuff
> to the front catch horns, width 0.20 m, height 0.19 m. Warm industrial
> palette: ivory coating, orange paint, gunmetal, dark polymer, blade steel
> with polished teeth, a brass gauge, and a single magenta `#ff3fd0` emissive
> accent. A launch spindle (r 0.0155) runs along the bore axis to the muzzle at
> 0.40 m. A clear iron-sight line at 0.150 m: nothing but the sights may rise
> into it. The seated disc must be readable from the ADS eye point. Product
> render on a neutral studio backdrop, 3/4 front-right hero angle.

## Alternative 1: "FORK" (fork and spindle)

Prompt delta: *The disc lies flat on a forward launch spindle and rail,
tilted slightly toward the eye, its toothed edge and magenta razor rim fully
exposed. An orange fork bridge crosses in front of it and carries a ring
sight on a post; two orange catch horns hinge off the bridge and sweep
forward and outward like mandibles, with glowing magnetic prongs at their
tips. A gunmetal flywheel drum sits behind the disc over the grip, with the
rear notch post on top. A skeletal cassette under the receiver shows the
spare disc's teeth.*

Silhouette: open, forward-reaching jaw; the disc itself is the hero surface.

## Alternative 2: "DRUM" (drum magazine above the rail)

Prompt delta: *Stack the discs vertically in a gunmetal drum magazine that
rides above the receiver, its orange face towards the shooter, feeding discs
down onto a short spindle. A compact front post and a glowing muzzle collar
at the spindle tip.*

Silhouette: tall, top-heavy, reads as a conventional launcher with a drum.

## Alternative 3: "BRACER" (wrist bracer only)

Prompt delta: *No gun body: a ribbed dark-polymer forearm bracer with ivory
bands and a flat deck plate over the back of the hand carrying the disc,
fired by a thumb trigger, with a brass gauge on the flank.*

Silhouette: gauntlet, not a weapon; minimal first-person mass.

## Choice

**Chosen: alternative 1, FORK.**

- DRUM puts the drum straight into the 0.150 sight line (the drum top reaches
  about 0.22), so it fails the iron-sight contract. It also hides the disc, so
  the "discs in hand" state cannot read from the viewmodel.
- BRACER has no gun silhouette: no pistol grip for the `HANDS` grip anchor, no
  spindle for the muzzle and heat-band contract, and no sight line. In third
  person it reads as an empty hand.
- FORK is the only alternative that keeps every contract anchor (spindle
  muzzle at 0.40, sight ring and notch at 0.150, grip and support stub) while
  making the seated disc the most visible surface from the eye. Its catch
  horns give a silhouette no other weapon in the roster has. The choice and
  the refinements that came with it are recorded in `../build-report.md`.
