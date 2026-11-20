"""Build both runtime LODs of the SL-2 in Blender.

blender -b --factory-startup --python-exit-code 1 -P tools/blender/selvedge/build.py
Add "-- --source /absolute/path/selvedge.blend" to save the editable workshop scene.
Dimensions and paths below use gun-local coordinates (+Y up, -Z forward).
"""
import json
import math
import struct
import sys

import numpy as np
from collections import defaultdict
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'public/assets/blender'
TAU = 2 * math.pi
GAME = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))
AUTHOR = GAME.transposed()
parts = {}
materials = {}
specs = {}
current = 'body'
detail = False


def finish(name, color, rough, metal=0, tile=None, emit=None):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metal
    shader.inputs['Roughness'].default_value = rough
    if emit:
        shader.inputs['Emission Color'].default_value = (*emit, 1)
        shader.inputs['Emission Strength'].default_value = 1
    if tile:
        tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(str(OUT / 'textures/palette' / (tile + '.jpg')), check_existing=True)
        multiply = mat.node_tree.nodes.new('ShaderNodeMixRGB')
        multiply.blend_type = 'MULTIPLY'
        multiply.inputs[0].default_value = 1
        multiply.inputs[2].default_value = (*color, 1)
        mat.node_tree.links.new(tex.outputs['Color'], multiply.inputs[1])
        mat.node_tree.links.new(multiply.outputs[0], shader.inputs['Base Color'])
    specs[name] = (color, rough, metal, tile, emit)
    materials[name] = mat
    return name


