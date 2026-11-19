"""Rivet's field trousers, climbing belt and approach boots in gameplay joint space."""
from math import cos, pi, sin, tau


def _pelvis(m):
    # Two crotch panels meet exactly at centre front/back at the waist, then
    # flare into separate leg openings. The hem rises on the inseam and drops
    # over each outer thigh. A deep seat also keeps the hips joined in a squat.
    count = 32
    for side in (-1, 1):
        rows = []
        for y, width, rx, rz, leg, dz, rise in [
            (-.187,.237,.095,.086,1.0,.008,.043),(-.154,.255,.117,.120,.94,.010,.035),
            (-.119,.256,.127,.135,.82,.010,.029),(-.089,.251,.130,.142,.65,.008,.021),
            (-.055,.249,.130,.146,.44,.006,.011),(-.021,.241,.126,.143,.20,.005,.004),
            (.031,.227,.121,.136,0,.004,0),(.072,.216,.118,.127,0,.002,0),
        ]:
            row = []
            for i in range(count):
                a = tau*i/count
                outer, front = sin(a), cos(a)
                # Half-ovals at the waist relax into elliptical legs below it.
                waist_x = width*max(0,outer)**.85
                thigh_x = width-rx+rx*outer
                x = side*(waist_x*(1-leg)+thigh_x*leg)
                height = y+rise*(.48-.55*outer+.23*front)
                # Seat volume peaks in the upper rear quarters, above the glute fold.
                z = dz-rz*front + .006*max(0,-front)*max(0,outer)*(1-leg)
                back = min(1, max(0, (z+.035)/.066))
                height += back * max(0, -.100-.22*max(0,-height-.100)-height)
                row.append((x,height,z))
            rows.append(row)
        faces=[]
        for j in range(len(rows)-1):
            for i in range(count):
                a,b=j*count+i,j*count+(i+1)%count
                faces.append((a,a+count,b+count,b))
        faces.append(tuple(range(count)))
        faces.append(tuple(reversed(range((len(rows)-1)*count,len(rows)*count))))
        if side<0:
            faces=[tuple(reversed(face)) for face in faces]
        m.mesh('hips','Gusseted trouser seat','cloth',[p for row in rows for p in row],faces)
        # Garment construction follows the front fabric rather than hovering
        # on a cylindrical shell. Each slashed opening ends inside its pocket.
        m.tube('hips','Inset hand pocket','rubber',[(side*.185,-.018,-.101),
            (side*.173,-.033,-.114),(side*.159,-.055,-.126),
            (side*.146,-.074,-.133),(side*.137,-.090,-.136)],.0038,6)
        m.tube('hips','Pocket facing stitch','cloth',[(side*.181,-.019,-.102),
            (side*.168,-.037,-.117),(side*.155,-.057,-.129),
            (side*.141,-.079,-.135)],.0021,5)
    m.tube('hips','Fly placket seam','rubber',[(.015,.003,-.138),(.016,-.017,-.141),
        (.020,-.037,-.143),(.024,-.057,-.140),(.031,-.069,-.136),(.040,-.074,-.134)],.0028,6)
    # Bias-bound jacket tails overlap the waist at a diagonal. Their fronts
    # part at the zip, exposing the fly instead of an uninterrupted raised rim.
    for side in (-1,1):
        rows=[]
        for y,rx,rz in [(.018,.226,.136),(.034,.230,.139),(.074,.223,.139),(.114,.216,.132)]:
            row=[]
            for i in range(17):
                a=.04+(pi-.06)*i/16
                x=sin(a); z=cos(a)
                hem=.010*cos(2*a+.4*side)-.011*max(0,-z)
                row.append((side*rx*x,y+hem,-rz*z+.001))
            rows.append(row if side>0 else list(reversed(row)))
        m.surface('hips','Jacket tail','dark',rows)
    m.loft('hips', 'Padded belt lining', 'rubber', [
        (-.026, .240, .137, 0, .002), (-.020, .249, .147, 0, .002),
        (.047, .247, .146, 0, .002), (.053, .232, .138, 0, .002),
    ], segments=32, exponent=.80)
    m.loft('hips', 'Woven equipment belt', 'web', [
        (-.011, .250, .148, 0, .002), (-.007, .253, .151, 0, .002),
        (.034, .251, .150, 0, .002), (.038, .249, .148, 0, .002),
    ], segments=32, exponent=.80)
    for side in (-1, 1):
        m.tube('hips', 'Seat yoke piping', 'cloth', [
            (side*.192, -.032, .112), (side*.138, -.050, .148), (side*.092, -.063, .152), (side*.054, -.069, .138),
        ], .0035, 5)
        m.box('hips', 'Belt keeper', 'cloth', (side*.103, .014, -.146), (.023,.067,.016), .005)
    for offset in (-.161, .161):
        m.box('hips', 'Rear belt keeper', 'cloth', (offset,.014,.131), (.023,.064,.016), .004)
    m.box('hips', 'Quick buckle backing', 'rubber', (0,.013,-.149), (.117,.065,.017), .006)
    m.box('hips', 'Quick buckle frame', 'metal', (0,.015,-.162), (.093,.045,.012), .006)
    m.box('hips', 'Buckle latch relief', 'rubber', (0,.015,-.171), (.052,.022,.007), .003)
    m.box('hips', 'Buckle release flag', 'orange', (.024,.016,-.176), (.014,.016,.004), .002)

    # Rounded utility pouch on the right hip; on the opposite side hang the web loop and clip.
    m.loft('hips', 'Hip field pouch', 'web', [
        (-.093,.031,.049,.255,.009), (-.084,.041,.062,.256,.009),
        (-.024,.042,.066,.256,.009), (.038,.038,.061,.252,.009),
        (.048,.032,.054,.251,.009),
    ], segments=16, exponent=.62)
    m.loft('hips', 'Field pouch lid', 'cloth', [
        (-.010,.043,.064,.257,.008), (-.003,.046,.065,.257,.008),
        (.045,.040,.061,.253,.008), (.053,.036,.055,.248,.008),
    ], segments=16, exponent=.69)
    m.box('hips','Pouch closure','web',(.302,-.015,.008),(.008,.046,.024),.003)
    m.box('hips','Pouch press stud','metal',(.307,-.025,.008),(.006,.014,.014),.003)
    m.box('hips','Clip anchor','web',(-.249,.004,-.042),(.024,.061,.038),.005)
    clip = [(-.257,.005,-.049),(-.274,-.006,-.053),(-.294,-.061,-.061),
            (-.292,-.078,-.064),(-.282,-.086,-.063),(-.266,-.084,-.062),
            (-.249,-.063,-.057),(-.242,-.036,-.054),(-.246,-.015,-.051),
            (-.252,.001,-.049),(-.257,.005,-.049)]
    m.tube('hips','Equipment carabiner','metal',clip,.006,8)
    m.tube('hips','Carabiner gate sleeve','orange',clip[6:9],.008,8)


