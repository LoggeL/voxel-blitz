"""Author TB-4 Thunderbolt as editable, textured Blender hard-surface geometry.
Run: Blender --background --factory-startup --python tools/blender/thunderbolt/build-thunderbolt.py
Geometry is authored in gun axes then baked to Blender (x,-game_z,game_y).
All gameplay mesh transforms are identity. Rigid animation ownership is `part`.
"""
import bpy, bmesh, math, json
from pathlib import Path
from mathutils import Vector, Matrix

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/design/blender/thunderbolt'; OUT.mkdir(parents=True,exist_ok=True)
bpy.context.preferences.filepaths.save_version=0
scene=bpy.context.scene
for obj in list(scene.objects): bpy.data.objects.remove(obj,do_unlink=True)
scene.name='TB-4 THUNDERBOLT | sculpted ceramic accelerator'
scene.unit_settings.system='METRIC'
scene['authoringCoordinates']='Blender (x,-gameZ,gameY); all mesh geometry is final gun-world'
scene['reference']='docs/design/thunderbolt/concept-blender-v2.png'
scene['rotorPivot']=(-.103,.009,-.22)
scene['energyPivot']=(0,.07,-.64)
scene['muzzle']=(0,.07,-.74)
scene['sight']=(0,.17,-.1)
scene['grip']=(.004,-.04,-.07)
scene['support']=(-.004,-.02,-.43)
PARTS=['body','bolt','trigger','rotor','orb0','orb1','orb2','orb3','energy','arcs','optic']
parts={}
for part in PARTS:
    ob=bpy.data.objects.new(part,None);scene.collection.objects.link(ob);parts[part]=ob

def cv(v):return (v[0],-v[2],v[1])
for name in ('muzzle','sight','grip','support','rotorPivot','energyPivot'):
    ob=bpy.data.objects.new('marker_'+name,None);scene.collection.objects.link(ob)
    ob.location=cv(scene[name]);ob['marker']=name;ob.empty_display_size=.015

specs=json.loads((ROOT/'docs/design/blender/material-library/materials.json').read_text())['materials']
materials={}
def material(name,key,emission=None):
    mat=bpy.data.materials.new('TB4 | '+name);mat.use_nodes=True
    shader=mat.node_tree.nodes.get('Principled BSDF');ns=mat.node_tree.nodes;links=mat.node_tree.links
    spec=specs[key]
    texture_file='textures/thunderbolt-ceramic.png' if name=='ceramic' else 'textures/palette/'+key+'.jpg'
    image=bpy.data.images.load(str(ROOT/'public/assets/blender'/texture_file),check_existing=True)
    image.name=texture_file
    tex=ns.new('ShaderNodeTexImage');tex.image=image;tex.label='Physical-scale material texture';tex.location=(-650,100)
    tint={'ceramic':(.94,.97,1,1),'phosphate':(.20,.23,.29,1),'steel':(.75,.80,.88,1),'copper':(.80,.70,.62,1),'rubber':(.085,.095,.115,1),'polymer':(.12,.14,.18,1)}.get(name,(1,1,1,1))
    shader.inputs['Base Color'].default_value=tint;mat['textureTint']=tint
    multiply=ns.new('ShaderNodeMixRGB');multiply.blend_type='MULTIPLY';multiply.inputs[0].default_value=1;
    multiply.inputs[2].default_value=tint;links.new(tex.outputs['Color'],multiply.inputs[1]);links.new(multiply.outputs[0],shader.inputs['Base Color'])
    shader.inputs['Metallic'].default_value=spec['metal'];shader.inputs['Roughness'].default_value=spec['rough']
    mat['textureFile']=texture_file;mat['textureBumpScale']=spec['bump'];mat['textureLibrary']=key
    bump=ns.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.24;bump.inputs['Distance'].default_value=spec['bump'];bump.location=(-200,-150)
    links.new(tex.outputs['Color'],bump.inputs['Height']);links.new(bump.outputs['Normal'],shader.inputs['Normal'])
    ramp=ns.new('ShaderNodeMapRange');ramp.inputs['From Min'].default_value=.05;ramp.inputs['From Max'].default_value=.95
    ramp.inputs['To Min'].default_value=max(.12,spec['rough']-.10);ramp.inputs['To Max'].default_value=min(.95,spec['rough']+.09)
    links.new(tex.outputs['Color'],ramp.inputs['Value']);links.new(ramp.outputs['Result'],shader.inputs['Roughness'])
    if emission:
        color,strength,flag=emission;shader.inputs['Emission Color'].default_value=(*color,1);shader.inputs['Emission Strength'].default_value=strength
        shader.inputs['Base Color'].default_value=(*color,1)
        for link in list(shader.inputs['Base Color'].links):links.remove(link)
        shader.inputs['Metallic'].default_value=.08;shader.inputs['Roughness'].default_value=.27
        mat[flag]=True
    materials[name]=mat;return mat
