import * as THREE from '../vendor/three.module.js';
import { AIR } from '../../../shared/world/blocks.js';
import { LARGE_MAP_LIGHTS, lightFixtureGeometry } from '../../../shared/world/large-map-lights.js';

const COLORS = Object.freeze({ cyan: 0xa1f1ff, amber: 0xffd08a, warm: 0xffda9c });

/** Emissive fixture faces: one instanced draw per color, zero extra light sources. */
export function buildMapLights(mapId, getBlock) {
  const group = new THREE.Group();
  group.name = 'map-lights';
  const fixtures = (LARGE_MAP_LIGHTS[mapId] || []).map(light => ({ ...light, ...lightFixtureGeometry(light) }));
  const batches = [];
  const transform = new THREE.Object3D();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const materialParams = { roughness: 0.55, metalness: 0, toneMapped: false };
  for (const color of Object.keys(COLORS)) {
    const entries = fixtures.filter(light => light.color === color);
    if (!entries.length) continue;
    const count = entries.reduce((sum, light) => sum + light.surfaces.length, 0);
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshStandardMaterial({ ...materialParams,
      color: COLORS[color], emissive: COLORS[color], emissiveIntensity: 0.9 });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = `map-light-${color}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // A batch can be restored after all its support cells were previously gone.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    let index = 0;
    for (const light of entries) {
      light.indices = light.surfaces.map(surface => {
        transform.position.fromArray(surface.position);
        transform.rotation.set(0, Math.atan2(surface.normal[0], surface.normal[2]), 0);
        transform.scale.set(surface.width, surface.height, 1);
        transform.updateMatrix();
        return { index: index++, matrix: transform.matrix.clone(), surface };
      });
      light.intact = () => getBlock(...light.foundation) !== AIR
        && light.cells.every(([x, y, z, type]) => getBlock(x, y, z) === type);
      light.visible = null;
    }
    batches.push({ mesh, entries });
    group.add(mesh);
  }
  const refresh = () => {
    for (const { mesh, entries } of batches) {
      let changed = false;
      for (const light of entries) {
        const intact = light.intact();
        light.visible = false;
        light.visibleFaces = 0;
        for (const instance of light.indices) {
          const { surface } = instance;
          const visible = intact && getBlock(
            Math.floor(surface.position[0] + surface.normal[0] * 0.02),
            Math.floor(surface.position[1]),
            Math.floor(surface.position[2] + surface.normal[2] * 0.02)) === AIR;
          light.visible ||= visible;
          if (visible) light.visibleFaces++;
          if (visible === instance.visible) continue;
          instance.visible = visible;
          mesh.setMatrixAt(instance.index, visible ? instance.matrix : hidden);
          changed = true;
        }
      }
      if (changed) mesh.instanceMatrix.needsUpdate = true;
    }
  };
  refresh();
  return {
    group,
    refresh,
    get stats() { return { fixtures: fixtures.length, visible: fixtures.filter(light => light.visible).length,
      faces: fixtures.reduce((sum, light) => sum + (light.visibleFaces || 0), 0),
      drawCalls: batches.length, dynamicLights: 0 }; },
    dispose() {
      for (const { mesh } of batches) { mesh.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
      batches.length = 0;
      group.removeFromParent();
      group.clear();
    },
  };
}
