"""Export the editable pieces as one skinned, animated, self-contained GLB."""
import json

import bpy


def export_skin(scene, rig, output):
    pieces = [obj for obj in scene.objects if obj.type == 'MESH' and 'rivet_joint' in obj]
    if not pieces:
        raise ValueError('The scene has no RIVET joint meshes.')
    # Build a temporary joined copy for transport. Edits made to individual
    # pieces remain authoritative in the .blend on subsequent exports.
    scratch = bpy.data.collections.new('Temporary GLB export')
    scene.collection.children.link(scratch)
    duplicates = []
    for piece in pieces:
        clone = piece.copy()
        clone.data = piece.data.copy()
        scratch.objects.link(clone)
        duplicates.append(clone)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in duplicates:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = duplicates[0]
    bpy.ops.object.join()
    skin = bpy.context.view_layer.objects.active
    skin.name = 'RIVET_SkinnedMesh'
    skin.data.calc_loop_triangles()
    triangles = len(skin.data.loop_triangles)
    images = sorted({m['rivet_image'] for m in skin.data.materials if 'rivet_image' in m})
    skin.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    # glTF has no height-map input. The Blender exporter otherwise treats a
    # Bump node's scalar image as a tangent-space normal vector.
    height_links = []
    for mat in skin.data.materials:
        shader = mat.node_tree.nodes.get('Principled BSDF')
        for link in list(shader.inputs['Normal'].links):
            if link.from_node.type == 'BUMP':
                height_links.append((mat.node_tree, link.from_socket, link.to_socket))
                mat.node_tree.links.remove(link)
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(output / 'rivet.glb'), export_format='GLB', use_selection=True,
            use_active_scene=True, export_animations=True, export_animation_mode='ACTIONS',
            export_anim_single_armature=False, export_skins=True, export_image_format='AUTO',
        )
        report = {
            'asset': 'RIVET',
            'design': 'Alpine rescue operator',
            'blender': bpy.app.version_string,
            'authoring_source': 'tools/blender/build-character.py',
            'editable_parts': len(pieces),
            'runtime_joints': len({p['rivet_joint'] for p in pieces}),
            'skin_meshes': 1, 'materials': len(skin.data.materials), 'triangles': triangles,
            'bones': [b.name for b in rig.data.bones], 'animations': ['Idle', 'Walk'],
            'embedded_textures': images, 'glb_bytes': (output / 'rivet.glb').stat().st_size,
            'runtime': {
                'path': 'public/assets/blender/rivet.gltf',
                'exporter': 'tools/blender/export-game-assets.py',
                'animation': 'Game stance and inverse kinematics',
            },
        }
        (output / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
        return report
    finally:
        for tree, source, target in height_links:
            tree.links.new(source, target)
        mesh = skin.data
        bpy.data.objects.remove(skin, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        bpy.data.collections.remove(scratch)
