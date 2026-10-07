// A full-strength fade before the far plane prevents a clipped skyline.
// Materials default to the legacy arena range; each large-world scene binds
// its own defines before compilation, including newly added vehicle/avatar FX.

import * as THREE from '../vendor/three.module.js';

export const FAR_FADE_START = 290;
export const FAR_FADE_END = 392;

const MARKER = '/* vb-far-fade */';

export function installFarFog() {
  const chunk = THREE.ShaderChunk.fog_fragment;
  if (chunk.includes(MARKER)) return false;
  const hook = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
  if (!chunk.includes(hook)) return false;
  THREE.ShaderChunk.fog_fragment = chunk.replace(hook,
    `${MARKER}
    #ifndef VB_FAR_FADE_START
      #define VB_FAR_FADE_START ${FAR_FADE_START.toFixed(1)}
      #define VB_FAR_FADE_END ${FAR_FADE_END.toFixed(1)}
    #endif
    fogFactor = max( fogFactor, smoothstep( VB_FAR_FADE_START, VB_FAR_FADE_END, vFogDepth ) );
    ${hook}`);
  return true;
}

/**
 * Bind a large-world far fade to every fogged material under `scene`, now and
 * (through scene.onBeforeRender) for materials added later. Returns a release
 * function that restores the original defines; its `sync()` binds materials
 * added since construction right away. Call it before shader warm-up:
 * renderer.compile never runs onBeforeRender, so a late root would otherwise
 * be compiled without the defines and relinked on the first live frame.
 */
export function configureSceneFarFog(scene, profile) {
  if (profile.fadeStart === FAR_FADE_START && profile.fadeEnd === FAR_FADE_END) {
    const noop = () => {};
    noop.sync = () => 0;
    return noop;
  }
  const start = profile.fadeStart.toFixed(1), end = profile.fadeEnd.toFixed(1);
  const touched = new Map();
  const restore = (material) => {
    const saved = touched.get(material);
    if (!saved) return;
    touched.delete(material);
    material.removeEventListener('dispose', onDispose);
    const defines = material.defines;
    if (defines?.VB_FAR_FADE_START !== start || defines?.VB_FAR_FADE_END !== end) return;
    if (saved.start === undefined) delete defines.VB_FAR_FADE_START;
    else defines.VB_FAR_FADE_START = saved.start;
    if (saved.end === undefined) delete defines.VB_FAR_FADE_END;
    else defines.VB_FAR_FADE_END = saved.end;
    if (!saved.defines && !Object.keys(defines).length) material.defines = saved.defines;
    material.needsUpdate = true;
  };
  const onDispose = (event) => restore(event.target);
  let changed = 0;
  const configure = (object) => {
    if (!object.material) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material.fog !== true) continue;
      if (!touched.has(material)) {
        touched.set(material, {
          defines: material.defines,
          start: material.defines?.VB_FAR_FADE_START,
          end: material.defines?.VB_FAR_FADE_END,
        });
        material.addEventListener('dispose', onDispose);
      }
      const defines = material.defines ||= {};
      if (defines.VB_FAR_FADE_START === start && defines.VB_FAR_FADE_END === end) continue;
      defines.VB_FAR_FADE_START = start;
      defines.VB_FAR_FADE_END = end;
      material.needsUpdate = true;
      changed++;
    }
  };
  const previous = scene.onBeforeRender;
  const beforeRender = function (...args) {
    previous?.apply(this, args);
    // The scene callback runs before projectObject and program lookup. Chained
    // onBeforeCompile handlers and their program keys remain untouched.
    scene.traverse(configure);
  };
  scene.onBeforeRender = beforeRender;
  scene.traverse(configure);
  const release = () => {
    if (scene.onBeforeRender === beforeRender) scene.onBeforeRender = previous;
    for (const material of touched.keys()) restore(material);
  };
  /** Bind materials added since the last pass now; returns how many changed. */
  release.sync = () => {
    changed = 0;
    scene.traverse(configure);
    return changed;
  };
  return release;
}
