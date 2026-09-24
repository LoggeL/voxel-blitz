#!/usr/bin/env python3
"""Render SKIPJACK reload-choreography pose proofs from the authored .blend.

Usage:
    blender --background --factory-startup docs/design/blender/skipjack/skipjack.blend \
        --python tools/blender/skipjack/pose-skipjack.py

The transforms replicate the runtime path in public/js/guns/actions.js
`_updateSkipjackReload` exactly. For every `mag` source mesh the runtime
subtracts CASSETTE_HINGE (game (-0.142, 0.020, -0.306), the vertical hub at the
cassette's front edge), applies Euler(0, -(0.92*open + 0.07*kick), 0.10*away)
XYZ in GAME space plus the translation game (-0.15*away, 0.05*lifted -
0.30*away, 0.05*away), then restores the hinge. The phase curves come verbatim
from the runtime with magTimeline start 0.16 / home 0.80 / clickAt 0.90
(TIMERS.mgl). Baked world vertices play the role of the runtime meshes' baked
game-space positions, so the game-space matrix is conjugated into authoring
space with GAME = ((1,0,0),(0,0,1),(0,-1,0)).

Frames (frac of the reload duration). Frames up to pose-seated show a tactical
swap from two total rounds (one reserve outside, the fresh cassette carries
two); pose-rack is the empty swap stripping one fresh round into the chamber:

    pose-home.png       0.00  closed on the hinge hub, one reserve round
    pose-open.png       0.27  swung out 53 deg about the vertical front hub
    pose-lift.png       0.36  lifted 5 cm off the hinge pin, still loaded
    pose-exchange.png   0.50  cassette away (hidden 0.46-0.56)
    pose-insert.png     0.66  fresh cassette (two rounds) back on the pin
    pose-seated.png     0.80  swung shut and seated
    pose-rack.png       0.905 empty swap: pawl at full boltTravel, one round
                              left outside after the strip

With VB_SKIPJACK_SMOKE_ROOT set every PNG lands under that root so development
runs never touch delivered docs.
"""
import os
import re
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
SLUG = 'skipjack'
ASSET = 'SKIPJACK'
DOCS = ROOT / 'docs/design/blender/skipjack'

GROUP_NAMES = ('body', 'mag', 'bolt', 'trigger', 'extra')
MATERIAL_KEYS = ('gunmetal', 'machined steel', 'olive drab', 'dark polymer',
                 'rubber', 'orange paint', 'brass', 'phosphor', 'optic glass')
BATCH_NAME = re.compile(
    r'^(?:' + '|'.join(map(re.escape, GROUP_NAMES)) + r') \| (?:'
    + '|'.join(map(re.escape, MATERIAL_KEYS)) + r'|round [1-3])$')

SAMPLES = 24
RESOLUTION = (1600, 1000)

GAME = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))  # game (x, y, z) = GAME @ authoring
CASSETTE_HINGE_GAME = Vector((-0.142, 0.020, -0.306))
GAME_TO_AUTH = GAME.to_3x3().transposed()
HINGE_AUTH = GAME_TO_AUTH @ CASSETTE_HINGE_GAME
MAG_TIMELINE = (0.16, 0.80, 0.90)  # start, home, clickAt (TIMERS.mgl.magTimeline)
TIMERS_BOLT_TRAVEL = 0.025        # TIMERS.mgl.boltTravel


def out_path(path):
    """Route writes under VB_SKIPJACK_SMOKE_ROOT when developing."""
    smoke = os.environ.get('VB_SKIPJACK_SMOKE_ROOT')
    if not smoke:
        return path
    root = Path(smoke)
    if not root.is_absolute():
        root = ROOT / root
    try:
        return root / path.relative_to(ROOT)
    except ValueError:
        return root / path.name


def is_source_mesh(obj):
    """Authored source art: never the runtime export, never studio furniture."""
    if obj.type != 'MESH':
        return False
    if any('export' in collection.name.lower() for collection in obj.users_collection):
        return False
    if obj.get('blenderAsset') == SLUG and BATCH_NAME.match(obj.name):
        return False  # a merged runtime batch, not its authored source parts
    return (obj.get('part') in GROUP_NAMES or obj.get('skipjack_material') is not None
            or obj.name.lower().startswith('round '))


# actions.js helpers, verbatim: _smooth01(t) = t * t * (3 - 2 * t) and
# _phase(t, from, to) = _smooth01(clamp01((t - from) / max(0.001, to - from))).
def smooth01(t):
    return t * t * (3 - 2 * t)


def phase(t, from_, to):
    return smooth01(max(0.0, min(1.0, (t - from_) / max(0.001, to - from_))))


def contact(t, at, decay):
    attack = min(0.018, decay * 0.25)
    return phase(t, at - attack, at) * (1 - phase(t, at, at + decay))


def reload_state(frac, racks):
    """Cassette/bolt state of _updateSkipjackReload at `frac`."""
    (start, home, click_at) = MAG_TIMELINE
    open_amount = phase(frac, start, 0.27) * (1 - phase(frac, 0.70, home))
    kick = contact(frac, 0.27, 0.05)
    lifted = phase(frac, 0.30, 0.36) * (1 - phase(frac, 0.66, 0.70))
    away = phase(frac, 0.36, 0.46) * (1 - phase(frac, 0.56, 0.66))
    rack = (phase(frac, click_at - 0.03, click_at + 0.02) *
            (1 - phase(frac, click_at + 0.04, 0.98))) if racks else 0.0
    visible = frac < 0.46 or frac >= 0.56
    return open_amount, kick, lifted, away, rack, visible


