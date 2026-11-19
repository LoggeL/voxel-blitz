import * as THREE from '../../vendor/three.module.js';

export const palette = { cloth: 0x393c54, armor: 0x282332, glove: 0x292532, cuff: 0xbb91ff };

const INK = 0x13111c;
const OBSIDIAN = 0x3c324b;
const FACET = 0x665a76;
const EDGE = 0x9c87b2;
const ETCH = 0xd2c3ed;
const VIOLET = 0xbb91ff;

// A curved finish needs more than the two corner triangles of a flat plate.
// Split only the long spans, then bake the new normals once at equip time.
function fittedGeometry(source, surface) {
  const pos = source.getAttribute('position');
  const vertices = [], normals = [];
  const du = new THREE.Vector3(), dv = new THREE.Vector3(), up = new THREE.Vector3();
  const mappedU = new THREE.Vector3(), mappedV = new THREE.Vector3();
  function vertex(point) {
    const [x,y,z] = point;
    const mapped = surface(x,y,z);
    // Carry the planar face normal around the bend. Bevels keep their own
    // normals, while the triangles within one ceramic face share its sheen.
    mappedU.fromArray(surface(x + du.x, y + du.y, z + du.z));
    mappedV.fromArray(surface(x + dv.x, y + dv.y, z + dv.z));
    up.fromArray(mapped);
    mappedU.sub(up);
    mappedV.sub(up);
    up.crossVectors(mappedU, mappedV).normalize();
    vertices.push(...mapped);
    normals.push(up.x, up.y, up.z);
  }
  function triangle(a, b, c) {
    const span = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const ab = span(a, b), bc = span(b, c), ca = span(c, a);
    if (Math.max(ab, bc, ca) > .050) {
      if (bc > ab && bc >= ca) [a, b, c] = [b, c, a];
      else if (ca > ab) [a, b, c] = [c, a, b];
      const mid = a.map((v, i) => (v + b[i]) * .5);
      triangle(a, mid, c);
      triangle(mid, b, c);
    } else {
      vertex(a); vertex(b); vertex(c);
    }
  }
  for (let i = 0; i < pos.count; i += 3) {
    const point = j => [pos.getX(j), pos.getY(j), pos.getZ(j)];
    const a = point(i), b = point(i + 1), c = point(i + 2);
    up.fromArray(a);
    du.fromArray(b).sub(up).normalize();
    dv.fromArray(c).sub(up);
    dv.addScaledVector(du, -du.dot(dv)).normalize().multiplyScalar(.00025);
    du.multiplyScalar(.00025);
    triangle(a, b, c);
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  result.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  source.dispose();
  return result;
}

// Form sheet armor around a run of elliptical cross sections in joint space.
// Each section supplies height, two radii and the garment centre at that height.
function wrap(sections, angle, arcRadius, plane = 0, facing = -1) {
  return (x, y, z) => {
    let i = 0;
    while (i < sections.length - 2 && y > sections[i + 1][0]) i++;
    const low = sections[i], high = sections[i + 1];
    const t = THREE.MathUtils.clamp((y - low[0]) / (high[0] - low[0]), 0, 1);
    const mix = k => THREE.MathUtils.lerp(low[k], high[k], t);
    const a = angle - facing * x / arcRadius;
    const offset = (z - plane) * facing;
    return [mix(3) + (mix(1) + offset) * Math.sin(a), y,
      mix(4) - (mix(2) + offset) * Math.cos(a)];
  };
}

// Rigid details are batched by finish within each animated joint. Vertex colors
// retain the many individual facets without giving every engraving a draw call.
function panels(ctx, parent, name, finishes) {
  const group = ctx.group(parent, `revenant_${name}`);
  const batches = [[], []];
  const transform = new THREE.Object3D();
  let surface;
  function add(geometry, position, color, rotation = [0, 0, 0], luminous = false) {
    let source = geometry.index ? geometry.toNonIndexed() : geometry;
    if (source !== geometry) geometry.dispose();
    transform.position.set(...position);
    transform.rotation.set(...rotation);
    transform.updateMatrix();
    source.applyMatrix4(transform.matrix);
    if (surface) source = fittedGeometry(source, surface);
    const tint = new THREE.Color(color);
    const colors = new Float32Array(source.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = tint.r; colors[i + 1] = tint.g; colors[i + 2] = tint.b;
    }
    source.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    batches[luminous ? 1 : 0].push(source);
  }
  function box(size, position, color = OBSIDIAN, rotation, luminous = false) {
    add(new THREE.BoxGeometry(...size), position, color, rotation, luminous);
  }
  function plate(points, depth, position, color = OBSIDIAN, bevel = 0.003, rotation) {
    const shape = new THREE.Shape();
    points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelSize: bevel,
      bevelThickness: bevel, bevelSegments: 1, steps: 1, curveSegments: 1,
    });
    geometry.translate(0, 0, -depth / 2 + bevel);
    add(geometry, position, color, rotation);
  }
  function line(a, b, z, width = 0.003, color = ETCH, luminous = false) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    box([width, Math.hypot(dx, dy), 0.002], [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z],
      color, [0, 0, -Math.atan2(dx, dy)], luminous);
  }
  function ring(radius, tube, position, color = EDGE, rotation = [0, 0, 0], luminous = false) {
    add(new THREE.TorusGeometry(radius, tube, 3, 8), position, color, rotation, luminous);
  }
  function finish() {
    batches.forEach((sources, index) => {
      if (!sources.length) return;
      const geometry = new THREE.BufferGeometry();
      for (const key of ['position', 'normal', 'color']) {
        const total = sources.reduce((n, source) => n + source.attributes[key].array.length, 0);
        const array = new Float32Array(total);
        let offset = 0;
        for (const source of sources) {
          array.set(source.attributes[key].array, offset);
          offset += source.attributes[key].array.length;
        }
        geometry.setAttribute(key, new THREE.BufferAttribute(array, 3));
      }
      for (const source of sources) source.dispose();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, finishes[index]);
      mesh.name = `${group.name}_${index ? 'channels' : 'armor'}`;
      group.add(mesh);
    });
  }
  return { box, plate, line, ring, finish, fit(mapping) { surface = mapping; } };
}

