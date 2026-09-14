"""Apply generated material scans to both studies and export clean GLB assets.

The texture pixels are unmodified ImageGen outputs. Rest-space planar UVs
give a consistent material scale. Roughness and bump are artistic estimates.
"""
import bpy
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/design/blender'
images={name:bpy.data.images.load(str(BASE/'textures'/f'{name}.png'),check_existing=True)
        for name in ['orange-painted-metal','ivory-armor','petrol-ballistic-fabric',
                     'worn-gunmetal','tan-webbing','worn-rubber']}
for image in images.values():
    image.colorspace_settings.name='sRGB'
    image.pack()


def assignment(name):
    if 'orange' in name.lower():return 'orange-painted-metal'
    if 'ceramic' in name.lower():return 'ivory-armor'
    if 'Suit |' in name:return 'petrol-ballistic-fabric'
    if 'Webbing' in name:return 'tan-webbing'
    if 'Joints' in name or 'rubber' in name:return 'worn-rubber'
    if 'Hardware' in name or 'machined steel' in name:return 'worn-gunmetal'
    if 'petrol paint' in name:return 'worn-gunmetal'
    return None


for material in bpy.data.materials:
    key=assignment(material.name)
    if not key or not material.use_nodes:continue
    nodes,links=material.node_tree.nodes,material.node_tree.links
    shader=nodes.get('Principled BSDF')
    if not shader:continue
    for node in list(nodes):
        if node.get('vb_generated_texture'):nodes.remove(node)
    tex=nodes.new('ShaderNodeTexImage')
    tex.image=images[key]
    tex.label='ImageGen | '+key
    tex['vb_generated_texture']=True
    tex.location=(-600,200)
    links.new(tex.outputs['Color'],shader.inputs['Base Color'])
    if 'petrol paint' in material.name:
        tint=nodes.new('ShaderNodeMix')
        tint.data_type='RGBA'
        tint.blend_type='MULTIPLY'
        tint.inputs[0].default_value=1
        tint_a=next(s for s in tint.inputs if s.name=='A' and s.type=='RGBA')
        tint_b=next(s for s in tint.inputs if s.name=='B' and s.type=='RGBA')
        tint_a.default_value=(.22,.65,.72,1)
        tint['vb_generated_texture']=True
        material['gltf_tint']=[.22,.65,.72,1]
        tint.location=(-280,240)
        links.new(tex.outputs['Color'],tint_b)
        links.new(next(s for s in tint.outputs if s.type=='RGBA'),shader.inputs['Base Color'])
    bump=nodes.new('ShaderNodeBump')
    bump['vb_generated_texture']=True
    bump.inputs['Strength'].default_value=.27 if 'fabric' in key or 'webbing' in key else .20
    bump.inputs['Distance'].default_value=.0012 if 'fabric' in key or 'webbing' in key else .0005
    bump.location=(-100,-160)
    links.new(tex.outputs['Color'],bump.inputs['Height'])
    links.new(bump.outputs['Normal'],shader.inputs['Normal'])
    # glTF keeps scalar roughness; Blender uses small image-driven variation.
    base_roughness=shader.inputs['Roughness'].default_value
    ramp=nodes.new('ShaderNodeMapRange')
    ramp['vb_generated_texture']=True
    ramp.inputs['From Min'].default_value=0
    ramp.inputs['From Max'].default_value=1
    ramp.inputs['To Min'].default_value=max(.15,base_roughness-.13)
    ramp.inputs['To Max'].default_value=min(.95,base_roughness+.09)
    links.new(tex.outputs['Color'],ramp.inputs['Value'])
    links.new(ramp.outputs['Result'],shader.inputs['Roughness'])
    material['imagegen_texture']=key+'.png'
    material['gltf_roughness']=base_roughness


def merge_weapon(scene,rig):
    if scene.objects.get('KESTREL_SkinnedMesh'):return
    source=bpy.data.collections.new('KESTREL SOURCE | individually editable parts')
    export=bpy.data.collections.new('KESTREL EXPORT | rig and merged skin')
    scene.collection.children.link(source)
    scene.collection.children.link(export)
    duplicates=[]
    for obj in list(rig.children):
        if obj.type!='MESH':continue
        for c in list(obj.users_collection):c.objects.unlink(obj)
        source.objects.link(obj)
        duplicate=obj.copy()
        duplicate.data=obj.data.copy()
        export.objects.link(duplicate)
        duplicates.append(duplicate)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in duplicates:obj.select_set(True)
    bpy.context.view_layer.objects.active=duplicates[0]
    bpy.ops.object.join()
    bpy.context.object.name='KESTREL_SkinnedMesh'
    source.hide_viewport=True
    source.hide_render=True


