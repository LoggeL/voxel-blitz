"""Field gloves in the viewmodel's palm frame: dorsal +Y, fingertips -Z."""

from math import cos, radians, sin, tau

from rivet.model import cross, dot, unit


# Palm mounting and grasp dimensions shared with existing weapon animations.
FINGERS = [
    ('index', -.030, -.046, (.031, .021, .017), .0165, .0150),
    ('middle', -.010, -.049, (.034, .024, .018), .0170, .0155),
    ('ring', .010, -.047, (.032, .022, .017), .0165, .0150),
    ('pinky', .030, -.040, (.025, .017, .014), .0145, .0135),
]
THUMB_BASE = (-.036, -.004, .012)

POSES = {
    'grip': (
        [(72, 84, 42), (76, 90, 46), (78, 90, 46), (80, 86, 44)],
        [-1, 0, 1, 2.5],
        [((-.20, -.56, -.80), .036), ((.55, -.28, -.79), .028), ((.82, -.08, -.56), .022)],
    ),
    'support': (
        [(28, 42, 18), (32, 46, 22), (30, 46, 22), (36, 48, 24)],
        [-6, -2, 2, 7],
        [((-.72, .04, -.69), .040), ((-.48, .02, -.88), .028), ((-.32, 0, -.95), .022)],
    ),
}
# z, half width, dorsal radius, palm radius, offset toward the thumb.
PALM = [
    (-.049, .029, .0085, .0073, -.002), (-.046, .037, .0131, .0118, -.0018),
    (-.041, .041, .0157, .0146, -.001), (-.033, .0423, .0164, .0162, -.0004),
    (-.020, .0419, .0167, .0178, -.001), (-.004, .0408, .0159, .0189, -.002),
    (.007, .0392, .0152, .0196, -.0023), (.017, .0363, .0149, .0175, -.0017),
    (.029, .0328, .0149, .0147, -.0006), (.039, .0319, .0143, .0139, 0),
]


def along(p, d, t):
    return tuple(p[i] + d[i]*t for i in range(3))


def section(m, part, name, mat, rings):
    """Closed sleeve of sections; sections around +Z are counterclockwise."""
    n = len(rings[0])
    verts = [v for row in rings for v in row]
    faces = [(j*n+i, j*n+(i+1)%n, (j+1)*n+(i+1)%n, (j+1)*n+i)
             for j in range(len(rings)-1) for i in range(n)]
    faces.extend([tuple(range(n-1, -1, -1)), tuple(range(len(verts)-n, len(verts)))])
    return m.mesh(part, name, mat, verts, faces)


def palm_dims(z):
    for low, high in zip(PALM, PALM[1:]):
        if z <= high[0]:
            t = min(1, max(0, (z-low[0])/(high[0]-low[0])))
            return [a + (b-a)*t for a, b in zip(low[1:], high[1:])]
    return PALM[-1][1:]


def palm_height(x, z, side):
    width, back, heel, shift = palm_dims(z)
    # The edge rolls toward the palm. A gentle central arch follows the dorsal
    # tendons, with greater volume by the thumb adductor on the palmar side.
    fraction = min(.9999, abs((x-shift)/width))
    return side * (back if side > 0 else heel) * (1-fraction**2.8)**(1/2.8)


def pad(m, part, title, name, mat, cx, cz, width, length, rise, side=1, skew=0):
    """Sewn or molded overlay fitted to the actual surface of the palm."""
    n = 20
    rings = []
    for size, offset in [(.015, -.002), (.92, -.002), (1, -.0007), (.94, .0009),
                         (.75, rise*.85), (.45, rise), (.035, rise*1.02)]:
        row = []
        for i in range(n):
            a = -side*i*tau/n
            x = cx + width*size*cos(a)
            z = cz + length*size*sin(a) + (x-cx)*skew
            row.append((x, palm_height(x,z,side)+side*offset, z))
        rings.append(row)
    section(m,part,title+' '+name,mat,rings)


