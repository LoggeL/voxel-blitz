"""Blockout three GL-3 SKIPJACK design alternatives and render review shots.

Self-contained: run through the live Blender MCP session (`execute_code`) or
headless with

    blender --background --factory-startup --python \
        docs/design/blender/skipjack/concepts/concept-blockouts.py

Generates the three design alternatives recorded in concept-prompts.md as real
geometry blockouts (rough forms, flat palette colours) and writes
concept-1-citadel.png / concept-2-triad.png / concept-3-trebuchet.png plus a
`-fp` rear-quarter view each and the concept-0-overview.png profile sheet next
to this file. These are design studies only: no contract checks, no delivery
export. The script creates its own scene and never modifies other scenes.
"""
import bpy
import math
from pathlib import Path
from mathutils import Vector

HERE = Path(__file__).resolve().parent
SCENE_NAME = 'SKIPJACK | concept study'

# Frozen viewmodel contract (authoring space: +Y muzzle, +Z up, +X right).
BORE_Z = 0.075
MUZZLE_Y = 0.782
BREACH_Y = 0.330          # exposed heat-sleeve barrel starts here (r 0.040)
SIGHT = (0.0, 0.332, 0.291)
GRIP = (0.047, 0.056, -0.203)
SUPPORT = (-0.058, 0.373, -0.184)
CASSETTE_X = -0.115       # grenade stack centreline on the left flank
ROUND_ROWS = (0.055, -0.008, -0.071)
ROUND_Y = 0.215           # grenade body centre along the launch axis

# flat blockout palette (matches the delivered texture family)
GREY = (0.24, 0.25, 0.28, 1)
OLIVE = (0.30, 0.30, 0.19, 1)
ORANGE = (0.78, 0.32, 0.07, 1)
IVORY = (0.80, 0.78, 0.72, 1)
DARK = (0.10, 0.10, 0.11, 1)
BLACK = (0.015, 0.015, 0.016, 1)
BRASS = (0.55, 0.40, 0.15, 1)
GLASS = (0.35, 0.75, 0.80, 0.35)

old = bpy.data.scenes.get(SCENE_NAME)
if old is not None:
    bpy.data.scenes.remove(old)
scene = bpy.data.scenes.new(SCENE_NAME)
for win in bpy.context.window_manager.windows:
    win.scene = scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1400, 880
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.world = bpy.data.worlds.new('concept world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.13, .15, .19, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.4


def material(name, colour, metal=0.2, rough=0.6):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = colour
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if name == 'glass':
        bsdf.inputs['Alpha'].default_value = 0.35
        mat.surface_render_method = 'BLENDED'
    return mat


MATS = {name: material(name, col, *args) for (name, col, *args) in (
    ('grey', GREY, .5, .45), ('olive', OLIVE, .1, .65), ('orange', ORANGE, .1, .5),
    ('ivory', IVORY, .05, .5), ('dark', DARK, .2, .8), ('black', BLACK, 0, 1),
    ('brass', BRASS, .7, .4), ('glass', GLASS, .05, .15))}

PARTS = []


def add(name, mat, verts, faces, loc=(0, 0, 0)):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    mesh.materials.append(MATS[mat])
    scene.collection.objects.link(obj)
    PARTS.append(obj)
    return obj


def box(name, mat, sx, sy, sz, y, z=BORE_Z, x=0.0, rx=0.0):
    # Local-space geometry with a real object origin, so rake and strut
    # rotations pivot on the part itself.
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    verts = [(dx, dy, dz) for dz in (-hz, hz) for dy in (-hy, hy) for dx in (-hx, hx)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    obj = add(name, mat, verts, faces, loc=(x, y, z))
    if rx:
        obj.rotation_euler[0] = rx
    return obj


def cyl(name, mat, r0, r1, y0, y1, seg=20, x=0.0, z=BORE_Z, inner=None):
    def ring(radius, y):
        return [(x + radius * math.cos(2 * math.pi * i / seg),
                 y, z + radius * math.sin(2 * math.pi * i / seg)) for i in range(seg)]

    verts = ring(r0, y0) + ring(r1, y1)
    faces = []
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((i, j, seg + j, seg + i))
    if inner is None:
        verts += [(x, y0, z), (x, y1, z)]
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((i, j, 2 * seg))
            faces.append((seg + j, seg + i, 2 * seg + 1))
    else:
        verts += ring(inner, y0) + ring(inner, y1)
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((2 * seg + i, 2 * seg + j, 3 * seg + j, 3 * seg + i))
            faces.append((i, 2 * seg + i, 2 * seg + j, j))
            faces.append((seg + j, 3 * seg + j, 3 * seg + i, seg + i))
    return add(name, mat, verts, faces)


def prism(name, mat, profile, width, x=0.0):
    """Extrude a (y, z) side profile across X."""
    count = len(profile)
    x0, x1 = x - width / 2, x + width / 2
    verts = [(x0, y, z) for (y, z) in profile] + [(x1, y, z) for (y, z) in profile]
    faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, j + count, i + count))
    return add(name, mat, verts, faces)


