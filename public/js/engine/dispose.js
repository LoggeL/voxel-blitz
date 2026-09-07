/** Release resources once across roots that may share geometry, materials or textures. */
export function disposeObjectTrees(roots, { excludedMaterials } = {}) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const collectMaterial = (material) => {
    if (!material || materials.has(material)) return;
    materials.add(material);
    for (const value of Object.values(material)) {
      if (value?.isTexture) textures.add(value);
    }
    for (const uniform of Object.values(material.uniforms || {})) {
      const value = uniform?.value;
      if (value?.isTexture) textures.add(value);
      else if (Array.isArray(value)) {
        for (const item of value) if (item?.isTexture) textures.add(item);
      }
    }
  };
  for (const root of roots) {
    root?.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (Array.isArray(object.material)) {
        for (const material of object.material) collectMaterial(material);
      } else {
        collectMaterial(object.material);
      }
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) {
    if (!excludedMaterials?.has(material)) material.dispose();
  }
}

export function disposeObjectTree(root) {
  disposeObjectTrees([root]);
}