const HEX = [[-0.5, -0.30], [-0.28, -0.5], [0.28, -0.5], [0.5, -0.30], [0.5, 0.30], [0.28, 0.5], [-0.28, 0.5], [-0.5, 0.30]];
const shield = (w, h) => [[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h * 0.24], [0, -h / 2], [-w / 2, -h * 0.24]];
const hex = (w, h) => HEX.map(([x, y]) => [x * w, y * h]);

function glyph(p, x, y, z, scale = 1) {
  const point = (a, b) => [x + a * scale, y + b * scale];
  // A broken double diamond and descending stem, repeated across the armor.
  for (const [a, b] of [
    [[0, 0.022], [0.016, 0]], [[0.016, 0], [0, -0.022]],
    [[0, -0.022], [-0.016, 0]], [[-0.016, 0], [-0.006, 0.014]],
    [[0, 0.011], [0.007, 0]], [[0.007, 0], [0, -0.010]],
    [[0, -0.022], [0, -0.038]], [[-0.008, -0.031], [0.008, -0.031]],
  ]) p.line(point(...a), point(...b), z, Math.max(0.0015, 0.0024 * scale), ETCH, true);
}

function helmet(ctx, av, materials) {
  const p = panels(ctx, av.head, 'sealed_helm', materials);
  // The chin returns to the gaiter; the upper seal wraps the toric goggles.
  const face = wrap([
    [-.16, .082, .120, 0, -.005], [-.128, .097, .155, 0, -.004],
    [-.099, .106, .153, 0, -.005], [-.062, .122, .143, 0, -.007],
    [-.041, .150, .173, 0, -.011], [.013, .165, .188, 0, -.011],
    [.060, .155, .183, 0, -.011], [.10, .144, .175, 0, -.009],
  ], 0, .144, -.169);
  p.fit((x, y, z) => z > -.085 ? [x * .821, y - .006, z] : face(x, y, -.169 + (z + .169) * .64));
  p.plate([[-0.139, 0.045], [0.139, 0.045], [0.143, -0.083], [0.081, -0.153], [-0.081, -0.153], [-0.143, -0.083]],
    0.028, [0, 0, -0.169], INK, 0.005);
  p.plate(hex(0.299, 0.060), 0.024, [0, 0.066, -0.175], OBSIDIAN);
  p.plate([[-0.148, 0.014], [-0.09, 0.03], [0, 0.015], [0.09, 0.03], [0.148, 0.014], [0.105, -0.015], [0, -0.029], [-0.105, -0.015]],
    0.019, [0, 0.010, -0.188], FACET, 0.002);
  p.plate(hex(0.246, 0.027), 0.010, [0, 0.007, -0.202], INK, 0.001);
  for (const side of [-1, 1]) {
    p.line([side * 0.014, 0.006], [side * 0.11, 0.013], -0.209, 0.006, VIOLET, true);
    p.plate([[-0.035, 0.022], [0.025, 0.031], [0.037, -0.029], [0, -0.052], [-0.034, -0.021]],
      0.017, [side * 0.09, -0.068, -0.191], side < 0 ? FACET : OBSIDIAN, 0.003, [0, side * 0.12, side * 0.14]);
    // Three inset respirator vents on each cheek, with polished lower edges.
    for (let i = 0; i < 3; i++) {
      p.box([0.027, 0.008, 0.002], [side * (0.080 + i * 0.004), -0.055 - i * 0.015, -0.204], INK, [0, 0, side * 0.24]);
      p.box([0.022, 0.002, 0.002], [side * (0.080 + i * 0.004), -0.058 - i * 0.015, -0.206], EDGE, [0, 0, side * 0.24]);
    }
    p.plate(hex(0.04, 0.086), 0.029, [side * 0.183, -0.020, 0.02], OBSIDIAN);
    p.box([0.004, 0.039, 0.018], [side * 0.206, -0.018, 0.01], EDGE);
    p.box([0.003, 0.013, 0.014], [side * 0.209, -0.013, 0.01], VIOLET, undefined, true);
    p.line([side * 0.112, 0.063], [side * 0.076, 0.070], -0.190, 0.002);
  }
  p.plate(shield(0.070, 0.100), 0.028, [0, -0.075, -0.204], OBSIDIAN);
  p.plate(shield(0.022, 0.073), 0.014, [0, -0.067, -0.224], FACET, 0.002);
  p.line([-0.029, -0.101], [0, -0.127], -0.220, 0.003, EDGE);
  p.line([0, -0.127], [0.029, -0.101], -0.220, 0.003, EDGE);
  glyph(p, 0, 0.063, -0.191, 0.53);
  p.finish();
}