def strut(name, mat, p0, p1, w):
    a, b = Vector(p0), Vector(p1)
    mid = (a + b) / 2
    obj = box(name, mat, w, (b - a).length, w, mid.y, mid.z, mid.x)
    obj.rotation_euler = (b - a).to_track_quat('Y', 'Z').to_euler()
    return obj


def grenade(prefix, x=CASSETTE_X, z=0.0, y=ROUND_Y):
    """One 40 mm grenade: brass base, olive body, orange band, ogive nose."""
    cyl(f'{prefix} | base', 'brass', .026, .026, y - .088, y - .062, 16, x, z)
    cyl(f'{prefix} | body', 'olive', .025, .025, y - .062, y + .045, 16, x, z)
    cyl(f'{prefix} | band', 'orange', .026, .026, y - .018, y - .006, 16, x, z)
    cyl(f'{prefix} | nose', 'olive', .025, .010, y + .045, y + .088, 16, x, z)
    cyl(f'{prefix} | tip', 'dark', .010, .004, y + .088, y + .098, 12, x, z)


def launcher_core(name):
    """Shared contract geometry: heat-sleeve barrel and the three grenades."""
    cyl(f'{name} | heat sleeve', 'grey', .040, .040, BREACH_Y, MUZZLE_Y - .004, 20, inner=.030)
    for i, row in enumerate(ROUND_ROWS):
        grenade(f'{name} | round {i + 1}', z=row)


def sight_reflex(name, mast_mat='grey'):
    """Compact hooded reflex at the frozen sight marker."""
    box(f'{name} | reflex body', 'dark', .072, .070, .058, SIGHT[1] + .01, SIGHT[2] + .035)
    box(f'{name} | reflex hood', mast_mat, .082, .024, .076, SIGHT[1] + .036, SIGHT[2] + .038)
    box(f'{name} | reflex lens', 'glass', .062, .003, .044, SIGHT[1] - .012, SIGHT[2] + .030)
    box(f'{name} | reflex base', 'orange', .050, .030, .008, SIGHT[1] + .01, SIGHT[2] + .064)


def pistol_grip(name, mat='dark'):
    box(f'{name} | grip', mat, .088, .115, .235, GRIP[1] + .012, GRIP[2], GRIP[0], rx=0.30)
    box(f'{name} | grip heel', 'black', .092, .130, .030, GRIP[1] - .085, GRIP[2] - .10, GRIP[0], rx=0.30)


