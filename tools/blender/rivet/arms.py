"""Articulated field jacket and gloves, in Rivet's shoulder, elbow and palm frames."""
from bisect import bisect_right
from math import ceil, cos, exp, pi, sin, sqrt, tau

from .model import cross, sub, unit


# Measurements follow the cut of a sleeve. The center shifts toward the inside
# at the shoulder seam and toward the triceps at the elbow.
UPPER = (
    (-.366, .031, .035, .001, .007), (-.350, .046, .054, .001, .008),
    (-.329, .063, .067, .002, .008), (-.304, .066, .074, .003, .007),
    (-.280, .067, .073, .003, .006), (-.243, .072, .078, .002, .004),
    (-.200, .077, .083, .001, .002), (-.156, .082, .089, -.003, -.001),
    (-.115, .088, .094, -.010, -.004), (-.084, .095, .100, -.019, -.005),
    (-.061, .100, .106, -.029, -.005), (-.039, .106, .109, -.042, -.004),
    (-.020, .105, .109, -.052, -.004), (-.006, .099, .104, -.059, -.002),
    ( .007, .087, .096, -.071, -.002), ( .019, .067, .079, -.087, .000),
    ( .027, .044, .057, -.100, .001), ( .031, .022, .027, -.109, .001),
    ( .032, .008, .012, -.112, .001),
)
FOREARM = (
    (-.323, .039, .041, -.001, .002), (-.301, .045, .049, -.002, .003),
    (-.270, .048, .050, -.003, .003), (-.240, .050, .054, -.004, .001),
    (-.206, .055, .059, -.006, -.002), (-.166, .062, .069, -.007, -.005),
    (-.118, .070, .074, -.006, -.007), (-.078, .073, .077, -.003, -.008),
    (-.036, .073, .074, -.001, -.003), (-.008, .069, .068, .001, .001),
    ( .017, .062, .063, .001, .004), ( .038, .051, .053, .000, .005),
    ( .055, .036, .041, -.002, .002), ( .068, .016, .021, -.002, .000),
)

# The dyed shoulder and the underarm are cut from two pieces of shell cloth.
# These angles are the sides of the seam at each height on the sleeve.
YOKE = (
    (-.136,-.36,.07),(-.104,-.88,.55),(-.073,-1.31,1.07),(-.046,-1.59,1.45),
    (-.020,-1.86,1.77),(.001,-2.08,1.88),(.015,-2.24,2.12),(.026,-2.27,2.19),
)


def sleeve_point(profile, side, y, angle, clearance=0):
    """Evaluate the garment surface so the seams and patches can follow it."""
    for low, high in zip(profile, profile[1:]):
        if y <= high[0]:
            t = max(0, (y - low[0]) / (high[0] - low[0]))
            break
    else:
        low = high = profile[-1]
        t = 0
    rx, rz, cx, cz = [a + (b - a)*t for a, b in zip(low[1:], high[1:])]
    # The darted folds run diagonally around only the free cloth. At the other
    # end of each dart its crest dissolves back into the sleeve.
    if profile is UPPER:
        creases = ((-.328, .016, 1.50), (-.296, .016, -1.45), (-.245, .014, -.50),
                   (-.194, .012, -2.60), (-.126, .009, 1.10))
    else:
        creases = ((-.279, .012, -1.12), (-.251, .010, 1.89), (-.205, .010, -.38),
                   (-.152, .012, -2.05), (-.096, .010, .45), (-.042, .013, -1.85))
    fold = 0
    for height, depth, phase in creases:
        along = y - height - .034 * sin(angle - phase)
        ridge = exp(-(along / .011)**2) - .60*exp(-((along+.016)/.014)**2)
        fold += depth * ridge * (.51 + .49*cos(angle - phase))
    return (side * (cx + (rx + fold + clearance)*cos(angle)), y,
            cz + (rz + fold + clearance)*sin(angle))


