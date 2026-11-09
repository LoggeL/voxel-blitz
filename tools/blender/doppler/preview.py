"""Fast shape check: build the geometry and render clay views (no materials, no bake).
blender --background --factory-startup --python tools/blender/doppler/preview.py -- <out_dir> [view ...]
"""
import math, sys
from pathlib import Path
import bpy
from mathutils import Vector
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / 'lib')]
import hardsurface as hs
import geometry

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
out = Path(argv[0]) if argv else HERE
views = argv[1:] or ['right', 'left', 'front34', 'rear34']
scene = bpy.context.scene
for ob in list(scene.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
st = hs.Study('DOPPLER')
geometry.build(st)
print('PARTS', len(st.objects), 'TRIS', st.triangles())
for part, obs in st.parts.items():
    print('  ', part, len(obs))
PALETTE = {'cerakote': (0.30, 0.30, 0.31), 'nitride': (0.035, 0.037, 0.04), 'polymer': (0.05, 0.052, 0.055),
           'stipple': (0.045, 0.047, 0.05), 'rubber': (0.025, 0.025, 0.027), 'steel': (0.55, 0.56, 0.58),
           'titanium': (0.55, 0.42, 0.62), 'brass': (0.80, 0.58, 0.22), 'copper': (0.72, 0.38, 0.22),
           'teal': (0.03, 0.24, 0.27), 'orange': (0.95, 0.30, 0.03), 'knurl': (0.06, 0.06, 0.065),
           'void': (0.004, 0.004, 0.004), 'glass': (0.6, 0.8, 0.9), 'lens': (0.2, 0.6, 0.7), 'smoke': (0.25, 0.2, 0.15)}
mats = {}
for key, col in PALETTE.items():
    m = bpy.data.materials.new(key); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Metallic'].default_value = 1.0 if key in ('steel', 'titanium', 'brass', 'copper', 'nitride') else 0.0
    b.inputs['Roughness'].default_value = 0.42
    if key in ('glass', 'lens', 'smoke'):
        b.inputs['Alpha'].default_value = 0.25 if key != 'smoke' else 0.45
        b.inputs['Transmission Weight'].default_value = 0.8
    mats[key] = m
for ob in st.objects:
    ob.data.materials.append(mats[ob['mat']])
world = bpy.data.worlds.new('w'); scene.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.055, 0.06, 0.07, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 1.0
def light(name, loc, energy, size, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, 'AREA'); d.energy = energy; d.size = size; d.color = color
    o = bpy.data.objects.new(name, d); scene.collection.objects.link(o); o.location = loc
    o.rotation_euler = (Vector((0, 0.17, 0.04)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
light('key', (0.5, -0.9, 1.2), 70, 1.2); light('fill', (-1.0, 0.6, 0.5), 30, 1.5, (0.8, 0.9, 1)); light('rim', (0.2, 1.2, -0.3), 40, 1.0)
light('low', (0.0, 0.2, -1.0), 14, 1.5); light('keyL', (-0.6, -1.0, 0.9), 50, 1.2)
cam_d = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_d); scene.collection.objects.link(cam); scene.camera = cam
scene.render.engine = 'CYCLES'; scene.cycles.samples = 24; scene.cycles.use_denoising = True
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences; prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for d in prefs.devices: d.use = True
    scene.cycles.device = 'GPU'
except Exception as e: print('cpu', e)
scene.render.resolution_x = 1800; scene.render.resolution_y = 900
scene.view_settings.view_transform = 'Standard'
# game -> blender: (x, -z, y). Views are given in game space.
VIEWS = {
    'right': dict(pos=(1.6, 0.03, -0.19), target=(0, 0.03, -0.19), ortho=1.02),
    'left': dict(pos=(-1.6, 0.03, -0.19), target=(0, 0.03, -0.19), ortho=1.02),
    'top': dict(pos=(0.0, 1.6, -0.19), target=(0, 0.03, -0.19), ortho=1.02),
    'bottom': dict(pos=(0.0, -1.6, -0.19), target=(0, 0.03, -0.19), ortho=1.02),
    'front34': dict(pos=(-0.55, 0.30, -1.10), target=(0, 0.02, -0.25), lens=70),
    'rear34': dict(pos=(-0.50, 0.32, 0.75), target=(0, 0.03, -0.15), lens=70),
    'rear34r': dict(pos=(0.55, 0.28, 0.70), target=(0, 0.03, -0.15), lens=70),
    'front': dict(pos=(0.0, 0.05, -1.4), target=(0, 0.02, 0), ortho=0.34),
    'rear': dict(pos=(0.0, 0.05, 1.4), target=(0, 0.02, 0), ortho=0.34),
    'fp': dict(pos=(-0.22, 0.24, 0.45), target=(-0.22, 0.24, -1.0), lens=23.5),
    'mech': dict(pos=(-0.40, 0.14, -0.02), target=(0, 0.045, -0.12), lens=85),
    'muzzle': dict(pos=(-0.22, 0.12, -0.86), target=(0, 0.04, -0.60), lens=85),
    'mag': dict(pos=(-0.42, -0.10, -0.52), target=(0, -0.08, -0.22), lens=85),
}
for name in views:
    v = VIEWS[name]
    cam.location = hs.blender(v['pos'])
    cam.rotation_euler = (hs.blender(v['target']) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    if 'ortho' in v: cam_d.type = 'ORTHO'; cam_d.ortho_scale = v['ortho']
    else: cam_d.type = 'PERSP'; cam_d.lens = v['lens']
    cam_d.clip_start = 0.01
    scene.render.filepath = str(out / f'clay-{name}.png')
    bpy.ops.render.render(write_still=True)
