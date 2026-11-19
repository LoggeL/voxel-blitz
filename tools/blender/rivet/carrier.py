"""Rivet's alpine field jacket, load-bearing webbing and radio pack, in joint space."""

from math import atan, cos, exp, pi, sin, tau


def _sgn_pow(value, exponent):
    return (1 if value >= 0 else -1) * abs(value) ** exponent


def _panel(m, part, name, mat, outline, face_z, depth, edge=.10, facing=-1, soft=False):
    """Stamp a contoured panel with a raised face and a rolled perimeter.

    outline is in the XY plane; face_z is sampled on each ring so a plate or
    pocket flap can wrap around the body. facing is the sign of its outward Z.
    """
    cx = sum(x for x, _ in outline) / len(outline)
    cy = sum(y for _, y in outline) / len(outline)
    area = sum(a[0]*b[1] - b[0]*a[1] for a, b in zip(outline, outline[1:] + outline[:1]))
    if (area > 0) != (facing > 0):
        outline = list(reversed(outline))
    vertices = []
    for scale, recess in [(1-edge, depth), (1, depth*.55), (1-edge, 0)]:
        for x, y in outline:
            px, py = cx + (x-cx)*scale, cy + (y-cy)*scale
            vertices.append((px, py, face_z(px, py) - facing*recess))
    n = len(outline)
    faces = [tuple(reversed(range(n)))]
    for ring in range(2):
        for i in range(n):
            j = (i+1) % n
            faces.append((ring*n+i, ring*n+j, (ring+1)*n+j, (ring+1)*n+i))
    vertices.append((cx, cy, face_z(cx, cy)))
    for i in range(n):
        faces.append((2*n+i, 2*n+(i+1) % n, 3*n))
    m.mesh(part, name, mat, vertices, faces, smooth=soft)


def _jacket_contact(m):
    """Return a strap point lifted onto the coat along its local outward normal."""
    panels=[p for p in m.pieces if p.name in ('Tailored ripstop jacket','Reinforced shoulder yoke')]
    faces=[[p.verts[i] for i in face] for p in panels for face in p.faces if len(face)==4]
    def contact(x,y,z,ny,nz):
        lift=0
        for face in faces:
            cut=[]
            for a,b in zip(face,face[1:]+face[:1]):
                if min(a[0],b[0]) <= x < max(a[0],b[0]):
                    k=(x-a[0])/(b[0]-a[0])
                    cut.append((a[1]+k*(b[1]-a[1]),a[2]+k*(b[2]-a[2])))
            if len(cut)!=2:
                continue
            (ay,az),(by,bz)=cut
            dy,dz=by-ay,bz-az
            det=ny*dz-nz*dy
            if abs(det)<1e-9:
                continue
            t=((ay-y)*dz-(az-z)*dy)/det
            u=((ay-y)*nz-(az-z)*ny)/det
            if 0<=u<=1 and -.004<t<.050:
                lift=max(lift,t+.003)
        return x,y+ny*lift,z+nz*lift
    return contact


def _ribbon(m, part, name, mat, path, width, contact=None):
    """A webbing strip draped front to back, with a small crown on the weave."""
    rows = []
    for i, (x, y, z) in enumerate(path):
        before, after = path[max(0, i-1)], path[min(len(path)-1, i+1)]
        dy, dz = after[1]-before[1], after[2]-before[2]
        inv_len = 1 / max(.0001, (dy*dy + dz*dz)**.5)
        ny, nz = dz*inv_len, -dy*inv_len
        row=[]
        for f in [-1,-.7,0,.7,1]:
            point=(x+f*width/2, y + ny*(1-abs(f))*.002, z + nz*(1-abs(f))*.002)
            row.append(contact(*point,ny,nz) if contact else point)
        rows.append(row)
    m.surface(part, name, mat, rows)
    for edge in [0,-1]:
        m.tube(part, name+' bound edge', mat, [row[edge] for row in rows], .002, 6)