def back_panel(m, part, title, name, material, outline, height):
    """A turned leather or rubber pattern cut from a polygon on the dorsal surface."""
    cx = sum(x for x,z in outline)/len(outline)
    cz = sum(z for x,z in outline)/len(outline)
    area = sum(x1*z2-x2*z1 for (x1,z1),(x2,z2) in zip(outline,outline[1:]+outline[:1]))
    if area > 0:
        outline = outline[::-1]
    rows = []
    for scale,lift in [(.97,-.0012),(1,-.0002),(.98,.0007),(.87,height),(.42,height*1.17),(.05,height)]:
        row = []
        for x,z in outline:
            px,pz = cx+scale*(x-cx),cz+scale*(z-cz)
            row.append((px,palm_height(px,pz,1)+lift,pz))
        rows.append(row)
    section(m,part,title+' '+name,material,rows)


def build_palm(m, part, title):
    rings = []
    for z, width, back, heel, shift in PALM:
        ring = []
        for i in range(40):
            angle = i*tau/40
            x = shift + width * (1 if cos(angle)>=0 else -1)*abs(cos(angle))**(2/2.8)
            y = (back if sin(angle)>=0 else -heel)*abs(sin(angle))**(2/2.8)
            ring.append((x,y,z))
        rings.append(ring)
    section(m,part,title+' palm','glove liner',rings)

    for label, cx, cz, rx, rz, skew in [
        ('thenar suede',-.021,-.001,.014,.026,-.51),
        ('heel suede',.021,.003,.0115,.025,.46),
        ('grip welt',.001,-.031,.031,.006,-.025),
    ]:
        pad(m,part,title,label,'glove leather',cx,cz,rx,rz,.0024,-1,skew)

    # A four-lobed strip protects the MCP knuckles. The intervening channels
    # expose stretch knit so the palm can close around the grip.
    back_panel(m,part,title,'dorsal leather','glove leather',[
        (-.032,-.035),(-.018,-.041),(.008,-.040),(.031,-.031),(.034,-.020),
        (.030,-.011),(.021,-.004),(.023,.006),(.015,.019),(.002,.026),
        (-.013,.020),(-.021,.012),(-.019,.003),(-.032,-.010),(-.036,-.022),
    ],.0016)
    for i, (_,x,z,*_) in enumerate(FINGERS):
        cx,cz = x*.93,z+.010
        width = .0072 if i==3 else .0086
        points = [(cx+width*a,cz+.009*b) for a,b in [
            (-1,-.33),(-.83,-.83),(-.30,-1),(.57,-.84),(.94,-.46),
            (1,.21),(.64,.78),(.18,1.03),(-.70,.84),(-.93,.49)]]
        back_panel(m,part,title,'metacarpal guard '+str(i+1),'ceramic armor',points,.0029)
    # Two articulated leather stays extend from the outer knuckles toward the
    # wrist. The inset fork between them is a stretch panel, not a rigid plate.
    for i,(outer,base,tip) in enumerate([(-.029,-.008,-.009),(.027,.007,.010)]):
        back_panel(m,part,title,'dorsal stay '+str(i+1),'glove leather',[
            (outer,-.028),(outer*.86,-.032),(base,-.024),(tip,-.002),
            (tip*.57,.012),(tip*.21,.014),(tip*.44,-.003),(base*.72,-.020)
        ],.0026)
    for i, sign in enumerate([-1,1]):
        path = [(sign*x,z) for x,z in [(.029,-.026),(.026,-.021),(.022,-.016),
                                         (.018,-.011),(.014,-.006),(.011,-.001)]]
        for j,(a,b) in enumerate(zip(path,path[1:])):
            x,z = a
            x1,z1 = x+(b[0]-x)*.58,z+(b[1]-z)*.58
            line = [(xx,palm_height(xx,zz,1)+.00235,zz) for xx,zz in [(x,z),(x1,z1)]]
            m.tube(part,title+' saddle stitch '+str(i+1)+' '+str(j+1),'glove liner',line,.00043,5)

    # Taper the cuff into the stock forearm frame. Its turned edge just clears
    # the wrist so an extended arm still meets the fingers.
    def loop(z, width, height, cy=0, count=28):
        return [(width*cos(tau*i/count),cy+height*sin(tau*i/count),z) for i in range(count)]
    section(m,part,title+' wrist','glove leather',
            [loop(.025,.0320,.0150),loop(.033,.0348,.0165),loop(.043,.0350,.0177),
             loop(.057,.0357,.0188),loop(.071,.0361,.0196),loop(.075,.0344,.0182)])
    section(m,part,title+' wrist strap','webbing',
            [loop(.042,.0349,.0175),loop(.043,.0368,.0191),
             loop(.052,.0371,.0198),loop(.053,.0357,.0186)])
    for k, z in enumerate([.0440,.0512]):
        a = loop(z,.0367,.0192)
        m.tube(part,title+' strap piping '+str(k+1),'glove liner',a+[a[0]],.00055,5)
    m.box(part,title+' strap buckle','hardware',(-.005,.0193,.048),(.016,.0028,.013),.0011)
    m.box(part,title+' strap tab','glove leather',(-.005,.0204,.048),(.009,.0015,.009),.0005)
    m.box(part,title+' rescue bartack','knuckle plate',(-.006,.0211,.048),(.006,.0012,.0022),.0005)


