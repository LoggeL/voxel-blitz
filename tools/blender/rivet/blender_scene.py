"""RIVET's assembled rest frames and Blender authoring helpers."""
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/design/blender/rivet'
# Game Y-up, facing -Z; Blender Z-up, facing +Y.
GAME_TO_BLENDER = Matrix.Rotation(math.pi / 2, 4, 'X')


def body_frames():
    """Author arms in a relaxed A-pose while keeping each runtime part joint-local."""
    frames = {}
    bones = {}

    def add_bone(name, start, end, parent=None):
        bones[name] = (GAME_TO_BLENDER @ Vector(start), GAME_TO_BLENDER @ Vector(end), parent)

    add_bone('root', (0, 0, 0), (0, .18, 0))
    add_bone('pelvis', (0, .84, 0), (0, .99, 0), 'root')
    add_bone('spine', (0, .99, 0), (0, 1.18, 0), 'pelvis')
    add_bone('chest', (0, 1.18, 0), (0, 1.435, 0), 'spine')
    add_bone('neck', (0, 1.435, 0), (0, 1.61, 0), 'chest')
    add_bone('head', (0, 1.61, 0), (0, 1.83, 0), 'neck')

    def place(part, bone, origin, rotation=None):
        local = Matrix.Translation(origin)
        if rotation is not None:
            local = local @ rotation
        frames[part] = (GAME_TO_BLENDER @ local, bone)
        return local

    place('head', 'head', (0, 1.66, 0))
    place('torso', 'chest', (0, 1.18, 0))
    place('hips', 'pelvis', (0, .84, 0))
    place('pack', 'chest', (0, 1.38, .18))
    place('pouches', 'spine', (0, 1.105, -.19))

    for side, prefix, suffix in [(-1, 'l', '.R'), (1, 'r', '.L')]:
        hip = (side * .16, .73, 0)
        knee = (side * .16, .405, 0)
        boot = (side * .16, .08, 0)
        for joint, bone, start, end, parent in [
            ('Thigh', 'thigh', hip, knee, 'pelvis'),
            ('Knee', 'shin', knee, boot, 'thigh' + suffix),
            ('Boot', 'foot', boot, (side * .16, .035, -.18), 'shin' + suffix),
        ]:
            add_bone(bone + suffix, start, end, parent)
            place(prefix + joint, bone + suffix, start)

        shoulder = (side * .32, 1.43, 0)
        upper_rotation = Matrix.Rotation(side * .23, 4, 'Z')
        lower_rotation = upper_rotation @ Matrix.Rotation(.17, 4, 'X')
        wrist_rotation = lower_rotation @ Matrix.Rotation(-side * .2, 4, 'Y')
        upper = place(prefix + 'Arm', 'upper_arm' + suffix, shoulder, upper_rotation)
        elbow = upper @ Vector((0, -.34, 0))
        lower = place(prefix + 'Elbow', 'forearm' + suffix, elbow, lower_rotation)
        wrist = lower @ Vector((0, -.34, 0))
        hand = place(prefix + 'Hand', 'hand' + suffix, wrist, wrist_rotation)

        add_bone('clavicle' + suffix, (side * .075, 1.422, 0), shoulder, 'chest')
        add_bone('upper_arm' + suffix, shoulder, elbow, 'clavicle' + suffix)
        add_bone('forearm' + suffix, elbow, wrist, 'upper_arm' + suffix)
        add_bone('hand' + suffix, wrist, hand @ Vector((0, -.09, 0)), 'forearm' + suffix)
    return frames, bones


def make_rig(scene, bones):
    armature = bpy.data.armatures.new('RIVET skeleton')
    rig = bpy.data.objects.new('RIVET_Rig', armature)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (start, end, parent) in bones.items():
        bone = armature.edit_bones.new(name)
        bone.head, bone.tail = start, end
        if parent:
            bone.parent = armature.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    armature.display_type = 'STICK'
    rig['asset_id'] = 'rivet'
    return rig