def _jacket(m):
    # The upper sections trace the trapezius over the collarbones, overhang
    # the shoulder seam and tuck back in under the arms. Below the vest the
    # jacket blouses over the belt, with slanted creases around each flank.
    profile = [
        (-.249,.214,.135,.003),(-.241,.220,.141,.003),(-.232,.225,.141,.004),
        (-.212,.216,.137,.005),(-.191,.211,.133,.004),(-.163,.204,.127,.003),
        (-.142,.200,.127,.001),(-.118,.197,.126,.001),(-.093,.191,.122,0),
        (-.057,.187,.121,0),(-.010,.193,.128,-.001),(.050,.203,.137,-.001),
        (.093,.216,.145,-.003),(.132,.230,.146,-.004),(.167,.242,.139,-.002),
        (.194,.248,.129,-.003),(.215,.246,.116,-.003),(.234,.232,.101,-.002),
        (.243,.212,.088,-.002),(.249,.184,.076,-.001),(.250,.146,.070,-.001),
        (.253,.108,.065,-.001),(.256,.084,.059,-.001),
    ]
    def cut(i,a,offset=0):
        y,rx,rz,cz=profile[i]
        front, flank = cos(a), abs(sin(a))
        gather = exp(-((y+.202)/.087)**2)
        ridges = sin(68*y+2.5*a+1.22*sin(2*a)) + .6*sin(97*y-3.0*a)
        radius_shift = gather*(.0015 + .008*flank)*ridges
        fold_height = gather*min(1,i/2)*(.003+.007*flank)*sin(2.5*sin(a)+sin(3*a)+i*.37)
        # The neck rises above a saddle in front, the shoulder apex drops
        # away from the neck, and cloth across the upper back stays fuller.
        horseshoe = max(0,min(1,(y-.125)/.10))
        top_drop = horseshoe*(.018*max(0,front)**2 + .005*max(0,-front)**3)
        return ((rx+radius_shift+offset)*_sgn_pow(sin(a),.89),
                y+fold_height-top_drop + offset*horseshoe,
                cz-(rz+radius_shift+offset)*_sgn_pow(front,.85))
    segments=44
    rows=[[cut(i,tau*j/segments) for j in range(segments)] for i in range(len(profile))]
    vertices = [v for row in rows for v in row]
    faces = []
    for i in range(len(rows)-1):
        for j in range(segments):
            nxt = (j+1) % segments
            faces.append((i*segments+j,(i+1)*segments+j,(i+1)*segments+nxt,i*segments+nxt))
    faces += [tuple(range(segments)),tuple(reversed(range(len(vertices)-segments,len(vertices))))]
    m.mesh('torso','Tailored ripstop jacket','dark',vertices,faces)

    for side in [-1,1]:
        # The raglan panel follows the crown of each shoulder over the stitch
        # line. It spans from the armhole to the neck like a real jacket yoke.
        yoke=[]
        for row,start,end in [(13,.92,2.19),(14,.80,2.28),(15,.70,2.37),
                              (16,.61,2.46),(17,.53,2.53),(18,.49,2.60),
                              (19,.46,2.68),(20,.44,2.74),(21,.41,2.76)]:
            angles=sorted((side*start,side*end))
            yoke.append([cut(row,angles[0]+(angles[1]-angles[0])*j/12,.0018) for j in range(13)])
        m.surface('torso','Reinforced shoulder yoke','suit',yoke)
        for col in [0,-1]:
            m.tube('torso','Yoke flat-felled seam','cloth',[r[col] for r in yoke],.0023,6)

        # A fitted waist gusset is quilted on the bias. Keep the lines on
        # the surface so the fabric retains its continuous silhouette.
        for start in [0,2,4]:
            slant=[cut(row,side*(1.02 + .73*j/4),.0014)
                   for j,row in enumerate(range(start,start+5))]
            m.tube('torso','Quilted flank dart','cloth',slant,.0017,6)
        hem=[cut(1,side*(.18+2.75*j/20),.0014) for j in range(21)]
        m.tube('torso','Bound jacket hem','dark',hem,.0021,6)

    # A stand collar pulled partway open around the mask. Its two front tips
    # drop and fold outwards, while its back and sides protect the nape.
    collar_rows=[]
    samples=26
    for t in [0,.16,.36,.60,.83,1]:
        row=[]
        for j in range(samples+1):
            gap=.025+.29*t*t
            a=gap+(tau-2*gap)*j/samples
            front=max(0,cos(a))
            # The front edges turn down clear of the throat; behind the
            # ears the taller collar rests against the neck and head.
            height=max(0,min(1,(.35-cos(a))/.55))
            height=height*height*(3-2*height)
            y=.201+t*(.051+.074*height+.0015*sin(2*a+.3))
            rx=.116-.014*t+.004*t*t
            rz=.102-.012*t+.017*front**5*t
            # Wind pulls the open edges into two shallow overlapping lapels.
            spread=.007*t*t*front**4
            row.append(((rx+spread)*sin(a),y,-.003-rz*cos(a)))
        collar_rows.append(row)
    m.surface('torso','Stand-up storm collar','suit',collar_rows)
    inside=[[(x*.944,y-.0015,z*.942) for x,y,z in reversed(row)] for row in collar_rows]
    m.surface('torso','Collar fleece lining','cloth',inside)
    m.tube('torso','Collar turned binding','dark',collar_rows[-1],.0036,7)
    for col in [0,-1]:
        m.tube('torso','Storm collar lip','dark',[r[col] for r in collar_rows],.0033,7)
    for col in [2,samples-2]:
        m.tube('torso','Collar shaping dart','dark',[r[col] for r in collar_rows[1:]],.0018,6)
    m.tube('torso','Waterproof centre zip','rubber',[(0,-.241,-.141),(0,-.208,-.136),(0,-.18,-.133)],.004,8)
    m.tube('torso','Storm zip','rubber',[(.002,.168,-.146),(.002,.195,-.124),
           (.003,.215,-.105),(.006,.236,-.104),(.011,.249,-.102)],.004,8)
    m.tube('torso','Collar zip pull','orange',[(.008,.246,-.104),(.018,.236,-.110),
           (.018,.230,-.110),(.013,.232,-.110)],.0024,7)