# Each shell spans one moving joint. Diagonal deviations at the fold stations
# break the tubular silhouette; the long side seam follows the actual cut.
def _trouser_shell(m, part, side, cut):
    count = 24
    vertices, faces = [], []
    profiles = []
    for y, rx, rz, xbias, zbias, bow, tilt in cut:
        row = []
        for i in range(count):
            a = i*tau/count
            # More volume at the outer thigh, with a sloping crease behind the limb.
            ease = .018*cos(2*a+.4*side) + .012*cos(3*a-1.15*side)
            row.append((xbias+rx*(1+ease)*sin(a),
                        y+bow*(.72*sin(a+tilt)+.28*sin(2*a-tilt)),
                        zbias-rz*(1+ease)*cos(a)))
        profiles.append(row)
        vertices.extend(row)
    for j in range(len(cut)-1):
        for i in range(count):
            a = j*count+i
            b = j*count+(i+1)%count
            faces.append((a,a+count,b+count,b))
    faces.append(tuple(range(count)))
    faces.append(tuple((len(cut)-1)*count+i for i in reversed(range(count))))
    m.mesh(part, 'Articulated trouser cut', 'cloth', vertices, faces)
    for index in (1 if side>0 else -1, 8 if side>0 else -8):
        stitch = []
        for row in profiles:
            x,y,z = row[index]
            stitch.append((x*1.012,y,z*1.012))
        m.tube(part,'Felled trouser seam','dark',stitch,.0028,5)


