import * as THREE from '../../vendor/three.module.js';

export const palette = { cloth: 0x8c6843, armor: 0x675342, glove: 0x514435, cuff: 0xc69a58 };

// Fabric keeps its team tint. These workshop fittings sit on the existing rigid
// joints and are batched by material, including the individual bolts and vents.
function fittings(ctx, parent, name) {
  const group = ctx.group(parent, `salvager_${name}`);
  const batches = new Map();
  const transform = new THREE.Matrix4();
  const orientation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const unit = new THREE.Vector3(1, 1, 1);
  function add(geometry, at, material, rotation = [0, 0, 0]) {
    orientation.setFromEuler(new THREE.Euler(...rotation));
    transform.compose(position.set(...at), orientation, unit);
    geometry.applyMatrix4(transform);
    if (geometry.index) {
      const indexed = geometry;
      geometry = geometry.toNonIndexed();
      indexed.dispose();
    }
    if (!batches.has(material)) batches.set(material, []);
    batches.get(material).push(geometry);
  }
  return {
    box(size, at, material, rotation) {
      add(new THREE.BoxGeometry(...size), at, material, rotation);
    },
    plate(size, at, material, rotation, bevel = 0.008) {
      const [w, h, d] = size;
      const b = Math.min(bevel, w / 4, h / 4, d / 4);
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2 + b, -h / 2 + b);
      shape.lineTo(w / 2 - b, -h / 2 + b);
      shape.lineTo(w / 2 - b, h / 2 - b);
      shape.lineTo(-w / 2 + b, h / 2 - b);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: d - 2 * b, bevelEnabled: true, bevelSegments: 1, steps: 1,
        bevelSize: b, bevelThickness: b,
      });
      geometry.translate(0, 0, -d / 2 + b);
      add(geometry, at, material, rotation);
    },
    cylinder(radius, length, at, material, rotation, segments = 10) {
      const geometry = new THREE.CylinderGeometry(radius, radius, length, segments);
      geometry.rotateX(Math.PI / 2);
      add(geometry, at, material, rotation);
    },
    // A solid pressed fitting. Each row gives its height and left/right limits;
    // point() describes the mating surface in joint space, including its curve.
    formed(rows, point, inset, material) {
      const columns = 9;
      const vertices = [], uvs = [], faces = [];
      for (let back = 0; back <= 1; back++) {
        for (const row of rows) {
          const [y, left, right] = row;
          for (let i = 0; i < columns; i++) {
            const u = i / (columns - 1);
            const p = point(left + (right - left) * u, y, u, row);
            vertices.push(...p.map((v, axis) => v + back * inset[axis]));
            uvs.push(u, y);
          }
        }
      }
      const count = rows.length * columns;
      function quad(a, b, c, d) { faces.push(a, b, c, a, c, d); }
      for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < columns - 1; i++) {
        const a = j * columns + i, b = a + columns;
        quad(a, b, b + 1, a + 1);
        quad(a + count + 1, b + count + 1, b + count, a + count);
      }
      const perimeter = [];
      for (let i = 0; i < columns; i++) perimeter.push(i);
      for (let j = 1; j < rows.length; j++) perimeter.push((j + 1) * columns - 1);
      for (let i = columns - 2; i >= 0; i--) perimeter.push(count - columns + i);
      for (let j = rows.length - 2; j > 0; j--) perimeter.push(j * columns);
      for (let j = 0; j < perimeter.length; j++) {
        const a = perimeter[j], b = perimeter[(j + 1) % perimeter.length];
        quad(a, b, b + count, a + count);
      }
      // A rear-facing or horizontal piece can use the same row ordering.
      const at = i => new THREE.Vector3().fromArray(vertices, i * 3);
      const n = at(columns).sub(at(0)).cross(at(1).sub(at(0)));
      if (n.dot(new THREE.Vector3(...inset)) > 0) faces.reverse();
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(faces);
      geometry.computeVertexNormals();
      add(geometry, [0, 0, 0], material);
    },
    finish() {
      for (const [material, pieces] of batches) {
        const geometry = new THREE.BufferGeometry();
        for (const key of ['position', 'normal', 'uv']) {
          const attrs = pieces.map(piece => piece.getAttribute(key));
          const array = new Float32Array(attrs.reduce((sum, attr) => sum + attr.array.length, 0));
          let offset = 0;
          for (const attr of attrs) { array.set(attr.array, offset); offset += attr.array.length; }
          geometry.setAttribute(key, new THREE.BufferAttribute(array, attrs[0].itemSize));
        }
        for (const piece of pieces) piece.dispose();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `${group.name}_batch`;
        group.add(mesh);
      }
      return group;
    },
  };
}