def _carrier(m):
    part = 'torso'
    # The back and side panels of the harness wrap under the arms. The front
    # is shaped separately, with shoulder relief over the high chest.
    m.loft(part,'Carrier cummerbund','web',[
        (-.104,.192,.130,0,-.003),(-.097,.200,.139,0,-.003),
        (-.064,.198,.141,0,-.003),(-.019,.201,.141,0,-.003),
        (.012,.204,.140,0,-.003),(.025,.203,.138,0,-.003),
    ],32,.77)
    for height in [-.079,-.042,-.006]:
        for side in [-1,1]:
            rx=.201+.035*(height+.065)
            path=[(side*rx*_sgn_pow(sin(a),.77),height,-.003-.143*_sgn_pow(cos(a),.77))
                  for a in [.74,.95,1.18,1.44,1.65,1.88,2.11,2.33]]
            # Bound edge of the horizontal webbing on the cummerbund.
            m.tube(part,'Cummerbund woven channel','cloth',path,.004,6)

    backing = [(-.135,-.093),(-.155,-.052),(-.153,.073),(-.122,.113),
               (-.105,.162),(-.089,.182),(.088,.182),(.107,.160),
               (.120,.119),(.153,.077),(.156,-.056),(.130,-.096)]
    def base_depth(x,y):
        return -.170 + 1.70*x*x + .44*(y-.036)**2
    _panel(m,part,'Chest harness padded backing','web',backing,base_depth,.022,.07,soft=True)
    m.tube(part,'Carrier bound hem','cloth',[(x,y,base_depth(x,y)+.005)
           for x,y in backing+backing[:1]],.004,7)

    # Shoulder straps: the crest sits on the jacket and the narrow tail runs
    # beneath the pack. Matching hardware on each strap anchors the chest bib.
    jacket_contact=_jacket_contact(m)
    for side in [-1,1]:
        path = [(side*x,y,z) for x,y,z in [
            (.121,.035,-.155),(.124,.081,-.157),(.130,.127,-.153),
            (.139,.159,-.140),(.149,.186,-.124),(.153,.218,-.096),
            (.155,.243,-.054),(.156,.255,.002),(.154,.247,.054),
            (.150,.219,.096),(.145,.169,.122),(.137,.102,.137),
            (.124,.044,.140),(.119,-.024,.141)]]
        _ribbon(m,part,'Shoulder harness','web',path,.044,jacket_contact)
        # Rectangular wire ladder lock, following the angle of the strap.
        loc = path[3]
        x,y,z = loc
        frame = [(x+dx,y+dy,z+.50*dy-.006) for dx,dy in
                 [(-.022,-.012),(-.024,-.009),(-.024,.011),(-.020,.015),
                  (.020,.015),(.024,.011),(.024,-.009),(.021,-.012),(-.022,-.012)]]
        m.tube(part,'Harness ladder-lock frame','metal',frame,.0037,7)
        m.tube(part,'Harness ladder-lock bar','metal',[(x-.021,y,z-.009),(x+.021,y,z-.009)],.0037,7)
        for yy in [.074,.092]:
            m.box(part,'Shoulder keeper', 'cloth',(side*.126,yy,-.161),(.041,.008,.008),.002)

    # The pouch backs follow the lower ribcage. A single 24 mm woven belt
    # lies against the coat; the three narrow hanging loops bridge from
    # that belt to the pouch backs, leaving the jacket visible in between.
    def waist_front(x):
        return -.132 + 1.48*x*x
    belt=[]
    for y,bulge in [(-.118,0),(-.115,.002),(-.098,.002),(-.094,0)]:
        belt.append([(x,y+.16*x*x,waist_front(x)-bulge)
                     for x in [-.165,-.141,-.110,-.070,-.035,0,.035,.070,.110,.141,.165]])
    m.surface(part,'Woven pouch mounting tape','web',belt)
    m.tube(part,'Mounting tape lower stitch','cloth',belt[1],.0012,5)
    for x in [-.119,-.021,.086]:
        back=waist_front(x)
        _ribbon(m,part,'Folded pouch hanger','cloth',[
            (x,-.164,back-.023),(x,-.146,back-.024),(x,-.119,back-.021),
            (x,-.108,back-.013),(x,-.101,back-.004),(x,-.091,back+.004)],
            .024)

    # The stamped rescue panel is nested inside a raised graphite gasket.
    outer = [(-.101,-.050),(-.108,-.030),(-.105,.075),(-.080,.090),(-.070,.123),
             (-.053,.134),(.063,.134),(.079,.114),(.089,.084),(.108,.069),(.105,-.032),(.090,-.050)]
    def plate_depth(x,y):
        return -.196 + 1.8*x*x + .49*(y-.044)**2
    _panel(m,part,'Shock isolated chest insert','rubber',outer,plate_depth,.025)
    plate = [(x*.96,(y-.041)*.922+.041) for x,y in outer]
    def ceramic_depth(x,y):
        return plate_depth(x,y)-.008
    _panel(m,part,'Pressed rescue chest plate','orange',plate,ceramic_depth,.012,.12)
    for side in [-1,1]:
        for y in [-.022,.068]:
            x=side*(.086 if y<0 else .080)
            z=ceramic_depth(x,y)-.002
            m.ellipsoid(part,'Captive plate fastener','metal',(x,y,z),(.006,.006,.0025),10,6)
    # A small molded ridge, removable ID strip and its two visible screw heads.
    _panel(m,part,'Chest ID strip','rubber',
           [(-.062,.076),(-.060,.098),(.054,.098),(.064,.084),(.059,.076)],
           lambda x,y:ceramic_depth(x,y)-.004,.005)
    for x in [-.046,-.035,-.024]:
        m.box(part,'Rescue ID stripe','shell',(x,.0855,ceramic_depth(x,.085)-.0058),(.006,.008,.0025),.001)
    for y in [-.013,.003,.019]:
        pts = [(x,y+.004*(abs(x)/.050),ceramic_depth(x,y)-.002) for x in [-.054,-.027,0,.027,.054]]
        m.tube(part,'Formed stiffening rib','orange',pts,.0027,6)

    # Push-to-talk clipped to the wearer's left strap, with the lead retained
    # above the carrier rather than stretching between independently posed parts.
    x=.147
    _panel(m,part,'Comms push-to-talk','rubber',[
        (x-.022,.033),(x-.018,.091),(x+.010,.094),(x+.018,.085),
        (x+.016,.032),(x+.006,.024),(x-.014,.025)],
        lambda x,y:-.158+1.2*(x-.128)**2,.023,.15)
    for y in [.052,.059,.066,.073]:
        m.tube(part,'Remote microphone grille','metal',[(x-.011,y,-.158),(x+.009,y,-.157)],.0015,5)
    m.box(part,'PTT key','orange',(x+.018,.058,-.150),(.005,.025,.008),.002)
    m.tube(part,'Clipped headset lead','rubber',[
        (.146,.091,-.147),(.162,.117,-.136),(.164,.151,-.121),(.158,.175,-.113),
        (.148,.193,-.091),(.146,.207,-.060),(.142,.216,-.024),(.136,.214,.021),
        (.130,.206,.061),(.128,.189,.091),(.124,.169,.115)],.0044,8)


