import * as THREE from '../../vendor/three.module.js';

// FOUNDRY / FN-06. Copper furnace cladding, refractory cassettes, mechanically
// fastened seams and a pressure dial. Heat cells and the thermal barrel material
// remain the live weapon's instrumentation; this layer adds no animated glow.
export function apply(model, ctx) {
  const palette = {
    0x62694a: { color: 0x9d4e2a, roughness: 0.48, metalness: 0.68 },
    0x889071: { color: 0xcd9563, roughness: 0.34, metalness: 0.72 },
    0x454b52: { color: 0x29323a, roughness: 0.42, metalness: 0.78 },
    0x3c4046: { color: 0x414856, roughness: 0.38, metalness: 0.76 },
    0x22252a: { color: 0x191d20, roughness: 0.85, metalness: 0.2 },
    0x15171a: { color: 0x13191d, roughness: 0.82, metalness: 0.18 },
    0xb09a72: { color: 0xd9a455, roughness: 0.55, metalness: 0.48 },
    0xc9a227: { color: 0xbd8150, roughness: 0.35, metalness: 0.8 },
  };
  // Hands are character-owned, even when a builder mounts them under the body.
  for (const child of model.body.children) {
    if (!['hand_l', 'hand_r'].includes(child.name)) ctx.tint(child, palette);
  }
  ctx.tint(model.mag, palette);
  const cover = model.extra.getObjectByName('minigun_feed_cover');
  if (cover) ctx.tint(cover, palette);

  const copper = ctx.material(0xad582f, { roughness: 0.44, metalness: 0.7 });
  const steel = ctx.material(0x9ca5ab, { roughness: 0.35, metalness: 0.8 });
  const black = ctx.material(0x121c23, { roughness: 0.8, metalness: 0.26 });
  const ceramic = ctx.material(0xc7b393, { roughness: 0.94, metalness: 0.05 });
  const ochre = ctx.material(0xf0aa35, { roughness: 0.58, metalness: 0.3 });
  const oxide = ctx.material(0x41676a, { roughness: 0.78, metalness: 0.3 });
  const body = ctx.group(model.body, 'foundry_furnace_cladding');
  const drum = ctx.group(model.mag, 'foundry_ammunition_drum');
  const rotor = model.body.getObjectByName('minigun_rotor');
  const collars = rotor ? ctx.group(rotor, 'foundry_rotating_collars') : null;
  const feed = cover ? ctx.group(cover, 'foundry_feed_hatch') : null;

  // Each owner/material pair is one draw, including fasteners, markings and fins.
  const batches = new Map();
  const block = (parent, material, size, position, rotation = [0, 0, 0]) => {
    if (!batches.has(parent)) batches.set(parent, new Map());
    const materials = batches.get(parent);
    if (!materials.has(material)) materials.set(material, []);
    materials.get(material).push({ size, position, rotation });
  };
  const sideStroke = (parent, material, x, y1, z1, y2, z2, thickness = 0.0012) => {
    block(parent, material, [0.0008, thickness, Math.hypot(y2 - y1, z2 - z1)],
      [x, (y1 + y2) / 2, (z1 + z2) / 2], [-Math.atan2(y2 - y1, z2 - z1), 0, 0]);
  };
  const panel = (x, z, name) => {
    const outline = [
      [-0.025, -0.037], [-0.029, -0.029], [-0.029, 0.030], [-0.021, 0.038],
      [0.021, 0.038], [0.026, 0.032], [0.026, -0.029], [0.018, -0.037],
    ];
    const shape = new THREE.Shape(outline.map(([dz, y]) => new THREE.Vector2(-(z + dz), y)));
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.0028, bevelEnabled: true, bevelSegments: 1,
      bevelThickness: 0.0007, bevelSize: 0.0012, steps: 1, curveSegments: 1,
    });
    geometry.rotateY(Math.PI / 2);
    geometry.translate(x - 0.0014, 0, 0);
    const mesh = new THREE.Mesh(geometry, copper);
    mesh.name = name;
    body.add(mesh);
  };
  const fastener = (parent, x, y, z) => {
    block(parent, steel, [0.0022, 0.0048, 0.0048], [x, y, z], [Math.PI / 4, 0, 0]);
    block(parent, black, [0.0006, 0.0008, 0.003], [x + Math.sign(x) * 0.0014, y, z]);
  };

  // Three individually chamfered cladding tiles on each side. Ceramic fins and
  // dark recessed slots retain the stepped motor shape and the open sight lane.
  for (const side of [-1, 1]) {
    const x = side * 0.088;
    for (let tile = 0; tile < 3; tile++) {
      const z = -0.127 - tile * 0.062;
      panel(x, z, `foundry_copper_tile_${side}_${tile}`);
      block(body, black, [0.0012, 0.035, 0.037], [side * 0.0904, -0.002, z - 0.001]);
      for (let slit = 0; slit < 4; slit++) {
        block(body, ceramic, [0.0018, 0.026, 0.003],
          [side * 0.0919, -0.002, z - 0.014 + slit * 0.0085], [0.20, 0, 0]);
      }
      sideStroke(body, steel, side * 0.0907, 0.031, z - 0.018, 0.031, z + 0.016, 0.001);
      for (const dz of [-0.020, 0.018]) {
        fastener(body, side * 0.091, -0.029, z + dz);
      }
      // Patinated corners are small physical inlays, never random per-frame noise.
      block(body, oxide, [0.0008, 0.003, 0.009], [side * 0.0905, 0.022, z - 0.016]);
      block(body, oxide, [0.0008, 0.008, 0.002], [side * 0.0906, 0.018, z - 0.019]);
    }
    // A continuous hazard strip runs below the shells, away from the sight line.
    block(body, ochre, [0.002, 0.009, 0.168], [side * 0.0828, -0.046, -0.191]);
    for (let stripe = 0; stripe < 15; stripe++) {
      block(body, black, [0.0009, 0.010, 0.005],
        [side * 0.0843, -0.046, -0.115 - stripe * 0.011], [0.48, 0, 0]);
    }
    // Refractory tiles are visibly separate; their narrow band avoids the hand grip.
    for (let brick = 0; brick < 7; brick++) {
      block(body, ceramic, [0.009, 0.005, 0.017], [side * 0.049, 0.072, -0.132 - brick * 0.0198]);
      block(body, black, [0.010, 0.001, 0.0017], [side * 0.049, 0.0753, -0.141 - brick * 0.0198]);
    }
  }

  // A rear access panel frames the existing live heat readout without covering it.
  block(body, copper, [0.067, 0.021, 0.0025], [0.006, -0.018, 0.003]);
  block(body, black, [0.050, 0.010, 0.0012], [0.006, -0.018, 0.0049]);
  for (let stud = 0; stud < 2; stud++) {
    block(body, steel, [0.0034, 0.0034, 0.0015], [-0.022 + stud * 0.055, -0.018, 0.0053], [0, 0, Math.PI / 4]);
  }
  // The small stamped serial reads FN-06. Geometry keeps it crisp without a texture.
  const glyphs = {
    F: [[0,0,0,1],[0,1,.55,1],[0,.55,.45,.55]],
    N: [[0,0,0,1],[0,1,.55,0],[.55,0,.55,1]],
    '-': [[.07,.5,.48,.5]],
    0: [[0,0,0,1],[0,1,.55,1],[.55,1,.55,0],[.55,0,0,0]],
    6: [[.55,1,0,1],[0,1,0,0],[0,0,.55,0],[.55,0,.55,.5],[.55,.5,0,.5]],
  };
  [...'FN-06'].forEach((letter, index) => {
    for (const [x1,y1,x2,y2] of glyphs[letter]) {
      const advance = -0.012 + index * 0.008;
      const scale = 0.0062;
      block(body, ceramic, [Math.hypot(x2-x1,y2-y1)*scale,0.00065,0.0006],
        [advance+(x1+x2)*scale/2,-0.021+(y1+y2)*scale/2,0.0059],
        [0,0,Math.atan2(y2-y1,x2-x1)]);
    }
  });

  // A raised analogue gauge sits behind the right cladding. It is a fixed cosmetic
  // pressure dial, deliberately separate from the five functioning heat cells.
  block(body,copper,[0.033,0.024,0.022],[0.068,0.006,-0.077]);
  const gauge = new THREE.Mesh(new THREE.TorusGeometry(0.017,0.0023,4,16), steel);
  gauge.rotation.y = Math.PI/2;
  gauge.position.set(0.084,0.006,-0.077);
  gauge.name = 'foundry_pressure_gauge_bezel';
  body.add(gauge);
  const dial = ctx.cylinder(body,0.0148,0.002,[0.0845,0.006,-0.077],black,
    {segments:16,rotation:[0,Math.PI/2,0]});
  dial.name = 'foundry_pressure_gauge_face';
  for (let mark = 0; mark < 9; mark++) {
    const a = -Math.PI*0.78 + mark/8*Math.PI*1.56;
    const y = 0.006+Math.cos(a)*0.011, z = -0.077+Math.sin(a)*0.011;
    block(body, mark>6 ? ochre : ceramic,[0.0008,0.003,0.0012], [0.0861,y,z], [a,0,0]);
  }
  sideStroke(body,ochre,0.0867,0.006,-0.077,0.013,-0.071,0.0012);
  block(body,steel,[0.0012,0.0022,0.0022],[0.0869,0.006,-0.077]);

  // Twelve shallow armor ribs follow the faceted drum and travel with reloads.
  for (let facet=0;facet<12;facet++) {
    const a=facet*Math.PI/6;
    const x=0.002+Math.cos(a)*0.1135, y=-0.154+Math.sin(a)*0.1135;
    block(drum,copper,[0.005,0.032,0.125],[x,y,-0.225],[0,0,a]);
    block(drum,black,[0.0012,0.017,0.077],
      [0.002+Math.cos(a)*0.1167,-0.154+Math.sin(a)*0.1167,-0.225],[0,0,a]);
    for (const z of [-0.274,-0.176]) {
      block(drum,steel,[0.002,0.006,0.006],
        [0.002+Math.cos(a)*0.1173,-0.154+Math.sin(a)*0.1173,z],[0,0,a]);
    }
  }
  // Yellow locks and end-cap witness marks make the drum read as ammunition gear.
  block(drum,ochre,[0.121,0.016,0.0018],[0.002,-0.154,-0.1079]);
  for (let stripe=0;stripe<10;stripe++) {
    block(drum,black,[0.005,0.014,0.0008],[-0.051+stripe*0.0118,-0.154,-0.1064],[0,0,0.38]);
  }
  for (let mark=0;mark<12;mark++) {
    const a=mark*Math.PI/6;
    block(drum,mark%3===0 ? ochre : steel,[0.012,0.003,0.0015],
      [0.002+Math.cos(a)*0.097,-0.154+Math.sin(a)*0.097,-0.1232],[0,0,a]);
  }

  if (collars) {
    // Both thin copper hoops belong to the existing rotor. No new structure spans
    // its open central sight gap or reaches past any of the six muzzle openings.
    for (const z of [-0.415,model.T.muzzle[2]+0.064]) {
      const ring=new THREE.Mesh(new THREE.TorusGeometry(0.081,0.003,4,24),copper);
      ring.position.z=z+0.0105;
      ring.name='foundry_copper_rotor_ring';
      collars.add(ring);
      for (let lug=0;lug<6;lug++) {
        const a=lug*Math.PI/3;
        block(collars,copper,[0.008,0.020,0.020],
          [Math.cos(a)*0.087,Math.sin(a)*0.087,z],[0,0,a]);
        block(collars,steel,[0.0018,0.004,0.009],
          [Math.cos(a)*0.0918,Math.sin(a)*0.0918,z],[0,0,a]);
        block(collars,ochre,[0.001,0.008,0.004],
          [Math.cos(a)*0.0929,Math.sin(a)*0.0929,z+0.006],[0,0,a]);
      }
    }
  }
  if (feed) {
    // This overlay follows the cover's own hinge through the reload sequence.
    block(feed,copper,[0.002,0.032,0.065],[-0.034,-0.018,-0.033]);
    block(feed,black,[0.001,0.019,0.047],[-0.0356,-0.018,-0.033]);
    for (let stripe=0;stripe<5;stripe++) {
      block(feed,ochre,[0.0008,0.015,0.0032],[-0.0365,-0.018,-0.014-stripe*0.009],[0.35,0,0]);
    }
  }

  const dummy=new THREE.Object3D();
  for (const [parent,materials] of batches) {
    for (const [material,transforms] of materials) {
      const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),material,transforms.length);
      mesh.name='foundry_batched_detail';
      transforms.forEach(({size,position,rotation},index)=>{
        dummy.position.set(...position);dummy.rotation.set(...rotation);dummy.scale.set(...size);
        dummy.updateMatrix();mesh.setMatrixAt(index,dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate=true;
      mesh.computeBoundingBox();mesh.computeBoundingSphere();
      parent.add(mesh);
    }
  }
}
