"""Apply shared ImageGen surface textures without rebuilding any weapon geometry.

The final export stage calls finish_asset(slug). It updates the editable Blender
source, portable GLB and browser glTF together. Blender's palette_texture and
runtime extras.textureLibrary are the material source of truth. Base-color images
also drive subtle artistic bump; this is not a measured PBR scan set.
"""
import hashlib
import json
import re
import shutil
import struct
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
LIB=ROOT/'docs/design/blender/material-library'
CONFIG=json.loads((LIB/'materials.json').read_text())
ASSETS=CONFIG['assets']
BACKUP=ROOT/'.artifacts/weapon-materials/before'


def assignment(name):
    label=re.sub(r'\.\d+$','',name.split(' | ')[-1]).strip().lower()
    return CONFIG['assignment'].get(label)


def backup(path):
    target=BACKUP/path.relative_to(ROOT)
    if path.exists() and not target.exists():
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,target)


def source_image(key):
    return ROOT/'public/assets/blender/textures/palette'/f'{key}.jpg'


def apply_scene(scene):
    import bpy
    materials={m for obj in scene.objects if obj.type=='MESH' for m in obj.data.materials if m}
    applied=[]
    for material in materials:
        key=assignment(material.name)
        if not key:continue
        image_path=source_image(key)
        if not image_path.exists():raise FileNotFoundError(image_path)
        spec=CONFIG['materials'][key]
        image=bpy.data.images.load(str(image_path),check_existing=True)
        image.name='textures/palette/'+key+'.jpg';image.colorspace_settings.name='sRGB';image.pack()
        material.use_nodes=True
        nodes=material.node_tree.nodes;nodes.clear();links=material.node_tree.links
        shader=nodes.new('ShaderNodeBsdfPrincipled');shader.location=(100,60)
        output=nodes.new('ShaderNodeOutputMaterial');output.location=(420,60)
        tex=nodes.new('ShaderNodeTexImage');tex.location=(-530,120);tex.image=image
        tex.label='ImageGen | '+key;tex.interpolation='Linear';tex.extension='REPEAT'
        links.new(tex.outputs['Color'],shader.inputs['Base Color'])
        bump=nodes.new('ShaderNodeBump');bump.location=(-150,-140)
        bump.inputs['Strength'].default_value=1
        bump.inputs['Distance'].default_value=spec['bump']
        links.new(tex.outputs['Color'],bump.inputs['Height']);links.new(bump.outputs['Normal'],shader.inputs['Normal'])
        shader.inputs['Metallic'].default_value=spec['metal']
        shader.inputs['Roughness'].default_value=spec['rough']
        links.new(shader.outputs['BSDF'],output.inputs['Surface'])
        # Existing exporters use their legacy fixed texture tables, then this
        # final stage applies palette_texture consistently to their output.
        if 'imagegen_texture' in material:del material['imagegen_texture']
        material['palette_texture']='palette/'+key+'.jpg'
        material['gltf_tint']=[1,1,1]
        material['gltf_roughness']=spec['rough']
        material['textureBumpScale']=spec['bump']
        applied.append({'material':material.name,'texture':key})
    return applied


