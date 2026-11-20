import * as THREE from '../../vendor/three.module.js';

// These profiles share the authored model's joint frames. They also work before
// a texture loader or a canvas is available (headless rigs and failed downloads).
export function buildFallback({ kit, groups, joints, lod }) {
  const { box, mat, ironSights } = kit;
  const { body, trigger } = groups;
  const { bobbin, shuttle, latch, guide, indicator, leftTine, rightTine } = joints;
  const detail = lod !== 'world';
  const facets = detail ? 28 : 12;
  const petrol = 0x25525a, edge = 0x447079, graphite = 0x233239;
  const rubber = 0x182426, ivory = 0xede4cd, ferrule = 0xbeb39a;
  const copper = 0xe18b4e, fiber = 0xf7ad68;
  const enamel = mat(petrol, 0.42, 0.28);
  const ceramic = mat(ivory, 0.37, 0.08);
  const vulcanite = mat(rubber, 0.86, 0.04);

  // The profile is drawn in forward/up coordinates and extruded across the rig.
  function profile(part, points, width, material, x = 0, bevel = 0.002) {
    const shape = new THREE.Shape(points.map(([forward, up]) => new THREE.Vector2(forward, up)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true,
      bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 1 });
    geo.translate(0, 0, -width / 2);
    geo.rotateY(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.x = x;
    part.add(mesh);
  }

  function wheel(part, sections, material) {
    const contour = sections.map(([x, radius]) => new THREE.Vector2(radius, -x));
    const geometry = new THREE.LatheGeometry(contour.reverse(), facets);
    geometry.rotateZ(Math.PI / 2);
    part.add(new THREE.Mesh(geometry, material));
  }

  // Two separated cheeks and a high spine leave the bobbin visible through the frame.
  profile(body, [[-.11,.005],[-.08,.059],[-.031,.080],[.081,.080],[.072,.038],
    [.052,.001],[-.015,-.018],[-.09,-.012]], .071, enamel);
  profile(body, [[-.073,.061],[-.045,.088],[.079,.088],[.132,.074],
    [.210,.074],[.249,.060],[.375,.059],[.371,.036],[.245,.038],
    [.212,.052],[.121,.052],[.067,.065]], .047, enamel);
  profile(body, [[.204,.036],[.243,.071],[.343,.079],[.377,.059],
    [.373,.025],[.330,.002],[.245,-.002]], .076, enamel);
  profile(body, [[-.020,.004],[.027,-.002],[-.003,-.094],[-.044,-.090]],
    .046, vulcanite);
  profile(body, [[.25,.014],[.342,.014],[.326,-.045],[.284,-.059],[.252,-.042]],
    .055, vulcanite);
  profile(body, [[-.065,.039],[-.101,.031],[-.181,-.014],[-.208,-.009],[-.206,.018],
    [-.124,.063],[-.061,.065]], .035, enamel);
  profile(body, [[-.213,.021],[-.196,.023],[-.187,-.064],[-.204,-.068]], .054, vulcanite);
  box(body, .021,.018,.136,0,-.039,.132,graphite,{rx:.37});
  box(trigger, .012,.029,.012,0,-.014,.003, copper,{rx:-.22});
  box(body, .028,.011,.061,0,-.061,-.035, graphite);
  box(body, .027,.041,.011,0,-.040,-.061, graphite,{rx:.19});

  // The continuous corrugated contour represents a wound package. The outer
  // flange is open between its spokes, so its orientation is visible when it turns.
  const winding = [[-.054,.002],[-.054,.056]];
  const turns = detail ? 14 : 6;
  for (let n = 1; n <= turns; n++) {
    const x = -.054 + n * .089 / turns;
    winding.push([x - .003,.058],[x,.055]);
  }
  winding.push([.035,.002]);
  wheel(bobbin, winding, mat(copper,.55,.31));
  wheel(bobbin, [[-.063,.049],[-.064,.062],[-.060,.066],[-.054,.066],[-.053,.055]], enamel);
  wheel(bobbin, [[.035,.002],[.035,.065],[.039,.065],[.041,.002]], mat(edge,.39,.46));
  wheel(bobbin, [[-.068,.001],[-.068,.016],[-.065,.020],[-.054,.020],[-.054,.001]],
    mat(ferrule,.32,.64));
  for (let n = 0; n < 3; n++) {
    const theta = n * Math.PI * 2 / 3 + .2;
    box(bobbin, .005,.010,.047,-.060,-.035 * Math.sin(theta),.035 * Math.cos(theta),
      edge,{rx:theta});
  }
  // Cam lever and side-facing tension roller.
  profile(latch, [[-.012,-.009],[.041,-.009],[.049,.003],[.011,.011],[-.011,.007]],
    .009, mat(ferrule,.42,.53));
  wheel(guide, [[-.008,0],[-.008,.014],[-.004,.015],[-.002,.010],
    [.001,.010],[.004,.015],[.008,.014],[.008,0]], mat(ferrule,.33,.63));

  for (const [joint, side] of [[leftTine,-1],[rightTine,1]]) {
    profile(joint, [[-.016,-.023],[.034,-.025],[.169,-.014],[.237,-.006],
      [.237,.006],[.172,.015],[.030,.023],[-.014,.021]], .020, ceramic);
    box(joint,.024,.047,.035,0,0,-.008,graphite);
    box(joint,.025,.042,.009,0,0,-.039,ferrule);
    // Amber witness stripe on the narrow inner face of each blade.
    box(joint,.002,.006,.140,-side * .0115,0,-.127,fiber);
    box(joint,.024,.016,.010,0,0,-.236,copper);
  }
  box(shuttle,.035,.020,.050,0,0,-.012,ferrule);
  box(shuttle,.013,.009,.062,0,0,-.055,fiber);

  const lamp = new THREE.MeshStandardMaterial({color:0xfece8d,emissive:0xfc9144,
    emissiveIntensity:.4, roughness:.28,metalness:.14});
  box(indicator,.019,.006,.028,0,0,0,fiber,{mat:lamp});
  box(body,.033,.012,.039,0,.085,-.048,graphite);

  ironSights(body,{rearZ:.023,frontZ:-.344,height:.144,width:.045,gap:.021,
    color:graphite,accent:fiber});
  for (const z of [.023,-.344]) {
    box(body,.029,.038,.017,0,.093,z,edge);
  }
  if (detail) {
    // Molded grip flutes and small instrument-face calibration marks.
    for (let i = 0; i < 5; i++) {
      box(body,.057,.003,.025,0,-.009-i*.007,-.309,rubber);
      box(body,.008,.002,.003,-.014,.091,-.005-i*.012,ferrule);
    }
    for (const [z,y] of [[-.040,.043],[-.265,.045],[-.335,.049],[.050,.029]]) {
      const screw = kit.cylZ(body,.004,.002,-.038,y,z,ferrule,{seg:6,mt:.72});
      screw.rotation.y = Math.PI / 2;
    }
  }
}
