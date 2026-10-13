import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/utils/BufferGeometryUtils.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { applyStingerSurfaces } from '../stinger-surfaces.js';

// AX-9: a replaceable launch canister in a reusable, hinged receiver saddle.
// The optic, gripstock and battery stay with the shooter during the exchange.
export const STINGER_SIGHT_Y = 0.178;
const R = 0.063;
const REAR = 0.36;
const P = { olive: 0x626b47, panel: 0x747c55, dark: 0x252e32, rubber: 0x141d21,
  steel: 0x6f7c80, edge: 0x9ca7a4, yellow: 0xdfb848, inset: 0x34403a };

// Merge static geometry per material inside each rigid part. Moving lids,
// lamps and the front cover retain their own nodes and material ownership.
function batchRigidPart(parent) {
  const batches = new Map();
  for (const child of [...parent.children]) {
    if (!child.isMesh || child.name) continue;
    child.updateMatrix();
    child.geometry.applyMatrix4(child.matrix);
    if (!batches.has(child.material)) batches.set(child.material, []);
    batches.get(child.material).push(child);
  }
  for (const [material, children] of batches) {
    if (children.length < 2) continue;
    const geometry = mergeGeometries(children.map(child => child.geometry));
    for (const child of children) { parent.remove(child); child.geometry.dispose(); }
    parent.add(new THREE.Mesh(geometry, material));
  }
  // The singleton geometry has already had its transform baked above.
  for (const children of batches.values()) if (children.length === 1) {
    children[0].position.set(0, 0, 0);
    children[0].rotation.set(0, 0, 0);
  }
}

