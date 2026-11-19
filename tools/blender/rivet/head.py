"""Alpine rescue helmet, snow goggles, communications set and fitted wind mask."""

from math import cos, exp, pi, sin


def build_head(m):
    part = 'head'

    def coords(angles, levels, point):
        return [[point(angle, level) for angle in angles] for level in levels]

    def steps(start, end, count):
        return [start + (end - start) * i / count for i in range(count + 1)]

    def closed_skin(label, material, rings):
        """The profile runs from neck to crown; each ring starts at the nape."""
        sides = len(rings[0])
        verts = [point for ring in rings for point in ring]
        faces = []
        for j in range(len(rings) - 1):
            for i in range(sides):
                a = j * sides + i
                b = j * sides + (i + 1) % sides
                faces.append((a, a + sides, b + sides, b))
        faces.append(tuple(range(sides)))
        top = len(verts) - sides
        faces.append(tuple(top + i for i in reversed(range(sides))))
        m.mesh(part, label, material, verts, faces)

    def stripe(label, material, centerline, halfwidth, layers, point, across=5):
        """A strip laid onto a curved surface in its angular coordinates."""
        rows = []
        for v in layers:
            start, end = centerline(v) - halfwidth(v), centerline(v) + halfwidth(v)
            rows.append([point(u, v) for u in steps(start, end, across)])
        m.surface(part, label, material, rows)

    # Sections through the balaclava. The jaw narrows into the chin, while a
    # shaped centre gore expands over the nose and folds at the bridge.
    # height, half-width, depth, aft centre, protrusion of the front gore
    mask = [
        (-.242, .065, .058, .003, .000),
        (-.210, .071, .070, .003, .006),
        (-.174, .073, .077, .002, .009),
        (-.158, .075, .083, -.002, .014),
        (-.151, .082, .092, -.005, .034),
        (-.143, .087, .101, -.006, .044),
        (-.121, .094, .108, -.008, .045),
        (-.089, .105, .121, -.003, .029),
        (-.064, .112, .127, .000, .014),
        (-.043, .117, .131, .001, .036),
        (-.026, .122, .139, .003, .054),
        (-.012, .124, .142, .003, .046),
        (.002, .125, .142, .004, .040),
        (.022, .125, .141, .004, .022),
        (.053, .125, .140, .007, .008),
        (.086, .108, .120, .009, .000),
    ]
    angles = steps(-pi, pi, 48)[:-1]

    def cloth_at(a, r, lift=0):
        y, rx, rz, zc, nose = r
        jaw = exp(-((y + .143) / .047) ** 2)
        cheek = sin(a) ** 2 * max(0, cos(a))
        # Across the jaw the gore is broad; it narrows abruptly over the
        # bridge of the nose. The mandible rises behind the chin toward the ear.
        breadth = .43 + .40 * jaw
        return ((rx + lift) * sin(a), y + .064 * jaw * cheek,
                zc - (rz + lift) * cos(a) - nose * exp(-(a / breadth) ** 2))

    def cloth_height(a, height, lift=0):
        for r0, r1 in zip(mask, mask[1:]):
            if r0[0] <= height <= r1[0]:
                t = (height - r0[0]) / (r1[0] - r0[0])
                r = [x + t * (y - x) for x, y in zip(r0, r1)]
                return cloth_at(a, r, lift)
        return cloth_at(a, mask[0] if height < mask[0][0] else mask[-1], lift)

    closed_skin('Windproof hood / nose and chin gores', 'cloth',
                [[cloth_at(a, r) for a in angles] for r in mask])

    # Fabric gathers under the chin instead of stretching the cheek fabric
    # all the way to the sternum. The back rises with the nape; alternating
    # diagonal rolls bunch where the gaiter meets the jacket collar.
    gaiter = [
        (-.240,.077,.073),(-.211,.080,.077),(-.198,.087,.083),
        (-.193,.085,.080),(-.187,.078,.075),(-.181,.084,.081),
        (-.173,.090,.085),(-.166,.089,.083),(-.160,.080,.076),
        (-.152,.079,.077),
    ]
    gathered = []
    for j, (height, rx, rz) in enumerate(gaiter):
        t = j / (len(gaiter)-1)
        row = []
        for a in steps(-pi, pi, 26):
            slope = .009*sin(a + .65 + t*1.4) + .003*sin(3*a+t*6)
            rise = -.011*t*cos(a) + slope*sin(pi*t*.8)
            row.append((rx*sin(a), height+rise, .002-rz*cos(a)))
        gathered.append(row)
    m.surface(part, 'Hood / gathered neck warmer', 'cloth', gathered)

    # A bound lower edge follows the underside of the jaw and turns upward
    # at the ears. This distinct undercut separates the fitted face cover
    # from the gathered fabric on the throat.
    jaw_angles = steps(-1.37,1.37,36)
    hem_rows = []
    for dy, lift in [(0,.001),(.002,.0025),(.004,.002)]:
        hem_rows.append([cloth_height(a,-.151+.033*sin(a)**2+dy,lift) for a in jaw_angles])
    m.surface(part, 'Wind mask / bound jawline', 'rubber', hem_rows)

    for side in (-1, 1):
        # Saddle seams curve outwards to the cheekbones and disappear behind
        # the helmet; the front knit panel meets the smoother side gussets.
        seam = [(.31,-.147),(.37,-.134),(.47,-.121),(.61,-.089),
                (.78,-.064),(.98,-.043),(1.13,-.026),(1.20,-.012),(1.25,.002)]
        points = [cloth_height(side*a, y, .0015) for a,y in seam]
        m.tube(part, 'Mask / bound cheek seam', 'rubber', points, .0018, sides=5)
        for seq, start, end in [(mask[2:9], 1.47, 1.18), (mask[1:5], 2.7, 2.42)]:
            line = [cloth_at(side * a, r, .0012)
                    for a, r in zip(steps(start, end, len(seq) - 1), seq)]
            m.tube(part, 'Mask / flatlock', 'dark', line, .0011, sides=5)

        # Bias-cut lower cheeks have a rolled top seam; the panel folds under
        # the chin. Small dark eyelets are pierced away from its centre seam.
        def panel(a, t):
            side_t = (abs(a) - .25) / .69
            y = -.132 + .034 * side_t + t * (.042 + .010 * side_t)
            lift = .001 + .0018 * sin(t * pi)
            return cloth_height(a, y, lift)
        panel_angles = steps(.25, .94, 10) if side == 1 else steps(-.94, -.25, 10)
        m.surface(part, 'Wind mask / woven cheek facing', 'cloth',
                  coords(panel_angles, steps(0, 1, 5), panel))
        m.tube(part, 'Wind mask / piping', 'rubber',
               [panel(a, .97) for a in panel_angles], .0011, sides=5)
        for vent_row in range(2):
            for i in range(4):
                a = side * (.33 + .095*i + .025*vent_row)
                y = -.102 + i * .0035 + vent_row * .0055
                vent = [cloth_height(a + .010*cos(t), y + .0016*sin(t), .0034)
                        for t in steps(0, -2*pi, 7)[:-1]]
                m.mesh(part, 'Cheek / laser cut vent', 'rubber',
                       vent, [tuple(range(len(vent)))])

    # The sidewalls descend over the temples and nape. Their raised ear cut
    # clears the cups; the frontal brim sits above the lens without a flat peak.
    def crown(a, t, lift=0):
        cf = cos(a)
        earpiece = exp(-((abs(a) - 1.65) / .46) ** 2)
        hem = -.045 + .111 * ((cf + 1) / 2) ** 1.65 + .024 * earpiece
        q = t * pi / 2
        radius = cos(q)
        nose = max(0, cf) ** 5 * .016 * exp(-t / .17)
        return (((.144 + lift) * radius) * sin(a),
                hem + (.185 + lift - hem) * sin(q),
                .013 - ((.174 + lift + nose) * radius) * cf)

    hoops = steps(-pi, pi, 48)[:-1]
    shells = [[crown(a, t) for a in hoops]
              for t in (0, .028, .085, .17, .27, .38, .49, .61, .73, .84, .93, .985)]
    closed_skin('Composite high-cut shell', 'shell', shells)

    def trim_hem(a, t):
        x, y, z = crown(a, t, .0016)
        return x, y - .0045, z

    m.surface(part, 'Shell / rolled protective rim', 'rubber',
              coords(steps(-pi, pi, 64), [0, .020], trim_hem))
    # A shallow brow sheds water over the top seal of the goggles. Build
    # its return separately so its rolled leading edge catches grazing light.
    brow_angles = steps(-1.12,1.12,36)
    def brow(a, reach, rise):
        root = crown(a,.050,.0008)
        edge = (1 - (abs(a)/1.12)**2) ** .72
        return (root[0] + .006*reach*edge*sin(a),
                root[1] - reach*.003*edge + rise*edge,
                root[2] - .023*reach*edge*cos(a))
    m.surface(part, 'Brow / molded rain peak', 'shell',
              [[brow(a,d,h) for a in brow_angles] for d,h in
               [(1,-.001),(.80,.0015),(.22,.0018),(0,0)]])
    m.surface(part, 'Brow / impact edging', 'rubber',
              [[brow(a,d,h) for a in brow_angles] for d,h in
               [(1,-.005),(1,-.001)]])
    for side in (-1,1):
        root = crown(side*.46,.14,.002)
        m.ellipsoid(part, 'Shell / recessed brow fixing', 'metal', root,
                    (.003,.0036,.0027), segments=9, rings=5)

    for side in (-1, 1):
        # Expand the footprint before laying down the coloured insert. This
        # leaves a narrow seal following the same contour on both sides.
        for name,mat,width,height,lift in [
                ('seal', 'rubber', 1., .0, .0016),
                ('team panel', 'suit', .92, .016, .0023)]:
            def panel_center(t):
                return side * (1.04 + t * .11)
            def panel_width(t):
                s = (t - (.06 + height)) / (.56 - 2 * height)
                return width * (.30 + .17 * sin(pi * max(0, min(1, s))) ** .55)
            stripe('Shell / temporal ' + name, mat, panel_center, panel_width,
                   steps(.06 + height, .62 - height, 10), lambda a, t: crown(a, t, lift))

        # Longitudinal channels on the rear quarter, set into a small gasket.
        for n, u in enumerate((2.02, 2.26, 2.50)):
            for label,mat,hw,h,lift in [('surround', 'metal', .061, 0, .0013),
                                        ('aperture', 'rubber', .043, .012, .0022)]:
                lo, hi = .22 + .025 * n + h, .56 + .025 * n - h
                stripe('Rear channel / ' + label, mat,
                       lambda t: side * (u - .18 * t),
                       lambda t: hw * (.6 + .4 * sin(pi * (t-lo)/(hi-lo))),
                       steps(lo, hi, 5), lambda a, t: crown(a, t, lift), across=2)

    # Orange crown tape bends over the dome, with separate front and rear
    # patches so there is no pinching texture at the pole.
    stripe('Helmet / high visibility rescue tape', 'orange',
           lambda t: 0, lambda t: .056 / max(.24, cos(t * pi / 2)),
           steps(.20, .90, 14), lambda a, t: crown(a, t, .0022))
    for y in (.21, .275):
        stripe('Tape / reflective break', 'ink', lambda t: 0,
               lambda t: .055 / cos(t * pi / 2), [y, y+.012],
               lambda a, t: crown(a, t, .0029))

    # The back strap is laid below the helmet rim and behind both cups.
    def strap(a, t):
        return (.139 * sin(a), -.038 + .028*t - .030 * (1 - cos(a)) / 2,
                .012 - .154 * cos(a))
    m.surface(part, 'Goggle / woven retention strap', 'rubber',
              coords(steps(1.04, 2*pi-1.04, 40), [0,.16,.84,1], strap))
    for side in (-1,1):
        for name, mat, x, y, z, rx, ry, rz in (
                ('Circumaural ear cushion', 'rubber', .133,-.022,.021,.022,.068,.057),
                ('Comm earcup alloy body', 'metal', .142,-.023,.020,.021,.061,.052),
                ('Comm earcup molded side', 'rubber', .153,-.025,.019,.015,.049,.043),
                ('Comm earcup rescue cap', 'orange', .163,-.026,.019,.007,.037,.031)):
            m.ellipsoid(part, name, mat, (side*x, y, z), (rx,ry,rz), segments=16, rings=8)
        # Counterbored earcap screws and recessed horizontal sound ports.
        for i in range(3):
            z0, z1 = .001 + .010*i, .007 + .010*i
            m.tube(part, 'Comms / baffled opening', 'rubber',
                   [(side*.1691,-.023,z0),(side*.1694,-.022,z1)], .0016, sides=6)
        for z in (-.010,.047):
            m.ellipsoid(part, 'Communication cup / pivot', 'metal',
                        (side*.163,-.025,z), (.004,.005,.005), segments=8, rings=4)
        m.tube(part, 'Ear defender / rear wishbone', 'metal',
               [(side*.136,.033,.088),(side*.152,.017,.074),
                (side*.161,-.007,.053),(side*.164,-.025,.046)],
               .0045, sides=7)
        m.tube(part, 'Ear defender / front wishbone', 'metal',
               [(side*.135,.042,-.051),(side*.151,.026,-.041),
                (side*.160,-.005,-.022),(side*.162,-.024,-.010)],
               .0045, sides=7)
        # Broad tape flattens against the mask on the way to the chin.
        tape = []
        for a, y in [(.58,-.145),(.68,-.133),(.85,-.110),(1.03,-.086),
                     (1.17,-.062),(1.34,-.042)]:
            tape.append([cloth_height(u, y, .003) for u in
                         sorted((side*(a-.073), side*(a+.073)))])
        m.surface(part, 'Liner / split retention web', 'rubber', tape)

    # A toric single lens. The bridge cut brings the bottom edge up over the
    # nose. Both lower corners recede toward the temples. A positive radial
    # lift follows the local surface, including around the side of the face.
    def goggle(a, v, lift=0):
        u = a / 1.24
        edge = abs(u) ** 3
        lo = -.045 + .048 * exp(-(u/.20)**2) + .028 * edge
        hi = .065 - .026 * edge
        bulge = .011 * sin(pi*v) * (1 - .44*edge)
        return ((.153 + bulge + lift) * sin(a), lo + (hi-lo)*v,
                -.010 - (.174 + bulge + lift) * cos(a))

    # A thickness return visible around the edges makes the goggles stand
    # proud of the gaiter and prevents see-through gaps in steep side views.
    corners = [(a, 0) for a in steps(-1.24, 1.24, 40)]
    corners += [(1.24, v) for v in steps(0, 1, 8)[1:]]
    corners += [(a, 1) for a in steps(1.24, -1.24, 40)[1:]]
    corners += [(-1.24, v) for v in steps(1, 0, 8)[1:]]
    m.surface(part, 'Goggle / molded frame return', 'rubber',
              [[goggle(a,v,lift) for a,v in corners] for lift in (-.012,.0008)])
    # Only the reveal around the lens needs a front surface. Reclaim the
    # hidden central area and keep the visible edge matched to the lens.
    for lo, hi in [(0,.095),(.905,1)]:
        m.surface(part, 'Goggle / horizontal frame reveal', 'rubber',
                  coords(steps(-1.24,1.24,44), [lo,hi], goggle))
    for lo, hi in [(-1.24,-1.16),(1.16,1.24)]:
        m.surface(part, 'Goggle / end frame reveal', 'rubber',
                  coords([lo,hi], steps(.095,.905,7), goggle))
    m.surface(part, 'Goggle / amber toric lens', 'visor',
              coords(steps(-1.18,1.18,44), steps(.077,.925,10),
                     lambda a,v: goggle(a,v,.0028)))

    for side in (-1,1):
        # Two spring clips keep the removable lens seated at the temples.
        for v in (.22,.80):
            m.tube(part, 'Lens / spring retainer', 'metal',
                   [goggle(side*a,v,.004) for a in steps(1.14,1.23,4)],
                   .0024, sides=5)
    # Tucked mic boom stays tight to the cheek and clear of the stock.
    m.tube(part, 'Comms / flexible boom', 'rubber',
           [(-.161,-.042,-.003),(-.158,-.053,-.038),(-.151,-.065,-.082),
            (-.134,-.072,-.112),(-.106,-.079,-.114),(-.084,-.078,-.119)],
           .0035, sides=8)
    m.ellipsoid(part, 'Comms / windscreen', 'rubber', (-.078,-.078,-.120),
                (.015,.008,.008), segments=14, rings=7)