function cuirass(ctx, av, materials) {
  const p = panels(ctx, av.torso, 'cuirass', materials);
  // The shell sides sweep back against the carrier straps. The low edge
  // ends above the suspension tape so the three soft pouches can still swing.
  p.fit((u, v, z) => {
    const x = u * .84, y = v * .84 + .045;
    return [x, y, -.208 + 2.2 * x * x + .54 * (y - .045) ** 2 + (z + .25) * .76];
  });
  p.plate(hex(.385,.224),.051,[0,.018,-.229],INK,.005);
  for (const side of [-1, 1]) {
    p.plate(hex(0.168, 0.215), 0.026, [side * 0.095, 0.019, -0.250], OBSIDIAN, 0.005, [0, side * 0.05, side * 0.04]);
    p.plate([[-0.065, 0.073], [0.057, 0.073], [0.067, 0.027], [0, -0.065], [-0.067, 0.027]],
      0.012, [side * 0.095, 0.030, -0.270], side < 0 ? FACET : OBSIDIAN, 0.002);
    p.line([side * 0.025, 0.086], [side * 0.028, 0.008], -0.279, 0.006, VIOLET, true);
    p.line([side * 0.028, 0.008], [side * 0.068, -0.044], -0.279, 0.006, VIOLET, true);
    p.line([side * 0.082, -0.060], [side * 0.147, 0.014], -0.280, 0.003, EDGE);
    for (let i = 0; i < 4; i++) {
      p.line([side * (0.113 + i * 0.008), 0.077], [side * (0.108 + i * 0.008), 0.061], -0.279, 0.002);
    }
    // Segmented ribs remain on the torso; shoulder cloth is never covered.
    for (let i = 0; i < 3; i++) {
      p.plate(hex(0.062, 0.025), 0.015, [side * 0.208, -0.040 - i * 0.033, -0.179], i === 0 ? EDGE : OBSIDIAN,
        0.002, [0, side * 0.62, 0]);
    }
  }
  p.plate(shield(0.038, 0.111), 0.035, [0, 0.017, -0.265], INK, 0.003);
  glyph(p, 0, 0.030, -0.285, 0.67);
  p.finish();

  const belt = panels(ctx, av.hips, 'segmented_belt', materials);
  belt.fit((x, y, z) => [x * .90, y - .051, z + .024 + .82 * x * x]);
  for (const side of [-1, 1]) {
    belt.plate(hex(0.100, 0.042), 0.020, [side * 0.130, 0.066, -0.169], OBSIDIAN, 0.002);
    belt.box([0.014, 0.031, 0.003], [side * 0.141, 0.066, -0.181], EDGE);
  }
  belt.plate(hex(0.064, 0.048), 0.014, [0, 0.066, -0.200], FACET, 0.002);
  belt.ring(0.016, 0.002, [0, 0.066, -0.210], VIOLET, undefined, true);
  glyph(belt, 0, 0.071, -0.211, 0.3);
  belt.finish();
}