material('ceramic','ivory-ceramic')
material('phosphate','phosphated-steel')
material('steel','machined-steel')
material('copper','aged-copper')
material('rubber','pebbled-rubber')
material('polymer','molded-polymer')
material('energy','machined-steel',((.012,.18,1.0),3.2,'tbEnergy'))
material('arc','machined-steel',((.32,.73,1.0),5.0,'tbArc'))
# A distinct dark glass/plasma material, kept separate from rail/sight emission.
# The runtime replaces these five tbOrb surfaces with its animated volume shader.
# Principled defaults deliberately remain a restrained, usable glTF fallback.
orb_mat=material('orb','machined-steel',((.004,.025,.15),.40,'tbOrb'))
orb_shader=orb_mat.node_tree.nodes.get('Principled BSDF')
orb_nodes=orb_mat.node_tree.nodes;orb_links=orb_mat.node_tree.links
orb_shader.inputs['Base Color'].default_value=(.003,.012,.055,1)
orb_shader.inputs['Roughness'].default_value=.16
orb_shader.inputs['Metallic'].default_value=0
orb_shader.inputs['Transmission Weight'].default_value=.86
orb_shader.inputs['IOR'].default_value=1.12
for socket in ('Normal','Roughness'):
    for link in list(orb_shader.inputs[socket].links):orb_links.remove(link)
orb_mat['textureTint']=(.003,.012,.055,1)
orb_mat['textureBumpScale']=0.0
coord=orb_nodes.new('ShaderNodeTexCoord');coord.label='Sphere-local plasma coordinates'
# Analytic bent segments form a few readable branching filaments in the volume.
# They are shader fields, not rings, line meshes, or extra ammo-state groups.
paths=[
 [(0.5,0.5,0.5),(.40,.55,.58),(.26,.62,.62),(.13,.63,.67)],
 [(0.5,0.5,0.5),(.58,.56,.59),(.70,.62,.69),(.79,.73,.68)],
 [(0.5,0.5,0.5),(.56,.38,.56),(.55,.26,.59),(.65,.11,.62)],
 [(0.5,0.5,0.5),(.49,.54,.37),(.59,.55,.23),(.57,.63,.09)],
 [(0.5,0.5,0.5),(.44,.40,.44),(.32,.35,.35),(.24,.22,.36)],
 [(.26,.62,.62),(.28,.70,.56),(.26,.83,.61)],
 [(.70,.62,.69),(.73,.51,.72),(.78,.49,.80)],
 [(.55,.26,.59),(.45,.26,.70),(.43,.21,.80)],
]
def math_node(op,*values):
    node=orb_nodes.new('ShaderNodeMath');node.operation=op
    for i,value in enumerate(values):
        if isinstance(value,(int,float)):node.inputs[i].default_value=value
        else:orb_links.new(value,node.inputs[i])
    return node.outputs[0]
filament_field=None
for points in paths:
    for a,b in zip(points[:-1],points[1:]):
        ab=tuple(b[i]-a[i] for i in range(3));length2=sum(v*v for v in ab)
        pa=orb_nodes.new('ShaderNodeVectorMath');pa.operation='SUBTRACT';pa.inputs[1].default_value=a
        orb_links.new(coord.outputs['Generated'],pa.inputs[0])
        dot=orb_nodes.new('ShaderNodeVectorMath');dot.operation='DOT_PRODUCT';dot.inputs[1].default_value=ab
        orb_links.new(pa.outputs[0],dot.inputs[0])
        t=math_node('MINIMUM',math_node('MAXIMUM',math_node('DIVIDE',dot.outputs['Value'],length2),0),1)
        along=orb_nodes.new('ShaderNodeVectorMath');along.operation='SCALE';along.inputs[0].default_value=ab
        orb_links.new(t,along.inputs[3])
        distance=orb_nodes.new('ShaderNodeVectorMath');distance.operation='DISTANCE'
        orb_links.new(pa.outputs[0],distance.inputs[0]);orb_links.new(along.outputs[0],distance.inputs[1])
        narrow=orb_nodes.new('ShaderNodeMapRange');narrow.clamp=True;narrow.interpolation_type='SMOOTHERSTEP'
        narrow.inputs['From Min'].default_value=.003;narrow.inputs['From Max'].default_value=.016
        narrow.inputs['To Min'].default_value=1;narrow.inputs['To Max'].default_value=0
        orb_links.new(distance.outputs['Value'],narrow.inputs['Value'])
        filament_field=narrow.outputs['Result'] if filament_field is None else math_node('MAXIMUM',filament_field,narrow.outputs['Result'])