def _cargo_pocket(m, part, side):
    # The side pocket is cut around the leg. Its bellows project at the bottom and
    # tuck behind the welt at the top. Angle zero is the front of the thigh.
    def point(a,y,rx,rz):
        return (side*(.004+rx*sin(a)),y,-rz*cos(a))

    def panel(name,mat,stations):
        # Angle progresses in opposite directions on the two legs for outward winding.
        rows = []
        for y, start, end, rx, rz in stations:
            row = [point(start+(end-start)*i/8,y,rx,rz) for i in range(9)]
            rows.append(row if side>0 else list(reversed(row)))
        # Bellows return to a backing that lies inside the trouser. A single
        # open decal here reads as detached when seen edge-on in the armory.
        width = len(rows[0])
        vertices = [v for row in rows for v in row]
        perimeter = list(range(width))
        perimeter += [j*width+width-1 for j in range(1,len(rows))]
        perimeter += list(reversed(range((len(rows)-1)*width, len(rows)*width-1)))
        perimeter += list(reversed([j*width for j in range(1,len(rows)-1)]))
        faces = [(j*width+i,(j+1)*width+i,(j+1)*width+i+1,j*width+i+1)
                 for j in range(len(rows)-1) for i in range(width-1)]
        inside = len(vertices)
        for idx in perimeter:
            x,y,z=vertices[idx]
            vertices.append((x*.67,y,z*.71))
        for i, idx in enumerate(perimeter):
            nxt = (i+1)%len(perimeter)
            faces.append((idx,perimeter[nxt],inside+nxt,inside+i))
        m.mesh(part,name,mat,vertices,faces)


    panel('Gusseted map pocket', 'cloth', [
        (-.245,.88,1.99,.114,.101),(-.232,.75,2.10,.133,.111),
        (-.209,.74,2.10,.137,.113),(-.130,.70,2.05,.143,.121),
        (-.105,.76,2.00,.125,.120),
    ])
    panel('Map pocket flap', 'cloth', [
        (-.155,.82,1.99,.142,.116),(-.147,.70,2.06,.146,.129),
        (-.112,.68,2.05,.146,.127),(-.099,.73,2.00,.125,.120),
    ])
    m.tube(part,'Map pocket pleat','cloth',[
        point(1.67,-.230,.132,.109),point(1.63,-.209,.138,.112),
        point(1.66,-.173,.141,.118),point(1.73,-.156,.143,.121),
    ],.0035,6)
    p = point(1.21,-.150,.149,.131)
    m.box(part,'Pocket zip garage','rubber',p,(.014,.036,.019),.004)
    m.tube(part, 'Glove friendly zip pull', 'orange', [
        (p[0],p[1]-.003,p[2]),(p[0]+side*.004,p[1]-.016,p[2]-.006),
        (p[0],p[1]-.025,p[2]-.005), (p[0]-side*.004,p[1]-.019,p[2]+.002),
    ], .0028,5)


