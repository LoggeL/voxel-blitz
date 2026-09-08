import * as THREE from '../vendor/three.module.js';

/** Each effect owns its texture so teardown never invalidates another fire batch. */
export function createFireAtlas() {
  const texture = typeof document === 'undefined'
    ? new THREE.Texture()
    : new THREE.TextureLoader().load('/assets/fx/fire-atlas.png');
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

// Top-left row-major atlas; inset and pixel snapping keep the generated art crisp.
export const FIRE_SPRITE_GLSL = `
  uniform sampler2D fireAtlas;
  vec4 fireSprite(vec2 uv, float phase) {
    float frame = mod(floor(phase), 16.0);
    vec2 cell = vec2(mod(frame, 4.0), 3.0 - floor(frame / 4.0));
    vec2 pixel = (floor(clamp(uv, 0.0, 0.999) * 32.0) + 0.5) / 32.0;
    vec4 sprite = texture2D(fireAtlas, (cell + pixel) / 4.0);
    if (sprite.a < 0.5) discard;
    return sprite;
  }
`;