def digit(m, part, title, name, start, chain, width, thick):
    """Sweep one continuous fourchette around its flexed phalanges."""
    stations = []
    for k, (direction,length) in enumerate(chain):
        prev_dir = chain[max(k-1,0)][0]
        joint_dir = unit(tuple(a+b for a,b in zip(prev_dir,direction)))
        # Near the crease the tangent blends across the joint, while the
        # section retreats slightly on each side of the reinforced fold.
        profile = ([(0,1),(.10,1.00),(.27,1.04),(.49,.995),(.70,1.00),(.87,.96),(.96,.92)]
                   if k < 2 else [(0,.95),(.15,.99),(.37,.97),(.63,.91),(.83,.78),(.94,.54),(1,.22)])
        if k == 0:
            stations.append((along(start,direction,-.006),direction,.76))
        for f, scale in profile:
            t = joint_dir if f==0 else direction
            if f>.85 and k<2:
                blend = (f-.85)/.15*.42
                t = unit(tuple(a*(1-blend)+b*blend for a,b in zip(direction,chain[k+1][0])))
            taper = 1 - (.075*k + f*.075)
            stations.append((along(start,direction,length*f),t,scale*taper))
        start = along(start,direction,length)

    n = 16
    rings, frames = [], []
    for center,tangent,scale in stations:
        guide = (1,0,0)
        width_axis = unit(tuple(a-b*dot(guide,tangent) for a,b in zip(guide,tangent)))
        dorsal = unit(cross(width_axis,tangent))
        def point(angle, lift=0, c=center, u=width_axis, v=dorsal, r=scale):
            return tuple(c[i] + u[i]*cos(angle)*(r*width/2+lift)
                         + v[i]*sin(angle)*(r*thick/2+lift) for i in range(3))
        rings.append([point(-tau*i/n) for i in range(n)])
        frames.append(point)
    section(m,part,title+' '+name,'glove leather',rings)

    # High-abrasion contact area is wrapped around the fingertip and the
    # flat of the distal finger. The darker material also delineates the curl.
    for label, indices, midpoint, mat in [
        ('tip grip',range(len(frames)-7,len(frames)-1),-1.57,'ceramic armor'),
        ('dorsal reinforcement',range(2,7),1.57,'glove liner'),
        ('middle reinforcement',range(10,14),1.57,'glove liner'),
    ]:
        rows = []
        ids = list(indices)
        for j, idx in enumerate(ids):
            narrow = .57 if j in (0,len(ids)-1) else 1
            edge = .84*narrow
            rows.append([frames[idx](midpoint+a*edge/4, .00035) for a in range(-4,5)])
        m.surface(part,title+' '+name+' '+label,mat,rows)
    for flank, angle in [('radial', .15),('ulnar',3.0)]:
        line = [f(angle,.00012) for f in frames[1:-2]]
        m.tube(part,title+' '+name+' '+flank+' seam','glove liner',line,.00048,5)


def build_gloves(m):
    for part, (angles, yaws, thumb) in POSES.items():
        title = part.title()
        build_palm(m,part,title)
        for (name,x,z,lengths,w,t), bends, yaw in zip(FINGERS,angles,yaws):
            chain, flex = [], 0
            for bend,length in zip(bends,lengths):
                flex += radians(bend)
                a = radians(yaw)
                chain.append(((sin(a)*cos(flex),-sin(flex),-cos(a)*cos(flex)),length))
            digit(m,part,title,name,(x,.003,z),chain,w,t)
        digit(m,part,title,'thumb',THUMB_BASE,[(unit(d),l) for d,l in thumb],.021,.018)
