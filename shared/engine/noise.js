// noise.js — seeded 2D simplex noise and fractal Brownian motion.
//
// The workhorse of procedural terrain, clouds, and any organic-looking field.
// Unlike Math.random(), noise is a *continuous* function of position: sample
// two nearby points and you get two nearby values, which is what makes it
// produce landscapes instead of static.

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

const GRAD2 = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Seeded 512-entry permutation table (xorshift-shuffled 0..255, doubled). */
function makePerm(seed) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

/**
 * Build a noise sampler for a seed.
 *
 * Returns `{ simplex2, fbm, perm }`. Two samplers with the same seed produce
 * identical fields forever, which is what lets a world be regenerated from a
 * seed string instead of stored.
 *
 * @param {number} seed
 */
export function createNoise2D(seed = 1337) {
  const PERM = makePerm(seed);

  /** Compact 2D simplex noise (Gustavson-style). Roughly in [-1, 1]. */
  function simplex2(xin, yin) {
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      const g = GRAD2[PERM[ii + PERM[jj]] & 7];
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      const g = GRAD2[PERM[ii + i1 + PERM[jj + j1]] & 7];
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      const g = GRAD2[PERM[ii + 1 + PERM[jj + 1]] & 7];
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  /**
   * Fractal Brownian motion: sum octaves of noise at rising frequency and
   * falling amplitude. This is what turns smooth blobs into terrain — the
   * coarse octaves carve continents, the fine ones add gravel.
   *
   * @param {number} octaves    how many layers; cost is linear in this
   * @param {number} lacunarity frequency multiplier per octave (~2)
   * @param {number} gain       amplitude multiplier per octave (~0.5)
   */
  function fbm(x, y, octaves, lacunarity, gain) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * simplex2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  return { simplex2, fbm, perm: PERM };
}