def obj(name, verts, faces, mat, bevel=0, smooth=False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([AUTHOR @ Vector(v) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    uv = mesh.uv_layers.new(name='Surface')
    for poly in mesh.polygons:
        normal = GAME @ poly.normal
        axis = max(range(3), key=lambda i: abs(normal[i]))
        u, v = [(2, 1), (0, 2), (0, 1)][axis]
        for index in poly.loop_indices:
            p = GAME @ mesh.vertices[mesh.loops[index].vertex_index].co
            uv.data[index].uv = (p[u] * 8.5, p[v] * 8.5)
        poly.use_smooth = smooth
    ob = bpy.data.objects.new(name, mesh)
    parts[current].objects.link(ob)
    ob.data.materials.append(materials[mat])
    ob['joint'] = current
    ob['nearDetail'] = detail
    if bevel:
        mod = ob.modifiers.new('Machined edge radius', 'BEVEL')
        mod.width, mod.segments = bevel, 2
        mod.harden_normals = True
        mod = ob.modifiers.new('Face normals', 'WEIGHTED_NORMAL')
        mod.keep_sharp = True
    return ob


def sweep(name, sections, mat, bevel=0, smooth=False):
    n = len(sections[0])
    verts = [p for ring in sections for p in ring]
    faces = [tuple(range(n)), tuple(range(n * (len(sections) - 1), n * len(sections)))]
    for j in range(len(sections) - 1):
        a, b = j * n, (j + 1) * n
        faces.extend([(a+i, a+(i+1) % n, b+(i+1) % n, b+i) for i in range(n)])
    return obj(name, verts, faces, mat, bevel, smooth)


def cheek(name, x0, x1, zy, mat, bevel=0):
    return sweep(name, [[(x, y, z) for z, y in zy] for x in (x0, x1)], mat, bevel)


def plank(name, rows, mat, bevel=0):
    # Swept rectangular cross-sections in increasing/decreasing Z.
    rings = []
    for x, y, z, w, h in rows:
        rings.append([(x-w/2,y-h/2,z), (x+w/2,y-h/2,z), (x+w/2,y+h/2,z), (x-w/2,y+h/2,z)])
    return sweep(name, rings, mat, bevel)


def box(name, p, size, mat, bevel=.001):
    x, y, z = p
    w, h, d = size
    return plank(name, [(x,y,z-d/2,w,h), (x,y,z+d/2,w,h)], mat, bevel)


def rod(name, a, b, rad, mat, sides=16, bevel=0, taper=None):
    a, b = Vector(a), Vector(b)
    axis = (b-a).normalized()
    u = axis.cross(Vector((0,1,0)) if abs(axis.y) < .9 else Vector((1,0,0))).normalized()
    v = axis.cross(u).normalized()
    ring = [u * math.cos(i * TAU / sides) + v * math.sin(i * TAU / sides) for i in range(sides)]
    return sweep(name, [[p + q * r for q in ring] for p,r in ((a,rad), (b,taper or rad))], mat, bevel)


def tube(name, points, radius, mat, sides=8):
    points = [Vector(p) for p in points]
    axis = (points[1] - points[0]).normalized()
    u = axis.cross(Vector((1,0,0)) if abs(axis.x) < .95 else Vector((0,1,0))).normalized()
    sections = []
    for i,p in enumerate(points):
        tangent = (points[min(i+1,len(points)-1)] - points[max(0,i-1)]).normalized()
        u = (u - tangent * tangent.dot(u)).normalized()
        v = tangent.cross(u)
        sections.append([p + radius * (u*math.cos(TAU*j/sides)+v*math.sin(TAU*j/sides)) for j in range(sides)])
    return sweep(name, sections, mat, smooth=True)


def ringx(name, x0, x1, y, z, inner, outer, mat, a0=0, a1=360, n=40):
    sections = []
    for i in range(n+1):
        angle = math.radians(a0+(a1-a0)*i/n)
        sections.append([(x, y + r*math.sin(angle), z+r*math.cos(angle))
                         for x,r in ((x0,inner), (x0,outer), (x1,outer), (x1,inner))])
    return sweep(name, sections, mat)


def station_marks(side, z, y, x, count):
    for i in range(count):
        box('Depth graduation', (side*x,y,z-i*.007), (.0008,.009 if i%5==0 else .004,.0014), ink, 0)


def lettering(name, value, pos, size, mat, face):
    # Real stencil outlines, visible in glTF with no font dependency on the client.
    curve = bpy.data.curves.new(name, 'FONT')
    curve.body, curve.size, curve.space_character = value, size, 1.14
    curve.resolution_u = 3
    ob = bpy.data.objects.new(name, curve)
    parts[current].objects.link(ob)
    ob.data.materials.append(materials[mat])
    gx, gy = face
    bx, by = AUTHOR @ Vector(gx), AUTHOR @ Vector(gy)
    ob.matrix_world = Matrix((bx, by, bx.cross(by))).transposed().to_4x4()
    ob.location = AUTHOR @ Vector(pos)
    ob['joint'], ob['nearDetail'] = current, True


bpy.ops.wm.read_factory_settings(use_empty=True)
for name in ['body','leftTine','rightTine','bobbin','shuttle','latch','guide','indicator','trigger','cassette']:
    parts[name] = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(parts[name])

petrol = finish('Deep tide powder coat', (.80,.94,.94), .48,.28,'petrol-paint')
ceramic = finish('Ivory alumina', (1,.97,.86), .32,.05,'ivory-ceramic')
graphite = finish('Graphite inserts', (.74,.78,.78), .57,.28,'phosphated-steel')
rubber = finish('Vulcanised heel', (.8,.85,.83), .87,0,'pebbled-rubber')
al = finish('Edge milled alloy', (.8,.86,.85), .32,.69,'machined-steel')
satin = finish('Satin champagne alloy', (1,.78,.53), .32,.42,'machined-steel')
stencil = finish('Black enamel stamp', (.009,.016,.018), .48,.04)
bronze = finish('Oxidised bronze', (.93,.72,.52), .38,.46,'aged-copper')
amber = finish('Saffron enamel', (1,.73,.40), .39,.24,'orange-paint')
wire = finish('Enamelled amber filament', (.92,.245,.041), .30,.39)
ink = finish('Bone screen print', (.83,.78,.58), .60)
glass = finish('Polarising glass', (.013,.051,.057), .22,.25)
light = finish('Mint phosphor', (.18,.92,.76), .27,.16,emit=(.11,.77,.56))

# The port side is open to the removable reel; the starboard backbone carries
# the load between the rear saddle and the ceramic fork.
cheek('Single-sided casting', -.010,.047,[(.166,.015),(.155,.062),(.095,.088),(-.219,.088),(-.276,.066),(-.363,.075),(-.395,.045),(-.372,-.002),(-.243,-.022),(-.090,-.020),(.057,-.028),(.153,-.022)],petrol,.007)
cheek('Rear saddle casting', -.046,.042,[(.199,-.019),(.172,.062),(.106,.081),(.024,.076),(-.055,.048),(-.064,.010),(-.020,-.021),(.048,-.029),(.133,-.021)],petrol,.006)
cheek('Suspended saddle bridge', -.038,.032,[(.231,.021),(.223,.059),(.167,.088),(.098,.093),(.056,.085),(.059,.075),(.158,.069),(.185,.042),(.197,.008)],graphite,.005)
cheek('Replaceable shoulder heel', -.045,.046,[(.238,.050),(.229,.067),(.207,.064),(.194,.036),(.185,-.030),(.195,-.063),(.216,-.066),(.228,-.026)],rubber,.006)
cheek('Lower open tail strut', -.031,.031,[(.203,-.046),(.194,-.023),(.063,-.020),(.056,-.032),(.092,-.050),(.173,-.057)],al,.0035)
cheek('Palm stock', -.024,.024,[(.047,-.012),(-.012,-.012),(-.017,-.039),(.007,-.109),(.028,-.129),(.068,-.113),(.059,-.083),(.041,-.046)],graphite,.006)
cheek('Backstrap', -.026,.026,[(.039,-.050),(.056,-.058),(.074,-.110),(.061,-.123),(.032,-.133),(.026,-.123),(.048,-.108)],rubber,.003)
tube('Trigger hoop', [(0,-.026,-.065),(0,-.057,-.079),(0,-.086,-.060),(0,-.092,-.020),(0,-.086,.008)],.0058,bronze,8)
current='trigger'
plank('Thumb contact',[(0,-.025,-.040,.011,.010),(0,-.038,-.050,.012,.018),(0,-.057,-.044,.013,.009)],amber,.002)
current='body'
cheek('Front hand cradle', -.037,.038,[(-.236,.035),(-.267,.059),(-.370,.061),(-.397,.036),(-.364,.008),(-.319,-.011),(-.315,-.052),(-.277,-.068),(-.249,-.057),(-.249,-.015),(-.233,.005)],petrol,.005)
cheek('Front saddle rubber', -.038,.039,[(-.248,-.027),(-.255,-.063),(-.286,-.077),(-.313,-.058),(-.315,-.035),(-.303,-.024),(-.279,-.043)],rubber,.003)
for side in [-1,1]:
    for i in range(5):
        box('Saddle moulding rib',(side*.038,-.001,-.257-i*.017),(.004,.011,.006),graphite,.001)
    for i in range(4):
        box('Palm chevron',(side*.0245,-.057-i*.012,.014+i*.005),(.003,.005,.022),rubber,.001)

# Raised station bridge and a pair of mechanical sights surrounding clear air.
plank('Porcelain upper bridge',[(0,.085,.091,.064,.012),(0,.099,.026,.079,.018),(0,.100,-.060,.072,.014),(0,.093,-.112,.056,.014),(0,.088,-.216,.052,.010),(0,.077,-.253,.062,.010)],ceramic,.003)
plank('Recessed instrument deck',[(0,.107,.025,.063,.005),(0,.108,-.061,.064,.005),(0,.098,-.094,.046,.005)],graphite,.002)
box('Display gasket',(0,.112,-.021),(.049,.005,.051),rubber,.002)
box('Index glass',(0,.115,-.021),(.046,.002,.047),glass,.002)
for side in [-1,1]:
    cheek('Rear sight yoke', side*.024-.003,side*.024+.003,[(.073,.090),(.065,.121),(.052,.146),(.038,.146),(.041,.116),(.052,.097)],graphite,.002)
    box('Luminous rear reference',(side*.023,.138,.060),(.006,.007,.003),light,.0006)
plank('Front floating sight stair',[(0,.083,-.343,.038,.014),(0,.100,-.361,.023,.022),(0,.122,-.380,.011,.028),(0,.139,-.384,.0038,.014)],graphite,.001)
box('Front optical bead',(0,.1435,-.382),(.0045,.004,.007),light,.0006)
current='indicator'
box('Stitch count cursor',(0,.117,-.020),(.028,.0018,.003),light,.0004)
current='body'
for i in range(6):
    box('Display index',(-.016+i*.0064,.1162,-.039),(.0024,.0015,.004 if i%2==0 else .002),ink,0)

# Shaped off-axis fork. Both sides curve outward to frame a genuinely hollow
# aperture, then converge to a pair of illuminated field contacts.
for side, part in [(-1,'leftTine'),(1,'rightTine')]:
    current=part
    stations=[(.040,-.346,.039,.049),(.060,-.397,.046,.054),(.072,-.435,.043,.055),(.076,-.486,.035,.050),(.067,-.545,.032,.043),(.047,-.590,.026,.039),(.033,-.603,.019,.031)]
    plank('Fork alloy undercut',[(side*x,.060,z,w,h) for x,z,w,h in stations],graphite,.0035)
    shoes=[(.052,-.381,.036,.060),(.068,-.413,.043,.065),(.075,-.454,.041,.064),(.077,-.486,.034,.058),(.066,-.547,.030,.051),(.052,-.573,.025,.045)]
    plank('Bolt-on ceramic fork shoe',[(side*x,.065,z,w,h) for x,z,w,h in shoes],ceramic,.0045)
    plank('Lapped contact ferrule',[(side*.055,.064,-.566,.032,.048),(side*.046,.063,-.591,.031,.045),(side*.031,.062,-.604,.022,.035)],satin,.002)
    plank('Translucent contact tooth',[(side*.038,.064,-.595,.012,.027),(side*.032,.062,-.604,.017,.027),(side*.027,.062,-.610,.012,.021)],light,.0014)
    plank('Contact collar key',[(side*.052,.087,-.574,.025,.002),(side*.049,.087,-.580,.022,.002)],graphite,.0005)
    plank('Inner guiding ribbon',[(side*(x-w*.49),.076,z,.0046,.007) for x,z,w,h in shoes],amber,.001)
    for x,z,w,h in (shoes[1],shoes[4]):
        rod('Fork socket', (side*(x+w/2-.002),.070,z), (side*(x+w/2+.002),.070,z),.0082,graphite,16)
        rod('Ceramic keeper pin',(side*(x+w/2+.002),.070,z),(side*(x+w/2+.003),.070,z),.0047,al,6)
    detail=True
    for i in range(4):
        z=-.445-.013*i
        box('Kiln alignment stripe',(side*.076,.098-i*.0006,z),(.020,.0015,.002),bronze,0)
    detail=False

current='body'
for side in [-1,1]:
    rod('Root trunnion', (side*.032,.06,-.365),(side*.068,.06,-.365),.020,al,24,.001)
    rod('Pivot cap', (side*.066,.06,-.365),(side*.071,.06,-.365),.016,graphite,24,.001)
    rod('Pivot socket',(side*.071,.06,-.365),(side*.073,.06,-.365),.008,bronze,6)
current='shuttle'
plank('Picker carriage',[(0,.051,-.305,.037,.021),(0,.057,-.343,.045,.029),(0,.065,-.378,.028,.025),(0,.066,-.399,.013,.016)],al,.002)
plank('Picker nose',[(0,.066,-.387,.022,.018),(0,.067,-.413,.007,.008)],light,.001)
current='body'
for x in [-.015,.015]:
    rod('Picker rail',(x,.045,-.292),(x,.045,-.370),.0038,bronze,12)
# The cage leaves the forward lower quadrant of filament and the outer face
# exposed. All reel geometry is rigid on the cassette spindle during extraction.
cy, cz = .017, -.145
current='cassette'
rod('Removable bearing nose',(-.055,cy,cz),(.041,cy,cz),.023,al,32,.001)
rod('Fixed cartridge seat',(.020,cy,cz),(.040,cy,cz),.055,graphite,40,.001)
current='bobbin'
rod('Filament package',(-.075,cy,cz),(.019,cy,cz),.067,wire,56,.002)
ringx('Deep rear flange',.014,.022,cy,cz,.020,.077,bronze,n=48)
# An Archimedean spiral on the exposed face and a single continuous helical
# winding on the barrel retain their pace as the spindle advances.
detail=True
turns, samples = 21, 38
points=[]
for i in range(turns*samples+1):
    t=i/(turns*samples)
    a=t*TAU*turns
    points.append((-.073+t*.089,cy+.0675*math.sin(a),cz+.0675*math.cos(a)))
tube('Laid monofilament',points,.00145,amber,5)
points=[]
for i in range(9*48+1):
    t=i/(9*48)
    a=t*TAU*9
    r=.029+.037*t
    points.append((-.076,cy+r*math.sin(a),cz+r*math.cos(a)))
tube('End winding spiral',points,.0010,bronze,5)
detail=False
ringx('Rolled reel rim',-.084,-.075,cy,cz,.068,.078,bronze,n=48)
ringx('Fine ivory witness line',-.0842,-.0845,cy,cz,.070,.071,ink,n=48)
rod('Three-spoke hub',(-.089,cy,cz),(-.075,cy,cz),.025,graphite,32,.001)
for angle in [15,135,255]:
    a=math.radians(angle)
    a2=math.radians(angle+13)
    tube('Swept stamped spoke',[(-.081,cy+.018*math.sin(a),cz+.018*math.cos(a)),
         (-.084,cy+.040*math.sin(a2),cz+.040*math.cos(a2)),
         (-.080,cy+.071*math.sin(a2),cz+.071*math.cos(a2))],.0046,al,6)
rod('Quarter-turn lock',(-.097,cy,cz),(-.087,cy,cz),.018,bronze,32,.001)
box('Drive key',(-.098,cy,cz),(.002,.004,.020),graphite,.0004)
detail=True
for i in range(24):
    r=.0732
    a=math.radians(i*15)
    rod('Reel witness dot',(-.085,cy+r*math.sin(a),cz+r*math.cos(a)),
        (-.086,cy+r*math.sin(a),cz+r*math.cos(a)),.0014 if i%6 else .0024,wire,8)
detail=False
current='latch'
ringx('Partial swinging reel keeper',-.095,-.088,cy,cz,.078,.087,petrol,65,208,n=24)
tube('Hinge bridge',[(-.091,.094,-.128),(-.086,.099,-.156),(-.080,.092,-.187),(-.070,.071,-.205)],.0048,petrol,8)
rod('Keeper hinge',(-.078,.071,-.205),(-.058,.071,-.205),.0094,al,16,.001)
box('Release pad',(-.092,-.003,-.061),(.011,.028,.016),amber,.002)
current='body'
# Small visible guide between spool and front picker. The stepped capstan
# rotates while its pin, sprung take-up lever and enamel strand stay on chassis.
rod('Capstan frame pin',(-.073,.064,-.255),(-.023,.064,-.255),.010,al,20)
current='guide'
for x,r,thick,m in [(-.051,.023,.025,bronze),(-.065,.027,.004,al),(-.038,.027,.005,graphite)]:
    rod('Fluted guide', (x-thick/2,.064,-.255),(x+thick/2,.064,-.255),r,m,32,.0006)
for i in range(4):
    a=TAU*i/4
    rod('Guide index',(-.068,.064+.016*math.sin(a),-.255+.016*math.cos(a)),(-.069,.064+.016*math.sin(a),-.255+.016*math.cos(a)),.0021,graphite,8)
current='body'
tube('Upstream filament',[(-.065,cy-.038,cz-.055),(-.058,.029,-.228),(-.052,.045,-.262),(-.052,.061,-.280)],.0019,wire,8)
tube('Filament takeoff',[(-.052,.061,-.280),(-.048,.078,-.276),(-.038,.082,-.298),(-.022,.079,-.317),(-.011,.072,-.341)],.0019,wire,8)
cheek('Tension lever',-.065,-.056,[(-.286,.069),(-.284,.076),(-.264,.092),(-.229,.099),(-.223,.089),(-.250,.082)],al,.0015)
rod('Pivot screw',(-.070,.091,-.232),(-.055,.091,-.232),.0056,bronze,12)
detail=True
points=[]
for i in range(9*12+1):
    t=i/(9*12)
    a=t*TAU*9
    points.append((-.052+.006*math.cos(a),.034+t*.045,-.224+.006*math.sin(a)))
tube('Take-up lever spring',points,.0013,al,5)
detail=False
cheek('Mounting flange',-.050,-.038,[(-.218,.029),(-.221,.061),(-.231,.070),(-.240,.061),(-.235,.023)],graphite,.002)
# Serial plate and a small bank of maintenance access fasteners on each side.
for side in [-1,1]:
    x=side*.047
    cheek('Inspection plate',x-.0015,x+.0015,[(.116,.018),(.123,.025),(.118,.054),(.112,.061),(.026,.061),(.022,.052),(.026,.021),(.035,.016)],satin,.001)
    for z,y in [(.113,.025),(.107,.053),(.033,.052),(.037,.024),(.135,.006),(-.282,.033),(-.335,.026)]:
        x2=x if z>0 else side*.039
        head=x2+side*.003
        rod('Counterbore',(x2,y,z),(head,y,z),.0048,graphite,16)
        rod('Captive screw',(head,y,z),(head+side*.001,y,z),.0031,al,6)
    detail=True
    station_marks(side,-.268,.044,.0395,12)
    detail=False
# Lettering faces the player on the port plate and top service deck.
lettering('Instrument plate','SL-2',(-.0492,.034,.040),.026,stencil,((0,0,1),(0,1,0)))
lettering('Maker plate','SELVEDGE',(-.0493,.023,.040),.010,stencil,((0,0,1),(0,1,0)))
lettering('Service deck','SL / 02',(-.023,.101,-.104),.010,graphite,((1,0,0),(0,0,-1)))
detail=True
for i in range(7):
    z=.194+i*.004
    # Shallow grooves in the replaceable heel and rear saddle alignment ticks.
    box('Heel tread',(0,.046-i*.011,.232-i*.001),(.076,.003,.003),graphite,.0007)
for i in range(3):
    box('Safety grip rib',(-.093,.003-i*.006,-.060),(.011,.0016,.010),graphite,0)
detail=False
# The operator sees the saddle and rear deck in extreme close-up.
tube('Deck seam', [(-.027,.090,.054),(-.033,.095,.029),(-.032,.102,-.040)],.0013,bronze,6)
detail=True
for i in range(7):
    z=.157-i*.010
    y=.088+(z-.157)*-.026
    box('Non-slip saddle inlay', (0,y,z),(.055,.0032,.0045),rubber,.0012)
for side in [-1,1]:
    rod('Sight adjustment wheel', (side*.025,.123,.057),(side*.031,.123,.057),.008,bronze,20)
    rod('Sight adjusting slot',(side*.031,.123,.057),(side*.032,.123,.057),.0041,graphite,6)
for i in range(4):
    box('Spine group marking',(-.030+i*.004,.100,.019),(.0021,.0012,.008),graphite,0)
detail=False


def finish_color(name):
    color, _, _, tile, _ = specs[name]
    if not tile:
        return color
    # Average the actual linear-light finish tile. Distant operators retain the
    # same material colors without a draw call per patch, screw and decal.
    nodes = materials[name].node_tree.nodes
    image = next(node.image for node in nodes if node.type == 'TEX_IMAGE')
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    mean = pixels.reshape(-1, 4)[::257, :3].mean(axis=0)
    return [float(c*m) for c,m in zip(color,mean)]


def export(slug, world):
    if world:
        # At arm's length the second bevel segment carries the edge glint. On
        # remote operators the silhouette fits within a fraction of a pixel.
        for ob in bpy.context.scene.objects:
            for mod in ob.modifiers:
                if mod.type == 'BEVEL':
                    mod.segments = 1
        bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    meshes = defaultdict(lambda: ({}, [], []))
    source_count=0
    for ob in bpy.context.scene.objects:
        if world and ob.get('nearDetail'):
            continue
        source_count+=1
        ev = ob.evaluated_get(deps)
        mesh = ev.to_mesh()
        try:
            mesh.calc_loop_triangles()
            uv = mesh.uv_layers.active
            normals = GAME @ ob.matrix_world.to_3x3().inverted().transposed()
            for tri in mesh.loop_triangles:
                material = mesh.materials[tri.material_index].name
                lookup, vs, idx = meshes[(ob['joint'], material)]
                corners=[]
                for li in tri.loops:
                    pos = GAME @ (ob.matrix_world @ mesh.vertices[mesh.loops[li].vertex_index].co)
                    normal = (normals @ mesh.corner_normals[li].vector).normalized()
                    uv0 = uv.data[li].uv if uv else (0.,0.)
                    corners.append(tuple(round(float(v),7) for v in (*pos, *normal, uv0[0], 1-uv0[1])))
                a,b,c = [Vector(v[:3]) for v in corners]
                if (b-a).cross(c-a).length_squared < 1e-22:
                    continue
                for v in corners:
                    if v not in lookup:
                        lookup[v]=len(vs)
                        vs.append(v)
                    idx.append(lookup[v])
        finally:
            ev.to_mesh_clear()
    data=bytearray()
    doc={'asset':{'version':'2.0','generator':'Blender / SELVEDGE instrument tooling','extras':{'blenderAsset':slug}},
         'scene':0,'scenes':[{'nodes':[]}],'nodes':[],'meshes':[],'materials':[],'textures':[],'images':[],
         'buffers':[],'bufferViews':[],'accessors':[],'samplers':[{'wrapS':10497,'wrapT':10497,'magFilter':9729,'minFilter':9987}]}
    finishes = specs
    if world:
        baked = defaultdict(lambda: ({}, [], []))
        colors = {name:finish_color(name) for name in specs}
        for (part, name), (_, vertices, indices) in meshes.items():
            target = 'World phosphor' if specs[name][4] else 'World patina'
            _, batch, faces = baked[(part,target)]
            offset = len(batch)
            batch.extend([(*v, *colors[name]) for v in vertices])
            faces.extend([offset+i for i in indices])
        meshes = baked
        finishes = {
            'World patina': ([1,1,1], .49, .23, None, None),
            'World phosphor': ([1,1,1], .30, .10, None, [.11,.77,.56]),
        }
    tiles=[]
    for name,(color,rough,metal,tile,emit) in finishes.items():
        pbr={'baseColorFactor':[*color,1],'roughnessFactor':rough,'metallicFactor':metal}
        mat={'name':name,'pbrMetallicRoughness':pbr}
        if tile:
            if tile not in tiles:
                i=len(tiles)
                tiles.append(tile)
                uri=f'textures/palette/{tile}.jpg'
                doc['images'].append({'uri':uri,'name':uri})
                doc['textures'].append({'sampler':0,'source':i})
            pbr['baseColorTexture']={'index':tiles.index(tile)}
            mat['extras']={'textureLibrary':tile,'textureBumpScale':.0001 if tile!='pebbled-rubber' else .0003}
        if emit:
            mat['emissiveFactor']=emit
        doc['materials'].append(mat)
    def accessor(values,width,kind,component,target,limits=False):
        while len(data)%4:
            data.append(0)
        begin=len(data)
        fmt={5126:'f', 5123:'H', 5121:'B'}[component]
        data.extend(struct.pack('<'+str(len(values))+fmt,*values))
        view=len(doc['bufferViews'])
        doc['bufferViews'].append({'buffer':0,'byteOffset':begin,'byteLength':len(data)-begin,'target':target})
        entry={'bufferView':view,'componentType':component,'count':len(values)//width,'type':kind}
        if component == 5121:
            entry['normalized'] = True
        if limits:
            entry['min']=[min(values[i::width]) for i in range(width)]
            entry['max']=[max(values[i::width]) for i in range(width)]
        doc['accessors'].append(entry)
        return len(doc['accessors'])-1

    triangles=0
    draws=0
    for part in parts:
        root=len(doc['nodes'])
        doc['scenes'][0]['nodes'].append(root)
        node={'name':part,'children':[]}
        doc['nodes'].append(node)
        for (joint,material),(_,vertices,indices) in meshes.items():
            if joint!=part or not indices:
                continue
            assert max(indices)<65536
            attributes={}
            layout=[('POSITION',slice(0,3),3,'VEC3'),('NORMAL',slice(3,6),3,'VEC3')]
            if not world:
                layout.append(('TEXCOORD_0',slice(6,8),2,'VEC2'))
            for attr,sl,width,kind in layout:
                values=[n for v in vertices for n in v[sl]]
                attributes[attr]=accessor(values,width,kind,5126,34962,attr=='POSITION')
            if world:
                rgba=[c for v in vertices for c in (*[round(min(1,max(0,t))*255) for t in v[8:11]],255)]
                attributes['COLOR_0']=accessor(rgba,4,'VEC4',5121,34962)
            primitive={'attributes':attributes,'indices':accessor(indices,1,'SCALAR',5123,34963),
                       'material':list(finishes).index(material)}
            label=f'{part}_{material}'
            node['children'].append(len(doc['nodes']))
            doc['nodes'].append({'name':label,'mesh':len(doc['meshes'])})
            doc['meshes'].append({'name':label,'primitives':[primitive]})
            triangles+=len(indices)//3
            draws+=1
    doc['buffers'].append({'uri':slug+'.bin','byteLength':len(data)})
    (OUT/(slug+'.gltf')).write_text(json.dumps(doc,separators=(',',':'))+'\n')
    (OUT/(slug+'.bin')).write_bytes(data)
    result={'asset':slug,'source_parts':source_count,'draws':draws,'triangles':triangles,'geometry_bytes':len(data)}
    print('SELVEDGE export:',result)
    return result

bpy.context.view_layer.update()
if '--source' in sys.argv:
    dest=Path(sys.argv[sys.argv.index('--source')+1]).resolve()
    dest.parent.mkdir(parents=True,exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(dest),compress=True)
manifest=json.loads((OUT/'manifest.json').read_text())
manifest['assets']=[a for a in manifest['assets'] if a['asset'] not in ('vanguard','selvedge','selvedge-world')]
manifest['assets'] += [export('selvedge',False), export('selvedge-world',True)]
manifest['assets'].sort(key=lambda a:a['asset'])
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
