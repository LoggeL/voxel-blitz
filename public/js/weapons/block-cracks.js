import * as THREE from '../vendor/three.module.js';

/** Ten cumulative 16px damage masks. Empty texels preserve the block's own material. */
export function createBlockCrackMaterials() {
  const size = 16;
  const branches = [
    [[8,8],[6,7],[6,5],[4,4],[3,2],[1,1]],
    [[8,8],[9,6],[11,6],[11,3],[13,2],[14,0]],
    [[8,8],[10,9],[12,9],[12,11],[14,12],[15,14]],
    [[8,8],[7,10],[5,11],[5,13],[3,14],[2,15]],
    [[6,5],[7,3],[7,1],[8,0]],
    [[11,6],[13,7],[15,6]],
    [[5,11],[3,10],[1,11],[0,11]],
    [[12,11],[10,13],[10,15]],
  ];
  return Array.from({ length: 10 }, (_, stage) => {
    const mask = new Uint8Array(size * size);
    branches.forEach((path, branch) => {
      const budget = Math.max(0, (stage + 1) / 10 * (path.length - 1) - (branch >= 4 ? 0.65 : 0));
      for (let segment = 0; segment < Math.ceil(budget); segment++) {
        const a = path[segment], b = path[segment + 1];
        if (!b) break;
        const length = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        for (let step = 0; step <= length * Math.min(1, budget - segment); step++) {
          const x = Math.round(a[0] + (b[0] - a[0]) * step / length);
          const y = Math.round(a[1] + (b[1] - a[1]) * step / length);
          mask[y * size + x] = 1;
        }
      }
    });
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x, offset = i * 4;
      const edge = !mask[i] && ((x > 0 && mask[i - 1]) || (y > 0 && mask[i - size]));
      if (!mask[i] && !edge) continue;
      const color = mask[i] ? 18 : 110;
      pixels.set([color, color, color, mask[i] ? 235 : 135], offset);
    }
    const map = new THREE.DataTexture(pixels, size, size);
    map.magFilter = map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.needsUpdate = true;
    return new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.1,
      depthWrite: false, toneMapped: false, polygonOffset: true,
      polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  });
}