filaments=math_node('MULTIPLY',filament_field,600)
radial=orb_nodes.new('ShaderNodeVectorMath');radial.operation='DISTANCE';radial.inputs[1].default_value=(.5,.5,.5)
orb_links.new(coord.outputs['Generated'],radial.inputs[0])
core=orb_nodes.new('ShaderNodeMapRange');core.clamp=True;core.interpolation_type='SMOOTHERSTEP'
core.inputs['From Min'].default_value=.02;core.inputs['From Max'].default_value=.11
core.inputs['To Min'].default_value=1;core.inputs['To Max'].default_value=0
orb_links.new(radial.outputs['Value'],core.inputs['Value'])
plasma=math_node('ADD',math_node('MULTIPLY',core.outputs['Result'],1100),filaments)
volume=orb_nodes.new('ShaderNodeVolumePrincipled');volume.inputs['Density'].default_value=.35
volume.inputs['Color'].default_value=(.005,.02,.10,1)
volume.inputs['Emission Color'].default_value=(.18,.58,1,1)
orb_links.new(plasma,volume.inputs['Emission Strength'])
output=orb_nodes.get('Material Output');orb_links.new(volume.outputs['Volume'],output.inputs['Volume'])
# A nearly transparent shell lets the tiny interior core stay white-cyan instead
# of filtering all emission through the opaque blue glTF fallback surface.
clear_shell=orb_nodes.new('ShaderNodeBsdfTransparent');clear_shell.inputs[0].default_value=(.55,.75,1,1)
shell_mix=orb_nodes.new('ShaderNodeMixShader');shell_mix.inputs[0].default_value=.86
orb_links.new(orb_shader.outputs['BSDF'],shell_mix.inputs[1]);orb_links.new(clear_shell.outputs['BSDF'],shell_mix.inputs[2])
orb_links.new(shell_mix.outputs[0],output.inputs['Surface'])
# Lettering deliberately shares the dark structural material for batching.
AUTH=[]
def uvmap(mesh,scale=4):
    mesh.update();uv=mesh.uv_layers.new(name='UVMap')
    for p in mesh.polygons:
        axis=max(range(3),key=lambda k:abs(p.normal[k]));a,b=[(1,2),(0,2),(0,1)][axis]
        for li in p.loop_indices:
            v=mesh.vertices[mesh.loops[li].vertex_index].co;uv.data[li].uv=(v[a]*scale,v[b]*scale)

def mesh(name,part,mat,verts,faces,bevel=0,smooth=False,segments=2):
    data=bpy.data.meshes.new(name+' mesh');data.from_pydata([cv(v) for v in verts],[],faces);data.update()
    bm=bmesh.new();bm.from_mesh(data);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(data);bm.free()
    data.update();uvmap(data,5 if mat in ('rubber','polymer') else 4)
    for p in data.polygons:p.use_smooth=smooth
    ob=bpy.data.objects.new(name,data);scene.collection.objects.link(ob);ob.parent=parts[part];ob['part']=part
    data.materials.append(materials[mat]);AUTH.append(ob)
    if bevel:
        mod=ob.modifiers.new('Manufactured edge radii','BEVEL');mod.width=bevel;mod.segments=segments;mod.limit_method='ANGLE';mod.angle_limit=.45
        mod.harden_normals=True
        norm=ob.modifiers.new('Area weighted corner normals','WEIGHTED_NORMAL');norm.keep_sharp=True;norm.weight=45
    return ob

def rr(w,h,r,n=4):
    pts=[]
    for cx,cy,start in [(w/2-r,h/2-r,0),(-w/2+r,h/2-r,90),(-w/2+r,-h/2+r,180),(w/2-r,-h/2+r,270)]:
        for i in range(n+1):
            a=math.radians(start+i*90/n);pts.append((cx+r*math.cos(a),cy+r*math.sin(a)))
    return pts

def extrude(name,part,mat,outline,depth,center=(0,0,0),axis='z',bevel=.001,smooth=False):
    def v(a,b,t):
        q=(a,b,t) if axis=='z' else ((t,b,a) if axis=='x' else (a,t,b))
        return tuple(q[i]+center[i] for i in range(3))
    n=len(outline);verts=[v(a,b,t) for t in (-depth/2,depth/2) for a,b in outline]
    faces=[(i,(i+1)%n,n+(i+1)%n,n+i) for i in range(n)]+[tuple(reversed(range(n))),tuple(range(n,2*n))]
    return mesh(name,part,mat,verts,faces,bevel,smooth)

def rounded(name,part,mat,size,center,r=.005,axis='z',bevel=.0008):
    dims=size
    if axis=='z':w,h,d=dims
    elif axis=='x':w,h,d=dims[2],dims[1],dims[0]
    else:w,h,d=dims[0],dims[2],dims[1]
    return extrude(name,part,mat,rr(w,h,min(r,w*.45,h*.45),3),d,center,axis,bevel)

