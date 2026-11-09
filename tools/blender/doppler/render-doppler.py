"""Studio proof renders of the baked SP-2 DOPPLER game mesh.

blender --background --factory-startup docs/design/blender/doppler/doppler.blend \
  --python tools/blender/doppler/render-doppler.py [-- <out_dir> view ...]
"""
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path[:0] = [str(HERE.parent / 'lib')]
import hardsurface as hs      # noqa: E402
import pbr_bake as pb         # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
out = Path(argv[0]) if argv else ROOT / 'docs/design/blender/doppler'
VIEWS = {
    'hero': dict(pos=(-0.74, 0.34, -1.16), target=(0.0, 0.005, -0.20), lens=50),
    'side': dict(pos=(1.6, 0.02, -0.195), target=(0, 0.02, -0.195), ortho=1.02),
    'left': dict(pos=(-1.6, 0.02, -0.195), target=(0, 0.02, -0.195), ortho=1.02),
    'rear': dict(pos=(-0.52, 0.34, 0.80), target=(0, 0.03, -0.14), lens=66),
    'rear-right': dict(pos=(0.60, 0.26, 0.74), target=(0, 0.03, -0.16), lens=66),
    'top': dict(pos=(0.0, 1.6, -0.195), target=(0, 0.03, -0.195), ortho=1.02, up=(-1, 0, 0)),
    'bottom': dict(pos=(0.0, -1.6, -0.195), target=(0, 0.03, -0.195), ortho=1.02, up=(1, 0, 0)),
    'fp': dict(pos=(-0.22, 0.24, 0.45), target=(-0.22, 0.24, -1.0), lens=23.5),
    'ads': dict(pos=(0.0, 0.142, 0.42), target=(0.0, 0.142, -1.0), lens=23.5),
    'mech': dict(pos=(-0.36, 0.13, 0.03), target=(0, 0.045, -0.10), lens=90),
    'muzzle': dict(pos=(-0.22, 0.13, -0.88), target=(0, 0.035, -0.60), lens=90),
    'mag': dict(pos=(-0.40, -0.06, -0.50), target=(0, -0.085, -0.215), lens=90),
    'port-right': dict(pos=(0.36, 0.10, -0.42), target=(0, 0.05, -0.18), lens=90),
    'stock': dict(pos=(-0.42, 0.16, 0.42), target=(0, 0.03, 0.12), lens=80),
}
views = argv[1:] or ['hero', 'side', 'left', 'rear', 'fp']
scene = bpy.context.scene
pb.use_gpu(scene)
scene.cycles.samples = 96
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 1800, 1000
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'

world = bpy.data.worlds.new('studio')
scene.world = world
world.use_nodes = True
nt = world.node_tree
bg = nt.nodes['Background']
sky = nt.nodes.new('ShaderNodeTexGradient')
coord = nt.nodes.new('ShaderNodeTexCoord')
mapping = nt.nodes.new('ShaderNodeMapping')
mapping.inputs['Rotation'].default_value = (0, 1.5708, 0)
ramp = nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].color = (0.012, 0.014, 0.018, 1)
ramp.color_ramp.elements[1].color = (0.085, 0.095, 0.115, 1)
nt.links.new(coord.outputs['Generated'], mapping.inputs[0])
nt.links.new(mapping.outputs[0], sky.inputs[0])
nt.links.new(sky.outputs[0], ramp.inputs[0])
nt.links.new(ramp.outputs[0], bg.inputs[0])
bg.inputs[1].default_value = 1.0


def light(name, pos, energy, size, color=(1, 1, 1), target=(0, 0.03, -0.2)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.size, data.color = energy, size, color
    ob = bpy.data.objects.new(name, data)
    scene.collection.objects.link(ob)
    ob.location = hs.blender(pos)
    ob.rotation_euler = (hs.blender(target) - ob.location).to_track_quat('-Z', 'Y').to_euler()
    return ob


light('key', (-0.9, 1.3, -0.9), 34, 1.4, (1.0, 0.97, 0.93))
light('key-right', (1.0, 1.1, -0.2), 20, 1.4, (1.0, 0.97, 0.93))
light('fill', (0.2, 0.2, 1.4), 8, 2.0, (0.80, 0.88, 1.0))
light('rim', (0.8, 0.5, -1.5), 30, 0.8, (0.85, 0.92, 1.0))
light('under', (-0.2, -1.0, -0.2), 4, 2.0)
strip = light('strip', (-1.1, 0.35, -0.2), 14, 0.25)
strip.data.shape = 'RECTANGLE'
strip.data.size, strip.data.size_y = 0.12, 1.6

cam_data = bpy.data.cameras.new('camera')
cam = bpy.data.objects.new('camera', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.clip_start = 0.01
for name in views:
    v = VIEWS[name]
    cam.location = hs.blender(v['pos'])
    direction = hs.blender(v['target']) - cam.location
    quat = direction.to_track_quat('-Z', 'Y')
    cam.rotation_euler = quat.to_euler()
    if 'up' in v:
        up = hs.blender(v['up'])
        fwd = direction.normalized()
        right = fwd.cross(up).normalized()
        real_up = right.cross(fwd)
        from mathutils import Matrix
        m = Matrix((right, real_up, -fwd)).transposed()
        cam.rotation_euler = m.to_euler()
    if 'ortho' in v:
        cam_data.type, cam_data.ortho_scale = 'ORTHO', v['ortho']
    else:
        cam_data.type, cam_data.lens = 'PERSP', v['lens']
    scene.render.filepath = str(out / f'render-{name}.png')
    bpy.ops.render.render(write_still=True)
    print('[render]', scene.render.filepath)
