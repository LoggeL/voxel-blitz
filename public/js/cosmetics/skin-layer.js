import * as THREE from '../vendor/three.module.js';
import { disposeObjectTrees } from '../engine/dispose.js';

/** Owns a reversible visual layer. Base geometry, shared materials and animation anchors stay intact. */
export class SkinLayer {
  constructor() {
    this.groups = [];
    this.originals = new Map();
    this.materials = new Set();
    this.clones = new Map();
  }

  material(color, options = {}) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.35,
      flatShading: true, transparent: true, ...options });
    this.materials.add(mat);
    return mat;
  }

  /** Match original palette colors, cloning once per source material, never recoloring another player's gun. */
  tint(root, palette, { includeHands = false } = {}) {
    root.traverse(object => {
      if (!object.isMesh || !object.material) return;
      if (!includeHands) {
        for (let parent = object; parent; parent = parent.parent) {
          if (parent.name === 'hand_l' || parent.name === 'hand_r') return;
          if (parent === root) break;
        }
      }
      const replace = original => {
        if (!original.color || original.isShaderMaterial) return original;
        const hex = original.color.getHex();
        if (!Object.hasOwn(palette, hex)) return original;
        if (!this.clones.has(original)) {
          const mat = original.clone();
          const paint = palette[hex];
          mat.color.setHex(typeof paint === 'object' ? paint.color : paint);
          if (typeof paint === 'object') {
            if (paint.roughness !== undefined) mat.roughness = paint.roughness;
            if (paint.metalness !== undefined) mat.metalness = paint.metalness;
          }
          this.clones.set(original, mat);
          this.materials.add(mat);
        }
        return this.clones.get(original);
      };
      const next = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
      if (next !== object.material) {
        if (!this.originals.has(object)) this.originals.set(object, object.material);
        object.material = next;
      }
    });
  }

  group(parent, name = 'cosmetic_detail') {
    const group = new THREE.Group();
    group.name = name;
    group.userData.cosmetic = true;
    parent.add(group);
    this.groups.push(group);
    return group;
  }

  box(parent, size, position, color, options = {}) {
    const mat = color?.isMaterial ? color : this.material(color, options);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    mesh.position.set(...position);
    if (options.rotation) mesh.rotation.set(...options.rotation);
    parent.add(mesh);
    return mesh;
  }

  cylinder(parent, radius, length, position, color, options = {}) {
    const geometry = new THREE.CylinderGeometry(radius, radius, length, options.segments || 12);
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, color?.isMaterial ? color : this.material(color, options));
    mesh.position.set(...position);
    if (options.rotation) mesh.rotation.set(...options.rotation);
    parent.add(mesh);
    return mesh;
  }

  clear() {
    for (const [object, material] of this.originals) object.material = material;
    disposeObjectTrees(this.groups, { excludedMaterials: this.materials });
    for (const group of this.groups) { group.removeFromParent(); group.clear(); }
    for (const material of this.materials) material.dispose();
    this.groups.length = 0;
    this.originals.clear(); this.materials.clear(); this.clones.clear();
  }
}