def cyl(name,part,mat,r,depth,center,n=32,axis='z',inner=None,bevel=.0005):
    n=min(n,40)
    verts=[];faces=[]
    def v(rad,i,t):
        a=2*math.pi*i/n;q=(rad*math.cos(a),rad*math.sin(a),t)
        if axis=='x':q=(q[2],q[1],q[0])
        elif axis=='y':q=(q[0],q[2],q[1])
        return tuple(q[j]+center[j] for j in range(3))
    for rad in ([r] if inner is None else [r,inner]):
        verts += [v(rad,i,t) for t in (-depth/2,depth/2) for i in range(n)]
    for i in range(n):
        j=(i+1)%n;faces.append((i,j,n+j,n+i))
        if inner is not None:
            faces.extend([(2*n+i,3*n+i,3*n+j,2*n+j),(n+i,n+j,3*n+j,3*n+i),(i,2*n+i,2*n+j,j)])
    if inner is None:faces.extend([tuple(reversed(range(n))),tuple(range(n,2*n))])
    ob=mesh(name,part,mat,verts,faces,bevel,True,segments=1)
    for p in ob.data.polygons:
        if len(p.vertices)>4:p.use_smooth=False
    return ob

def loft(name,part,mat,stations,n=4,bevel=.0006):
    # Each station: z, y, x, full width, full height, corner radius.
    verts=[]
    for z,y,x,w,h,r in stations:verts.extend([(x+a,y+b,z) for a,b in rr(w,h,r,n)])
    count=len(rr(stations[0][3],stations[0][4],stations[0][5],n));faces=[]
    for s in range(len(stations)-1):
        for i in range(count):j=(i+1)%count;faces.append((s*count+i,s*count+j,(s+1)*count+j,(s+1)*count+i))
    faces.extend([tuple(reversed(range(count))),tuple(range((len(stations)-1)*count,len(stations)*count))])
    ob=mesh(name,part,mat,verts,faces,bevel,True)
    for p in ob.data.polygons:
        if len(p.vertices)>4:p.use_smooth=False
    return ob

def tube(name,part,mat,points,r=.002,n=8):
    verts=[];faces=[];P=[Vector(p) for p in points]
    for i,p in enumerate(P):
        tangent=(P[min(i+1,len(P)-1)]-P[max(0,i-1)]).normalized()
        ref=Vector((0,1,0)) if abs(tangent.y)<.95 else Vector((1,0,0))
        a=tangent.cross(ref).normalized();b=tangent.cross(a).normalized()
        for j in range(n):verts.append(tuple(p+r*(a*math.cos(2*math.pi*j/n)+b*math.sin(2*math.pi*j/n))))
    for i in range(len(P)-1):
        for j in range(n):k=(j+1)%n;faces.append((i*n+j,i*n+k,(i+1)*n+k,(i+1)*n+j))
    faces.extend([tuple(reversed(range(n))),tuple(range((len(P)-1)*n,len(P)*n))])
    return mesh(name,part,mat,verts,faces,0,True)

def torus(name,part,mat,R,r,center,n=40,m=8):
    pts=[];faces=[]
    for i in range(n):
        a=2*math.pi*i/n
        for j in range(m):b=2*math.pi*j/m;pts.append((center[0]+(R+r*math.cos(b))*math.cos(a),center[1]+(R+r*math.cos(b))*math.sin(a),center[2]+r*math.sin(b)))
    for i in range(n):
        for j in range(m):faces.append((i*m+j,((i+1)%n)*m+j,((i+1)%n)*m+(j+1)%m,i*m+(j+1)%m))
    return mesh(name,part,mat,pts,faces,0,True)

def sphere(name,part,mat,r,center,n=32,m=16):
    # Single poles avoid coincident vertices and degenerate cap triangles.
    verts=[(center[0],center[1],center[2]+r)];faces=[]
    for j in range(1,m):
        b=math.pi*j/m
        for i in range(n):
            a=2*math.pi*i/n
            verts.append((center[0]+r*math.sin(b)*math.cos(a),center[1]+r*math.sin(b)*math.sin(a),center[2]+r*math.cos(b)))
    south=len(verts);verts.append((center[0],center[1],center[2]-r))
    for i in range(n):
        k=(i+1)%n;faces.append((0,1+i,1+k))
        for j in range(m-2):
            a=1+j*n;faces.append((a+i,a+n+i,a+n+k,a+k))
        a=1+(m-2)*n;faces.append((a+i,south,a+k))
    return mesh(name,part,mat,verts,faces,0,True)

def screw(name,part,center,axis='x',r=.0033):
    cyl(name+' recessed seat',part,'phosphate',r*1.35,.0012,center,16,axis,bevel=0)
    p=list(center);p['xyz'.index(axis)]+=.001 if center['xyz'.index(axis)]>0 else -.001
    cyl(name+' bolt head',part,'steel',r,.002,tuple(p),12,axis,bevel=.0002)
    p['xyz'.index(axis)]+=.0011 if center['xyz'.index(axis)]>0 else -.0011
    cyl(name+' hex recess',part,'phosphate',r*.48,.00035,tuple(p),6,axis,bevel=0)

# Tapered receiver: changing cross-sections form a softly crowned load-bearing spine.
loft('Receiver sculpted pressure casing','body','phosphate',[
 (.047,.065,0,.079,.060,.018),(.020,.069,0,.089,.077,.022),(-.050,.074,0,.099,.085,.024),
 (-.250,.077,0,.093,.086,.024),(-.330,.073,0,.078,.080,.023),(-.365,.070,0,.067,.065,.023)])
