"""Build the editable RIVET operator and its standalone skinned GLB.

blender --background --factory-startup --python tools/blender/build-character.py
"""
import json
import sys
from pathlib import Path

import bpy

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from rivet.blender_scene import OUT, add_piece, animate, body_frames, make_rig, material_library, scene_studio
from rivet.model import build_model
from rivet.standalone import export_skin

OUT.mkdir(parents=True, exist_ok=True)
factory_session = bpy.app.background and '--factory-startup' in sys.argv and not bpy.data.filepath
if factory_session:
    bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.data.scenes.new('RIVET | Alpine rescue operator')
bpy.context.window.scene = scene
if factory_session:
    for empty in list(bpy.data.scenes):
        if empty != scene:
            bpy.data.scenes.remove(empty)
scene_studio(scene)
frames, bones = body_frames()
rig = make_rig(scene, bones)
materials = material_library()
collections = {}
for joint in frames:
    collection = bpy.data.collections.new(joint)
    scene.collection.children.link(collection)
    collections[joint] = collection

model = build_model()
for piece in model.pieces:
    frame, bone = frames[piece.part]
    add_piece(piece, frame, bone, rig, collections[piece.part], materials[piece.mat])

animate(rig)
scene.frame_start, scene.frame_end = 1, 73
scene.frame_set(1)
scene.render.filepath = str(OUT / 'rivet-front.png')
metrics = export_skin(scene, rig, OUT)
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = rig
# A normal .blend opens directly to the portrait camera. If called inside an
# existing project, isolate the new scene and its dependencies in the export.
if factory_session:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'rivet.blend'), copy=True, compress=True)
else:
    bpy.data.libraries.write(str(OUT / 'rivet.blend'), {scene}, path_remap='RELATIVE_ALL', compress=True)
print('RIVET_AUTHORING', json.dumps(metrics))
