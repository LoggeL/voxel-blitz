"""Revision 12 geometry traced against rounded-direction-b.png.

Executed by build-skipjack.py in its authoring namespace. Reference coordinates
refer to the large side view, not the smaller perspective views. This keeps the
receiver/stock/cassette/grip proportions tied to the selected image.
"""

REF_SCALE = .00072


def ref_yz(px, py):
    return .782 - (px - 63) * REF_SCALE, .075 + (262 - py) * REF_SCALE


def smooth_outline(points, steps=4):
    result = []
    count = len(points)
    for i in range(count):
        p0, p1, p2, p3 = [Vector(points[j % count])
                          for j in (i - 1, i, i + 1, i + 2)]
        for j in range(steps):
            t = j / steps
            result.append(tuple(.5 * ((2 * p1) + (-p0 + p2) * t
                + (2*p0 - 5*p1 + 4*p2 - p3) * t*t
                + (-p0 + 3*p1 - 3*p2 + p3) * t*t*t)))
    return result


def traced_shell(name, group, mat, points, width, bevel, x=0, steps=3):
    outline = smooth_outline([ref_yz(*p) for p in points], steps)
    obj = profile_prism(name, group, mat, x, width, outline, bevel)
    major = bevel > .006
    for poly in obj.data.polygons:
        poly.use_smooth = major
    if bevel:
        obj.modifiers[0].segments = 3 if major else 1
        obj.modifiers[0].harden_normals = False
    if major:
        # The broad shells need continuous shading across the round shoulder.
        # Area-weighted normals turn that shoulder into a broad flat band.
        for modifier in list(obj.modifiers):
            if modifier.type == 'WEIGHTED_NORMAL':
                obj.modifiers.remove(modifier)
    return obj


