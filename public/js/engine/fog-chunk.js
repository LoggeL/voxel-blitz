// Distance fog that always reaches full strength before the camera's 400 m far
// plane. Exponential fog alone leaves distant terrain at ~50% fog on thin-fog
// maps, so the far plane cut a hard edge into the skyline. The override is a
// global chunk edit made once, before any world program compiles.

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
    `${MARKER}\n\tfogFactor = max( fogFactor, smoothstep( ${FAR_FADE_START.toFixed(1)}, ${FAR_FADE_END.toFixed(1)}, vFogDepth ) );\n\t${hook}`);
  return true;
}