export function apply(avatar, ctx) {
  const ceramic = ctx.material(0xd4c9a7, { roughness: 0.78, metalness: 0.12, flatShading: false });
  const bronze = ctx.material(0x9c7141, { roughness: 0.48, metalness: 0.68, flatShading: false });
  const steel = ctx.material(0x494e49, { roughness: 0.62, metalness: 0.65 });
  const rubber = ctx.material(0x292b26, { roughness: 0.93, metalness: 0.04 });
  const amber = ctx.material(0xf2b85b, { emissive: 0x5b2508, emissiveIntensity: 0.6,
    roughness: 0.28, metalness: 0.28 });
  amber.userData.cosmeticGlow = true;
  // Only stock armor and the visor may change. Team cloth, shoulder bands and
  // exposed skin retain their original shared materials.
  for (const part of [avatar.torso, avatar.hips, avatar.head, avatar.lArm, avatar.rArm,
    avatar.lLeg, avatar.rLeg]) ctx.tint(part, {
    [0x26323b]: { color: 0x675342, roughness: 0.72, metalness: 0.38 },
    [0x6aa5af]: { color: 0xc39349, roughness: 0.26, metalness: 0.5 },
  });

  // The field carrier has a curved front and tapers toward the shoulders.
  // A bronze lower corner and three repair staples distinguish the right half.
  const chest = fittings(ctx, avatar.torso, 'chest');
  const bib = (x, y) => -.214 + 2.50 * x * x + .48 * (y - .045) ** 2;
  const bibPoint = (x, y) => [x, y, bib(x,y)];
  const left = [[-.065,-.113,-.017],[-.050,-.14,-.006],[.052,-.14,-.006],
    [.098,-.111,-.006],[.127,-.081,-.017]];
  const right = [[-.016,.007,.135],[.055,.007,.140],[.095,.007,.109],[.127,.016,.081]];
  chest.formed(left, bibPoint, [0,0,.021], ceramic);
  chest.formed(right, bibPoint, [0,0,.021], ceramic);
  chest.formed([[-.065,.017,.114],[-.050,.007,.140],[-.021,.007,.136]],
    bibPoint, [0,0,.021], bronze);
  chest.box([.012,.178,.016], [0,.032,-.207], rubber);
  for (const x of [-.112,-.023,.023,.112]) for (const y of [-.044,.051]) {
    chest.cylinder(.005,.007,[x,y,bib(x,y)-.002],bronze,[0,-Math.atan(5*x),0],6);
  }
  chest.plate([.066,.019,.006],[-.061,.043,bib(-.061,.043)-.003],steel,[0,.28,0],.002);
  for (let i = 0; i < 4; i++) {
    const x = -.081+i*.012;
    chest.box([.004,.009,.004],[x,.043,bib(x,.043)-.0065],ceramic,[0,.28,0]);
  }
  for (const x of [.035,.066,.097]) chest.box([.009,.026,.007],
    [x,-.018,bib(x,-.018)-.003], steel,[0,-Math.atan(5*x),0]);
  chest.finish();

  // The facepiece narrows beneath the chin. Quarter-turn filters sit on its
  // sloped cheeks so the goggle seal stays visible from the side.
  const head = fittings(ctx, avatar.head, 'respirator');
  const mask = (x, y) => -.170 + 5.9*x*x + .83*(y+.09)**2;
  head.formed([[-.143,-.031,.031],[-.131,-.064,.064],[-.102,-.096,.096],
    [-.080,-.100,.100],[-.061,-.072,.072],[-.045,-.026,.026],[-.034,-.010,.010]],
    (x,y) => [x,y,mask(x,y)], [0,0,.026],rubber);
  head.formed([[-.127,-.023,.023],[-.113,-.038,.038],[-.074,-.033,.033],[-.059,-.015,.015]],
    (x,y) => [x,y,mask(x,y)-.005], [0,0,.009],ceramic);
  for (const y of [-.077,-.089,-.101]) head.box([.042,.003,.005],[0,y,-.176],steel);
  for (const side of [-1,1]) {
    const x = side*.074, angle = -side*.63, radius = side < 0 ? .032 : .024;
    const z = mask(x,-.093);
    head.cylinder(radius,.038,[x,-.093,z],bronze,[0,angle,0],14);
    head.cylinder(radius*.80,.010,[x-Math.sin(angle)*.021,-.093,z-Math.cos(angle)*.021],
      rubber,[0,angle,0],14);
    for (let i = -1; i <= 1; i++) {
      head.box([.004,radius*(1.27-Math.abs(i)*.21),.004],
        [x-Math.sin(angle)*.027+Math.cos(angle)*i*.009,-.093,
          z-Math.cos(angle)*.027-Math.sin(angle)*i*.009], bronze,[0,angle,0]);
    }
  }
  // Bolt the lamp shoe to the existing ear-cup wishbone.
  head.plate([.021,.047,.071],[.155,.014,-.016],steel,undefined,.004);
  head.cylinder(.017,.065,[.158,.023,-.032],bronze);
  head.cylinder(.013,.006,[.158,.023,-.066],amber);
  head.finish();

  const pack = fittings(ctx, avatar.pack, 'reclaimer_pack');
  pack.plate([.213,.253,.033],[0,-.179,.142],steel);
  for (const x of [-.080,.080]) {
    pack.cylinder(.040,.227,[x,-.179,.172],ceramic,[Math.PI/2,0,0],16);
    for (const y of [-.283,-.176,-.073]) pack.cylinder(.042,.014,[x,y,.172],bronze,[Math.PI/2,0,0],16);
    pack.cylinder(.018,.027,[x,-.053,.172],steel,[Math.PI/2,0,0]);
    pack.box([.010,.214,.009],[x,-.179,.211],bronze);
  }
  for (const y of [-.237,-.117]) pack.box([.239,.014,.012],[0,y,.208],steel);
  pack.box([.023,.022,.013],[0,-.117,.214],bronze);
  for (const y of [-.246,-.216,-.186]) pack.box([.020,.006,.008],[0,y,.16],bronze);
  pack.box([.019,.105,.018],[-.147,-.177,.060],bronze);
  pack.box([.043,.015,.024],[-.146,-.123,.060],steel);
  pack.finish();

  const belt = fittings(ctx, avatar.hips, 'utility_belt');
  belt.plate([.098,.049,.012],[0,.015,-.175],bronze);
  belt.box([.059,.028,.011],[0,.015,-.183],steel);
  for (const side of [-1,1]) {
    belt.box([.019,.057,.013],[side*.157,.015,-.125],bronze,[0,-side*.37,0]);
    belt.box([.029,.028,.020],[side*.198,.018,.101],steel,[0,side*.52,0]);
  }
  belt.finish();

  for (const [elbow, side] of [[avatar.lElbow,-1],[avatar.rElbow,1]]) {
    // A curved rail bed follows the forearm taper. The steel end pieces
    // wrap both sides so they stay joined to the sleeve when the elbow folds.
    const arm = fittings(ctx,elbow,side < 0 ? 'left_gauntlet' : 'right_gauntlet');
    const back = (x,y) => .083 + .13*(y+.10) - 5.7*(x+side*.005)**2;
    const rear = (x,y) => [x,y,back(x,y)];
    arm.formed([[-.231,-.032,.032],[-.212,-.048,.048],[-.108,-.057,.057],[-.083,-.041,.041]],
      rear,[0,0,-.016],side < 0 ? bronze : ceramic);
    for (const [y, width] of [[-.210,.051],[-.105,.060]]) {
      arm.formed([[y-.006,-width,width],[y+.006,-width,width]],
        (x,h) => [x,h,back(x,h)+.004],[0,0,-.009],steel);
    }
    if (side < 0) {
      arm.plate([.017,.082,.009],[-.018,-.154,back(-.018,-.154)+.003],steel,[.12,0,0],.002);
      for (const x of [-.028,-.017,-.006]) arm.box([.005,.020,.009],
        [x,-.113,back(x,-.113)+.005],steel);
    } else {
      for (const x of [-.028,-.009,.010,.029]) arm.box([.005,.048,.007],
        [x,-.151,back(x,-.151)+.002],steel,[.13,0,0]);
    }
    arm.finish();
  }

  for (const [leg,side] of [[avatar.lLeg,-1],[avatar.rLeg,1]]) {
    const { thigh,knee,boot } = leg.userData.joints;
    const upper = fittings(ctx,thigh,side < 0 ? 'left_tool_holster' : 'right_tool_holster');
    // Bent brackets bite into the bellows of the outer cargo pocket.
    const pocket = (z,y) => .147 + .13*(y+.14) - 3.2*z*z;
    for (const z of [-.036,.031]) {
      upper.plate([.011,.112,.014],[side*pocket(z,-.172),-.172,z],
        bronze,[0,side*.12, -side*.13],.003);
    }
    for (const y of [-.130,-.206]) upper.plate([.018,.013,.086],
      [side*(pocket(0,y)-.006),y,-.003],bronze,undefined,.003);
    upper.finish();

    const lower = fittings(ctx,knee,side < 0 ? 'left_greave' : 'right_greave');
    const cup = (x,y) => -.157 + 5.3*x*x + 4.1*(y+.028)**2;
    lower.formed([[-.097,-.019,.019],[-.083,-.044,.044],[-.052,-.067,.067],
      [-.012,-.077,.077],[.017,-.062,.062],[.033,-.033,.033]],
      (x,y) => [x,y,cup(x,y)],[0,0,.014],ceramic);
    for (const x of [-.053,.053]) lower.cylinder(.005,.006,[x,-.026,cup(x,-.026)-.002],
      bronze,[0,-Math.atan(10.6*x),0],6);
    const shin = (x,y) => -.091 - .041*(y+.170) + 5.1*x*x;
    lower.formed([[-.244,-.023,.023],[-.228,-.043,.043],[-.146,-.050,.050],[-.125,-.041,.041]],
      (x,y) => [x,y,shin(x,y)],[0,0,.017],bronze);
    for (const y of [-.215,-.182,-.149]) lower.formed([[y-.002,-.036,.036],[y+.002,-.036,.036]],
      (x,h) => [x,h,shin(x,h)-.0025],[0,0,.004],ceramic);
    lower.finish();

    const foot = fittings(ctx,boot,side < 0 ? 'left_steeltoe' : 'right_steeltoe');
    // A rising toe dome hugs the boot last and leaves the laces and sole visible.
    const toe = [[-.221,-.022,.022,.008],[-.216,-.052,.052,.024],[-.205,-.066,.066,.031],
      [-.192,-.077,.077,.036],[-.169,-.085,.085,.042],[-.143,-.089,.089,.044]];
    foot.formed(toe,(_x,z,u,[, ,width,top]) => {
      const angle = Math.PI*(u-.5);
      const edge = -.015+.011*Math.max(0,(-z-.173)/.048);
      return [width*Math.sin(angle),edge+(top-edge)*Math.cos(angle)**.58,z];
    },[0,-.010,0],bronze);
    foot.finish();
  }

  // Glove backings follow opposite palm shapes for the grip and the fore-end.
  for (const [hand, side] of [[avatar.lHand,-1],[avatar.rHand,1]]) {
    const glove = fittings(ctx,hand,side < 0 ? 'left_glove' : 'right_glove');
    const y = side < 0 ? -.022 : -.014;
    glove.plate([.009,.041,.045],[side*.027,y,.003],bronze,[0,0,side*.11],.003);
    for (const z of [-.011,.003,.017]) glove.box([.009,.015,.006],[side*.029,y-.013,z],bronze);
    glove.finish();
  }
}