def scene_rig(scene):
    # Blender suffixes display names when building into a populated session.
    return next(obj for obj in scene.objects if obj.type == 'ARMATURE' and obj.get('asset_id') == 'rivet')


def add_clip(rig, name, length, walking):
    rig.animation_data.action = bpy.data.actions.new(name)
    action = rig.animation_data.action
    for frame in range(1, length + 2, 2):
        phase = (frame - 1) / length * math.tau
        for bone in rig.pose.bones:
            bone.rotation_mode = 'XYZ'
            bone.rotation_euler = (0, 0, 0)
            bone.location = (0, 0, 0)
        rig.pose.bones['chest'].rotation_euler.x = math.sin(phase) * (.025 if walking else .012)
        rig.pose.bones['head'].rotation_euler.y = math.sin(phase) * .035
        rig.pose.bones['pelvis'].location.y = (1 - math.cos(phase * 2)) * (.012 if walking else .002)
        for side, suffix in [(-1, '.R'), (1, '.L')]:
            swing = math.sin(phase) * side
            if walking:
                rig.pose.bones['thigh' + suffix].rotation_euler.x = swing * .48
                rig.pose.bones['shin' + suffix].rotation_euler.x = max(0, -swing) * .65
                rig.pose.bones['foot' + suffix].rotation_euler.x = -max(0, -swing) * .25
                rig.pose.bones['upper_arm' + suffix].rotation_euler.x = -swing * .36
                rig.pose.bones['forearm' + suffix].rotation_euler.x = -.1 - max(0, swing) * .2
            else:
                rig.pose.bones['upper_arm' + suffix].rotation_euler.z = swing * .01
        for bone in rig.pose.bones:
            bone.keyframe_insert('rotation_euler', frame=frame)
        rig.pose.bones['pelvis'].keyframe_insert('location', frame=frame)
    action.use_fake_user = True
    return action


def animate(rig):
    rig.animation_data_create()
    actions = [add_clip(rig, 'Idle', 72, False), add_clip(rig, 'Walk', 24, True)]
    rig.animation_data.action = None
    for action in actions:
        track = rig.animation_data.nla_tracks.new()
        track.name = action.name
        track.strips.new(action.name, 1, action)
        track.mute = True
    rig.animation_data.action = actions[0]


def material_library():
    from rivet.materials import MATERIALS
    result = {}
    for key, desc in MATERIALS.items():
        mat = bpy.data.materials.new(desc['name'])
        mat.use_nodes = True
        mat['rivet_material'] = key
        color = (*desc['color'], 1)
        mat.diffuse_color = color
        shader = mat.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value = color
        shader.inputs['Roughness'].default_value = desc['roughness']
        shader.inputs['Metallic'].default_value = desc['metalness']
        if desc.get('texture'):
            path = ROOT / 'public/assets/blender' / desc['texture']
            image = bpy.data.images.load(str(path), check_existing=True)
            if not image.packed_file:
                image.pack()
            tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
            tex.image = image
            tex.location = (-620, 240)
            # The glTF exporter recognizes the multiply node as baseColorFactor.
            multiply = mat.node_tree.nodes.new('ShaderNodeMix')
            multiply.data_type = 'RGBA'
            multiply.blend_type = 'MULTIPLY'
            multiply.inputs[0].default_value = 1
            a = next(s for s in multiply.inputs if s.name == 'A' and s.type == 'RGBA')
            b = next(s for s in multiply.inputs if s.name == 'B' and s.type == 'RGBA')
            b.default_value = color
            multiply.location = (-300, 240)
            mat.node_tree.links.new(tex.outputs['Color'], a)
            mat.node_tree.links.new(next(s for s in multiply.outputs if s.type == 'RGBA'),
                                    shader.inputs['Base Color'])
            height = desc.get('extras', {}).get('textureBumpScale')
            if height:
                bump = mat.node_tree.nodes.new('ShaderNodeBump')
                bump.inputs['Distance'].default_value = height
                bump.location = (-300, -40)
                mat.node_tree.links.new(tex.outputs['Color'], bump.inputs['Height'])
                mat.node_tree.links.new(bump.outputs['Normal'], shader.inputs['Normal'])
            mat['rivet_image'] = path.name
        result[key] = mat
    return result