def shoulder_sleeve(m, part, side):
    ys = []
    for low,high in zip(UPPER,UPPER[1:]):
        steps = ceil((high[0]-low[0])/.010)
        ys.extend(low[0]+(high[0]-low[0])*i/steps for i in range(steps))
    ys.append(UPPER[-1][0])
    # Both cuts meet on exactly the same vertices. No second surface crosses
    # the rounding of the shoulder when the trim converges at its crown.
    ys = sorted(set(ys + [y for y, _, _ in YOKE]))
    colored, underarm = 16, 20
    width = colored + underarm
    vertices, normals, rim = [], [], []
    for y in ys:
        if y <= YOKE[0][0]:
            _, first, last = YOKE[0]
        elif y >= YOKE[-1][0]:
            _, first, last = YOKE[-1]
        else:
            for (y0, a, b), (y1, c, d) in zip(YOKE, YOKE[1:]):
                if y <= y1:
                    t = (y-y0)/(y1-y0)
                    first, last = a + t*(c-a), b + t*(d-b)
                    break
        angles = [first + (last-first)*j/colored for j in range(colored)]
        angles += [last + (tau-last+first)*j/underarm for j in range(underarm)]
        for angle in angles:
            point = sleeve_point(UPPER, side, y, angle)
            dy = sub(sleeve_point(UPPER, side, y+.0003, angle), sleeve_point(UPPER, side, y-.0003, angle))
            da = sub(sleeve_point(UPPER, side, y, angle+.002), sleeve_point(UPPER, side, y, angle-.002))
            normal = unit(cross(dy, da))
            vertices.append(point)
            normals.append(tuple(side*v for v in normal))
        if y >= YOKE[0][0]:
            rim.append((len(vertices)-width, len(vertices)-width+colored))
    cuts = {'dark': [], 'suit': []}
    for i, y in enumerate(ys[:-1]):
        for j in range(width):
            a = i*width+j
            b = i*width+(j+1)%width
            face = (a,a+width,b+width,b)
            mat = 'suit' if y >= YOKE[0][0] and j < colored else 'dark'
            cuts[mat].append(face if side == 1 else tuple(reversed(face)))
    caps = [tuple(range(width)),tuple(reversed(range(len(vertices)-width,len(vertices))))]
    cuts['dark'].extend(caps if side == 1 else [tuple(reversed(f)) for f in caps])
    for mat, faces in cuts.items():
        used = sorted({i for f in faces for i in f})
        remap = {old: new for new,old in enumerate(used)}
        label = 'Team shoulder yoke' if mat == 'suit' else 'Articulated jacket sleeve'
        m.mesh(part, label, mat, [vertices[i] for i in used],
               [tuple(remap[i] for i in f) for f in faces], normals=[normals[i] for i in used])
    # The welt is sewn to the shared boundary, lifted along the real surface
    # normal so that it also stays visible where the sleeve turns horizontal.
    edge = [left for left,_ in reversed(rim)] + [rim[0][0]+j for j in range(1,colored)]
    edge += [right for _,right in rim]
    welt = [tuple(p+n*.0015 for p,n in zip(vertices[i],normals[i])) for i in edge]
    m.tube(part,'Shoulder yoke piping','cloth',welt,.0018,sides=6)


def cloth_panel(m, part, name, material, profile, side, rows, clearance, slices=10):
    """A tailored panel with a shaped edge following the circumference."""
    grid = []
    samples = []
    for low, high in zip(rows, rows[1:]):
        steps = ceil((high[0]-low[0])/.012)
        samples.extend(tuple(a+(b-a)*i/steps for a,b in zip(low,high)) for i in range(steps))
    for y, first, last in samples + [rows[-1]]:
        row = [sleeve_point(profile, side, y, first+(last-first)*i/slices, clearance)
               for i in range(slices+1)]
        grid.append(row if side == 1 else list(reversed(row)))
    m.surface(part, name, material, grid)


def seam(m, part, name, material, profile, side, control, clearance=.003, width=.0015):
    path = []
    for (y0, a0), (y1, a1) in zip(control, control[1:]):
        steps = max(1, ceil(abs(y1-y0)/.021), ceil(abs(a1-a0)/.23))
        for j in range(steps):
            t = j/steps
            path.append(sleeve_point(profile, side, y0+(y1-y0)*t, a0+(a1-a0)*t, clearance))
    path.append(sleeve_point(profile, side, *control[-1], clearance))
    m.tube(part, name, material, path, width, sides=6)


