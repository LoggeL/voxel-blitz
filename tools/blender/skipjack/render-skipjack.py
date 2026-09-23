#!/usr/bin/env python3
"""Render SKIPJACK hero/side and review proof shots from the authored .blend.

Usage:
    blender --background --factory-startup docs/design/blender/skipjack/skipjack.blend \
        --python tools/blender/skipjack/render-skipjack.py

Source art only: the runtime game-export collection and the leftover studio
gear stay out of the render and the studio is rebuilt in-script (dark sweep,
three area lights, orthographic cameras) so every proof is deterministic across
revisions. Outputs:

    skipjack-hero.png                 orthographic front-left three-quarter,
                                      muzzle to image left
    skipjack-side.png                 pure left-side profile, cassette side
                                      facing camera
    review/final/right-side.png       pure right-side profile
    review/final/muzzle.png           front quarter into the crowned muzzle
    review/final/rear.png             sight picture from behind
    review/final/top.png              overhead three-quarter
    review/final/ads.png              exactly on the sight line (0, y, 0.291),
                                      looking +Y toward the muzzle

With VB_SKIPJACK_SMOKE_ROOT set every PNG lands under that root so development
runs never touch delivered docs.
"""
import os
import re
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
SLUG = 'skipjack'
ASSET = 'SKIPJACK'
DOCS = ROOT / 'docs/design/blender/skipjack'

GROUP_NAMES = ('body', 'mag', 'bolt', 'trigger', 'extra')
MATERIAL_KEYS = ('gunmetal', 'machined steel', 'olive drab', 'dark polymer',
                 'rubber', 'orange paint', 'brass', 'phosphor', 'optic glass')
# A merged runtime batch is named exactly `<part> | <material key>` (or
# `mag | round N`); authored source parts never are.
BATCH_NAME = re.compile(
    r'^(?:' + '|'.join(map(re.escape, GROUP_NAMES)) + r') \| (?:'
    + '|'.join(map(re.escape, MATERIAL_KEYS)) + r'|round [1-3])$')

SAMPLES = 40
RESOLUTION = (1600, 1000)


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

# In-script dark sweep + three area lights (the .blend's own studio gear is
# hidden above so revisions cannot shift the proof lighting).
sweep_material = bpy.data.materials.new(f'{ASSET} | render sweep')
sweep_material.use_nodes = True
sweep_shader = sweep_material.node_tree.nodes['Principled BSDF']
sweep_shader.inputs['Base Color'].default_value = (0.023, 0.032, 0.039, 1)
sweep_shader.inputs['Roughness'].default_value = 0.68
bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0.28, -0.42))
sweep = bpy.context.object
sweep.name = 'SKIPJACK | render sweep'
sweep.data.materials.append(sweep_material)

world = bpy.data.worlds.new('SKIPJACK | dark sweep world')
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

cam_data = bpy.data.cameras.new('SKIPJACK | proof camera')
cam = bpy.data.objects.new('SKIPJACK | proof camera', cam_data)
scene.collection.objects.link(cam)
cam_data.type = 'ORTHO'
scene.camera = cam

# name: (output path, camera position, look-at, orthographic scale)
VIEWS = (
    ('skipjack-hero', 'skipjack-hero.png',
     (-1.55, 1.15, 0.32), (0.0, 0.32, -0.005), 1.18),
    ('skipjack-side', 'skipjack-side.png',
     (-2.0, 0.32, -0.005), (0.0, 0.32, -0.005), 1.18),
    ('right-side', 'review/final/right-side.png',
     (2.0, 0.32, -0.005), (0.0, 0.32, -0.005), 1.18),
    ('muzzle', 'review/final/muzzle.png',
     (-0.20, 2.0, 0.19), (0.0, 0.32, -0.005), 0.95),
    ('rear', 'review/final/rear.png',
     (0.0, -1.35, 0.40), (0.0, 0.35, 0.24), 0.95),
    ('top', 'review/final/top.png',
     (-0.75, 0.48, 1.55), (0.0, 0.32, -0.005), 1.18),
    ('ads', 'review/final/ads.png',
     (0.0, -1.0, 0.291), (0.0, 0.6, 0.291), 0.5),
)

for name, rel, pos, target, scale in VIEWS:
    cam.location = Vector(pos)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.ortho_scale = scale
    output = out_path(DOCS / rel)
    output.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
    print(f'RENDER_SAVED {rel}')

print('SKIPJACK-RENDER-DONE')
