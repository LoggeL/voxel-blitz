import * as THREE from '../vendor/three.module.js';

// The boot path can still dress a player when the downloadable Rivet mesh is
// unavailable. These low-resolution profiles use the same local joint frames.
// Bake them once per page; each operator still owns its materials.
let template;

function makeTemplate() {
  const shapes = [];
  const segments = 16;
  function profile(part, material, rows, { x = 0, z = 0, exponent = 1 } = {}) {
    const positions = [], indices = [];
    const curve = v => Math.sign(v) * Math.pow(Math.abs(v), exponent);
    for (const [y, width, depth, offsetZ = 0] of rows) {
      for (let i = 0; i < segments; i++) {
        const angle = i * Math.PI * 2 / segments;
        positions.push(x + width * curve(Math.sin(angle)), y, z + offsetZ - depth * curve(Math.cos(angle)));
      }
    }
    for (let j = 0; j < rows.length - 1; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * segments + i, b = j * segments + (i + 1) % segments;
        indices.push(a, a + segments, b, b, a + segments, b + segments);
      }
    }
    const top = (rows.length - 1) * segments;
    for (let i = 1; i < segments - 1; i++) indices.push(0, i, i + 1, top, top + i + 1, top + i);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.userData.pageOwned = true;
    shapes.push({ part, material, geometry });
  }

  // Tailored jacket, carrier, collar and suspended belt kit.
  profile('torso', 'dark', [[-.25,.174,.12],[-.17,.183,.13],[-.04,.188,.141],[.14,.231,.144],
    [.20,.236,.127],[.24,.15,.105],[.245,.074,.075]]);
  profile('torso', 'suit', [[-.055,.13,.033],[.002,.174,.05],[.152,.177,.048],[.184,.14,.035]],
    { z: -.127, exponent: .64 });
  profile('torso', 'accent', [[.016,.062,.008],[.031,.070,.012],[.103,.070,.012],[.118,.060,.008]],
    { z: -.176, exponent: .62 });
  for (const x of [-.133, .133]) {
    profile('torso', 'web', [[-.013,.019,.011],[.13,.024,.017],[.213,.024,.011,.034]],
      { x, z: -.134, exponent: .63 });
  }
  profile('torso', 'cloth', [[.180,.105,.097],[.23,.111,.109],[.267,.097,.093]], { z: .008 });
  profile('pack', 'web', [[-.32,.12,.04],[-.29,.162,.068],[-.10,.169,.074],[.019,.144,.061],
    [.043,.109,.041]], { z: .055, exponent: .70 });
  profile('pack', 'accent', [[-.13,.045,.004],[-.108,.047,.005]], { z: .128, exponent: .60 });
  for (const x of [-.104, 0, .104]) {
    profile('pouches', 'web', [[-.13,.035,.027],[-.115,.048,.042],[-.025,.046,.042],
      [-.016,.04,.037]], { x, z: -.012, exponent: .53 });
  }
  profile('hips', 'cloth', [[-.118,.187,.113],[-.079,.229,.136],[.022,.233,.147],[.101,.194,.128]], { exponent: .83 });
  profile('hips', 'web', [[.031,.237,.149],[.038,.240,.153],[.088,.235,.146],[.092,.229,.142]]);

  // Neck gaiter below a domed shell, with a separate wraparound lens and cups.
  profile('head', 'cloth', [[-.25,.076,.073,.01],[-.18,.084,.082],[-.135,.08,.09,-.018],
    [-.10,.098,.105,-.031],[-.045,.119,.116,-.033],[.035,.121,.137],[.09,.09,.111]]);
  profile('head', 'armor', [[.014,.142,.147],[.043,.153,.161],[.094,.151,.153],
    [.145,.125,.13],[.179,.078,.084],[.19,.024,.026]]);
  profile('head', 'visor', [[-.041,.077,.027],[-.032,.117,.038],[.008,.134,.046],
    [.035,.121,.04],[.04,.088,.026]], { z: -.112, exponent: .80 });
  for (const sign of [-1, 1]) {
    profile('head', 'cloth', [[-.066,.015,.028],[-.048,.023,.049],[.021,.024,.052],
      [.044,.012,.030]], { x: sign * .142, z: .013 });
  }

  for (const side of ['l', 'r']) {
    const sign = side === 'l' ? -1 : 1;
    profile(side + 'Thigh', 'cloth', [[-.327,.076,.082],[-.28,.083,.089],[-.15,.111,.111],
      [-.06,.122,.121],[-.003,.109,.115],[.018,.081,.092]]);
    profile(side + 'Thigh', 'dark', [[-.237,.036,.044],[-.216,.046,.066],[-.104,.05,.065],
      [-.092,.045,.059]], { x: sign * .084, exponent: .68 });
    profile(side + 'Knee', 'cloth', [[-.326,.066,.067],[-.277,.070,.07,.006],[-.13,.088,.088,.017],
      [-.072,.091,.091,.014],[.034,.076,.078]]);
    profile(side + 'Knee', 'armor', [[-.085,.045,.021],[-.057,.078,.035],[.009,.084,.042],
      [.045,.061,.029]], { z: -.079, exponent: .78 });
    profile(side + 'Boot', 'cloth', [[-.045,.097,.142,-.054],[-.012,.098,.144,-.056],
      [.021,.091,.126,-.045],[.055,.08,.085,-.004],[.12,.074,.067]], { exponent: .75 });
    profile(side + 'Boot', 'rubber', [[-.071,.091,.151],[-.066,.099,.156],[-.038,.099,.154]],
      { z: -.061, exponent: .69 });
    profile(side + 'Arm', 'suit', [[-.34,.058,.064],[-.265,.067,.073],[-.166,.08,.081],
      [-.067,.101,.097],[.008,.104,.100],[.049,.085,.089],[.073,.039,.049]]);
    profile(side + 'Arm', 'dark', [[-.164,.019,.042],[-.151,.023,.047],[-.089,.025,.05]],
      { x: sign * .084, exponent: .78 });
    profile(side + 'Elbow', 'dark', [[-.337,.046,.05],[-.257,.056,.060],[-.16,.067,.074],
      [-.083,.07,.080],[.009,.068,.067],[.043,.042,.044]]);
    profile(side + 'Elbow', 'rubber', [[-.34,.047,.05],[-.298,.050,.054]]);
    profile(side + 'Hand', 'cloth', [[-.06,.026,.04],[-.041,.039,.047],[.014,.039,.048],
      [.043,.028,.037]], { exponent: .71 });
    profile(side + 'Hand', 'rubber', [[-.04,.014,.025],[-.018,.019,.029],[.013,.016,.02]],
      { x: -sign * .034, z: -.019 });
  }
  return shapes;
}

export function createFallbackOperatorParts(palette) {
  template ??= makeTemplate();
  const materials = { ...palette };
  for (const [key, color] of [['cloth', 0x373f43], ['web', 0x7a7060], ['rubber', 0x22272a], ['accent', 0xb85029]]) {
    materials[key] = new THREE.MeshStandardMaterial({ color, roughness: 0.85, transparent: true });
  }
  materials.accent.name = 'Armor | rescue orange';
  const parts = {};
  for (const { part, material, geometry } of template) {
    const group = parts[part] ??= new THREE.Group();
    group.name = part;
    group.add(new THREE.Mesh(geometry, materials[material]));
  }
  return parts;
}