def unit_patch(m, part, side):
    # The shield is sewn across the deltoid's outside and rolls forward a little
    # so the call sign is legible from a three-quarter view.
    rows = [(-.146, -.30, .04), (-.134, -.61, .31), (-.104, -.72, .42),
            (-.066, -.70, .40), (-.056, -.56, .26)]
    cloth_panel(m, part, 'Woven sleeve shield', 'cloth', UPPER, side, rows, .0055)
    border = [(y, a) for y, a, _ in rows] + [(y, b) for y, _, b in reversed(rows)]
    seam(m, part, 'Shield bound edge', 'dark', UPPER, side, border+[border[0]], .0062, .002)
    if side < 0:
        # Upright open-stroke numerals, sized for a cloth patch at game scale.
        for label, line in [('0', [(-.113,-.46),(-.119,-.40),(-.117,-.27),(-.109,-.23),
                                   (-.080,-.25),(-.076,-.31),(-.077,-.44),(-.084,-.48),(-.113,-.46)]),
                            ('7', [(-.078,-.13),(-.078,.13),(-.118,-.025)])]:
            seam(m, part, 'Call sign '+label, 'ink', UPPER, side, line, .0078, .0025)
    else:
        # An embroidered ridgeline on the other shoulder.
        seam(m, part, 'Alpine team badge', 'ink', UPPER, side,
             [(-.114,-.51),(-.084,-.29),(-.103,-.17),(-.077,-.025),(-.114,.20)], .0078, .0025)
        seam(m, part, 'Squad tab', 'orange', UPPER, side, [(-.126,-.24),(-.126,.03)], .0076, .0018)


# The angular boundaries of the reinforcement are measured on the lower
# sleeve. Both fabrics are cut from one skin, including the rolled binding.
ELBOW_CUT = (
    (-.217,.65,1.17),(-.199,.29,1.68),(-.143,.10,1.95),(-.081,-.02,2.08),
    (-.030,-.10,1.89),(.002,.14,1.68),(.019,.55,1.22),
)


def forearm_shell(m, part, side):
    patch_start, patch_end = ELBOW_CUT[0][0], ELBOW_CUT[-1][0]
    cut_heights = [row[0] for row in ELBOW_CUT]
    # Three darts compress the backing inside the abrasion panel. Extra rows
    # sample each little trough in cross-section. Their centre lines curve
    # around the forearm, then fade at the stitched edges.
    darts = [-.128, -.096, -.064]
    heights = {row[0] for row in FOREARM} | set(cut_heights)
    heights.update([patch_start+.0015, patch_start+.004, patch_end-.004, patch_end-.0015])
    for y in darts:
        heights.update(y+d for d in [-.0045, -.0011, .0011, .0045])
    anchors = sorted(heights)
    rows = []
    for lo,hi in zip(anchors,anchors[1:]):
        count = ceil((hi-lo)/.009)
        rows.extend(lo+(hi-lo)*i/count for i in range(count))
    rows.append(anchors[-1])
    vertices, body, facing = [],[],[]
    inside, outside = 12,20
    width = inside+outside

    for y in rows:
        k = max(0,min(len(ELBOW_CUT)-2,bisect_right(cut_heights,y)-1))
        y0,a,b = ELBOW_CUT[k]
        y1,c,d = ELBOW_CUT[k+1]
        t = max(0,min(1,(y-y0)/(y1-y0)))
        left,right = a+(c-a)*t,b+(d-b)*t
        # The stitches have a constant width on the fabric, independent of
        # the width of the cut at the ends of the patch.
        seam = min(.025,(right-left)*.12)
        angles = [left] + [left+seam+(right-left-2*seam)*i/(inside-2) for i in range(inside-1)]
        angles.extend(right+(left+tau-right)*i/outside for i in range(outside))
        for j,angle in enumerate(angles):
            u = max(0,min(1,(angle-left)/(right-left)))
            across = min(angle-left,right-angle)*.065
            vertical = min(y-patch_start,patch_end-y)
            distance = min(across,vertical)
            inside_patch = distance > 0
            actual_y, relief = y,0.
            if inside_patch:
                drape = max(0,min(1,(y+.174)/.028,(.004-y)/.032))
                actual_y -= .0065*sin(pi*u)*drape
                # The straight cut edges sit in the same crease as the
                # surrounding sleeve. A millimetre of binding rolls inward.
                bevel = min(1,distance/.0015)
                relief = .0009*bevel + .0007*max(0,1-abs(distance-.0015)/.0025)
                trough = min(abs(y-line) for line in darts)
                relief -= .0015*max(0,1-trough/.0045)*sin(pi*u)
            vertices.append(sleeve_point(FOREARM,side,actual_y,angle,relief))

    for row,(lo,hi) in enumerate(zip(rows,rows[1:])):
        mid = (lo+hi)/2
        for j in range(width):
            a,b = row*width+j,row*width+(j+1)%width
            face = (a,a+width,b+width,b)
            cut = body
            if patch_start < mid < patch_end and j < inside:
                hem = j in (0,inside-1) or min(mid-patch_start,patch_end-mid)<.0015
                quilt = min(abs(mid-line) for line in darts)<.0011
                cut = body if hem or quilt else facing
            cut.append(face if side==1 else tuple(reversed(face)))
    caps = [tuple(range(width)),tuple(reversed(range(len(vertices)-width,len(vertices))))]
    body.extend(caps if side==1 else [tuple(reversed(f)) for f in caps])
    # Smooth across the material boundary using the same spatial derivatives
    # on both cuts, especially where the facing crosses a gathered fold.
    normals = []
    for row in range(len(rows)):
        lo = max(0,row-1)*width
        hi = min(len(rows)-1,row+1)*width
        for j in range(width):
            dy = sub(vertices[hi+j],vertices[lo+j])
            da = sub(vertices[row*width+(j+1)%width],vertices[row*width+(j-1)%width])
            normals.append(tuple(side*x for x in unit(cross(dy,da))))
    for faces,label,material in [(body,'Tailored lower sleeve','dark'),
                                 (facing,'Elbow abrasion facing','cloth')]:
        used = sorted({i for f in faces for i in f})
        remap = {old:new for new,old in enumerate(used)}
        m.mesh(part,label,material,[vertices[i] for i in used],
               [tuple(remap[i] for i in face) for face in faces],normals=[normals[i] for i in used])