# Separate armor follows a sloping silhouette, allowing a crisp seam above and below.
for side in (-1,1):
    profile=[(.018,.035),(.016,.092),(-.027,.111),(-.278,.111),(-.335,.090),(-.324,.046),(-.255,.031),(-.065,.028)]
    extrude('Ceramic receiver cheek '+str(side),'body','ceramic',profile,.011,(side*.047,0,0),'x',.0025)
    # Thin recessed seam and inset status channel.
    tube('Lower copper gasket '+str(side),'body','copper',[(side*.051,.032,-.064),(side*.051,.033,-.255),(side*.048,.047,-.321)],.0017,6)
    rounded('Status window recess '+str(side),'body','phosphate',(.002,.009,.077),(side*.0535,.088,-.216),r=.004,axis='x',bevel=.0004)
    rounded('Status window emitter '+str(side),'body','energy',(.0022,.003,.062),(side*.055,.088,-.219),r=.0013,axis='x',bevel=0)
    for j in range(3):
        rounded('Casing vent '+str((side,j)),'body','phosphate',(.0015,.005,.019),(side*.0534,.063,-.260+j*.027),r=.0023,axis='x',bevel=0)
    for z,y in [(-.301,.086),(-.075,.052),(.000,.073)]:screw('Casing screw '+str((side,z)),'body',(side*.054,y,z))
# Crown split by a physical ceramic strip, below the frozen sight axis.
loft('Receiver crown cover','body','polymer',[(.012,.123,0,.055,.020,.006),(-.046,.130,0,.066,.029,.010),(-.287,.127,0,.057,.022,.008),(-.343,.116,0,.041,.013,.005)])
rounded('Crown ceramic spline','body','ceramic',(.018,.003,.247),(0,.145,-.16),r=.006,axis='y',bevel=.0005)
rounded('Crown charge light','body','energy',(.004,.0016,.209),(-.017,.144,-.160),r=.001,axis='y',bevel=0)

# Short stock with flowing transitions and a rounded recoil pad, no plain cuboid.
loft('Stock structural neck','body','phosphate',[(.032,.064,0,.068,.055,.016),(.078,.064,0,.060,.065,.020),(.175,.054,0,.065,.087,.022),(.222,.046,0,.069,.103,.026)])
loft('Stock ceramic saddle','body','ceramic',[(.045,.086,0,.074,.041,.014),(.090,.088,0,.068,.038,.014),(.160,.085,0,.072,.050,.017),(.210,.074,0,.073,.068,.021)])
loft('Stock textured heel','body','rubber',[(.216,.043,0,.074,.112,.026),(.231,.043,0,.079,.118,.030),(.249,.043,0,.071,.112,.028)],bevel=0)
loft('Stock copper edge','body','copper',[(.209,.043,0,.075,.108,.026),(.215,.043,0,.077,.111,.027)],bevel=.0004)
for j in range(5):
    rounded('Butt pad transverse groove '+str(j),'body','phosphate',(.050,.0035,.0015),(0,.004+j*.018,.250),r=.0015,bevel=0)
for side in (-1,1):
    screw('Stock screw '+str(side),'body',(side*.038,.067,.188))
# Real supporting deck under the game's dynamic ammo-counter display.
rounded('Counter display ceramic deck','body','ceramic',(.058,.017,.079),(-.027,.121,.158),r=.006,bevel=.001)
rounded('Counter display dark seat','body','polymer',(.046,.008,.062),(-.033,.133,.157),r=.005,bevel=.0006)

# Accelerator interfaces are annular and visibly hollow.
cyl('Accelerator ceramic root collar','body','ceramic',.081,.033,(0,.07,-.371),48,inner=.059,bevel=.002)
cyl('Accelerator root bearing','body','phosphate',.075,.023,(0,.07,-.399),48,inner=.054,bevel=.001)
cyl('Accelerator machined inner lip','body','steel',.059,.008,(0,.07,-.411),48,inner=.052,bevel=.0006)
for i in range(6):
    a=math.pi/6+i*math.pi/3
    screw('Collar radial fastener '+str(i),'body',(.069*math.cos(a),.07+.069*math.sin(a),-.416),'z',.0026)