def _pouches(m):
    part = 'pouches'
    # Individual fabric bodies and sewn flaps overlap a common mounting panel.
    # Differences in height and sag give each pouch its own packed shape.
    for index,(x,w,height,depth) in enumerate([
        (-.119,.090,.106,.058),(-.021,.087,.126,.087),(.086,.098,.115,.068)]):
        bottom=-.140 + (.009 if index==0 else 0)
        top=bottom+height
        # A bellows provides extra volume at the front of the middle
        # radio pouch. Keep the rear panels pressed against the same web.
        z=.015 + 1.48*x*x - .5*(depth-.055)
        first_piece=len(m.pieces)
        m.loft(part,'Soft utility pouch','web',[
            (bottom,w*.35,depth*.32,x,z), (bottom+.007,w*.46,depth*.48,x,z),
            (bottom+.024,w*.50,depth*.52,x,z-.002),
            (top-.026,w*.48,depth*.52,x,z),
            (top-.010,w*.46,depth*.47,x,z+.001),(top,w*.35,depth*.36,x,z+.002),
        ],20,.53)
        def front(px,py):
            return z-depth*.61+.96*(px-x)**2
        flap=[(x-w*.48,top-.010),(x-w*.48,top-.034),(x-w*.34,top-.055),
              (x-w*.20,top-.060),(x+w*.32,top-.055),(x+w*.48,top-.038),
              (x+w*.47,top-.010),(x+w*.40,top-.003),(x-w*.37,top-.003)]
        _panel(m,part,'Rounded pouch flap','web',flap,front,.014,.09,soft=True)
        stitched=[(px,py,front(px,py)-.001) for px,py in flap[:6]]
        m.tube(part,'Pouch flap binding','cloth',stitched,.0022,6)
        # Narrow pull web and rounded snap hardware.
        m.box(part,'Pouch pull web','cloth',(x,top-.047,front(x,top)-.002),
              (.017,.045,.008),.003)
        m.ellipsoid(part,'Blackened pouch snap','metal',(x,top-.041,front(x,top)-.007),
                    (.005,.005,.0025),10,6)
        m.box(part,'Pouch pull tip','web',(x,top-.073,front(x,top)-.003),(.014,.011,.007),.0018)
        # Each pouch lies tangent to the belt. Turning the complete sewn
        # assembly keeps its flap, snap and web pull on the same face.
        angle=-atan(2*1.48*x)
        c,s=cos(angle),sin(angle)
        for piece in m.pieces[first_piece:]:
            piece.verts=[(x+c*(px-x)+s*(pz-z),py,z-s*(px-x)+c*(pz-z)) for px,py,pz in piece.verts]
            if piece.normals:
                piece.normals=[(c*nx+s*nz,ny,-s*nx+c*nz) for nx,ny,nz in piece.normals]



