"""Independent, read-only source and export correspondence audit.

blender --background docs/design/blender/omp-weapon/weapon.blend \
  --python tools/blender/audit-weapon-source.py
"""
import bpy
import bmesh
import json
import hashlib
from pathlib import Path
from mathutils import Vector
from mathutils.kdtree import KDTree

root = Path(__file__).resolve().parents[2]
out = root / '.artifacts/omp-weapon/review'
out.mkdir(parents=True, exist_ok=True)
depsgraph = bpy.context.evaluated_depsgraph_get()
objects = []
source_coords = {}
hashes = {name: hashlib.sha256((root / path).read_bytes()).hexdigest() for name, path in {
    'blend': 'docs/design/blender/omp-weapon/weapon.blend',
    'glb': 'public/assets/blender/omp-weapon/weapon.glb',
}.items()}
for obj in bpy.context.scene.objects:
    if obj.type != 'MESH':
        continue
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    # Text caps can use duplicate seam vertices; weld coincident positions
    # before reporting boundary topology so those seams are not false defects.
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    coords = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    source_coords[obj.name] = coords
    low = [min(v[i] for v in coords) for i in range(3)]
    high = [max(v[i] for v in coords) for i in range(3)]
    objects.append({
        'name': obj.name,
        'location': list(obj.location),
        'rotation': list(obj.rotation_euler),
        'bounds_blender': {'min': low, 'max': high},
        'vertices': len(mesh.vertices),
        'boundary_edges': sum(edge.is_boundary for edge in bm.edges),
        'nonmanifold_edges': sum(not edge.is_manifold for edge in bm.edges),
        'local_vertex_sample': [list(v.co) for v in mesh.vertices[:3]],
    })
    bm.free()
    evaluated.to_mesh_clear()

report = {'hashes': hashes, 'objects': objects, 'packed_images': [
    {'name': image.name, 'packed': bool(image.packed_file), 'size': list(image.size)}
    for image in bpy.data.images if image.type == 'IMAGE'
]}
report['coincident_pairs'] = []
for i, a in enumerate(objects):
    for b in objects[i+1:]:
        if a['vertices'] == b['vertices'] and all(
            abs(x-y) < 1e-7 for bound in ('min', 'max')
            for x, y in zip(a['bounds_blender'][bound], b['bounds_blender'][bound])
        ):
            report['coincident_pairs'].append([a['name'], b['name']])

# Import the delivered GLB into a new empty scene and check whether the actual
# world-space vertices of each source object survived the batch export.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(root / 'public/assets/blender/omp-weapon/weapon.glb'))
bpy.context.view_layer.update()
delivered = [obj.matrix_world @ v.co for obj in bpy.context.scene.objects
             if obj.type == 'MESH' for v in obj.data.vertices]
kd = KDTree(len(delivered))
for i, co in enumerate(delivered):
    kd.insert(co, i)
kd.balance()
report['source_export_mismatches'] = []
for name, coords in source_coords.items():
    distances = [kd.find(co)[2] for co in coords]
    misses = sum(d > 1e-5 for d in distances)
    if misses:
        report['source_export_mismatches'].append({
            'name': name, 'missing_vertices': misses,
            'vertices': len(coords), 'max_distance_metres': max(distances),
        })
(out / 'source-inspection.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'objects': len(objects), 'nonmanifold': [
    o for o in objects if o['nonmanifold_edges']
], 'coincident_pairs': report['coincident_pairs'],
    'source_export_mismatches': report['source_export_mismatches']}, indent=2))