def add_piece(piece, frame, bone, rig, collection, material):
    from rivet.export import corners
    # Use the runtime corner data for shading and UV seams, with welded edit vertices.
    lookup, verts, faces, normals, uvs = {}, [], [], [], []
    for triangle in corners(piece):
        indices = []
        for position, normal, uv in triangle:
            key = tuple(position)
            if key not in lookup:
                lookup[key] = len(verts)
                verts.append(key)
            indices.append(lookup[key])
            normals.append(normal)
            uvs.extend((uv[0], 1 - uv[1]))
        faces.append(indices)
    mesh = bpy.data.meshes.new(piece.name)
    mesh.from_pydata(verts, [], faces, shade_flat=False)
    mesh.update()
    mesh.normals_split_custom_set(normals)
    uv_layer = mesh.uv_layers.new(name='MaterialUV')
    uv_layer.uv.foreach_set('vector', uvs)
    obj = bpy.data.objects.new(piece.name, mesh)
    collection.objects.link(obj)
    mesh.materials.append(material)
    obj['rivet_joint'] = piece.part
    obj.parent = rig
    obj.matrix_basis = frame
    group = obj.vertex_groups.new(name=bone)
    group.add(list(range(len(verts))), 1, 'REPLACE')
    obj.modifiers.new('Character rig', 'ARMATURE').object = rig
    return obj


def scene_studio(scene):
    scene.unit_settings.system = 'METRIC'
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1150
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.fps = 24
    scene.view_settings.view_transform = 'AgX'
    scene.world = bpy.data.worlds.new('Rivet softbox studio')
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (.24, .29, .34, 1)
    bg.inputs[1].default_value = .52
    stage = bpy.data.collections.new('Studio lights and floor')
    scene.collection.children.link(stage)

    def area(name, loc, power, color, size, target):
        data = bpy.data.lights.new(name, 'AREA')
        data.energy, data.color, data.size = power, color, size
        obj = bpy.data.objects.new(name, data)
        stage.objects.link(obj)
        obj.location = loc
        obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

    area('Key softbox', (-2.8, 3.1, 4.2), 375, (1, .86, .72), 2.8, (0,0,1.1))
    area('Front fill', (2.7, 2.5, 2.9), 225, (.72, .86, 1), 2, (0,0,1.2))
    area('Rear strip', (.7, -2.2, 3), 425, (.7, .86, 1), 2, (0,0,1.2))
    area('Visor card', (-.5, 1.4, 2.3), 18, (1, .92, .8), .45, (0,0,1.6))
    floor_mesh = bpy.data.meshes.new('Cyclorama floor')
    floor_mesh.from_pydata([(-80,-80,0),(80,-80,0),(80,80,0),(-80,80,0)], [], [(0,1,2,3)])
    floor = bpy.data.objects.new('Studio floor', floor_mesh)
    stage.objects.link(floor)
    floor.location.z = .006
    floor_material = bpy.data.materials.new('Stage graphite')
    floor_material.diffuse_color = (.056,.071,.084,1)
    floor_material.use_nodes = True
    floor_shader = floor_material.node_tree.nodes.get('Principled BSDF')
    floor_shader.inputs['Base Color'].default_value = floor_material.diffuse_color
    floor_shader.inputs['Roughness'].default_value = .87
    floor_mesh.materials.append(floor_material)

    camera = bpy.data.objects.new('Portrait camera', bpy.data.cameras.new('Portrait lens'))
    stage.objects.link(camera)
    camera.location = (1.6, 4.6, 1.98)
    camera.rotation_euler = (Vector((0,0,.93)) - camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 2.14
    scene.camera = camera
    for area in bpy.context.screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.shading.type = 'MATERIAL'
            area.spaces.active.overlay.show_overlays = False