function reactor(ctx, av, materials) {
  const p = panels(ctx, av.pack, 'reliquary', materials);
  // The lower equipment pocket stands proud of the upper clamshell.
  // The core and its two retaining rails follow both surfaces in one piece.
  p.fit((u, v, z) => {
    const x = u * .80, y = (v + .163) * .82 - .166;
    const pocket = THREE.MathUtils.smoothstep(-y, .153, .216);
    return [x, y, .130 + .030 * pocket - .90 * x * x + .75 * (z - .106)];
  });
  p.plate(hex(0.308, 0.300), 0.025, [0, -0.163, 0.109], OBSIDIAN, 0.005);
  // Split rails frame an octagonal sealed core. The assembly follows the pack's
  // gear motion instead of floating rigidly with the main torso.
  for (const side of [-1, 1]) {
    p.plate(hex(0.053, 0.271), 0.029, [side * 0.118, -0.163, 0.136], FACET, 0.003);
    p.box([0.008, 0.224, 0.004], [side * 0.116, -0.163, 0.153], INK);
    p.line([side * 0.116, -0.064], [side * 0.116, -0.254], 0.156, 0.0045, VIOLET, true);
    for (let i = 0; i < 5; i++) {
      p.box([0.044, 0.008, 0.013], [side * 0.118, -0.083 - i * 0.040, 0.158], EDGE);
    }
    p.line([side * 0.076, -0.112], [side * 0.089, -0.080], 0.143, 0.004, EDGE);
    p.line([side * 0.076, -0.208], [side * 0.089, -0.247], 0.143, 0.004, EDGE);
  }
  p.plate(hex(0.175, 0.204), 0.024, [0, -0.163, 0.131], INK, 0.004);
  p.ring(0.066, 0.009, [0, -0.157, 0.151], FACET);
  p.ring(0.052, 0.003, [0, -0.157, 0.158], VIOLET, [0, 0, Math.PI / 8], true);
  p.plate(hex(0.070, 0.077), 0.022, [0, -0.157, 0.162], OBSIDIAN, 0.003);
  glyph(p, 0, -0.151, 0.175, 0.90);
  for (const y of [-0.060, -0.260]) {
    p.box([0.078, 0.011, 0.009], [0, y, 0.143], EDGE);
    p.box([0.026, 0.004, 0.003], [0, y, 0.150], VIOLET, undefined, true);
  }
  p.finish();
}

