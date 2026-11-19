"""Export edits from the packed RIVET Blender scene into the game's joint frames.

blender --background docs/design/blender/rivet/rivet.blend --python tools/blender/export-game-assets.py
Pass "-- /path/to/directory" to write an isolated geometry export for inspection.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rivet.blender_scene import ROOT, body_frames, scene_rig
from rivet.export import write_runtime, update_manifest
from rivet.model import MeshModel


def read_pieces(scene, rig):
    frames, _ = body_frames()
    graph = bpy.context.evaluated_depsgraph_get()
    model = MeshModel()
    for obj in scene.objects:
        joint = obj.get('rivet_joint')
        if not joint or obj.type != 'MESH':
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            # Rigid root motion and study arm splay are both removed; object
            # transforms performed by the artist within that frame are kept.
            frame, _ = frames[joint]
            to_local = (rig.matrix_world @ frame).inverted() @ evaluated.matrix_world
            normal_matrix = to_local.to_3x3().inverted().transposed()
            uv_layer = mesh.uv_layers.active
            if uv_layer is None:
                raise ValueError(f'{obj.name} lacks its material UV layer')
            batches = defaultdict(list)
            for tri in mesh.loop_triangles:
                mat = mesh.materials[tri.material_index]
                batches[mat['rivet_material']].append(tri)
            for mat, tris in batches.items():
                positions, normals, uvs, faces = [], [], [], []
                for tri in tris:
                    first = len(positions)
                    for loop_index in tri.loops:
                        vertex_index = mesh.loops[loop_index].vertex_index
                        positions.append(tuple(to_local @ mesh.vertices[vertex_index].co))
                        normals.append(tuple((normal_matrix @ mesh.corner_normals[loop_index].vector).normalized()))
                        uv = uv_layer.uv[loop_index].vector
                        uvs.append((uv.x, 1 - uv.y))
                    faces.append((first, first + 1, first + 2))
                model.mesh(joint, obj.name, mat, positions, faces, normals=normals, uvs=uvs)
        finally:
            evaluated.to_mesh_clear()
    found = {p.part for p in model.pieces}
    if found != set(frames):
        raise ValueError(f'RIVET joint mismatch: {found.symmetric_difference(frames)}')
    return model


scene = bpy.context.scene
rig = scene_rig(scene)
pose = rig.data.pose_position
try:
    rig.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    model = read_pieces(scene, rig)
finally:
    rig.data.pose_position = pose
isolated = '--' in sys.argv
output = Path(sys.argv[sys.argv.index('--') + 1]) if isolated else ROOT / 'public/assets/blender'
stats = write_runtime(model, output)
if not isolated:
    update_manifest(stats, output)
print(json.dumps(stats))
