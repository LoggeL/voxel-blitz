#!/usr/bin/env python3
"""Render a multi-angle review sheet of the PEREGRINE study.

    blender --background docs/design/blender/peregrine/peregrine.blend \
        --python tools/blender/peregrine/render-angles.py -- \
        [--views ...] [--samples 48] [--width 1600] [--height 1000] [--tag ""] [--cpu]

Writes `review-<view><tag>.png` next to the study file. The four canonical
delivery views live in `render-views.py`; this script exists for review passes:
it walks the model from twelve directions, including the underside, the muzzle
and three close-ups, so a floating panel or a detached bracket is visible from
at least one angle.

Only the authored parts are rendered (objects carrying the `part` property), so
the material-batched export copies that also live in the study never double the
geometry. The three `extra` stripper rounds are left out: the runtime hides them
outside the reload animation and parked on their authored positions they read as
a modelling fault. The study file itself is never written to.
"""
import bpy
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/peregrine'
SCENE = 'PEREGRINE | Voxel Blitz sniper study'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

def flag(name, default=None, cast=str):
    if name in argv:
        return cast(argv[argv.index(name) + 1])
    for value in argv:
        if value.startswith(name + '='):
            return cast(value.split('=', 1)[1])
    return default

# Authoring frame: +Y forward, +Z up, +X right. (position, look-at, ortho scale)
PRESETS = {
    'hero':        ((0.62, 0.86, 0.52), (0.0, -0.02, 0.10), None),
    'rear-quarter': ((-0.55, -0.86, 0.34), (0.0, -0.05, 0.09), None),
    'rear':        ((0.30, -1.05, 0.42), (0.0, -0.10, 0.08), None),
    'left':        ((-2.4, 0.05, 0.06), (0.0, 0.05, 0.06), 1.30),
    'side':        ((2.4, 0.05, 0.06), (0.0, 0.05, 0.06), 1.30),
    'top':         ((0.0, 0.05, 2.4), (0.0, 0.05, 0.02), 1.30),
    'bottom':      ((0.0, 0.05, -2.4), (0.0, 0.05, 0.02), 1.30),
    'front':       ((0.0, 2.4, 0.20), (0.0, 0.05, 0.10), 1.10),
    'ads':         ((0.0, -0.62, 0.205), (0.0, 0.30, 0.205), None),
    'scope':       ((0.30, -0.34, 0.44), (0.0, 0.10, 0.195), None),
    'receiver':    ((0.34, 0.10, 0.42), (0.0, 0.06, 0.05), None),
    'grip':        ((0.36, 0.44, -0.14), (0.0, 0.08, -0.02), None),
    'stock':       ((-0.34, -0.60, 0.30), (0.0, -0.24, 0.05), None),
    'magazine':    ((0.30, 0.52, -0.34), (0.0, 0.22, -0.10), None),
    'fore-end':    ((0.42, 0.74, -0.30), (0.0, 0.26, -0.01), None),
    'muzzle':      ((0.22, 1.05, 0.22), (0.0, 0.66, 0.06), None),
    'trigger':     ((-0.34, 0.42, -0.32), (0.0, 0.16, -0.045), None),
    'underside':   ((0.30, -0.34, -0.86), (0.0, -0.02, -0.02), None),
    'magwell':     ((-0.30, 0.60, -0.34), (0.0, 0.23, -0.06), None),
}

VIEWS = flag('--views', 'hero,rear-quarter,left,top,bottom,front,scope,receiver,grip,stock,magazine,fore-end').split(',')
SAMPLES = flag('--samples', 48, int)
WIDTH = flag('--width', 1600, int)
HEIGHT = flag('--height', 1000, int)
TAG = flag('--tag', '')
CPU = '--cpu' in argv

study = bpy.data.scenes[SCENE] if SCENE in bpy.data.scenes else next(
    s for s in bpy.data.scenes if s.name.startswith('PEREGRINE'))

# A review scene of its own: the authored parts only, dropped in with the
# placements they carry in the study, and nothing else.
review = bpy.data.scenes.new('PEREGRINE review')
for window in bpy.context.window_manager.windows:
    window.scene = review
review.unit_settings.system = 'METRIC'
review.render.engine = 'CYCLES'
review.cycles.samples = SAMPLES
review.cycles.use_denoising = True
review.cycles.device = 'CPU' if CPU else 'GPU'
review.render.resolution_x, review.render.resolution_y = WIDTH, HEIGHT
review.render.resolution_percentage = 100
review.render.image_settings.file_format = 'PNG'
review.view_settings.view_transform = 'AgX'
review.world = bpy.data.worlds.new('PEREGRINE review world')
review.world.use_nodes = True
review.world.node_tree.nodes['Background'].inputs[0].default_value = (.14, .17, .21, 1)
review.world.node_tree.nodes['Background'].inputs[1].default_value = .35

linked = 0
for obj in list(study.objects):
    if obj.type != 'MESH' or 'part' not in obj.keys() or obj['part'] == 'extra':
        continue
    copy = obj.copy()
    copy.data = obj.data
    copy.parent = None
    copy.modifiers.clear()
    for modifier in obj.modifiers:
        baked = copy.modifiers.new(modifier.name, modifier.type)
        for prop in modifier.bl_rna.properties:
            if prop.identifier in {'rna_type', 'name', 'type'} or prop.is_readonly:
                continue
            try:
                setattr(baked, prop.identifier, getattr(modifier, prop.identifier))
            except (AttributeError, TypeError):
                pass
    matrix = obj.matrix_world.copy()
    review.collection.objects.link(copy)
    copy.matrix_world = matrix
    linked += 1
print(f'review scene parts: {linked}')
if not linked:
    raise SystemExit('no authored parts found in the study scene')

def area_light(name, location, energy, size=1.4, colour=(1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = colour
    light = bpy.data.objects.new(name, data)
    light.location = location
    light.rotation_euler = (Vector((0, 0.05, 0.08)) - Vector(location)).to_track_quat('-Z', 'Y').to_euler()
    review.collection.objects.link(light)

area_light('REVIEW key', (2.2, 1.6, 2.4), 900)
area_light('REVIEW fill', (-2.4, -0.6, 1.1), 320, size=2.4, colour=(0.82, 0.88, 1.0))
area_light('REVIEW rim', (-0.9, -2.2, 1.8), 420, size=1.6, colour=(1.0, 0.94, 0.86))

camera_data = bpy.data.cameras.new('REVIEW camera')
camera_data.lens = 62
camera = bpy.data.objects.new('REVIEW camera', camera_data)
review.collection.objects.link(camera)
review.camera = camera

for view in VIEWS:
    if view not in PRESETS:
        raise SystemExit(f'unknown view {view!r}; known: {", ".join(sorted(PRESETS))}')
    location, look, ortho = PRESETS[view]
    camera.location = Vector(location)
    camera.rotation_euler = (Vector(look) - Vector(location)).to_track_quat('-Z', 'Y').to_euler()
    if ortho:
        camera_data.type = 'ORTHO'
        camera_data.ortho_scale = ortho
    else:
        camera_data.type = 'PERSP'
    review.render.filepath = str(DOCS / f'review-{view}{TAG}.png')
    try:
        bpy.ops.render.render(write_still=True)
    except RuntimeError as error:
        print(f'RENDER_GPU_FAILED {view}: {error}')
        review.cycles.device = 'CPU'
        bpy.ops.render.render(write_still=True)
    print(f'RENDER_SAVED {review.render.filepath}')

print('PEREGRINE-ANGLES-DONE', ','.join(VIEWS))