function arms(ctx, av, materials) {
  for (const [side, arm, elbow, hand] of [[-1, av.lArm, av.lElbow, av.lHand], [1, av.rArm, av.rElbow, av.rHand]]) {
    const shoulder = panels(ctx, arm, `${side < 0 ? 'left' : 'right'}_pauldron`, materials);
    // The sleeve head rolls toward the clavicle. Lamellar scales follow
    // that slope and turn around the upper arm toward the woven unit badge.
    shoulder.fit(wrap([
      [-.16,.084,.088,-side*.004,-.002],[-.113,.091,.098,-side*.010,-.004],
      [-.084,.097,.103,-side*.019,-.005],[-.057,.104,.109,-side*.032,-.005],
      [-.033,.108,.111,-side*.045,-.004],[-.015,.104,.109,-side*.053,-.003],
      [.004,.095,.101,-side*.068,-.002],[.022,.060,.072,-side*.091,0],
    ], side * 1.38, .097));
    shoulder.plate(hex(.140, .078), .015, [0,-.035,-.002], OBSIDIAN);
    shoulder.plate(shield(.096, .053), .009, [0,-.041,-.011], FACET, .002);
    shoulder.line([-.048,-.020],[.045,-.020],-.013,.0025, EDGE);
    shoulder.plate(shield(.106,.067),.010,[0,-.085,-.003],OBSIDIAN,.002);
    shoulder.plate(shield(.079,.053),.009,[0,-.119,-.003],FACET,.002);
    shoulder.line([-.031,-.082],[.022,-.089],-.011,.003,VIOLET,true);
    glyph(shoulder,0,-.038,-.017,.46);
    shoulder.finish();

    const fore = panels(ctx, elbow, `${side < 0 ? 'left' : 'right'}_vambrace`, materials);
    fore.fit(wrap([
      [-.27,.051,.053,-side*.003,.003],[-.21,.058,.065,-side*.006,-.002],
      [-.16,.065,.073,-side*.007,-.005],[-.12,.073,.079,-side*.006,-.007],
      [-.078,.076,.082,-side*.003,-.008],[-.04,.075,.078,0,-.003],
    ], side * 1.94, .079, .100, 1));
    fore.plate(hex(0.139, 0.188), 0.020, [0, -0.145, 0.100], OBSIDIAN, 0.003);
    fore.plate(shield(0.103, 0.128), 0.014, [0, -0.128, 0.115], FACET, 0.002);
    fore.line([0.044, -0.080], [0.044, -0.175], 0.119, 0.0045, VIOLET, true);
    for (let i = 0; i < 3; i++) {
      fore.plate(hex(0.123 - i * 0.009, 0.023), 0.015, [0, -0.201 - i * 0.024, 0.098], i === 1 ? EDGE : OBSIDIAN, 0.002);
    }
    glyph(fore, 0, -0.120, 0.124, 0.65);
    fore.finish();

    const glove = panels(ctx, hand, `${side < 0 ? 'left' : 'right'}_gauntlet`, materials);
    glove.fit(wrap([
      [-.047,.019,.029,side*.005,.003],[-.027,.023,.042,side*.011,.002],
      [-.004,.023,.047,side*.013,.001],[.014,.020,.037,side*.010,.004],
    ], side * 1.36, .038));
    glove.plate(hex(.057,.039), .006, [0,-.012,-.002], OBSIDIAN,.0015);
    for (const y of [-.004,-.014,-.024]) glove.line([-.017,y],[.007,y-.004],-.006,.002,EDGE);
    glyph(glove,.012,-.008,-.007,.23);
    glove.finish();
  }
}