def forearm_details(m, part, side):
    m.loft(part, 'Glove gauntlet', 'rubber', [
        (-.353,.026,.030,0,.005),(-.345,.036,.038,0,.003),
        (-.335,.041,.042,0,.001),(-.324,.045,.046,0,.002),
        (-.299,.046,.049,-side*.001,.002),(-.289,.045,.048,-side*.001,.002)], 20, .85)
    m.loft(part, 'Wrist cinch', 'cloth', [
        (-.319,.046,.048,0,.002),(-.317,.048,.050,0,.002),
        (-.305,.048,.051,0,.002),(-.303,.046,.050,0,.002)], 20, .85)
    m.box(part, 'Cinch release', 'rubber', (side*.046,-.310,.003), (.009,.022,.038),.003)
    m.box(part, 'Cinch size index', 'orange', (side*.051,-.310,-.005),(.002,.011,.005),.0008)
    if side < 0:
        seam(m, part, 'Forearm pocket coil', 'cloth', FOREARM, side,
             [(-.216,-.32),(-.176,-.54),(-.114,-.68)], .0026,.0026)
        seam(m, part, 'Forearm pocket pull', 'orange', FOREARM, side,
             [(-.114,-.68),(-.126,-.63),(-.144,-.70)], .0046,.0029)


def finger(m, part, name, side, path, radii):
    """A continuous tapered glove finger with a crease at each interphalangeal joint."""
    sections = 9
    verts = []
    for i, ((x,y,z), radius) in enumerate(zip(path, radii)):
        prev, nxt = path[max(0,i-1)], path[min(len(path)-1,i+1)]
        dx,dy,dz = (b-a for a,b in zip(prev,nxt))
        length = sqrt(dx*dx+dy*dy+dz*dz)
        dx,dy,dz = dx/length,dy/length,dz/length
        span = sqrt(dx*dx+dz*dz)
        a = (dz/span, 0, -dx/span)
        b = (dy*a[2], dz*a[0]-dx*a[2], -dy*a[0])
        for j in range(sections):
            u,v = radius*cos(tau*j/sections),radius*.88*sin(tau*j/sections)
            verts.append((side*(x+u*a[0]+v*b[0]),y+v*b[1],z+u*a[2]+v*b[2]))
    faces = []
    for i in range(len(path)-1):
        for j in range(sections):
            a,b = i*sections+j,i*sections+(j+1)%sections
            faces.append((a,b,b+sections,a+sections))
    end = (len(path)-1)*sections
    faces += [tuple(reversed(range(sections))),tuple(range(end,end+sections))]
    m.mesh(part,name,'cloth',verts,faces if side == 1 else [tuple(reversed(f)) for f in faces])


