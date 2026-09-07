// Shared deterministic value-noise / fbm used by world generation.
// No Math.random anywhere: every call is a pure function of coordinates + seed.

function hash2i(xi, zi, seed) {
  // Integer lattice hash -> [-1, 1]. Deterministic across JS engines (int32 math).
  let h = xi * 374761393 + zi * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h & 0xfffff) / 0xfffff * 2 - 1;
}

function smooth(t) { return t * t * (3 - 2 * t); }

/** Single-octave value noise on a unit-ish scale (input in "world units"). */
export function valueNoise2(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const tx = smooth(x - xi), tz = smooth(z - zi);
  const a = hash2i(xi, zi, seed);
  const b = hash2i(xi + 1, zi, seed);
  const c = hash2i(xi, zi + 1, seed);
  const d = hash2i(xi + 1, zi + 1, seed);
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * tz;
}

/** Fractal Brownian motion, output roughly in [-1, 1]. */
export function fbm2(x, z, seed, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * freq, z * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Tiny seeded PRNG (mulberry32) for feature scatter / spray sampling. */
export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