def _knee(m, part):
    for y, rx, rz, cz in [(-.103,.097,.102,.006),(.006,.094,.098,.001)]:
        m.loft(part,'Knee pad retaining strap','web',[
            (y-.009,rx-.005,rz-.006,0,cz),(y-.006,rx,rz,0,cz),
            (y+.008,rx,rz,0,cz),(y+.011,rx-.005,rz-.006,0,cz),
        ], segments=20, exponent=.89)

    # Use the same convex mould for backing and shell. A depth offset keeps
    # their edges seated without letting the backing show through the ceramic.
    rim = [(-.026,.055),(.028,.055),(.063,.045),(.084,.023),(.093,-.012),
           (.086,-.052),(.071,-.081),(.052,-.108),(.030,-.120),(-.028,-.120),
           (-.051,-.108),(-.071,-.082),(-.086,-.054),(-.093,-.013),
           (-.084,.022),(-.063,.044)]
    cy = -.028
    def depth(x,y):
        return -.140 + .044*(x/.093)**2 + .036*((y-cy)/.096)**2

    def mould(name, mat, rings, scale_x, scale_y):
        vertices=[(0,cy,depth(0,cy)+rings[0][1])]
        faces=[]
        n=len(rim)
        for ring_index,(scale,dz) in enumerate(rings):
            for x,y in rim:
                x=x*scale_x*scale
                y=cy+(y-cy)*scale_y*scale
                vertices.append((x,y,depth(x,y)+dz))
            start=1+n*ring_index
            for i in range(n):
                a,b=start+i,start+(i+1)%n
                faces.append((0,a,b) if ring_index==0 else (a-n,a,b,b-n))
        faces.append(tuple(reversed(range(len(vertices)-n,len(vertices)))))
        m.mesh(part,name,mat,vertices,faces)

    mould('Wraparound EVA knee backing','rubber',[(.54,0),(.92,0),(1,.006),
          (.99,.020),(.88,.044)],1.0,1.0)
    mould('Preshaped ceramic knee cup','shell',[(.42,-.012),(.80,-.010),
          (.95,-.008),(1,-.004),(.99,.001)],.82,.82)
    for side in (-1,1):
        for x,y in [(side*.051,.008),(side*.045,-.069)]:
            m.ellipsoid(part,'Recessed shell stud','metal',(x,y,depth(x,y)-.010),
                        (.004,.004,.0025),8,4)
        path=[(side*x,y,depth(x,y)-.0105) for x,y in [(.023,-.074),(.031,-.070),(.041,-.061)]]
        m.tube(part,'Moulded relief line','rubber',path,.0016,5)