function legs(ctx, av, materials) {
  for (const [side, leg] of [[-1, av.lLeg], [1, av.rLeg]]) {
    const { thigh, knee, boot } = leg.userData.joints;
    const t = panels(ctx, thigh, `${side < 0 ? 'left' : 'right'}_tasset`, materials);
    const thighShell = wrap([
      [-.27,.086,.089,side*.002,-.004],[-.22,.105,.106,side*.003,-.004],
      [-.16,.113,.117,side*.005,-.004],[-.12,.114,.123,side*.004,-.003],
      [-.056,.123,.127,-side*.006,.002],
    ], side * .42, .105, -.133);
    t.fit((x,y,z) => thighShell(x - side * .078, y, z));
    t.plate(hex(0.071, 0.193), 0.029, [side * 0.078, -0.166, -0.133], OBSIDIAN, 0.003);
    t.line([side * 0.060, -0.100], [side * 0.060, -0.215], -0.150, 0.003, EDGE);
    glyph(t, side * 0.085, -0.118, -0.151, 0.47);
    t.finish();

    const shin = panels(ctx, knee, `${side < 0 ? 'left' : 'right'}_greave`, materials);
    // The knee insert sits on the convex ceramic cup. The lower scales
    // turn independently around the much narrower calf below its straps.
    shin.fit((u,v,z) => {
      const x=u*.86, y=(v+.023)*.84-.028;
      return [x, y, -.149 + .042*(x/.093)**2 + .034*((y+.028)/.096)**2 + .66*(z+.163)];
    });
    shin.plate(shield(0.174, 0.138), 0.025, [0, -0.023, -0.163], OBSIDIAN, 0.004);
    shin.plate(shield(0.111, 0.083), 0.014, [0, -0.013, -0.184], FACET, 0.002);
    glyph(shin, 0, -0.001, -0.193, 0.65);
    shin.line([-0.051, 0.014], [0.051, 0.014], -0.193, 0.002, EDGE);
    shin.fit(wrap([
      [-.286,.068,.072,0,.004],[-.24,.080,.082,0,.001],[-.196,.083,.090,0,.005],
      [-.162,.086,.096,0,.007],[-.12,.093,.097,0,.005],[-.084,.096,.096,0,.003],
    ], 0, .095, -.111));
    shin.plate(shield(0.126, 0.190), 0.029, [0, -0.185, -0.111], OBSIDIAN, 0.003);
    for (let i = 0; i < 3; i++) {
      shin.plate(hex(0.122 - i * 0.014, 0.036), 0.015, [0, -0.121 - i * 0.045, -0.135], i === 1 ? FACET : OBSIDIAN, 0.002);
    }
    shin.line([side * 0.039, -0.117], [side * 0.031, -0.235], -0.144, 0.0045, VIOLET, true);
    shin.finish();

    const foot = panels(ctx, boot, `${side < 0 ? 'left' : 'right'}_sabatons`, materials);
    foot.fit((u,v,z) => {
      const x = u * .74;
      if (v > .053) return [x, .039 + (z+.14)*.32 - 2.9*x*x + (v-.068)*.8, z];
      return [x, v*.56 - .009, -.210 + 3.0*x*x + (z+.210)*.75];
    });
    foot.plate(hex(0.184, 0.071), 0.013, [0, -0.002, -0.210], OBSIDIAN, 0.002);
    for (let i = 0; i < 3; i++) foot.box([0.182 - i * 0.009, 0.008, 0.024], [0, 0.068, -0.143 + i * 0.038], i === 1 ? EDGE : FACET);
    foot.line([-0.056, 0.019], [0.056, 0.019], -0.219, 0.002, EDGE);
    foot.finish();
  }
}

export function apply(avatar, ctx) {
  // Only cloned armor and visor materials change. Cloth and dark team material
  // retain their identities, so setAvatarTeam keeps working after equipping.
  for (const root of [avatar.head, avatar.torso, avatar.hips, avatar.lArm, avatar.rArm, avatar.lLeg, avatar.rLeg]) {
    ctx.tint(root, {
      [0x26323b]: { color: palette.armor, roughness: 0.42, metalness: 0.46 },
      [0x6aa5af]: { color: 0x6f4d8c, roughness: 0.19, metalness: 0.83 },
    });
  }
  const armor = ctx.material(0xffffff, { vertexColors: true, roughness: 0.44, metalness: 0.40, flatShading: false });
  const channels = ctx.material(0xffffff, {
    vertexColors: true, roughness: 0.35, metalness: 0.30, flatShading: false,
    emissive: 0xaa74ff, emissiveIntensity: 1.3,
  });
  channels.userData.cosmeticGlow = true;
  const materials = [armor, channels];
  helmet(ctx, avatar, materials);
  cuirass(ctx, avatar, materials);
  reactor(ctx, avatar, materials);
  arms(ctx, avatar, materials);
  legs(ctx, avatar, materials);
}