# ---------------------------------------------------------------------------
# Alternative 1 — CITADEL: one armoured wedge with a bayed cassette.
# ---------------------------------------------------------------------------
def variant_citadel():
    n = 'citadel'
    launcher_core(n)
    prism(f'{n} | wedge receiver', 'olive',
          [(-.13, .01), (-.09, .115), (.06, .155), (.30, .155), (.40, .11),
           (.43, .0), (.33, -.075), (.02, -.085)], .180)
    prism(f'{n} | top ridge', 'grey',
          [(-.06, .145), (.08, .185), (.30, .185), (.38, .15)], .100)
    cyl(f'{n} | fluted shroud', 'grey', .058, .052, .36, .58, 8, inner=.041)
    box(f'{n} | muzzle brake', 'grey', .104, .095, .104, .735)
    box(f'{n} | crown', 'black', .070, .02, .070, .782)
    for row in ROUND_ROWS:
        cyl(f'{n} | chamber sleeve', 'grey', .031, .031, .11, .315, 16,
            CASSETTE_X - .012, row, inner=.026)
    box(f'{n} | armoured cheek', 'olive', .016, .235, .215, .215, -.008, CASSETTE_X - .055)
    for row in ROUND_ROWS:
        cyl(f'{n} | window', 'dark', .026, .026, .126, .132, 16, CASSETTE_X - .055, row)
    strut(f'{n} | hinge boss', 'grey', (CASSETTE_X - .05, .30, .055),
          (CASSETTE_X + .03, .30, .055), .030)
    box(f'{n} | release paddle', 'orange', .014, .034, .052, .285, -.05, CASSETTE_X - .062, rx=0.35)
    prism(f'{n} | stock', 'olive',
          [(-.19, .045), (-.15, .10), (-.02, .085), (.03, .02), (.0, -.04), (-.16, -.055)], .120)
    box(f'{n} | stock pad', 'black', .128, .035, .150, -.185, .0)
    pistol_grip(n)
    box(f'{n} | fore grip', 'dark', .075, .10, .19, SUPPORT[1], SUPPORT[2] + .03, SUPPORT[0], rx=-0.18)
    # A-frame sight fin growing out of the top ridge.
    for side in (-1, 1):
        strut(f'{n} | sight fin {side:+}', 'grey',
              (side * .035, .255, .17), (side * .022, SIGHT[1], SIGHT[2] - .03), .022)
    sight_reflex(n)


# ---------------------------------------------------------------------------
# Alternative 2 — TRIAD: open drum cage over a slim tube.
# ---------------------------------------------------------------------------
def variant_triad():
    n = 'triad'
    launcher_core(n)
    prism(f'{n} | spine receiver', 'grey',
          [(-.10, .0), (-.06, .10), (.06, .13), (.32, .13), (.40, .07),
           (.38, -.02), (.10, -.05)], .110)
    box(f'{n} | top rail', 'dark', .085, .30, .028, .22, .145)
    cyl(f'{n} | muzzle nut', 'grey', .050, .050, .70, .775, 20, inner=.032)
    cyl(f'{n} | bumper', 'black', .052, .048, .775, .782, 20, inner=.032)
    # Machined drum cage: two slotted ring spiders + three chamber sleeves.
    for y in (.12, .31):
        cyl(f'{n} | ring spider', 'grey', .105, .105, y - .012, y + .012, 24,
            CASSETTE_X + .01, -.008, inner=.075)
    for row in ROUND_ROWS:
        cyl(f'{n} | chamber sleeve', 'grey', .030, .030, .11, .315, 16,
            CASSETTE_X, row, inner=.026)
        box(f'{n} | saddle web', 'grey', .045, .20, .014, .21, row - .033, CASSETTE_X + .005)
    box(f'{n} | spine bar', 'grey', .030, .22, .19, .215, -.008, CASSETTE_X - .055)
    box(f'{n} | release paddle', 'orange', .014, .030, .048, .30, -.075, CASSETTE_X - .058, rx=0.35)
    strut(f'{n} | stock upper', 'grey', (-.03, -.08, .06), (-.03, -.185, .02), .026)
    strut(f'{n} | stock lower', 'grey', (-.03, -.08, -.03), (-.03, -.185, -.02), .026)
    box(f'{n} | stock pad', 'black', .085, .03, .12, -.19, .0)
    pistol_grip(n)
    box(f'{n} | hand stop', 'dark', .062, .075, .115, SUPPORT[1], SUPPORT[2] + .05, SUPPORT[0], rx=-0.12)
    for side in (-1, 1):
        box(f'{n} | ladder wing {side:+}', 'grey', .012, .16, .05, .55, .115, side * .05, rx=0.0)
    box(f'{n} | optic pedestal', 'grey', .05, .10, .055, SIGHT[1], .165)
    sight_reflex(n)