def _boots(m, part, side):
    # Horizontal sections use the actual last rather than scaling cylinders:
    # the inside edge is straighter, the medial toe is longer, the waist narrows.
    outline = [( .000,-.217),(.044,-.213),(.071,-.195),(.086,-.160),(.089,-.114),
               (.083,-.068),(.076,-.018),(.074,.038),(.066,.068),(.045,.081),
               (.002,.085),(-.043,.081),(-.065,.067),(-.074,.040),(-.071,-.015),
               (-.073,-.065),(-.083,-.111),(-.085,-.155),(-.077,-.191),(-.051,-.213)]
    def sole(name,mat,layers):
        vertices, faces = [], []
        for height,width,length,offset in layers:
            for x,z in outline:
                # Turn up the tip so the toe doesn't read as a slab.
                rock = max(0,(-z-.151)/.066)**2*.018
                vertices.append((side*x*width,height+rock,z*length+offset))
        n = len(outline)
        for j in range(len(layers)-1):
            for i in range(n):
                a,b = j*n+i,j*n+(i+1)%n
                faces.append((a,a+n,b+n,b))
        faces.append(tuple(range(n)))
        faces.append(tuple((len(layers)-1)*n+i for i in reversed(range(n))))
        if side<0: faces = [tuple(reversed(f)) for f in faces]
        m.mesh(part,name,mat,vertices,faces)
    sole('Climbing outsole','rubber',[(-.061,.95,.985,0),(-.057,1,1,0),(-.038,1,1,0),(-.034,.98,.995,0)])
    sole('Foamed midsole','midsole',[(-.042,.983,.996,0),(-.037,.990,1,0),(-.030,.975,.989,0)])
    sole('Toe and heel rand','rubber',[(-.032,.978,.990,0),(-.026,.980,.985,0),(-.009,.954,.974,.001),(.004,.902,.955,.001)])
    for z,width in [(-.180,.075),(-.139,.081),(-.099,.080),(-.059,.075),(.017,.070),(.052,.068)]:
        for edge in (-1,1):
            y = -.060 if z>-.160 else -.055
            m.box(part,'Outsole lug','rubber',(edge*(width-.018),y,z),(.040,.016,.024),.004)
    # Cross-sections along the vamp. Toe box, instep and heel follow different radii.
    stations = [(-.211,.024,.013),(-.199,.056,.026),(-.174,.072,.034),
                (-.147,.080,.037),(-.113,.083,.040),(-.090,.079,.049),
                (-.071,.076,.065),(-.048,.073,.091),(-.024,.071,.110),
                (.008,.069,.119),(.041,.066,.111),(.060,.065,.103),
                (.073,.055,.088),(.078,.039,.056)]
    # Cut across the leather last. The upper has a flat lasting margin down
    # inside the rubber rand, a vertical quarter, and a domed toe and instep.
    outline = [(0,1),(.33,.97),(.60,.90),(.81,.75),(.96,.52),(1,.25),
               (.96,.05),(.85,0),(-.85,0),(-.96,.05),(-1,.25),(-.96,.52),
               (-.81,.75),(-.60,.90),(-.33,.97)]
    vertices, faces = [], []
    segments=len(outline)
    for z,width,top in stations:
        for x,height in outline:
            vertices.append((width*x,-.025+(top+.025)*height,z))
    for j in range(len(stations)-1):
        for i in range(segments):
            a,b = j*segments+i,j*segments+(i+1)%segments
            faces.append((a,a+segments,b+segments,b))
    faces.extend([tuple(range(segments)),tuple((len(stations)-1)*segments+i for i in reversed(range(segments)))])
    m.mesh(part,'Waxed nubuck upper','leather',vertices,faces)
    # Quarters wrap up either side of the ankle. The opening is a U at
    # the instep, making room for the longer tongue and crossed laces.
    for s in (-1,1):
        rows=[]
        for rx,rz,rear,front,shift in [(.066,.077,.001,-.018,0),(.074,.080,.057,.025,0),
                                        (.073,.077,.097,.055,.003),(.066,.075,.119,.067,.004)]:
            row=[]
            for i in range(15):
                a=.53+(pi-.50)*i/14
                x=sin(a);z=cos(a)
                y=front+(rear-front)*(1-z)*.50
                row.append((s*rx*x,y,-rz*z+shift))
            rows.append(row if s>0 else list(reversed(row)))
        m.surface(part,'Ankle quarter','leather',rows)
        m.tube(part,'Rolled collar facing','rubber',rows[-1],.0055,6)
    tongue=[(.039,-.123,.029),(.051,-.098,.034),(.072,-.082,.036),(.091,-.071,.036),
            (.110,-.061,.037),(.124,-.055,.030)]
    m.surface(part,'Gusseted tongue','rubber',[
        [(-w,y-.006,z+.005),(-w*.62,y-.001,z-.001),(0,y,z-.004),
         (w*.62,y-.001,z-.001),(w,y-.006,z+.005)] for y,z,w in tongue])
    m.tube(part,'Tongue binding','leather',[(-.030,.118,-.050),(-.020,.124,-.055),
        (0,.126,-.058),(.020,.124,-.055),(.030,.118,-.050)],.0035,6)
    for s in (-1,1):
        m.tube(part,'Heel stay piping','leather',[(s*.061,-.008,.055),(s*.068,.018,.041),
            (s*.071,.055,.034),(s*.063,.080,.045)],.0036,6)
        m.tube(part,'Toe cap stitching','dark',[(s*.079,-.003,-.149),(s*.069,.011,-.152),
            (s*.044,.026,-.148),(0,.032,-.142)],.0026,6)
    eyelets=[(.036,-.121,.033),(.050,-.099,.037),(.066,-.082,.041),(.086,-.072,.043),(.105,-.064,.042)]
    for y,z,w in eyelets:
        for s in (-1,1):
            m.ellipsoid(part,'Lace hook','metal',(s*w,y,z),(.009,.005,.006),8,4)
    for (y,z,w),(ny,nz,nw) in zip(eyelets,eyelets[1:]):
        for s in (-1,1):
            m.tube(part,'Round trekking lace','web',[(s*w,y,z),
                (s*.015,y*.65+ny*.35+.008,z*.65+nz*.35-.005),
                (-s*.013,y*.33+ny*.67+.008,z*.33+nz*.67-.005),(-s*nw,ny,nz)],.0036,6)
    m.tube(part,'Heel pull loop','web',[(0,.078,.073),(0,.115,.082),(0,.126,.078),(0,.124,.071),(0,.098,.068)],.005,6)


