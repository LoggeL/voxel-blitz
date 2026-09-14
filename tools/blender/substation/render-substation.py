"""Render overview proof shots of the SUBSTATION map study with Cycles (CPU).

Through the live Blender MCP session (after build-substation.py has run in it):

    from pathlib import Path
    p = Path('.../tools/blender/substation/render-substation.py')
    exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p), 'SUBSTATION_VIEWS': ['hero']})

or headless against the saved study:

    SUBSTATION_VIEWS=hero,yard,control blender --background \
        docs/design/blender/substation/substation.blend \
        --python tools/blender/substation/render-substation.py

The script renders only the scene named 'SUBSTATION | Voxel Blitz map study',
adds one camera of its own, and writes docs/design/blender/substation/
render-<view>.png. Views are given in game voxel coordinates (x, y, z) and
converted to Blender's (x, z, y) authoring axes. SUBSTATION_SAMPLES overrides
the Cycles sample count (default 40).
"""
import json
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / 'docs/design/blender/substation'
SCENE_NAME = 'SUBSTATION | Voxel Blitz map study'

# name: (camera position, look-at target, lens mm), in game voxel coordinates
VIEWS = {
    'hero': ((138.0, 66.0, 128.0), (58.0, 14.0, 42.0), 36),
    'yard': ((36.0, 17.5, 22.0), (66.0, 19.0, 44.0), 28),
    'control': ((27.0, 24.0, 66.0), (64.0, 18.0, 46.0), 32),
    'preview': ((118.0, 27.0, 88.0), (58.0, 16.0, 42.0), 30),
}


def game_to_blender(point):
    x, y, z = point
    return Vector((x, z, y))


requested = globals().get('SUBSTATION_VIEWS') or os.environ.get('SUBSTATION_VIEWS', 'hero,yard,control')
if isinstance(requested, str):
    requested = [v for v in requested.split(',') if v]
samples = int(globals().get('SUBSTATION_SAMPLES') or os.environ.get('SUBSTATION_SAMPLES', '40'))

scene = bpy.data.scenes.get(SCENE_NAME)
if scene is None:
    raise RuntimeError(f'scene {SCENE_NAME!r} is not open; run build-substation.py first')
scene.render.engine = 'CYCLES'
scene.cycles.samples = samples
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 1280, 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'

cam_name = 'SUBSTATION | review camera'
cam_obj = bpy.data.objects.get(cam_name)
if cam_obj is None:
    cam_data = bpy.data.cameras.new(cam_name)
    cam_obj = bpy.data.objects.new(cam_name, cam_data)
    scene.collection.objects.link(cam_obj)
cam_obj.data.clip_end = 600
scene.camera = cam_obj

written = []
for name in requested:
    position, target, lens = VIEWS[name]
    cam_obj.location = game_to_blender(position)
    direction = game_to_blender(target) - cam_obj.location
    cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam_obj.data.lens = lens
    output = DOCS / f'render-{name}.png'
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True, scene=scene.name)
    written.append(str(output.relative_to(ROOT)))
    print(f'RENDER_SAVED {output.name}')

print('SUBSTATION-RENDER-DONE ' + json.dumps({'views': written, 'samples': samples}))