# ---------------------------------------------------------------------------
# Alternative 3 — TREBUCHET: tall arc-sight tower, shells in an open clip.
# ---------------------------------------------------------------------------
def variant_trebuchet():
    n = 'trebuchet'
    launcher_core(n)
    prism(f'{n} | long spine', 'grey',
          [(-.11, -.01), (-.07, .09), (.05, .12), (.34, .12), (.42, .05),
           (.40, -.02), (.08, -.055)], .095)
    cyl(f'{n} | tapered tube', 'grey', .052, .044, .34, .68, 20, inner=.032)
    box(f'{n} | muzzle crown block', 'grey', .115, .085, .115, .742)
    box(f'{n} | crown face', 'black', .078, .012, .078, .782)
    # Stamped open clip: spine rail + three shell saddles on the left cheek.
    box(f'{n} | clip rail', 'grey', .026, .24, .20, .21, -.01, CASSETTE_X - .05)
    for i, row in enumerate(ROUND_ROWS):
        box(f'{n} | shell saddle {i + 1}', 'grey', .05, .09, .014, .16, row - .032, CASSETTE_X - .01)
        box(f'{n} | nose brace {i + 1}', 'grey', .05, .014, .05, .30, row, CASSETTE_X - .01)
    box(f'{n} | release paddle', 'orange', .014, .030, .045, .305, -.08, CASSETTE_X - .055, rx=0.35)
    for side in (-1, 1):
        strut(f'{n} | stock rail {side:+}', 'grey',
              (side * .045, -.06, .02), (side * .045, -.19, .05), .022)
        strut(f'{n} | stock lower {side:+}', 'grey',
              (side * .045, -.06, -.05), (side * .045, -.19, -.02), .022)
    box(f'{n} | stock pad', 'black', .11, .03, .14, -.195, .015)
    box(f'{n} | grip', 'dark', .08, .095, .22, GRIP[1], GRIP[2], GRIP[0], rx=0.12)
    prism(f'{n} | fore stock', 'dark',
          [(.30, -.075), (.45, -.075), (.45, -.19), (.30, -.16)], .085, SUPPORT[0])
    # Ladder arc tower: two notched plates, cursor bar, reflex slung on top.
    for side in (-1, 1):
        prism(f'{n} | ladder plate {side:+}', 'grey',
              [(.30, .13), (.36, .28), (SIGHT[1] + .03, .28), (SIGHT[1] + .03, .22),
               (.33, .17)], .016, side * .033)
    for i in range(4):
        box(f'{n} | range notch {i + 1}', 'orange', .075, .006, .008,
            .335 + i * .001, .17 + i * .032)
    box(f'{n} | cursor bar', 'dark', .09, .02, .012, SIGHT[1] - .01, SIGHT[2] - .02)
    sight_reflex(n)


# ---------------------------------------------------------------------------
# Lighting, cameras and renders.
# ---------------------------------------------------------------------------
def area_light(name, location, energy, size=1.4, colour=(1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector((0, .3, 0)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    return obj


area_light('key', (-1.3, 1.1, 1.5), 700, 2.0, (.8, .87, 1))
area_light('fill', (1.5, -.4, .9), 380, 2.2, (1, .95, .88))
area_light('rim', (0, 1.6, -.8), 300, 1.4, (.85, .9, 1))

cam_data = bpy.data.cameras.new('concept camera')
cam = bpy.data.objects.new('concept camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.type = 'ORTHO'


def shot(name, location, target, scale=1.30):
    cam.location = location
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.ortho_scale = scale
    scene.render.filepath = str(HERE / name)
    bpy.ops.render.render(write_still=True)
    print('CONCEPT_SAVED', name)


HERO_CAM = (-1.35, 1.25, .38)
FP_CAM = (.55, -.85, .55)
TARGET = (0, .30, -.01)

for build, slug in ((variant_citadel, 'citadel'), (variant_triad, 'triad'),
                    (variant_trebuchet, 'trebuchet')):
    PARTS.clear()
    build()
    index = {'citadel': 1, 'triad': 2, 'trebuchet': 3}[slug]
    shot(f'concept-{index}-{slug}.png', HERO_CAM, TARGET, 1.30)
    shot(f'concept-{index}-{slug}-fp.png', FP_CAM, TARGET, 1.15)
    for obj in PARTS:
        bpy.data.objects.remove(obj, do_unlink=True)

# overview sheet: all three profiles in a row (left CITADEL, centre TRIAD,
# right TREBUCHET), each spaced 1.25 m along +Y.
for build, slug in ((variant_citadel, 'citadel'), (variant_triad, 'triad'),
                    (variant_trebuchet, 'trebuchet')):
    offset = {'citadel': -1.25, 'triad': 0.0, 'trebuchet': 1.25}[slug]
    PARTS.clear()
    build()
    for obj in PARTS:
        obj.location.y += offset

shot('concept-0-overview.png', (-3.4, .30, .10), (0, .30, .0), 4.3)
print('CONCEPTS_DONE')