def cassette_matrix(open_amount, kick, lifted, away):
    """Authoring-space replica of the runtime cassette transform."""
    delta_game = Vector((-0.15 * away, 0.05 * lifted - 0.30 * away, 0.05 * away))
    rotation_game = Euler((0.0, -(0.92 * open_amount + 0.07 * kick), 0.10 * away),
                          'XYZ').to_matrix()
    rotation_auth = GAME_TO_AUTH @ rotation_game @ GAME.to_3x3()
    return (Matrix.Translation(HINGE_AUTH + GAME_TO_AUTH @ delta_game)
            @ rotation_auth.to_4x4() @ Matrix.Translation(-HINGE_AUTH))


def bolt_matrix(back):
    """The bolt group's stroke along game +z (rearward = authoring -Y)."""
    return Matrix.Translation(GAME_TO_AUTH @ Vector((0.0, 0.0, back)))


scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.cycles.seed = 20260923
scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'

for obj in scene.objects:
    obj.hide_render = not is_source_mesh(obj)

# In-script dark sweep + three area lights (same study lighting as
# render-skipjack.py so pose stills match the review renders).
sweep_material = bpy.data.materials.new(f'{ASSET} | render sweep')
sweep_material.use_nodes = True
sweep_shader = sweep_material.node_tree.nodes['Principled BSDF']
sweep_shader.inputs['Base Color'].default_value = (0.023, 0.032, 0.039, 1)
sweep_shader.inputs['Roughness'].default_value = 0.68
bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0.28, -0.42))
sweep = bpy.context.object
sweep.name = 'SKIPJACK | render sweep'
sweep.data.materials.append(sweep_material)

world = bpy.data.worlds.new(f'{ASSET} | dark sweep world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.018, 0.024, 0.030, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
scene.world = world


def area(name, loc, power, color, size, target):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = power
    data.color = color
    data.shape = 'DISK'
    data.size = size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    return obj


area('SKIPJACK | key softbox', (1.4, -0.6, 1.6), 95, (0.72, 0.84, 1.0), 1.4, (0, 0.34, 0))
area('SKIPJACK | cool edge', (-1.15, 0.48, 0.78), 105, (0.72, 0.83, 1.0), 0.9, (0, 0.36, 0))
area('SKIPJACK | overhead strip', (0.1, 0.75, 1.3), 78, (0.66, 0.90, 1.0), 1.1, (0, 0.37, -0.02))

cam_data = bpy.data.cameras.new(f'{ASSET} | pose camera')
cam = bpy.data.objects.new(f'{ASSET} | pose camera', cam_data)
scene.collection.objects.link(cam)
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 1.25
scene.camera = cam
# Left-rear three-quarter, as the shooter sees the flank: the front hinge hub,
# the bay and the whole swing envelope (rear edge out to -X) read from here.
cam.location = Vector((-1.45, -0.45, 0.35))
cam.rotation_euler = (Vector((-0.05, 0.25, -0.03)) - cam.location).to_track_quat('-Z', 'Y').to_euler()

mag_parts = [o for o in scene.objects
             if is_source_mesh(o) and (o.get('part') == 'mag'
                                       or o.get('skipjack_material') == 'round colors'
                                       or o.name.lower().startswith('round '))]
bolt_parts = [o for o in scene.objects if is_source_mesh(o) and o.get('part') == 'bolt']
if not mag_parts or not bolt_parts:
    raise SystemExit('pose-skipjack needs the authored mag/bolt source parts of skipjack.blend')

originals = {obj: obj.matrix_world.copy() for obj in mag_parts + bolt_parts}


def reset_nodes():
    for obj in mag_parts + bolt_parts:
        obj.matrix_world = originals[obj]
        obj.hide_render = obj.name.startswith('round 1 |')
    bpy.context.view_layer.update()


# (name, reload fraction, empty swap that racks, exterior rounds shown)
POSES = (
    ('pose-home', 0.00, False, 1),
    ('pose-open', 0.27, False, 1),
    ('pose-lift', 0.36, False, 1),
    ('pose-exchange', 0.50, False, 1),
    ('pose-insert', 0.66, False, 2),
    ('pose-seated', 0.80, False, 2),
    ('pose-rack', 0.905, True, 1),
)


def round_shown(obj, count):
    """Slots empty from the top: round 1 is the upper, round 3 the lower slot."""
    match = re.match(r'round ([1-3]) \|', obj.name)
    return not match or int(match.group(1)) > 3 - count


for name, frac, racks, count in POSES:
    reset_nodes()
    open_amount, kick, lifted, away, rack, visible = reload_state(frac, racks)
    cassette = cassette_matrix(open_amount, kick, lifted, away)
    bolt = bolt_matrix(TIMERS_BOLT_TRAVEL * rack)
    for obj in mag_parts:
        obj.matrix_world = cassette @ originals[obj]
        obj.hide_render = not visible or not round_shown(obj, count)
    for obj in bolt_parts:
        obj.matrix_world = bolt @ originals[obj]
    bpy.context.view_layer.update()
    output = out_path(DOCS / f'{name}.png')
    output.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
    print(f'POSE_SAVED {name}.png frac={frac} open={open_amount:.3f} lifted={lifted:.3f} '
          f'away={away:.3f} rack={rack:.3f} visible={visible} rounds={count}')

reset_nodes()
print('SKIPJACK-POSE-DONE')