# Three smooth accelerator prongs; all forward ends stop at z=-.740 exactly.
for i in range(3):
    a=math.pi/6+i*2*math.pi/3;cx=.061*math.cos(a);cy=.07+.061*math.sin(a)
    cyl('Rail round core '+str(i),'body','steel',.012,.306,(cx,cy,-.564),32,bevel=.0007)
    # Main sheaths are elongated rounded profiles with tapered nose shoulders.
    loft('Rail dark pressure sheath '+str(i),'body','phosphate',[
        (-.414,cy,cx,.027,.031,.010),(-.443,cy,cx,.025,.029,.011),(-.677,cy,cx,.023,.027,.011),(-.717,cy,cx,.021,.025,.010)],n=3,bevel=.0005)
    cyl('Rail ceramic isolator '+str(i),'body','ceramic',.017,.063,(cx,cy,-.444),32,bevel=.0012)
    # Continuous helical copper winding, visibly different from stacked blocks.
    points=[]
    for j in range(81):
        t=j/80;ph=t*math.pi*2*5;points.append((cx+.018*math.cos(ph),cy+.018*math.sin(ph),-.486-t*.044))
    tube('Rail copper induction winding '+str(i),'body','copper',points,.0022,6)
    cyl('Rail nose ceramic shoe '+str(i),'body','ceramic',.017,.037,(cx,cy,-.709),32,bevel=.001)
    # Inner blue strips direct the eye to the open electromagnetic channel.
    ix=cx*.84;iy=.07+(cy-.07)*.84
    tube('Rail inner emitter '+str(i),'body','energy',[(ix,iy,-.537),(ix,iy,-.689)],.003,8)
    cyl('Rail copper muzzle terminal '+str(i),'body','copper',.016,.013,(cx,cy,-.7335),32,bevel=0)
cyl('Open muzzle guard','body','phosphate',.077,.015,(0,.07,-.719),48,inner=.059,bevel=.0008)
cyl('Muzzle machined lip','body','steel',.078,.005,(0,.07,-.728),48,inner=.065,bevel=.0004)
# Small ceramic curved shields around the guard, leaving central bore open.
for i in range(3):
    a=math.pi/6+i*2*math.pi/3
    points=[(.076*math.cos(a+t),.07+.076*math.sin(a+t),-.716) for t in [-.18,-.12,-.06,0,.06,.12,.18]]
    tube('Muzzle curved ceramic trim '+str(i),'body','ceramic',points,.006,8)

# Four-charge rotary magazine: deep separate sockets and an open spoke structure.
rx,ry,rz=(-.103,.009,-.22)
cyl('Rotor rear barrel shell','rotor','phosphate',.091,.060,(rx,ry,rz-.015),48,inner=.068,bevel=.001)
cyl('Rotor middle armor belt','rotor','steel',.094,.018,(rx,ry,rz-.022),48,inner=.089,bevel=.0007)
cyl('Rotor rear copper seam','rotor','copper',.092,.003,(rx,ry,rz-.045),48,inner=.086,bevel=.0003)
cyl('Rotor rear cover','rotor','phosphate',.088,.006,(rx,ry,rz-.048),48,bevel=.0008)
cyl('Rotor ceramic front rim','rotor','ceramic',.096,.017,(rx,ry,rz+.043),48,inner=.082,bevel=.001)
cyl('Rotor front machined lip','rotor','steel',.084,.006,(rx,ry,rz+.054),48,inner=.079,bevel=.0006)
# Four spokes, no flat full plate behind the cells.
for i in range(4):
    a=i*math.pi/2
    p=[(rx+math.cos(a)*t,ry+math.sin(a)*t,rz+.048) for t in [.015,.045,.081]]
    tube('Rotor front spoke '+str(i),'rotor','phosphate',p,.006,8)
    ax=rx+math.cos(a)*.087;ay=ry+math.sin(a)*.087
    cyl('Rotor perimeter screw '+str(i),'rotor','steel',.0028,.003,(ax,ay,rz+.054),12,bevel=.0003)
    # Peripheral scallops and segmented armor create a readable quarter-turn.
    center=(rx+math.cos(a)*.092,ry+math.sin(a)*.092,rz+.001)
    cyl('Rotor perimeter coupling '+str(i),'rotor','copper',.008,.015,center,12,bevel=.0005)
for i in range(4):
    a=math.pi/4-i*math.pi/2;x=rx+math.cos(a)*.052;y=ry+math.sin(a)*.052
    cyl('Cell '+str(i)+' deep well','rotor','polymer',.029,.058,(x,y,rz+.024),32,inner=.023,bevel=.0007)
    cyl('Cell '+str(i)+' inner shadow floor','rotor','phosphate',.023,.003,(x,y,rz-.005),32,bevel=0)
    cyl('Cell '+str(i)+' copper contact sleeve','rotor','copper',.024,.013,(x,y,rz+.020),32,inner=.022,bevel=.0004)
    cyl('Cell '+str(i)+' bevel steel socket','rotor','steel',.030,.011,(x,y,rz+.052),32,inner=.023,bevel=.0006)
    # One smooth plasma surface per discrete charge, with no latitude lines.
    sphere('Charged orb '+str(i),'orb'+str(i),'orb',.021,(x,y,rz+.059),32,16)