export function build({ kit, T, groups }) {
  const { body, mag, bolt, trigger, extra } = groups;
  const { box, cylZ, mat } = kit;
  const y = T.muzzle[1], front = T.muzzle[2];
  const accent = GLOW_ACCENT.stinger;
  const metal = { rg: 0.38, mt: 0.72 };
  const rubber = { rg: 0.94, mt: 0.03 };
  const paint = { rg: 0.72, mt: 0.2 };
  const tube = (parent, radius, length, z, color, options = {}) =>
    cylZ(parent, radius, length, 0, y, z, color, { seg: 12, ...options });
  const lampMaterial = () => new THREE.MeshStandardMaterial({
    color: 0x30433a, emissive: accent, emissiveIntensity: 0.06,
    roughness: 0.28, metalness: 0.2, flatShading: true,
  });
  // Octagonal, bevelled profiles catch light underneath the generated surfaces.
  const plate = (parent, width, height, depth, x, cy, z, color, options = {}) => {
    const bevel = Math.min(width, height) * 0.16;
    const shape = new THREE.Shape();
    const w = width / 2, h = height / 2;
    shape.moveTo(-w + bevel, -h);
    for (const [px, py] of [[w - bevel, -h], [w, -h + bevel], [w, h - bevel],
      [w - bevel, h], [-w + bevel, h], [-w, h - bevel], [-w, -h + bevel]]) shape.lineTo(px, py);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: depth - 0.004,
      bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1, steps: 1 });
    geometry.translate(0, 0, -depth / 2 + 0.002);
    // Match the indexed primitive attributes before batching.
    const mesh = new THREE.Mesh(geometry, mat(color, options.rg ?? 0.65, options.mt ?? 0.3));
    mesh.position.set(x, cy, z);
    // Extrusions are non-indexed; convert all rigid meshes before merging below.
    parent.add(mesh);
    return mesh;
  };

  // Full consumable canister. Broad raised facets, inset seams and end rings
  // split up the old featureless pipe while keeping its original muzzle axis.
  tube(mag, R, REAR - front - 0.03, (REAR + front + 0.03) / 2, P.olive, { ...paint, open: true });
  for (const [z, length] of [[-0.665, 0.24], [-0.29, 0.39], [0.14, 0.29]]) {
    for (const side of [-1, 1]) {
      box(mag, 0.006, 0.049, length, side * 0.060, y + 0.012, z, P.panel, paint);
      box(mag, 0.008, 0.005, length - 0.018, side * 0.060, y + 0.039, z, P.olive, paint);
      box(mag, 0.005, 0.011, length - 0.025, side * 0.051, y - 0.042, z, P.inset, paint);
    }
    box(mag, 0.036, 0.005, length, 0, y + R - 0.003, z, P.panel, paint);
  }
  for (const z of [-0.50, -0.06]) tube(mag, R + 0.001, 0.012, z, P.inset, paint);
  tube(mag, R + 0.002, 0.035, front + 0.10, P.yellow, paint);
  tube(mag, R + 0.003, 0.009, front + 0.13, P.rubber, rubber);
  tube(mag, R + 0.012, 0.030, front + 0.018, P.dark, { ...metal, open: true });
  tube(mag, R + 0.005, 0.012, front + 0.004, P.edge, { ...metal, open: true });
  tube(mag, R - 0.006, 0.075, front + 0.041, P.rubber, { ...rubber, open: true })
    .userData.stingerUntextured = true;
  const frontCover = tube(mag, R - 0.009, 0.006, front + 0.076, P.inset, paint);
  frontCover.name = 'stinger_front_cover';
  tube(mag, R + 0.008, 0.036, REAR - 0.018, P.dark, metal);
  tube(mag, R + 0.009, 0.009, REAR - 0.036, P.edge, metal);
  // Sparse side stencils, contrasting wear edges and serial bars.
  for (const side of [-1, 1]) {
    box(mag, 0.004, 0.026, 0.089, side * 0.065, y + 0.006, -0.21, P.inset);
    for (let i = 0; i < 4; i++) box(mag, 0.005, 0.004, 0.012 + i * 0.004,
      side * 0.068, y + 0.014 - i * 0.007, -0.22, 0xc2c4a0);
    box(mag, 0.003, 0.004, 0.11, side * 0.064, y + 0.033, 0.16, P.edge, metal);
  }

  // Permanent lower spine and exposed seating rails. These stay visible when
  // the spent canister is lifted clear, so the reload has a readable empty beat.
  plate(body, 0.10, 0.047, 0.83, 0, -0.012, -0.165, P.dark, metal).name = 'stinger_gripstock';
  for (const side of [-1, 1]) {
    box(body, 0.012, 0.018, 0.82, side * 0.049, 0.014, -0.165, P.steel, metal);
    box(body, 0.011, 0.013, 0.54, side * 0.055, -0.019, -0.18, P.inset);
  }
  // Both saddle lids hinge along the right rail; negative z rotation opens
  // them outward, exposing the silver cradle beneath.
  const clamps = [];
  for (const z of [-0.48, 0.055]) {
    plate(body, 0.159, 0.048, 0.048, 0, y - 0.061, z, P.steel, metal);
    const clamp = new THREE.Group();
    clamp.name = `stinger_clamp_${clamps.length}`;
    clamp.position.set(0.077, y, z);
    const shape = new THREE.Shape();
    shape.moveTo(-0.151, -0.012);
    for (const [x, cy] of [[-0.151,0.044],[-0.123,0.074],[-0.031,0.074],[-0.004,0.044],[-0.004,-0.012],
      [-0.018,-0.012],[-0.018,0.037],[-0.040,0.059],[-0.114,0.059],[-0.137,0.037],[-0.137,-0.012]]) shape.lineTo(x, cy);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape,{depth:0.034,bevelEnabled:true,bevelSize:0.002,
      bevelThickness:0.002,bevelSegments:1,steps:1});
    geo.translate(0,0,-0.017);
    clamp.add(new THREE.Mesh(geo,mat(P.steel,0.38,0.72)));
    box(clamp,0.012,0.042,0.022,-0.15,0.01,0,P.dark,metal);
    box(clamp,0.015,0.023,0.014,-0.157,0.013,0,P.edge,metal);
    box(clamp,0.052,0.004,0.020,-0.077,0.077,0,P.edge,metal);
    for (const x of [-0.125,-0.029]) {
      cylZ(clamp,0.006,0.003,x,0.050,0.020,P.rubber,{seg:8,...rubber});
      cylZ(clamp,0.003,0.004,x,0.050,0.022,P.edge,{seg:6,...metal});
    }
    cylZ(clamp,0.010,0.045,0,0,0,P.dark,{seg:8,...metal});
    body.add(clamp); clamps.push(clamp);
  }

  plate(body,0.043,0.157,0.056,0.006,-0.064,-0.066,P.rubber,rubber);
  box(body,0.049,0.012,0.064,0.006,-0.142,-0.073,P.steel,metal);
  for (let i=0;i<4;i++) box(body,0.046,0.007,0.045,0.006,-0.039-i*0.026,-0.071,P.dark,rubber);
  box(body,0.034,0.008,0.075,0.006,-0.009,-0.124,P.steel,metal);
  box(body,0.030,0.044,0.009,0.006,-0.026,-0.159,P.dark);
  box(trigger,0.009,0.027,0.010,0.006,-0.004,T.triggerZ ?? -0.11,P.steel,metal).name='stinger_trigger';
  plate(body,0.039,0.109,0.046,-0.004,-0.050,-0.36,P.rubber,rubber);
  box(body,0.047,0.010,0.054,-0.004,-0.106,-0.36,P.steel,metal);
  // Fixed battery housing, protected by the gripstock rather than masquerading as ammo.
  box(body,0.054,0.046,0.076,0,-0.047,-0.22,P.inset);
  box(body,0.057,0.007,0.061,0,-0.073,-0.22,P.yellow,paint);
  // Rear pad has a steel mounting plate, broad bevels and stepped rubber ribs.
  plate(body,0.112,0.178,0.026,0,-0.007,0.274,P.steel,metal);
  plate(body,0.116,0.180,0.036,0,-0.007,0.302,P.rubber,rubber);
  for(let i=0;i<6;i++) box(body,0.101,0.009,0.008,0,-0.077+i*0.029,0.324,P.dark,rubber);

  // A compact protected seeker replaces the large wire grille. The rear-facing
  // indicator bank can be read in first person, with no panel across the sights.
  const seeker = new THREE.Group(); seeker.name='stinger_seeker';
  seeker.position.set(-0.099,y+0.037,-0.37);
  plate(seeker,0.070,0.073,0.19,0,0,0,P.dark,metal);
  plate(seeker,0.058,0.059,0.12,0,0,-0.03,P.olive,paint);
  cylZ(seeker,0.026,0.028,0,0,-0.111,P.rubber,{seg:10,...rubber});
  cylZ(seeker,0.020,0.006,0,0,-0.128,0x426a51,{seg:10,rg:0.2,mt:0.45});
  box(seeker,0.055,0.030,0.010,0,0.007,0.101,P.rubber,rubber);
  const lamps=[];
  for(let i=0;i<5;i++) {
    const lamp=box(seeker,0.006,0.020,0.003,-0.020+i*0.010,0.007,0.108,accent,{mat:lampMaterial()});
    lamp.name=`stinger_lock_lamp_${i}`; lamps.push(lamp);
  }
  box(seeker,0.011,0.054,0.028,-0.036,0,-0.045,P.steel,metal);
  box(body,0.035,0.026,0.037,-0.073,y+0.015,-0.37,P.steel,metal);
  body.add(seeker);
  // Short stowed IFF vanes remain below the optic rather than filling the view.
  for(const z of [-0.40,-0.34]) box(body,0.011,0.018,0.11,-0.080,0.034,z,P.inset,{ry:-0.12});
  const latch = new THREE.Group(); latch.name='stinger_arming_latch';
  latch.position.set(0.038,y+0.055,-0.015);
  box(body,0.017,0.112,0.036,0.071,0.069,-0.015,P.dark,metal);
  box(body,0.048,0.010,0.038,0.052,0.127,-0.015,P.steel,metal);
  box(latch,0.017,0.012,0.045,0,0,-0.016,P.yellow,paint);
  bolt.add(latch);

  body.userData.sightHeight=STINGER_SIGHT_Y;
  const sights=new THREE.Group(); sights.name='factory-optic'; body.add(sights);
  // Side-supported sight posts leave the removable canister and bore clear.
  for(const [z,r] of [[-0.02,0.009],[-0.69,0.030]]) {
    const postTop = STINGER_SIGHT_Y-r-0.008;
    box(sights,0.011,postTop+0.005,0.016,0.083,(postTop-0.005)/2,z,P.dark,metal);
    box(sights,0.084,0.010,0.016,0.042,STINGER_SIGHT_Y-r-0.008,z,P.steel,metal);
    box(sights,0.012,0.021,0.016,0,STINGER_SIGHT_Y-r-0.015,z,P.dark,metal);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(r,0.0035,4,16),mat(P.dark,0.5,0.5));
    ring.position.set(0,STINGER_SIGHT_Y,z); sights.add(ring);
  }
  const statusLamp=box(sights,0.007,0.007,0.007,0.030,STINGER_SIGHT_Y,-0.69,accent,{mat:lampMaterial()});
  statusLamp.name='stinger_status_lamp';
  // A low carrying grip sits off-axis, leaving both sights unobstructed.
  for(const z of [-0.40,-0.17]) box(mag,0.016,0.024,0.016,0.041,y+0.059,z,P.steel,metal);
  box(mag,0.018,0.018,0.25,0.041,y+0.074,-0.285,P.rubber,rubber);

  applyStingerSurfaces([mag, body, bolt, trigger], P);
  for(const group of [mag,body,seeker,sights,...clamps]) {
    for(const child of group.children) if(child.isMesh && !child.name && child.geometry.index) {
      const original=child.geometry; child.geometry=original.toNonIndexed(); original.dispose();
    }
    batchRigidPart(group);
  }
  extra.userData.stinger={canister:mag,clamps,seeker,lamps,statusLamp,frontCover,latch};
  return true;
}
