import * as THREE from '../vendor/three.module.js';
import { GoreFX } from '../weapons/gore.js';
import { goreProfile } from '../weapons/gore-profile.js';
import { makeAvatar, beginAvatarDeath, updateAvatarDeath, resetAvatarPose, disposeAvatar } from '../avatar/avatar.js';

const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(1200, 430);
renderer.setScissorTest(true);
document.getElementById('view').append(renderer.domElement);
const panels = [0, 30, 200].map((overkill, index) => {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x26313c);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7780, 3));
  const floor = new THREE.Mesh(new THREE.BoxGeometry(30, 1, 30), new THREE.MeshLambertMaterial({ color: 0x93968b }));
  floor.position.y = -0.5; scene.add(floor);
  const camera = new THREE.PerspectiveCamera(54, 400 / 430, 0.05, 100);
  camera.position.set(5.7, 4.2, 7.7); camera.lookAt(0, 1, 0);
  const avatar = makeAvatar(`overkill-${index}`, 'TARGET'); scene.add(avatar.group);
  const label = document.createElement('article');
  label.innerHTML = `<h2>${overkill} overkill</h2><p>${100 + overkill} health damage · 100 health</p><p class="counts"></p>`;
  document.getElementById('labels').append(label);
  return { scene, camera, avatar, overkill, label, fx: null };
});
let seconds = 0.18;

function seed() {
  let state = 0x4f982;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
}

function renderComparison() {
  const originalRandom = Math.random;
  const headshot = document.getElementById('headshot').checked;
  const results = [];
  try {
    for (let index = 0; index < panels.length; index++) {
      const panel = panels[index];
      Math.random = seed();
      panel.fx?.dispose();
      resetAvatarPose(panel.avatar);
      const event = { vx: 0, vy: 1.55, vz: 0, hs: headshot, healthDamage: 100 + panel.overkill,
        overkill: panel.overkill };
      const profile = goreProfile(event, { lethal: true });
      panel.fx = new GoreFX(panel.scene, panel.camera, (_x, y) => y < 0 ? 1 : 0);
      beginAvatarDeath(panel.avatar, 0, event);
      panel.fx.gore(event, { lethal: true });
      for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += 1 / 120) {
        const dt = Math.min(1 / 120, seconds - elapsed);
        panel.fx.update(dt); updateAvatarDeath(panel.avatar, dt, Math.min(1, (elapsed + dt) / 2.7));
      }
      renderer.setViewport(index * 400, 0, 400, 430);
      renderer.setScissor(index * 400, 0, 400, 430);
      renderer.render(panel.scene, panel.camera);
      const stains = panel.fx.goreStains.filter((particle) => particle.active).length;
      panel.label.querySelector('.counts').textContent =
        `${profile.mistCount} mist · ${profile.dropletCount} droplets · ${profile.chunkCount} chunks · ${stains} active stains`;
      results.push({ overkill: panel.overkill, profile, stains,
        finite: panel.fx.goreMeshes.every((mesh) => mesh.instanceMatrix.array.every(Number.isFinite)) });
    }
    const glError = renderer.getContext().getError();
    if (glError || results.some((row) => !row.finite)) throw new Error(`Invalid renderer state (${glError})`);
    document.documentElement.dataset.goreComparisonReady = 'true';
    document.documentElement.dataset.goreComparisonMetrics = JSON.stringify(results);
    status.textContent = `Rendered ${headshot ? 'headshot' : 'body hit'} comparison at ${seconds.toFixed(2)} s. Existing particle pools remain bounded.`;
  } catch (error) {
    status.textContent = error.message; document.documentElement.dataset.goreComparisonError = error.message;
  } finally { Math.random = originalRandom; }
}
for (const button of document.querySelectorAll('[data-time]')) button.addEventListener('click', () => {
  seconds = Number(button.dataset.time); renderComparison();
});
document.getElementById('headshot').addEventListener('change', renderComparison);
window.addEventListener('pagehide', () => {
  for (const panel of panels) { panel.fx?.dispose(); disposeAvatar(panel.avatar); }
  renderer.dispose();
}, { once: true });
renderComparison();
