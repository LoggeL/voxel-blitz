import * as THREE from '../vendor/three.module.js';

// The planted objective charge (design docs/design/interact-anims/, reference
// B "objective device"): olive-tan blocks under black tape, a grey keypad and
// a team-neutral red LED on top. `big` is the S&D bomb: two blocks around a
// grey timer box with a red display. One builder serves the first-person
// hands, the third-person planter and the world props, so the three match.

/** Blink period (ms) and lit share of the LED for `leftMs` until the blast (null: unknown, the slow blink). */
export function chargeBlink(leftMs) {
  if (!Number.isFinite(leftMs)) return { periodMs: 1000, duty: 0.22 };
  if (leftMs <= 3000) return { periodMs: 180, duty: 0.5 };
  if (leftMs <= 10000) return { periodMs: 450, duty: 0.3 };
  return { periodMs: 1000, duty: 0.22 };
}

/** LED lit at `nowMs` for `leftMs` left (phase-locked to the clock so every charge of one fuse blinks together). */
export const chargeLedOn = (nowMs, leftMs) => {
  const { periodMs, duty } = chargeBlink(leftMs);
  return ((nowMs % periodMs) + periodMs) % periodMs < periodMs * duty;
};

let shared = null;
function sharedMaterials() {
  if (shared) return shared;
  shared = {
    geometry: new THREE.BoxGeometry(1, 1, 1),
    putty: new THREE.MeshStandardMaterial({ color: 0x9c8a55, roughness: 0.86 }),
    tape: new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.8 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x5c6166, roughness: 0.55, metalness: 0.35 }),
    keys: new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7 }),
    display: new THREE.MeshBasicMaterial({ color: 0x8a1410, toneMapped: false }),
    wires: [0xc8352b, 0x2f6fd0, 0xd9b42c].map(color => new THREE.MeshStandardMaterial({ color, roughness: 0.6 })),
  };
  shared.geometry.userData.pageOwned = true;
  return shared;
}

/**
 * Build a charge. Returns {root, led, ledMaterial, wires, setLed(on, level)}.
 * The root sits on its base (y 0 is the floor), +z its keypad face.
 * Every instance owns its LED material (it blinks on its own); the rest is shared.
 */
export function buildChargeModel({ big = false, name = 'objective-charge' } = {}) {
  const { geometry, putty, tape, steel, keys, display: displayMaterial, wires: wireMaterials } = sharedMaterials();
  const root = new THREE.Group();
  root.name = name;
  const box = (material, size, pos, into = root) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(...size); mesh.position.set(...pos);
    mesh.castShadow = true;
    into.add(mesh);
    return mesh;
  };
  const h = big ? 0.12 : 0.085;
  const ledMaterial = new THREE.MeshStandardMaterial({ color: 0x5a0d09, emissive: 0xff2a1a, emissiveIntensity: 0, roughness: 0.4 });
  let led;
  const wires = [];
  if (big) {
    for (const sx of [-1, 1]) {
      box(putty, [0.13, h, 0.15], [sx * 0.125, h / 2, 0]);
      for (const ox of [-0.035, 0.035]) box(tape, [0.022, h + 0.006, 0.156], [sx * 0.125 + ox, h / 2, 0]);
    }
    box(steel, [0.12, h + 0.02, 0.13], [0, (h + 0.02) / 2, 0.005]);
    const display = box(displayMaterial, [0.08, 0.03, 0.004], [0, h * 0.72, 0.072]);
    display.name = 'charge-display';
    for (let i = 0; i < 6; i++) box(keys, [0.018, 0.012, 0.006], [-0.025 + (i % 3) * 0.025, h * 0.32 - Math.floor(i / 3) * 0.02, 0.072]);
    led = box(ledMaterial, [0.03, 0.022, 0.03], [0, h + 0.031, 0]);
  } else {
    box(putty, [0.2, h, 0.12], [0, h / 2, 0]);
    for (const ox of [-0.06, 0.06]) box(tape, [0.024, h + 0.006, 0.126], [ox, h / 2, 0]);
    box(steel, [0.075, 0.018, 0.06], [0, h + 0.009, 0.01]);                 // keypad plate on top
    for (let i = 0; i < 6; i++) box(keys, [0.014, 0.006, 0.012], [-0.022 + (i % 3) * 0.022, h + 0.02, 0.0 + Math.floor(i / 3) * 0.02]);
    led = box(ledMaterial, [0.018, 0.016, 0.018], [0.06, h + 0.014, -0.035]);
    // Three cables over the front face (the defuse cuts them).
    wireMaterials.forEach((material, i) => wires.push(box(material, [0.012, h * 0.7, 0.01], [-0.03 + i * 0.03, h * 0.5, 0.064])));
  }
  led.name = 'charge-led';
  const setLed = (on, level = 1) => {
    const lit = on ? Math.max(0, level) : 0;
    ledMaterial.emissiveIntensity = lit * 3.2;
    ledMaterial.color.setHex(lit > 0 ? 0xff3b2a : 0x5a0d09);
  };
  setLed(false);
  return { root, led, ledMaterial, wires, setLed };
}

/** Free an instance's own LED material (the shared parts stay). */
export function disposeChargeModel(model) {
  model?.ledMaterial?.dispose();
  model?.root?.removeFromParent();
}