def glove(m, part, side):
    # The palm anchor is on the side of the grip. Each hand has its own grasp:
    # the dominant fingers go round the upright grip and the support fingers
    # cup the underside of the fore-end. The thumb opposes the other fingers.
    m.ellipsoid(part,'Glove heel and wrist gusset','cloth',
                (side*.002,-.007,.015),(.029,.031,.036),16,8)
    if side == 1:
        m.loft(part,'Leather palm','cloth',[
            (-.059,.009,.022,.005,.002),(-.049,.016,.033,.009,.004),
            (-.030,.019,.042,.012,.002),(-.006,.021,.046,.014,-.001),
            (.014,.016,.042,.012,.002),(.028,.012,.031,.010,.010),(.034,.008,.016,.007,.014)],18,.82)
        for i in range(4):
            y = .009-i*.017
            knuckle = -.040 + .0025*i
            end = -.046 + .004*i
            path = [( .015,y,knuckle+.013),(.017,y+.002,knuckle+.003),
                    (.015,y+.002,knuckle-.009),(.007,y+.0005,knuckle-.014),
                    (-.005,y-.001,knuckle-.015),(-.014,y-.002,knuckle-.016),
                    (-.024,y-.004,end),(-.029,y-.005,end+.007),(-.030,y-.005,end+.011)]
            if i == 0:
                # The index rests slightly forward of the other fingertips.
                path = [(x,y,z-max(0,j-2)*.00135) for j,(x,y,z) in enumerate(path)]
            finger(m,part,'Gripping finger %d'%(i+1),side,path,
                   [.0073,.0090,.0088,.0073,.0082,.0070,.0075,.0065,.0032])
            m.ellipsoid(part,'Knuckle overlay %d'%i,'rubber',(.026,y+.001,knuckle+.012),(.0065,.008,.013),12,6)
        thumb = [( .015,.012,.029),(.012,.021,.028),(.006,.027,.020),
                 (-.004,.029,.010),(-.010,.025,.001),(-.014,.021,-.010),(-.014,.018,-.018)]
    else:
        m.loft(part,'Fore-end support palm','cloth',[
            (-.050,.010,.025,-.004,.002),(-.043,.022,.039,-.005,.001),
            (-.029,.026,.045,-.007,.000),(-.015,.023,.046,-.011,.001),
            (.001,.017,.040,-.013,.004),(.013,.011,.027,-.013,.007),(.019,.007,.013,-.011,.010)],18,.84)
        for i in range(4):
            z = -.030+.018*i
            rise = .011 - .003*i
            path=[(.015,-.020,z+.001),(.013,-.030,z),(.008,-.038,z-.002),
                  (-.002,-.042,z-.002),(-.012,-.043,z-.001),(-.023,-.041,z),
                  (-.032,-.034,z+.002),(-.037,-.024,z+.002),(-.037,-.016+rise,z+.003)]
            finger(m,part,'Supporting finger %d'%(i+1),side,path,
                   [.0078,.0092,.0084,.0076,.0081,.0076,.0080,.0073,.0040])
            m.ellipsoid(part,'Knuckle overlay %d'%i,'rubber',(-.024,-.016,z),(.007,.012,.0075),12,6)
        thumb = [(.010,-.014,.030),(.014,-.005,.032),(.017,.003,.024),
                 (.018,.009,.015),(.016,.014,.005),(.015,.018,-.007),(.013,.019,-.015)]
    finger(m,part,'Opposed glove thumb',side,thumb,[.010,.012,.012,.010,.010,.0085,.0037])


def build_arms(m):
    for side, prefix in [(-1,'l'),(1,'r')]:
        arm, fore = prefix+'Arm', prefix+'Elbow'
        shoulder_sleeve(m,arm,side)
        unit_patch(m,arm,side)
        seam(m,arm,'Felled sleeve seam','cloth',UPPER,side,
             [(-.328,-1.23),(-.266,-1.18),(-.216,-1.19),(-.145,-1.34),(-.079,-1.51)],.002,.0014)
        forearm_shell(m,fore,side)
        forearm_details(m,fore,side)
        glove(m,prefix+'Hand',side)