cyl('Rotor center spindle','rotor','steel',.016,.108,(rx,ry,rz),24,bevel=.0007)
cyl('Rotor copper indexed hub','rotor','copper',.016,.012,(rx,ry,rz+.061),8,bevel=.001)
cyl('Rotor hub hex','rotor','phosphate',.005,.002,(rx,ry,rz+.068),6,bevel=0)
rounded('Rotor asymmetrical zero mark','rotor','copper',(.012,.010,.007),(rx,ry+.085,rz+.055),r=.002,bevel=.0005)
# Fixed index pointer visibly stays in place while drum turns.
extrude('Fixed magazine indexing pointer','body','ceramic',[(-.151,.098),(-.184,.103),(-.204,.119),(-.158,.120)],.035,(rx,0,0),'x',.0015)
# Short bridge sits behind the drum and preserves its rotation clearance.
rounded('Magazine spindle bridge','body','phosphate',(.067,.025,.040),(-.064,.009,-.258),r=.010,bevel=.001)

# Rounded anatomical grip retains original hand anchors and finger clearance.
profile=[(-.043,.009),(-.081,.013),(-.099,-.001),(-.087,-.024),(-.071,-.053),(-.058,-.087),(-.047,-.105),(-.009,-.098),(-.020,-.082),(-.036,-.047),(-.031,-.023)]
extrude('Pistol grip flowing core','body','polymer',profile,.038,(.004,0,0),'x',.003)
# Grippy panel is itself a continuous curved loft across the hand surface.
for side in (-1,1):
    extrude('Pistol pebbled palm insert '+str(side),'body','rubber',[(-.047,-.018),(-.077,-.019),(-.065,-.052),(-.048,-.091),(-.021,-.088),(-.034,-.055)],.004,(.004+side*.020,0,0),'x',.0015)
for j in range(4):
    z=-.047+j*.005;y=-.034-j*.017
    tube('Pistol finger tread '+str(j),'body','rubber',[(-.013,y,z-.007),(.004,y-.002,z),(.021,y,z-.007)],.0024,7)
rounded('Pistol ceramic pommel','body','ceramic',(.047,.011,.047),(.004,-.101,-.030),r=.009,axis='y',bevel=.001)
# Smooth trigger guard follows a continuous U with open center.
tube('Trigger guard continuous bow','body','phosphate',[(.004,.010,-.082),(.004,-.026,-.086),(.004,-.037,-.107),(.004,-.034,-.142),(.004,-.024,-.151),(.004,.011,-.151)],.005,8)
tube('Trigger curved copper blade','trigger','copper',[(.004,.002,-.12),(.004,-.006,-.118),(.004,-.014,-.126),(.004,-.013,-.131)],.0033,8)
# Short front handgrip matches the original support palm location.
extrude('Foregrip sculpted body','body','polymer',[(-.455,.016),(-.414,.018),(-.407,-.014),(-.416,-.052),(-.446,-.055),(-.453,-.027)],.035,(-.004,0,0),'x',.003)
for j in range(4):
    tube('Foregrip soft tread '+str(j),'body','rubber',[(-.022,-.010-j*.010,-.421),(-.022,-.012-j*.010,-.440)],.002,6)
rounded('Foregrip ceramic lower shoe','body','ceramic',(.042,.009,.041),(-.004,-.053,-.432),r=.007,axis='y',bevel=.001)
rounded('Foregrip receiver mount','body','steel',(.060,.013,.061),(-.004,.016,-.430),r=.009,axis='y',bevel=.001)
# Separate bolt slide preserves existing runtime movement.
rounded('Bolt charging shoe','bolt','copper',(.017,.023,.040),(.063,.050,-.140),r=.006,axis='x',bevel=.001)
cyl('Bolt knurled knob','bolt','rubber',.010,.020,(.077,.050,-.126),24,'x',bevel=.0008)

# Factory sights stop precisely at the established y=.17 sight axis.
for side in (-1,1):
    extrude('Rear sight ear '+str(side),'optic','phosphate',[(-.024,.131),(-.004,.131),(-.008,.170),(-.021,.170)],.007,(side*.016,0,0),'x',.0007)
    rounded('Rear sight blue pip '+str(side),'optic','energy',(.002,.014,.0015),(side*.016,.159,-.003),r=.0008,bevel=0)
rounded('Rear sight base','optic','steel',(.044,.009,.030),(0,.135,-.014),r=.004,axis='y',bevel=.0007)
rounded('Front sight bridge','optic','phosphate',(.022,.025,.025),(0,.131,-.56),r=.003,bevel=.0008)
extrude('Front sight tapered blade','optic','phosphate',[(-.553,.141),(-.568,.141),(-.565,.170),(-.556,.170)],.008,(0,0,0),'x',.0006)
rounded('Front sight luminous bead','optic','energy',(.0028,.015,.001),(0,.160,-.552),r=.0008,bevel=0)

# Arc and core geometry stay fully separate for current state-driven animation.
sphere('Accelerator confined core','energy','orb',.022,(0,.07,-.64),32,16)
for rail in range(3):
    a=math.pi/6+rail*2*math.pi/3;P=[]
    for j in range(14):
        t=j/13;rad=.019+abs(2*t-1)*.029;jitter=.004 if j%2 else -.003
        P.append((math.cos(a)*rad+math.sin(a)*jitter,.07+math.sin(a)*rad+math.cos(a)*jitter,-.434-t*.265))
    tube('Accelerator electric arc '+str(rail),'arcs','arc',P,.00085,5)

