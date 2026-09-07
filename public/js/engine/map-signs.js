import * as THREE from '../vendor/three.module.js';
import { AIR, GLASS } from '../../../shared/world/blocks.js';

// Signs are flush paint on solid voxel faces. Every backing cell is tracked so
// destruction removes the paint with its wall, including on a late join.
const SIGNS = {
  foundry: [
    ['NORTH FORGE', 'CASTING / 01', 60.5, 18.5, 31, 7, 0.8, '+z'],
    ['FOUNDRY', 'HEAVY LIFT', 65.5, 24.5, 47, 7, 0.8, '+z'],
  ],
  depot: [
    ['DEPOT / 07', 'FREIGHT HANDLING', 64, 26.5, 52, 12, 0.8, '+z'],
    ['DEPOT / 07', 'FREIGHT HANDLING', 64, 26.5, 44, 12, 0.8, '-z'],
    ['WEST LOADING', 'BAY 01', 18.5, 22.5, 38, 12, 0.8, '+z'],
    ['EAST LOADING', 'BAY 02', 109.5, 22.5, 58, 12, 0.8, '-z'],
  ],
  citadel: [
    ['THE KEEP', 'SOUTH COURT', 52, 22, 66, 5.6, 1.5, '+z'],
  ],
  solstice: [
    ['HELIO / 03', 'SOLAR RESEARCH', 54, 24, 46, 3.6, 1.2, '+z'],
    ['BIOME / 01', 'BOTANICAL RESEARCH', 28.5, 21.5, 68, 10, 0.8, '+z'],
  ],
  caldera: [
    ['CALDERA', 'GEOTHERMAL WORKS', 64.5, 21, 51, 4.6, 1.8, '+z'],
    ['OBSIDIAN GATE', 'WEST ACCESS', 26, 21.5, 51, 12, 0.8, '+z'],
  ],
  nuketown: [
    ['01', 'ATOMIC AVENUE', 60.5, 19.5, 61, 2.4, 0.8, '-z'],
    ['02', 'ATOMIC AVENUE', 67.5, 19.5, 35, 2.4, 0.8, '+z'],
  ],
  dust2: [
    ['A SITE', 'LONG / SHORT', 104, 21, 10, 7, 1.8, '+z'],
    ['B SITE', 'KASBAH / TUNNELS', 26.5, 20.5, 10, 7, 1.8, '+z'],
    ['MID DOORS', 'CT SPAWN', 59.5, 23.1, 32, 8, 1.4, '+z'],
    ['T SPAWN', 'MID / LONG / TUNNELS', 65.5, 20.5, 90, 8, 1.8, '-z'],
  ],
  killhouse: [
    ['LIVE FIRE', 'KEEP DOWNRANGE CLEAR', 64, 18.5, 58, 15, 2, '+z'],
    ['THE COURSE', 'ENTRY', 15, 20.5, 50, 6.7, 0.85, '+z'],
    ['RANGE RULES', 'KEEP MUZZLE DOWNRANGE', 54, 20.5, 90, 12, 1, '-z'],
  ],
};
const COLORS = {
  foundry: ['#273b39', '#f0c97b'], depot: ['#253744', '#ffce75'],
  citadel: ['#753c36', '#f7dfaf'], solstice: ['#25555a', '#f5e5b6'],
  caldera: ['#433b40', '#ffd1a0'], nuketown: ['#427268', '#fff0cd'],
  dust2: ['#d9bd86', '#823e2b'],
  killhouse: ['#263848', '#ffcf77'],
};
const supportsPaint = type => type !== AIR && type !== GLASS;

export function buildMapSigns(mapId, getBlock) {
  const group = new THREE.Group();
  group.name = 'map-signs';
  const signs = [];
  const [paper, ink] = COLORS[mapId] || COLORS.foundry;
  for (const [title, subtitle, x, y, z, width, height, face] of SIGNS[mapId] || []) {
    const outward = face === '+z' ? 1 : -1;
    const supports = new Map();
    for (let dx = -width / 2 + 0.01; dx <= width / 2; dx += 0.25) {
      for (let dy = -height / 2 + 0.01; dy <= height / 2; dy += 0.25) {
        const cell = [Math.floor(x + dx), Math.floor(y + dy), Math.floor(z - outward * 0.01)];
        supports.set(cell.join(','), cell);
      }
    }
    const backing = [...supports.values()];
    const exposed = backing.map(([bx, by, bz]) => [bx, by, bz + outward]);
    // Never stretch an opaque label across a doorway, window, or destroyed wall.
    const intact = () => backing.every(cell => supportsPaint(getBlock(...cell)))
      && exposed.every(cell => getBlock(...cell) === AIR);
    if (!intact()) continue;
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = ink;
    ctx.fillRect(20, 20, 8, 216);
    ctx.fillRect(44, 218, 940, 3);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 100px sans-serif';
    ctx.fillText(title, 518, 100, 906);
    ctx.font = 'bold 31px monospace';
    ctx.fillText(subtitle, 518, 183, 890);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({ map: texture, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const geometry = new THREE.PlaneGeometry(width, height);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = title;
    mesh.position.set(x, y, z + outward * 0.018);
    mesh.rotation.y = outward < 0 ? Math.PI : 0;
    group.add(mesh);
    signs.push({ mesh, intact, texture });
  }
  return {
    group,
    refresh() {
      for (const { mesh, intact } of signs) mesh.visible = intact();
    },
    dispose() {
      for (const { mesh, texture } of signs) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        texture.dispose();
      }
      signs.length = 0;
      group.removeFromParent();
      group.clear();
    },
  };
}