def cut_rounded_box(obj, loc, size, radius):
    """Apply real shallow cavities and ventilation openings before edge bevel."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    cutter = bpy.context.object
    cutter.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = cutter.modifiers.new('rounded cutter', 'BEVEL')
    bevel.width = radius
    bevel.segments = 4
    bpy.context.view_layer.objects.active = cutter
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    boolean = obj.modifiers.new('machined opening', 'BOOLEAN')
    boolean.operation = 'DIFFERENCE'
    boolean.solver = 'EXACT'
    boolean.object = cutter
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_move_to_index(modifier=boolean.name, index=0)
    bpy.ops.object.modifier_apply(modifier=boolean.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    orient(obj.data)


def reflex_frame():
    def contour(width,height,radius):
        points=[]
        for cx,cz,start in ((width/2-radius,-height/2+radius,-math.pi/2),
                            (width/2-radius,height/2-radius,0),
                            (-width/2+radius,height/2-radius,math.pi/2),
                            (-width/2+radius,-height/2+radius,math.pi)):
            for i in range(6):
                a=start+i/5*math.pi/2
                points.append((cx+radius*math.cos(a),.216+cz+radius*math.sin(a)))
        return points
    outer=contour(.072,.078,.012);inner=contour(.053,.055,.009);n=len(outer)
    verts=[(x,y,z) for points,y in ((outer,.331),(outer,.355),(inner,.331),(inner,.355))
           for x,z in points]
    faces=[]
    for i in range(n):
        j=(i+1)%n
        faces.extend(((i,j,n+j,n+i),(2*n+i,3*n+i,3*n+j,2*n+j),
                      (i,2*n+i,2*n+j,j),(n+i,n+j,3*n+j,3*n+i)))
    mesh=bpy.data.meshes.new('reflex frame mesh');mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new('reflex frame',mesh);source_collection.objects.link(obj)
    return link_part(obj,'sight | open reflex hood','body','gunmetal',.0005,smooth=True)


def screw(name, px, py, side=-1, x=.075, radius=.007):
    y, z = ref_yz(px, py)
    cylinder(name + ' seat', 'body', 'dark polymer',
             (side*x, y, z), radius*1.38, .002, axis='X', verts=12, bevel=0)
    cylinder(name + ' head', 'body', 'machined steel',
             (side*(x+.0015), y, z), radius, .003, axis='X', verts=12, bevel=.0005)
    cylinder(name + ' socket', 'body', 'dark polymer',
             (side*(x+.0032), y, z), radius*.42, .001, axis='X', verts=6, bevel=0)


# Continuous oval clamshell, traced silhouette and narrow perimeter gasket.
receiver_outline = [(548,215),(583,177),(657,139),(749,122),(927,126),
    (1045,143),(1100,180),(1131,235),(1130,325),(1103,378),
    (1018,411),(816,422),(695,414),(605,389),(556,344),(540,282)]
traced_shell('receiver | olive clamshell', 'body', 'olive drab',
             [(px, py-2 if py<230 else py+1) for px,py in receiver_outline],
             .153, .027)

# A thin seam follows the top cover, rather than an unrelated oval side plaque.
for side in (-1, 1):
    traced_shell(f'receiver | top service seam {side}', 'body', 'gunmetal',
        [(584,184),(689,151),(821,148),(1010,159),(1070,180),
         (1007,163),(820,153),(691,156)], .0015, .0004, x=side*.061, steps=3)
    for px,py in ((600,255),(663,375),(749,170),(1087,218),(1100,345)):
        screw(f'receiver | screw {side} {px}',px,py,side,.077,.0065)

# Long stock with a narrow neck, thumb scoop and curved shoulder pad.
stock_outline = [(1088,185),(1174,209),(1250,211),(1340,197),
    (1423,187),(1460,213),(1463,451),(1441,492),(1395,500),
    (1334,483),(1271,437),(1210,388),(1147,364),(1092,374)]
stock_sections=[(1065,225,375,.061),(1110,212,371,.055),
    (1160,208,369,.042),(1210,211,388,.036),(1260,211,428,.037),
    (1320,201,474,.046),(1380,191,497,.057),(1430,189,500,.064),
    (1460,209,478,.063),(1472,240,447,.060)]


def stock_surface(y,z):
    px=63+(.782-y)/REF_SCALE
    samples=stock_rings
    index=next((i for i in range(len(samples)-1)
                if px<=samples[i+1][0]),len(samples)-2)
    a,b=samples[index:index+2]
    t=max(0,min(1,(px-a[0])/(b[0]-a[0])))
    top,bottom,rx=[a[j]*(1-t)+b[j]*t for j in (1,2,3)]
    cz=ref_yz(px,(top+bottom)/2)[1];rz=(bottom-top)*REF_SCALE/2
    return rx*max(.025,1-min(.995,abs((z-cz)/rz))**3)**(1/3)


stock_rings=[]
for i in range(len(stock_sections)-1):
    p0,p1,p2,p3=[Vector(stock_sections[max(0,min(j,len(stock_sections)-1))])
                 for j in (i-1,i,i+1,i+2)]
    for step in range(3):
        t=step/3
        stock_rings.append(.5*((2*p1)+(-p0+p2)*t+
            (2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t))
stock_rings.append(Vector(stock_sections[-1]))
verts=[];segments=24
for px,top,bottom,rx in stock_rings:
    y,cz=ref_yz(px,(top+bottom)/2);rz=(bottom-top)*REF_SCALE/2
    for i in range(segments):
        a=i/segments*2*math.pi;c=math.cos(a);s=math.sin(a)
        verts.append((rx*math.copysign(abs(c)**(2/3),c),y,
                      cz+rz*math.copysign(abs(s)**(2/3),s)))
faces=[tuple(reversed(range(segments)))]
for ring in range(len(stock_rings)-1):
    for i in range(segments):
        j=(i+1)%segments
        faces.append((ring*segments+i,ring*segments+j,(ring+1)*segments+j,(ring+1)*segments+i))
last=(len(stock_rings)-1)*segments
faces.append(tuple(last+i for i in range(segments)))
mesh=bpy.data.meshes.new('stock cross section mesh');mesh.from_pydata(verts,[],faces);mesh.update()
stock=bpy.data.objects.new('stock shell',mesh);source_collection.objects.link(stock)
link_part(stock,'stock | swept olive shell','body','olive drab',0,smooth=True)
scoop=[(1150,213),(1214,226),(1264,257),(1310,309),(1334,350),
       (1321,372),(1295,371),(1250,344),(1210,310),(1176,271)]
scoop_outline=[Vector(p) for p in smooth_outline([ref_yz(*p) for p in scoop],2)]


def scoop_depth(y,z):
    p=Vector((y,z));inside=False;distance=1
    for i,a in enumerate(scoop_outline):
        b=scoop_outline[(i+1)%len(scoop_outline)];edge=b-a
        if (a.y>z)!=(b.y>z) and y<(b.x-a.x)*(z-a.y)/(b.y-a.y)+a.x:
            inside=not inside
        t=max(0,min(1,(p-a).dot(edge)/max(1e-12,edge.length_squared)))
        distance=min(distance,(p-(a+t*edge)).length)
    t=min(1,distance/.011) if inside else 0
    return .009*t*t*(3-2*t)


for v in stock.data.vertices:
    if abs(v.co.x)>.018:
        v.co.x-=math.copysign(scoop_depth(v.co.y,v.co.z),v.co.x)
stock.data.update();orient(stock.data)
from mathutils.bvhtree import BVHTree
stock_bvh=BVHTree.FromPolygons([v.co for v in stock.data.vertices],
                              [list(p.vertices) for p in stock.data.polygons])
for side in (-1,1):
    inset=profile_prism(f'stock | recessed thumb scoop {side}','body','dark polymer',
        side*.0575,.0008,[tuple(p) for p in scoop_outline],0)
    # Subdivide the thin insert so it follows the curved, depressed stock face.
    import bmesh
    bm=bmesh.new();bm.from_mesh(inset.data)
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    bmesh.ops.subdivide_edges(bm,edges=list(bm.edges),cuts=1,use_grid_fill=True)
    bm.to_mesh(inset.data);bm.free()
    for v in inset.data.vertices:
        hit,_,_,_=stock_bvh.ray_cast(Vector((side*.2,v.co.y,v.co.z)),
                                    Vector((-side,0,0)),.4)
        surface=side*hit.x if hit is not None else stock_surface(v.co.y,v.co.z)
        v.co.x=side*(surface+.002+side*v.co.x-.0575)
    inset.data.update();orient(inset.data)
    for poly in inset.data.polygons:poly.use_smooth=True
    for px,py in ((1407,224),(1402,450)):
        screw(f'stock | screw {side} {px} {py}',px,py,side,
              stock_surface(*ref_yz(px,py))+.001,.006)
traced_shell('stock | rubber shoulder pad','body','rubber',
    [(1446,191),(1480,199),(1495,231),(1494,453),(1481,490),
     (1455,504),(1428,500),(1442,462),(1446,270)],.141,.014,steps=3)
for py in (248,286,324,362,400,438):
    y,z=ref_yz(1492,py)
    box(f'stock | fine pad groove {py}','body','dark polymer',
        (0,y,z),(.11,.002,.0018),.0007)

# Reference has one forward pistol grip. Support hand rests below the shroud.
grip_outline=[(622,399),(684,411),(709,442),(711,488),(736,551),
              (767,585),(751,608),(700,618),(663,606),(651,572),(628,472),(613,430)]
traced_shell('grip | ergonomic core','body','dark polymer',grip_outline,.073,.014)
for side in (-1,1):
    traced_shell(f'grip | stippled inset {side}','body','rubber',
        [(639,449),(660,446),(681,467),(687,504),(705,559),
         (711,584),(687,591),(669,570),(650,503)],
        .003,.001,x=side*.0375,steps=3)
    traced_shell(f'grip | backstrap inlay {side}','body','rubber',
        [(701,448),(708,479),(728,540),(750,574),(738,582),
         (722,563),(704,517),(695,476)],.003,.001,x=side*.0365,steps=3)
    screw(f'grip | heel screw {side}',724,595,side,.033,.0035)
for py in (485,510,535,558,579):
    y,z=ref_yz(652+(py-485)*.18,py)
    box(f'grip | finger groove {py}','body','dark polymer',
        (0,y,z),(.060,.0028,.002),.0008)
y,z=ref_yz(615,435)
box('grip | safety paddle','extra','orange paint',(0,y,z),(.074,.018,.009),.003,bevel_segments=3)
rod_between('trigger | pivot pin','trigger','gunmetal',
            (-.022,.345,-.022),(.022,.345,-.022),.004,16)
rod_between('trigger | curved blade','trigger','gunmetal',
            (0,.345,-.022),(0,.363,-.057),.004,16)
arc('trigger | compact guard','trigger','gunmetal',(0,.351,-.014),.043,
    math.pi*1.05,math.pi*1.90,'YZ',.004,20)

# Full length circular barrel jacket, with actual rounded ventilation slots.
hollow_tube('barrel | launch tube','body','gunmetal',(0,.559,BORE_Z),
            .039,.032,.446,verts=32,bevel=.0007)
cylinder('barrel | bore shadow','body','rubber',(0,.59,BORE_Z),.033,.003,verts=32,bevel=0)
shroud=hollow_tube('barrel | vented cylindrical jacket','body','gunmetal',
                   (0,.612,BORE_Z),.055,.048,.322,verts=40,bevel=.0007)
for side in (-1,1):
    for z_offset in (-.028,.028):
        profile=[]
        for end,start in ((1,-math.pi/2),(-1,math.pi/2)):
            for i in range(9):
                a=start+i/8*math.pi
                profile.append((.726+end*.025+.0065*math.cos(a),
                                BORE_Z+z_offset+.0065*math.sin(a)))
        cutter=profile_prism('temporary vent cutter','body','gunmetal',side*.050,.040,profile,0)
        boolean=shroud.modifiers.new('capsule vent','BOOLEAN')
        boolean.operation='DIFFERENCE';boolean.solver='EXACT';boolean.object=cutter
        bpy.context.view_layer.objects.active=shroud
        bpy.ops.object.modifier_move_to_index(modifier=boolean.name,index=0)
        bpy.ops.object.modifier_apply(modifier=boolean.name)
        bpy.data.objects.remove(cutter,do_unlink=True)
for y,radius,depth in ((.446,.064,.021),(.472,.064,.015),
                        (.558,.059,.007),(.608,.058,.006),
                        (.658,.058,.006),(.694,.057,.006)):
    hollow_tube(f'barrel | collar {y}','body','gunmetal',(0,y,BORE_Z),
                radius,.048,depth,verts=24,bevel=0)
for y in (.456,.487,.565,.615,.665,.759):
    hollow_tube(f'barrel | fine machined edge {y}','body','machined steel',
                (0,y,BORE_Z),.0565 if y>.50 else .0645,.050,.002,verts=24,bevel=0)
hollow_tube('barrel | orange collar band','body','orange paint',(0,.491,BORE_Z),
            .063,.048,.008,verts=32,bevel=0)
hollow_tube('crown | rounded muzzle lip','body','gunmetal',(0,.772,BORE_Z),
            .061,.032,.020,verts=32,bevel=.001)
hollow_tube('crown | silver lip','body','machined steel',(0,.781,BORE_Z),
            .057,.034,.002,verts=40,bevel=0)
box('crown | orange index','body','orange paint',(0,.763,BORE_Z+.061),
    (.014,.012,.005),.0015,bevel_segments=2)
for side in (-1,1):
    cylinder(f'crown | small screw {side}','body','machined steel',
        (side*.061,.771,BORE_Z),.0035,.002,axis='X',verts=12,bevel=.0003)

# Large flank cassette, with flat capped rounds and a single continuous frame.
CASSETTE_X=-.119
ROUND_ROWS=(.083,.020,-.043)
HINGE_AUTH=Vector((-.151,.095,.083))
frame=box('cassette | continuous rounded frame','mag','gunmetal',
    (-.145,.188,.020),(.037,.224,.229),.009,bevel_segments=3)
cut_rounded_box(frame,(-.145,.188,.020),(.10,.186,.190),.008)
box('cassette | recessed bay','mag','dark polymer',(-.080,.188,.020),
    (.009,.215,.216),.011,bevel_segments=3)
box('receiver | bay seat','body','gunmetal',(-.075,.188,.020),
    (.011,.227,.227),.010,bevel_segments=3)
for index,row in enumerate(ROUND_ROWS,1):
    round_cyl(f'round {index} | steel base','machined steel',
              (CASSETTE_X,.105,row),.0265,.014,verts=24)
    round_cyl(f'round {index} | olive body','olive drab',
              (CASSETTE_X,.188,row),.025,.152,verts=24)
    round_cyl(f'round {index} | orange band','orange paint',
              (CASSETTE_X,.162,row),.0255,.010,verts=24)
    round_cyl(f'round {index} | steel shoulder','machined steel',
              (CASSETTE_X,.269,row),.0265,.011,verts=24)
    round_cyl(f'round {index} | olive cap','olive drab',
              (CASSETTE_X,.277,row),.024,.008,verts=24)
    round_cyl(f'round {index} | cap centre','gunmetal',
              (CASSETTE_X,.282,row),.019,.002,verts=24)
    for y in (.100,.276):
        torus(f'cassette | retaining collar {index} {y}','mag','machined steel',
              (CASSETTE_X,y,row),.028,.0035,axis='Y',segments=20,ring_segments=6)
        cylinder(f'cassette | retainer peg {index} {y}','mag','machined steel',
                  (-.165,y,row),.0065,.009,axis='X',verts=16,bevel=.0006)
    box(f'cassette | orange round mark {index}','mag','orange paint',
        (-.165,.080,row),(.004,.018,.0035),.0007)
# Subtle long machined grooves in the solid frame, as on the image.
for z in (.124,-.084):
    box(f'cassette | recessed long groove {z}','mag','dark polymer',
        (-.1645,.187,z),(.001,.161,.004),.0015,bevel_segments=3)
for y in (.083,.293):
    for z in (.109,-.069):
        cylinder(f'cassette | frame bolt {y} {z}','mag','machined steel',
                  (-.165,y,z),.0038,.002,axis='X',verts=12,bevel=.0003)
cylinder('cassette | hinge axle','mag','machined steel',HINGE_AUTH,
         .009,.051,axis='X',verts=20,bevel=.0007)
box('cassette | orange release tab','mag','orange paint',(-.163,.078,-.087),
    (.021,.021,.038),.005,bevel_segments=3)
cylinder('cassette | release tab screw','mag','gunmetal',(-.175,.078,-.090),
    .0035,.002,axis='X',verts=12,bevel=.0003)

# Compact sight housing is seated directly on the short rail.
box('sight | short base rail','body','gunmetal',(0,.321,.175),
    (.074,.142,.012),.004,bevel_segments=3)
for y in (.266,.280,.294):
    box(f'sight | rail groove {y}','body','dark polymer',(0,y,.182),
        (.069,.004,.002),.0007)
reflex_frame()
for side in (-1,1):
    traced_shell(f'sight | tapered electronics wing {side}','body','gunmetal',
        [(667,27),(692,22),(710,32),(729,61),(751,103),
         (740,117),(717,107),(700,84),(680,76)],
        .008,.002,x=side*.031,steps=3)
box('sight | electronics foot','body','gunmetal',(0,.318,.185),
    (.067,.058,.018),.006,bevel_segments=3)
box('sight | reflex lens','body','optic glass',(0,.342,.216),
    (.051,.001,.051),.004,bevel_segments=3)
cylinder('sight | reflex emitter','extra','phosphor',(0,.342,.216),
    .0014,.001,axis='Y',verts=12,bevel=0)
for side in (-1,1):
    cylinder(f'sight | adjustment dial {side}','body','dark polymer',
        (side*.035,.313,.198),.011,.006,axis='X',verts=24,bevel=.001)
    cylinder(f'sight | orange dial {side}','body','orange paint',
        (side*.039,.313,.198),.0073,.002,axis='X',verts=24,bevel=.0006)
    cylinder(f'sight | mounting screw {side}','body','machined steel',
        (side*.035,.293,.188),.003,.003,axis='X',verts=12,bevel=.0004)

# Flush right-side charging handle and chamber cover follow the clamshell.
traced_shell('chamber | service cover','body','gunmetal',
    [(800,241),(990,241),(1017,268),(1008,333),(961,351),(810,333)],
    .003,.002,x=.078,steps=3)
box('bolt | recessed charging track','body','dark polymer',(.079,.240,.086),
    (.003,.111,.008),.003,bevel_segments=3)
box('bolt | short charging pawl','bolt','gunmetal',(.085,.248,.086),
    (.014,.041,.012),.004,bevel_segments=3)
cylinder('bolt | pawl grip','bolt','machined steel',(.096,.250,.086),
    .007,.010,axis='X',verts=20,bevel=.001)
cylinder('extra | selector dial','extra','gunmetal',(.079,.331,-.015),
    .009,.006,axis='X',verts=20,bevel=.001)
box('extra | chamber witness','extra','orange paint',(.081,.294,.039),
    (.003,.011,.003),.0007)