# Readable, understated markings are converted to geometry for browser export.
def label(name,text,size,pos,normal='left',mat='phosphate'):
    curve=bpy.data.curves.new(name+' lettering','FONT');curve.body=text;curve.size=size;curve.extrude=.00010;curve.bevel_depth=0;curve.resolution_u=3;curve.align_x='CENTER';curve.align_y='CENTER'
    ob=bpy.data.objects.new(name,curve);scene.collection.objects.link(ob)
    # Blender text XY -> game (z,y) side plane. Left normal -x.
    X=Vector((0,-1 if normal=='left' else 1,0));Y=Vector((0,0,1));Z=X.cross(Y)
    basis=Matrix((X,Y,Z)).transposed().to_4x4();basis.translation=Vector(cv(pos));ob.matrix_world=basis
    bpy.context.view_layer.objects.active=ob;ob.select_set(True);bpy.ops.object.convert(target='MESH');bpy.ops.object.transform_apply(location=True,rotation=True,scale=True);ob.select_set(False)
    ob.parent=parts['body'];ob['part']='body';ob.data.materials.append(materials[mat]);uvmap(ob.data);AUTH.append(ob)
label('Left identification TB-4','TB-4',.016,(-.0534,.079,-.027),'left')
label('Right identification TB-4','TB-4',.016,(.0534,.079,-.027),'right')
# Hazard outline and lightning bolt on both stock cheeks, no extra text noise.
for side in (-1,1):
    x=side*.037
    tube('Electrical hazard triangle '+str(side),'body','phosphate',[(x,.063,.126),(x,.086,.139),(x,.063,.152),(x,.063,.126)],.0008,5)
    tube('Electrical hazard bolt '+str(side),'body','phosphate',[(x,.078,.141),(x,.072,.136),(x,.072,.141),(x,.066,.137)],.0007,5)

# Studio objects do not carry part tags and are excluded by the runtime exporter.
scene.render.engine='CYCLES';scene.cycles.samples=48;scene.cycles.use_denoising=True
scene.render.resolution_x=1440;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.world=bpy.data.worlds.new('TB-4 charcoal studio');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.027,.044,.063,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.4
scene.view_settings.view_transform='AgX'
# Image paths remain relative and portable with repository-local library files.
for image in bpy.data.images:
    if image.source=='FILE':image.filepath=bpy.path.relpath(image.filepath,start=str(OUT))

def area(name,pos,power,size,color):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
    ob=bpy.data.objects.new(name,data);scene.collection.objects.link(ob);ob.location=pos;ob.rotation_euler=(Vector((0,.20,.06))-ob.location).to_track_quat('-Z','Y').to_euler()
area('Large warm key',(-1.1,-.5,1.4),120,1.4,(1,.90,.77))
area('Cool rail rim',(.7,1.0,1.0),145,1.1,(.53,.72,1))
area('Soft rear fill',(-.6,-.8,.2),40,1.0,(.7,.8,1))
cam_data=bpy.data.cameras.new('TB-4 presentation camera');cam=bpy.data.objects.new('TB-4 presentation camera',cam_data);scene.collection.objects.link(cam)
cam.location=(-1.14,-1.04,.75);target=Vector((-.01,.24,.035));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam_data.type='ORTHO';cam_data.ortho_scale=1.13;scene.camera=cam
# Store an editable, pleasant startup view.
for area_item in bpy.context.screen.areas if bpy.context.screen else []:
    if area_item.type=='VIEW_3D':area_item.spaces.active.region_3d.view_distance=1.4
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'thunderbolt.blend'))
deps=bpy.context.evaluated_depsgraph_get();triangles=0;counts={};batches=set()
for ob in AUTH:
    evaluated=ob.evaluated_get(deps);data=evaluated.to_mesh();data.calc_loop_triangles();triangles+=len(data.loop_triangles);counts[ob['part']]=counts.get(ob['part'],0)+len(data.loop_triangles);batches.add((ob['part'],ob.data.materials[0].name));evaluated.to_mesh_clear()
report={'source':'docs/design/blender/thunderbolt/thunderbolt.blend','meshes':len(AUTH),'triangles':triangles,'materialGroupBatches':len(batches),'parts':counts,'materials':{k:{'textureFile':v['textureFile'],'textureBumpScale':v['textureBumpScale'],'textureTint':list(v['textureTint']),'tbEnergy':v.get('tbEnergy',False),'tbArc':v.get('tbArc',False),'tbOrb':v.get('tbOrb',False)} for k,v in materials.items()}}
(OUT/'source-report.json').write_text(json.dumps(report,indent=2)+'\n');print('TB4_SOURCE_REPORT '+json.dumps(report))
scene.render.filepath=str(OUT/'studio.png');bpy.ops.render.render(write_still=True)