def uv_map(obj):
    layer=obj.data.uv_layers.active
    if layer is None:
        layer=obj.data.uv_layers.new(name='MaterialUV')
    # Coordinates from the rest mesh, never from the animated pose.
    transform=obj.matrix_world
    for polygon in obj.data.polygons:
        normal=transform.to_3x3()@polygon.normal
        axis=max(range(3),key=lambda i:abs(normal[i]))
        axes=[i for i in range(3) if i!=axis]
        for loop_index in polygon.loop_indices:
            vertex=obj.data.vertices[obj.data.loops[loop_index].vertex_index]
            p=transform@vertex.co
            layer.data[loop_index].uv=(p[axes[0]]*3.2,p[axes[1]]*3.2)


results=[]
for prefix,slug,rig_name in [('RIVET','rivet','RIVET_Rig'),('KESTREL','kestrel','KESTREL_Rig')]:
    scene=next(s for s in bpy.data.scenes if s.name.startswith(prefix+' |'))
    bpy.context.window.scene=scene
    rig=scene.objects[rig_name]
    scene.frame_set(1)
    if prefix=='KESTREL':merge_weapon(scene,rig)
    for obj in list(scene.objects):
        if obj.type=='MESH' and obj.parent==rig:uv_map(obj)
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    export_objects=[rig]
    for obj in rig.children:
        if obj.type=='EMPTY' or obj.name==prefix+'_SkinnedMesh':
            obj.select_set(True)
            export_objects.append(obj)
    bpy.context.view_layer.objects.active=rig
    # Temporarily use constant roughness for a portable standard glTF material.
    material_links=[]
    for material in bpy.data.materials:
        if 'gltf_roughness' not in material:continue
        shader=material.node_tree.nodes.get('Principled BSDF')
        for socket_name in ['Roughness','Normal']:
            for link in list(shader.inputs[socket_name].links):
                material_links.append((material,link.from_socket,link.to_socket))
                material.node_tree.links.remove(link)
        shader.inputs['Roughness'].default_value=material['gltf_roughness']
    bpy.ops.export_scene.gltf(filepath=str(BASE/slug/(slug+'.glb')),
        export_format='GLB',use_selection=True,use_active_scene=True,
        export_animation_mode='ACTIONS',export_anim_single_armature=False,
        export_animations=True,export_extras=True,export_skins=True,
        export_image_format='AUTO')
    for material,source,target in material_links:material.node_tree.links.new(source,target)
    manifest_path=BASE/slug/'manifest.json'
    manifest=json.loads(manifest_path.read_text())
    manifest['skin_meshes']=1
    manifest['imagegen_textures']=sorted({material['imagegen_texture']
        for obj in export_objects if obj.type=='MESH' for material in obj.data.materials
        if material and 'imagegen_texture' in material})
    manifest['glb_bytes']=(BASE/slug/(slug+'.glb')).stat().st_size
    manifest['material_note']='ImageGen albedo embedded in GLB. Bump and image-driven roughness are Blender shader estimates; GLB uses scalar roughness.'
    if prefix=='KESTREL':
        manifest['integration_remaining'][0]='Browser draw-call and animation budget'
    manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
    scene.render.filepath=str(BASE/slug/('rivet-front.png' if slug=='rivet' else 'kestrel.png'))
    # Enable Metal Cycles when supported; CPU remains the deterministic fallback.
    prefs=bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type='METAL'
        prefs.get_devices()
        for device in prefs.devices:device.use=device.type=='METAL'
        scene.cycles.device='GPU' if any(d.type=='METAL' for d in prefs.devices) else 'CPU'
    except Exception:scene.cycles.device='CPU'
    bpy.ops.wm.save_as_mainfile(filepath=str(BASE/slug/(slug+'.blend')))
    results.append({'asset':prefix,'objects':[obj.name for obj in export_objects],
                    'device':scene.cycles.device,'glb_bytes':manifest['glb_bytes']})
print(json.dumps(results,indent=2))