def build_lower_body(m):
    _pelvis(m)
    for side, prefix in [(-1,'l'),(1,'r')]:
        thigh,knee,boot = prefix+'Thigh',prefix+'Knee',prefix+'Boot'
        # The lapped cuts dip and recover at the knees and boot tops, where
        # compression bunches the fabric. Each pair has a different bias.
        _trouser_shell(m,thigh,side,[
            (-.346,.028,.035,0,0,.002,.6*side),(-.335,.055,.063,0,-.001,.003,.6*side),
            (-.320,.071,.078,0,-.002,.004,.6*side),(-.302,.084,.087,0,-.002,.010,1.0*side),
            (-.289,.084,.089,0,-.006,.012,.9*side),(-.277,.078,.083,0,-.007,.012,.9*side),
            (-.256,.091,.092,side*.001,-.004,.013,.7*side),(-.242,.088,.090,side*.002,-.002,.012,.7*side),
            (-.217,.101,.103,side*.004,-.005,.012,.3*side),(-.169,.107,.112,side*.005,-.005,.009,.3*side),
            (-.120,.111,.120,side*.004,-.003,.010,.4*side),(-.108,.109,.115,side*.004,-.001,.013,.3*side),
            (-.083,.117,.123,-side*.004,.002,.013,.3*side),(-.042,.118,.126,-side*.007,.003,.010,.6*side),
            (-.004,.119,.128,-side*.009,.006,.009,.7*side),(.021,.111,.124,-side*.012,.011,.008,.6*side),
            (.053,.078,.051,-side*.014,-.064,.003,.6*side),
            (.075,.032,.025,-side*.012,-.057,.002,.6*side),
        ])
        _cargo_pocket(m,thigh,side)
        _trouser_shell(m,knee,side,[
            (-.321,.057,.059,-side*.001,.008,.004,.5*side),(-.298,.063,.067,-side*.001,.003,.006,.6*side),
            (-.277,.071,.073,-side*.002,.004,.008,.4*side),
            (-.254,.068,.071,-side*.003,.001,.009,.7*side),(-.246,.079,.081,-side*.003,-.001,.010,.7*side),
            (-.230,.081,.082,-side*.001,.002,.011,.7*side),(-.215,.073,.077,0,.003,.012,.8*side),
            (-.195,.080,.089,side*.001,.006,.011,.9*side),(-.171,.083,.094,side*.002,.008,.011,1.4*side),
            (-.127,.089,.095,side*.003,.008,.008,1.3*side),(-.085,.093,.095,side*.001,.004,.005,1.3*side),
            (-.055,.091,.089,0,.002,.006,.5*side),(-.032,.090,.092,0,.002,.005,.4*side),
            (-.008,.088,.089,0,0,.003,.4*side),(.022,.073,.077,0,-.002,.002,.2*side),(.040,.062,.065,0,-.004,.002,.2*side),
            (.054,.043,.045,0,-.006,.001,.2*side),(.061,.018,.019,0,-.006,.001,.2*side),
        ])
        _knee(m,knee)
        _boots(m,boot,side)
