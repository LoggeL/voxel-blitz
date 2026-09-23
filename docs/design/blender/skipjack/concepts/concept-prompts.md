# GL-3 SKIPJACK — design alternatives (revision 8 redo)

The repo workflow asks for design alternatives before a substantial visual
change. No image generator is available in this toolset, so each alternative
below is generated as a real-geometry Blender blockout by
`concept-blockouts.py` (flat palette colours, coarse forms) and rendered to
`concept-{1..3}-*.png`. The prompt text is kept verbatim per alternative — it
is the brief each blockout was generated from, and the same text would drive an
image generator if one were used.

The revision 7 study this replaces read as an assembly of unrelated slabs: a
stepped riser tower carrying a wire-cage reflex, three oversized bottles bolted
on an open bracket outside the receiver wall, ski rails floating on a thin
barrel, and a bent-wire release tap dangling below. Every alternative below
fixes the same failures: one continuous silhouette, 40 mm mass in the bore and
muzzle, ammunition that reads as chambered ordnance, and a sight structure that
makes the 0.291 m arc-aiming line look intentional.

Shared frame for all three prompts:

> Compact science-fiction 40 mm three-shot grenade launcher for a first-person
> shooter viewmodel, display name GL-3 SKIPJACK. About 0.95 m long. Fat launch
> bore on the gun centreline; the forward barrel half is a bare heat sleeve
> kept free of furniture. Three live 40 mm grenades ride in a left-flank
> cassette that hinges open on reload. Tall reflex sight line 0.29 m over the
> bore axis for arc aiming, with a genuinely open sight window. Pistol grip
> under the rear, a support fore-grip hanging under the barrel start. Warm
> industrial palette: gunmetal, olive drab, orange safety paint, ivory
> markings, dark polymer, black rubber, brass. Product render on a neutral
> studio backdrop, 3/4 front-left hero angle. NOT stacked slabs, NOT bottles on
> an open bracket, NOT a stepped riser tower, NOT bent wires.

## Alternative 1 — "CITADEL" (armoured wedge with a bayed cassette)

Prompt delta: *One continuous faceted wedge: the receiver and the barrel shroud
are a single armoured volume whose diagonal top ridge runs from the stock comb
to the muzzle nut. The three grenades sit half-recessed in a milled left bay,
each in its own chamber sleeve, and the cassette's outer wall is an armoured
cheek pierced by three round chamber windows that show the ogive noses and
orange bands. Heavy fluted shroud and a slotted muzzle brake. The arc sight is
a swept A-frame fin growing out of the top ridge, carrying a compact hooded
reflex — no stack of plates. Solid tapered stock with cheek comb and rubber
pad.*

Silhouette: one monolithic diagonal wedge, mass low and rearward, ammo visible
through armour windows.

## Alternative 2 — "TRIAD" (open drum cage over a slim tube)

Prompt delta: *Service-launcher language, Milkor lineage: a slim rounded
receiver spine with a scalloped left wall that the cassette nests into. The
cassette is a machined drum cage — two slotted ring spiders and three chunky
chamber sleeves holding fully exposed grenades with brass bases and ogive
noses. Slim tube barrel with a stepped muzzle nut and rubber bumper rings.
Tubular reflex on a short pedestal, folding ladder wings along the barrel.
Light skeletal stock struts to a rubber pad, stubby vertical grip and hand
stop.*

Silhouette: heavy open drum mass forward-left, thin barrel, light skeletal
rear. Maximum ammunition read.

## Alternative 3 — "TREBUCHET" (arc-tower artillery carbine)

Prompt delta: *Artillery DNA: the 0.29 m sight line is the signature, carried
by a tall ladder tower — two notched arc-range plates with a sliding cursor and
the reflex slung on top. Long slim tapered spine receiver, thick squared muzzle
crown block. The three grenades hang in an open stamped-steel clip under the
left cheek like shells in a mortar rack, ogive noses forward. Triangular target
stock with a wide pad, vertical grip, long angled fore-stock with finger
grooves.*

Silhouette: tall notched sight fin over a long slim body, shells racked in the
open. Most original read.

## Choice

**Chosen: alternative 1, CITADEL** — the one continuous armoured wedge with
the bayed cassette. Judged on the blockout renders (`concept-0-overview.png`
plus the hero and rear-quarter shots):

- It is the only alternative that reads as one designed object. The revision 7
  failure was fragmentation, and CITADEL's single diagonal mass from stock comb
  to muzzle nut fixes it structurally rather than cosmetically.
- The cassette is *part of the body*: chamber block flush against the receiver
  wall, machined rims, and an armoured cheek whose three chamber windows frame
  the grenades. TRIAD's drum ring plates ended up hiding the rounds behind
  solid annuli — the opposite of its own goal — so its "exposed ammunition"
  ambition is taken over as large windows instead of open cage.
- Its profile carries the mass low and rearward with an honest stock, where
  TREBUCHET read blobby and TRIAD read as three separate boxes on a tube.

Two refinements come with the choice, both documented against the losers:

1. **Ladder language from TREBUCHET.** The 0.291 m sight line is unusually
   tall; bare risers made revision 7 look broken. CITADEL's swept fin becomes
   an arc-range ladder: two notched plates with range marks and a cursor bar,
   carrying the compact hooded reflex on top. The height now reads as function
   (arc aiming), not as a tower of plates.
2. **Muzzle authority from TREBUCHET.** A squared, chamfered crown block with a
   deep bore and slot vents replaces the thin tube-and-nut ending, so the
   launch bore has real mass at the muzzle.

The reflex shrinks to a hooded micro sight and the sight mast is structurally
continuous with the top ridge — in the blockouts the reflex floated, which must
not survive into the build.