def _pack(m):
    part = 'pack'
    m.loft(part,'Radio pack contact pad','cloth',[
        (-.317,.104,.047,0,-.011),(-.299,.138,.052,0,-.013),
        (-.245,.148,.055,0,-.015),(-.083,.147,.057,0,-.015),
        (-.039,.124,.052,0,-.013),(-.014,.080,.041,0,-.007),
    ],28,.74)
    m.loft(part,'Clamshell radio pack','dark',[
        (-.330,.096,.043,0,.042),(-.324,.132,.061,0,.044),
        (-.306,.145,.069,0,.050),(-.239,.151,.073,0,.055),
        (-.115,.149,.075,0,.055),(-.063,.145,.074,0,.051),
        (-.046,.134,.068,0,.047),(-.028,.116,.062,0,.041),
        (-.017,.068,.043,0,.039),
    ],32,.72)
    pocket=[(-.115,-.302),(-.125,-.278),(-.119,-.197),(-.100,-.182),
            (.093,-.178),(.117,-.190),(.122,-.273),(.109,-.299),(.079,-.310),(-.083,-.310)]
    def pocket_face(x,y):
        return .159-.96*x*x-.32*(y+.235)**2
    _panel(m,part,'Pack field pocket','web',pocket,pocket_face,.048,.15,1)
    for side in [-1,1]:
        m.tube(part,'Pack edge piping','cloth',[(side*x,y,z) for x,y,z in [
            (.102,-.317,.089),(.133,-.296,.086),(.142,-.250,.087),(.143,-.124,.088),
            (.134,-.075,.091),(.117,-.052,.094),(.084,-.038,.090)]],.0038,7)
    # Rear-facing relief patch and two reflective bars read from spectator view.
    patch=[(-.104,-.157),(-.112,-.142),(-.105,-.083),(-.083,-.070),
           (.080,-.070),(.104,-.083),(.108,-.145),(.088,-.157)]
    def rear_face(x,y):
        return .133-.85*x*x-.36*(y+.110)**2
    _panel(m,part,'Pack upper reinforcement','cloth',patch,rear_face,.023,.09,1)
    for y,width in [(-.103,.100),(-.121,.061)]:
        points=[(x,y,rear_face(x,y)+.002) for x in [-width/2,0,width/2]]
        m.tube(part,'Pack reflective identification','shell',points,.0038,6)
    # Bent sliders traverse a matching zipper track on the pocket.
    zipline=[(-.098,-.201),(-.063,-.196),(-.018,-.194),(.038,-.194),(.081,-.196),(.097,-.204)]
    m.tube(part,'Field pocket zipper','rubber',[(x,y,pocket_face(x,y)+.001) for x,y in zipline],.0033,7)
    for x in [.015,.032]:
        z=pocket_face(x,-.195)
        m.box(part,'Pack zip slider','metal',(x,-.196,z+.003),(.013,.009,.007),.0025)
        m.tube(part,'Cord zipper pull','orange',[(x,-.199,z+.004),(x+.006,-.211,z+.007),
               (x+.004,-.219,z+.004),(x-.002,-.218,z+.004),(x-.002,-.207,z+.005)],.0021,6)
    for side in [-1,1]:
        x=side*.137
        m.loft(part,'Side compression sleeve','web',[
            (-.231,.017,.028,x,.042),(-.220,.027,.043,x,.042),(-.151,.027,.043,x,.040),
            (-.143,.023,.039,x,.040)],16,.70)
        # Side fasteners and short tension tails.
        m.box(part,'Side compression slide','rubber',(side*.162,-.169,.040),(.010,.026,.026),.004)
    # Bottom shock cord makes a conspicuous opposing diagonal on the rear.
    for side in [-1,1]:
        pts=[(side*.079,-.225,.151),(side*.043,-.249,.160),(side*.005,-.275,.161),
             (-side*.024,-.281,.159)]
        m.tube(part,'Lower pocket shock cord','rubber',pts,.0035,7)
        m.ellipsoid(part,'Cord anchor','metal',(side*.079,-.225,.151),(.006,.006,.006),10,6)
    # Sewn grab handle sits against the top and a short low-profile aerial
    # bends toward the shoulder. All moving electronics stay on the pack joint.
    m.tube(part,'Grab handle','web',[(-.044,-.030,.047),(-.040,-.002,.044),
           (-.024,.009,.042),(.023,.009,.042),(.039,-.002,.044),(.044,-.030,.047)],.008,8)
    m.loft(part,'Radio antenna socket','rubber',[
        (-.043,.014,.014,.109,.038),(-.029,.014,.014,.109,.038),
        (-.022,.010,.010,.109,.038)],12)
    m.tube(part,'Flexible radio antenna','rubber',[
        (.109,-.027,.038),(.111,.004,.038),(.116,.055,.039),(.123,.117,.041),
        (.131,.171,.046)],.0036,7)
    m.tube(part,'Aerial protective tip','cloth',[(.130,.162,.045),(.131,.172,.046)],.0046,8)


def build_carrier(m):
    _jacket(m)
    _carrier(m)
    _pouches(m)
    _pack(m)