def patch_document(doc,binary=None):
    images=doc.setdefault('images',[]);textures=doc.setdefault('textures',[])
    samplers=doc.setdefault('samplers',[])
    if not samplers:samplers.append({'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497})
    applied=[]
    for material in doc.get('materials',[]):
        key=assignment(material.get('name',''))
        if not key:continue
        spec=CONFIG['materials'][key];uri=f'textures/palette/{key}.jpg'
        image_index=next((i for i,v in enumerate(images) if v.get('uri')==uri or v.get('name')==uri),None)
        if image_index is None:
            image_index=len(images)
            if binary is None:images.append({'uri':uri,'name':uri})
            else:
                while len(binary)%4:binary.append(0)
                start=len(binary);binary.extend(source_image(key).read_bytes())
                views=doc.setdefault('bufferViews',[])
                view=len(views);views.append({'buffer':0,'byteOffset':start,'byteLength':len(binary)-start})
                images.append({'name':uri,'mimeType':'image/jpeg','bufferView':view})
        texture_index=next((i for i,v in enumerate(textures) if v.get('source')==image_index),None)
        if texture_index is None:
            texture_index=len(textures);textures.append({'source':image_index,'sampler':0})
        pbr=material.setdefault('pbrMetallicRoughness',{})
        pbr['baseColorTexture']={'index':texture_index};pbr['baseColorFactor']=[1,1,1,1]
        pbr['metallicFactor']=spec['metal'];pbr['roughnessFactor']=spec['rough']
        material.setdefault('extras',{}).update({'textureLibrary':key,'textureBumpScale':spec['bump']})
        applied.append({'material':material['name'],'texture':key})
    return applied


def patch_gltf(path):
    backup(path);doc=json.loads(path.read_text())
    geometry={k:doc.get(k) for k in ('nodes','meshes','accessors','bufferViews','buffers','scenes','skins','animations')}
    snapshot=json.dumps(geometry,sort_keys=True)
    applied=patch_document(doc)
    assert json.dumps({k:doc.get(k) for k in geometry},sort_keys=True)==snapshot
    path.write_text(json.dumps(doc,separators=(',',':'))+'\n')
    return applied


def patch_glb(path):
    backup(path);data=path.read_bytes();offset=12;chunks=[]
    while offset<len(data):
        length,kind=struct.unpack_from('<II',data,offset);offset+=8
        chunks.append((kind,data[offset:offset+length]));offset+=length
    doc=json.loads(next(c for t,c in chunks if t==0x4e4f534a))
    binary=bytearray(next(c for t,c in chunks if t==0x004e4942))
    original=bytes(binary)
    applied=patch_document(doc,binary)
    assert binary[:len(original)]==original, 'material update changed geometry bytes'
    doc['buffers'][0]['byteLength']=len(binary)
    while len(binary)%4:binary.append(0)
    payload=json.dumps(doc,separators=(',',':')).encode()
    while len(payload)%4:payload+=b' '
    body=struct.pack('<II',len(payload),0x4e4f534a)+payload+struct.pack('<II',len(binary),0x004e4942)+binary
    path.write_bytes(struct.pack('<III',0x46546c67,2,12+len(body))+body)
    return applied


def finish_asset(slug,scene=None):
    """Final material stage after the weapon-specific authoring/export script."""
    assert slug in ASSETS,slug
    import bpy
    directory=ROOT/'docs/design/blender'/slug
    blend=directory/(slug+'.blend');backup(blend)
    loaded=[]
    if scene is None:
        # Load isolated datablocks, preserving whatever the user has open.
        with bpy.data.libraries.load(str(blend),link=False) as (src,dst):
            dst.scenes=[name for name in src.scenes if name.upper().startswith(slug.upper())]
        loaded=[s for s in dst.scenes if s]
        assert loaded, f'no {slug} scene in {blend}'
        scene=next((s for s in loaded if 'study' in s.name.lower()),loaded[0])
    applied=apply_scene(scene)
    bpy.data.libraries.write(str(blend),{scene},fake_user=True,compress=True)
    portable=directory/(slug+'.glb')
    if portable.exists():patch_glb(portable)
    runtime=ROOT/'public/assets/blender'/(slug+'.gltf')
    if runtime.exists():patch_gltf(runtime)
    record=directory/'material-library.json'
    record.write_text(json.dumps({'version':CONFIG['version'],'asset':slug,'materials':applied},indent=2)+'\n')
    # Only discard copies this call loaded, never the current artist scene.
    for s in loaded:
        owned=list(s.objects);bpy.data.scenes.remove(s)
        for obj in owned:
            if not obj.users_scene:bpy.data.objects.remove(obj,do_unlink=True)
    return {'asset':slug,'textured_materials':len(applied)}
