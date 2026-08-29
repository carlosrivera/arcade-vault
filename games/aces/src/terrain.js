// terrain.js — infinite procedural terrain.
//
// Deterministic simplex noise (no seed storage needed — same lattice every
// session). Terrain streams as a grid of chunk meshes recycled around the
// player. Also provides heightAt(x, z) for collision and AI ground avoidance.

import * as THREE from 'three';

// ---------------------------------------------------------------- noise
// Compact 2D simplex noise (Gustavson-style), seeded permutation.
const NOISE_SEED = 1337;
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
const PERM = makePerm(NOISE_SEED);
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

function simplex2(xin, yin) {
  const F2 = 0.5 * (Math.sqrt(3) - 1),
    G2 = (3 - Math.sqrt(3)) / 6;
  let n0 = 0,
    n1 = 0,
    n2 = 0;
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s),
    j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t),
    y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0,
    j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2,
    y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2,
    y2 = y0 - 1 + 2 * G2;
  const ii = i & 255,
    jj = j & 255;
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

function fbm(x, y, octaves, lacunarity, gain) {
  let amp = 1,
    freq = 1,
    sum = 0,
    norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

const saturate = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, v) => {
  const t = saturate((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Tiling grayscale noise used as a bump map — adds micro relief the mesh
// resolution can't carry (rocks, scree, gully texture).
function makeDetailBumpTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  function hash(x, y) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >>> 13)) >>> 0;
    return ((Math.imul(h, 1274126177) ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vn(x, y, period) {
    let xi = Math.floor(x),
      yi = Math.floor(y);
    const xf = x - xi,
      yf = y - yi;
    const u = xf * xf * (3 - 2 * xf),
      v = yf * yf * (3 - 2 * yf);
    const l = (a, b, t) => a + (b - a) * t;
    const wrap = (c) => ((c % period) + period) % period;
    return l(
      l(hash(wrap(xi), wrap(yi)), hash(wrap(xi + 1), wrap(yi)), u),
      l(hash(wrap(xi), wrap(yi + 1)), hash(wrap(xi + 1), wrap(yi + 1)), u),
      v,
    );
  }
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size;
      let n = 0,
        amp = 0.5,
        f = 4;
      // Integer frequencies + lattice wrap make the texture tile. A non-integer
      // frequency (f *= 2.4 before) leaves a mismatched seam on every repeat,
      // reading as a regular grid of lines in-world.
      for (let o = 0; o < 5; o++) {
        n += amp * vn(u * f, v * f, f);
        amp *= 0.55;
        f *= 2;
      }
      const val = Math.round(Math.max(0, Math.min(1, n)) * 255);
      const i = (y * size + x) * 4;
      img.data[i] = val;
      img.data[i + 1] = val;
      img.data[i + 2] = val;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(120, 120);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

// Height is only half of convincing terrain. This material uses world-space
// triplanar detail, then blends biomes from elevation and slope. The world-space
// projection keeps cliffs crisp without stretched UVs or visible chunk seams.
function makeTerrainMaterial(cloud) {
  const detailMap = makeDetailBumpTexture();
  const shaderState = { debugMode: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.terrainDetail = { value: detailMap };
    shader.uniforms.terrainDebugMode = shaderState.debugMode;
    if (cloud) {
      // Shared uniform objects with the cloud system, so per-frame updates
      // (center follows the player, clock drifts) reach this shader for free.
      shader.uniforms.uCloudShadow = { value: cloud.shadowMap };
      shader.uniforms.uCloudCenter = cloud.shadowUniforms.uCenter;
      shader.uniforms.uCloudRange = cloud.shadowUniforms.uRange;
      mat.defines = { USE_CLOUD_SHADOW: '' };
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorldPosition;
        varying vec3 vTerrainWorldNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTerrainWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D terrainDetail;
        uniform float terrainDebugMode;
        #ifdef USE_CLOUD_SHADOW
        uniform sampler2D uCloudShadow;
        uniform vec2 uCloudCenter;
        uniform float uCloudRange;
        #endif
        varying vec3 vTerrainWorldPosition;
        varying vec3 vTerrainWorldNormal;

        vec3 terrainTriplanar(vec3 p, vec3 n, float scale) {
          vec3 w = pow(abs(n), vec3(5.0));
          w /= max(w.x + w.y + w.z, 0.0001);
          
          // Primary sample
          vec3 sx1 = texture2D(terrainDetail, p.zy * scale).rgb;
          vec3 sy1 = texture2D(terrainDetail, p.xz * scale).rgb;
          vec3 sz1 = texture2D(terrainDetail, p.xy * scale).rgb;
          vec3 s1 = sx1 * w.x + sy1 * w.y + sz1 * w.z;
          
          // Secondary rotated sample to break up tiling (AAA technique)
          mat2 rot = mat2(0.793, -0.609, 0.609, 0.793); // ~37.5 degrees
          float scale2 = scale * 1.618; // Irrational multiplier
          vec3 sx2 = texture2D(terrainDetail, rot * (p.zy * scale2)).rgb;
          vec3 sy2 = texture2D(terrainDetail, rot * (p.xz * scale2)).rgb;
          vec3 sz2 = texture2D(terrainDetail, rot * (p.xy * scale2)).rgb;
          vec3 s2 = sx2 * w.x + sy2 * w.y + sz2 * w.z;
          
          // Blend noise dynamically
          return mix(s1, s2, 0.5) * 1.2;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 terrainN = normalize(vTerrainWorldNormal);
        float terrainH = vTerrainWorldPosition.y;
        float terrainSlope = 1.0 - clamp(terrainN.y, 0.0, 1.0);
        float terrainDistance = distance(cameraPosition, vTerrainWorldPosition);
        float detailFade = 1.0 - smoothstep(3500.0, 14500.0, terrainDistance);
        vec3 macroSample = terrainTriplanar(vTerrainWorldPosition, terrainN, 0.00075);
        vec3 microSample = terrainTriplanar(vTerrainWorldPosition, terrainN, 0.012);
        float macro = macroSample.r - 0.5;
        float grain = (microSample.g - 0.5) * detailFade;

        vec3 sand = vec3(0.18, 0.14, 0.08);
        vec3 scrub = vec3(0.06, 0.09, 0.04);
        vec3 meadow = vec3(0.09, 0.13, 0.05);
        vec3 rock = vec3(0.08, 0.08, 0.08);
        vec3 highRock = vec3(0.12, 0.12, 0.12);
        vec3 snow = vec3(0.85, 0.90, 0.95);

        float shoreWeight = 1.0 - smoothstep(65.0, 210.0, terrainH);
        float meadowWeight = smoothstep(80.0, 420.0, terrainH) *
          (1.0 - smoothstep(1050.0, 1850.0, terrainH));
        float cliffWeight = smoothstep(0.13, 0.58, terrainSlope) *
          smoothstep(90.0, 500.0, terrainH);
        float alpineWeight = smoothstep(900.0, 1900.0, terrainH);
        float snowWeight = smoothstep(1550.0 + macro * 240.0, 2350.0 + macro * 180.0, terrainH) *
          (1.0 - smoothstep(0.28, 0.72, terrainSlope));

        vec3 lowland = mix(scrub, meadow, meadowWeight);
        vec3 terrainColor = mix(lowland, sand, shoreWeight);
        terrainColor = mix(terrainColor, mix(rock, highRock, alpineWeight),
          clamp(cliffWeight + alpineWeight * 0.36, 0.0, 1.0));
        terrainColor = mix(terrainColor, snow, snowWeight);
        terrainColor *= 1.0 + macro * 0.45 + grain * mix(0.3, 0.7, cliffWeight);
        terrainColor *= mix(0.75, 1.15, clamp(terrainN.y, 0.0, 1.0));
        #ifdef USE_CLOUD_SHADOW
        vec2 cloudUv = (vTerrainWorldPosition.xz - uCloudCenter) / uCloudRange + 0.5;
        float cloudShadow = texture2D(uCloudShadow, cloudUv).r;
        terrainColor *= mix(1.0, cloudShadow, 0.8);
        #endif

        if (terrainDebugMode > 0.5 && terrainDebugMode < 1.5) {
          float e = clamp((terrainH + 200.0) / 2900.0, 0.0, 1.0);
          terrainColor = mix(vec3(0.04, 0.15, 0.34), vec3(0.15, 0.62, 0.24), smoothstep(0.05, 0.38, e));
          terrainColor = mix(terrainColor, vec3(0.96, 0.91, 0.82), smoothstep(0.55, 0.95, e));
        } else if (terrainDebugMode > 1.5 && terrainDebugMode < 2.5) {
          terrainColor = mix(vec3(0.08, 0.24, 0.12), vec3(0.95, 0.15, 0.06), smoothstep(0.05, 0.65, terrainSlope));
        } else if (terrainDebugMode > 2.5) {
          terrainColor = vec3(shoreWeight, cliffWeight, snowWeight);
        }
        diffuseColor.rgb *= terrainColor;`,
      );
  };
  mat.customProgramCacheKey = () =>
    cloud ? 'aces-terrain-triplanar-v2-cs' : 'aces-terrain-triplanar-v2';
  mat.userData.shaderState = shaderState;
  return mat;
}

// ---------------------------------------------------------------- height field
// Landform-driven terrain, not uniform noise:
//   continents (very low freq)      -> land vs ocean
//   uplift belt (anisotropic mask)  -> where mountain ranges exist
//   ridged multifractal             -> the relief inside those belts
//   fbm                             -> rolling ground everywhere else
//   drainage (proportional carve)   -> valleys and gorges
//
// Frequencies are written as feature wavelengths in metres so each term's band
// is legible. The mesh samples every 25 m near the player, so wavelengths below
// roughly 80 m only ever show up through normals and the detail map.
const OCEAN_LEVEL = 0;
// Start the opening sortie in a foothill basin facing a major range. These are
// deterministic noise-space offsets, not a handcrafted height override.
const WORLD_OFFSET_X = 48000;
const WORLD_OFFSET_Z = -28000;

// Continental stretch: every feature wavelength is multiplied by this, so the
// same landforms are laid out 8x wider in X/Z while vertical amplitudes are
// untouched. Slopes therefore read 8x gentler -- ranges become long ridges.
const HSCALE = 4;
const WL = (metres) => 1 / (metres * HSCALE);

// Rotating the domain between octaves keeps every octave from sharing the same
// simplex lattice axes, which otherwise shows up as faint directional banding.
const OCT_ROT = Math.PI * 0.37;
const ORC = Math.cos(OCT_ROT),
  ORS = Math.sin(OCT_ROT);

// Ridged multifractal -- the core of the mountain shape. Each octave is masked
// by the one beneath it (crest weighting), so detail concentrates along ridge
// lines instead of spraying uniformly; this is what produces continuous crests
// and spurs rather than isotropic lumps.
//
// An earlier revision divided each octave by the accumulated squared gradient
// as an erosion term. It produced straight, beaded chute lines along the noise
// lattice directions -- unmistakably artificial from the air -- so it is gone;
// crest weighting alone carries the eroded-rock read.
//
// Output is roughly 0..0.8 and is deliberately never clamped by the caller --
// a hard clamp is what flattens summits into plateaus.
function ridgeMultifractal(x, z, octaves, lacunarity, gain, crest) {
  let sum = 0,
    norm = 0,
    amp = 1,
    freq = 1,
    w = 1;
  let px = x,
    pz = z;
  for (let o = 0; o < octaves; o++) {
    const v = simplex2(px * freq, pz * freq);
    let r = 1 - Math.abs(v);
    r *= r;
    sum += amp * r * w;
    w = saturate(r * crest * 2.0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    const nx = px * ORC - pz * ORS;
    pz = px * ORS + pz * ORC;
    px = nx;
  }
  return sum / norm;
}

// fbm with the octave rotation, for rolling ground: same treatment as the
// ridge field so the two blend without a character break.
function rotatedFbm(x, z, octaves, lacunarity, gain) {
  let sum = 0,
    norm = 0,
    amp = 1,
    freq = 1;
  let px = x,
    pz = z;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex2(px * freq, pz * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    const nx = px * ORC - pz * ORS;
    pz = px * ORS + pz * ORC;
    px = nx;
  }
  return sum / norm;
}

// How many octaves of a term can this sample spacing actually carry? An octave
// finer than two samples per wavelength is below Nyquist: including it adds no
// detail, it aliases. At continental cell sizes that aliasing reads as the
// horizon crawling and boiling as the sample grid slides under it, so the far
// levels are band-limited instead. It also makes them much cheaper -- the
// outermost level evaluates one or two octaves where the near field runs ten.
function octavesFor(wavelength, lacunarity, maxOct, cell, minOct = 1) {
  if (cell <= 0) return maxOct;
  let n = 0,
    wl = wavelength;
  while (n < maxOct && wl >= 2 * cell) {
    wl /= lacunarity;
    n++;
  }
  return n < minOct ? minOct : n;
}

// `cell` is the world-space sample spacing of the caller. Zero (the default)
// means full detail, which is what collision and gameplay queries want.
export function heightAt(x, z, cell = 0) {
  const px = x + WORLD_OFFSET_X;
  const pz = z + WORLD_OFFSET_Z;

  // continents -> land vs ocean
  const cont = fbm(px * WL(120000), pz * WL(120000), 3, 2.0, 0.5);
  const land = smoothstep(-0.25, 0.3, cont);

  // A high-frequency warp only. A low-frequency warp of any useful amplitude
  // folds the ridge field over itself and smears it into long wax-like streaks.
  // Always keep one octave: dropping the warp entirely would shift the ridges
  // sideways and put a seam between levels.
  const wOct = octavesFor(9000 * HSCALE, 2.0, 2, cell, 1);
  const w1 = fbm(px * WL(9000) + 11.5, pz * WL(9000) - 2.9, wOct, 2.0, 0.5);
  const w2 = fbm(px * WL(9000) - 8.3, pz * WL(9000) + 4.1, wOct, 2.0, 0.5);

  // Mountain belts. Real ranges are linear, so the anisotropy lives here in the
  // mask rather than in the ridge field -- stretching the mask elongates the
  // range while leaving the crests inside it isotropic and sharp.
  const ux = ((px * 0.94 + pz * 0.34) * WL(80000)) / 2.2;
  const uz = (pz * 0.94 - px * 0.34) * WL(80000) * 2.2;
  const uplift = fbm(ux + 5.2 + w1 * 0.35, uz + 1.3 + w2 * 0.35, 3, 2.0, 0.5);
  const belt = smoothstep(-0.3, 0.38, uplift); // high range core
  const foot = smoothstep(-0.6, 0.02, uplift); // wider skirt -> foothills

  let relief = 0;
  if (foot > 0.001) {
    const rOct = octavesFor(11000 * HSCALE, 2.07, 10, cell, 1);
    const rx = px * WL(11000) + w1 * 0.1;
    const rz = pz * WL(11000) + w2 * 0.1;
    relief = ridgeMultifractal(rx, rz, rOct, 2.07, 0.52, 0.7);
    // monotonic remap: steepens the peak distribution without ever clipping,
    // so summits stay pointed instead of flattening into snowfields
    relief = (relief * 1.45) ** 1.35;
  }

  // rolling ground outside the ranges, down to ~60 m features
  const lOct = octavesFor(6000 * HSCALE, 2.13, 7, cell, 1);
  let lowland = rotatedFbm(px * WL(6000) + 17.0, pz * WL(6000) - 9.0, lOct, 2.13, 0.55) * 450;
  const fOct = octavesFor(900 * HSCALE, 2.1, 4, cell, 0);
  if (fOct > 0) {
    lowland += rotatedFbm(px * WL(900) - 5.0, pz * WL(900) + 3.0, fOct, 2.1, 0.5) * 90;
  }

  // No unmodulated pedestal here: every mountain metre is scaled by relief, so
  // the belt mask cannot show through as a smooth ramp of its own.
  const mtn =
    (belt * 0.75 + foot * 0.25) * (relief * 2600 + relief * relief * 700) + foot * relief * 480;

  let h = -260 + land * 680 + lowland * land * (1 - belt * 0.5) + mtn * land;

  // Drainage, carved as a fraction of the land standing above a floor rather
  // than as a fixed depth. Gorges cut deep where the terrain is high, valleys
  // stay shallow in the lowlands, and nothing is ever cut below the floor -- so
  // a channel can never punch a hole through a ridge or flood the interior.
  const river = Math.abs(fbm(px * WL(26000) - 4.4, pz * WL(26000) + 2.2, 3, 2.0, 0.5));
  const trunk = smoothstep(0.2, 0.0, river);
  const cOct = octavesFor(7000 * HSCALE, 2.1, 3, cell, 1);
  const creek = Math.abs(
    fbm(px * WL(7000) + 2.1 + w1 * 0.4, pz * WL(7000) - 6.3 + w2 * 0.4, cOct, 2.1, 0.5),
  );
  const trib = smoothstep(0.11, 0.0, creek);
  const carve = saturate(trunk * 0.55 + trib * 0.22) * land;
  h -= carve * Math.max(0, h - 55);

  return h;
}

// Fast sampler with memoization grid for collision queries.
//
// Band-limited to the same spacing the finest rendered level uses. Querying
// full detail here instead would let the jet collide with octaves the mesh
// never draws -- up to ~25 m of invisible terrain near ridge crests. Collision
// should agree with what the player can actually see.
const sampleCache = new Map();
function cachedHeight(x, z) {
  const key = `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
  let v = sampleCache.get(key);
  if (v === undefined) {
    v = heightAt(x, z, BASE_CELL / CELL_SEGS[0]);
    if (sampleCache.size > 8000) sampleCache.clear();
    sampleCache.set(key, v);
  }
  return v;
}
export { cachedHeight as terrainHeightAt };

// ---------------------------------------------------------------- chunks
// Continental streaming uses a nested clipmap rather than one uniform grid.
// A single grid cannot span both 25 m detail and hundreds of kilometres: chunk
// count grows with the square of the radius, so reaching 200 km at 2.4 km cells
// would need about 7000 chunks. Here each level doubles its cell size and
// covers a square ring around the finer level nested inside it, so every level
// costs the same fixed number of chunks and the total grows with the LOGARITHM
// of view distance -- 352 chunks reach 205 km.
//
// The levels nest exactly, with neither gaps nor double-drawn overlap, because
// each level snaps its window to an EVEN cell index. That makes a level's outer
// boundary land precisely on a cell boundary of the next level out, so the hole
// punched in the coarser level coincides with the finer level's extent. RING
// must stay even and >= 4 for that alignment argument to hold.
const BASE_CELL = 800; // finest cell
// Segments per cell edge, one entry per level. Near levels tessellate twice as
// finely (12.5 m vertices at level 0) so the ground under the jet reads smooth;
// mid levels got 48 too — they sit right at the DOF focus ring where the eye
// still resolves silhouette detail; the outermost levels stay at 32 since
// their vertices are far below one pixel (and DOF blurs them anyway).
const CELL_SEGS = [64, 64, 48, 48, 32, 32, 32];
const RING = 8; // cells per side per level; even and >= 4
const LEVELS = 7; // 800 m .. 51.2 km cells -> terrain out to ~205 km
const SHADOW_LEVELS = 2; // only the near levels sit inside the sun's frustum
const BUILD_BUDGET_MS = 5; // per-frame slice for staging new chunks

export class Terrain {
  constructor(scene, cloud) {
    this.scene = scene;
    this.chunks = new Map();
    this.mat = makeTerrainMaterial(cloud);
    this.debugMode = 0;

    this.group = new THREE.Group();
    scene.add(this.group);

    this.levels = [];
    for (let L = 0; L < LEVELS; L++) {
      this.levels.push({
        L,
        cell: BASE_CELL * (1 << L),
        step: (BASE_CELL * (1 << L)) / CELL_SEGS[L],
        cast: L < SHADOW_LEVELS,
        chunks: new Map(), // "cx,cz" -> mesh, committed and visible
        staged: new Map(), // built but hidden, waiting for an atomic swap
        free: [],
      });
    }
    // Each level snaps to an even cell index, so its window sits up to one cell
    // off the player. Coverage is therefore guaranteed only to (RING/2 - 1)
    // cells of the outermost level, not RING/2 -- fog has to saturate inside
    // this radius or the terrain would visibly end short in some directions.
    this.viewRadius = (RING / 2 - 1) * BASE_CELL * (1 << (LEVELS - 1));

    // Ocean has to reach past the outermost level, or the far terrain would
    // hang over open space.
    const oceanGeo = new THREE.PlaneGeometry(this.viewRadius * 5, this.viewRadius * 5, 1, 1);
    oceanGeo.rotateX(-Math.PI / 2);
    this.ocean = new THREE.Mesh(
      oceanGeo,
      new THREE.MeshStandardMaterial({
        color: 0x051a2e,
        roughness: 0.1,
        metalness: 0.8,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this.ocean.position.y = OCEAN_LEVEL;
    scene.add(this.ocean);
  }

  // Geometry is built directly rather than from PlaneGeometry so the vertex
  // order matches the sample grid exactly, and so each chunk can carry a skirt:
  // a vertical apron around its rim. Neighbouring levels sample the ridges at
  // half the rate of each other, so their shared edge does not agree to the
  // metre. The skirt hangs below the seam and fills the crack that would
  // otherwise show sky straight through the terrain.
  makeChunkGeometry(cell, seg) {
    const gw = seg + 1,
      step = cell / seg;
    const rim = 4 * seg;
    const vertCount = gw * gw + rim;
    const pos = new Float32Array(vertCount * 3);
    for (let iz = 0; iz <= seg; iz++) {
      for (let ix = 0; ix <= seg; ix++) {
        const i = (iz * gw + ix) * 3;
        pos[i] = ix * step - cell / 2;
        pos[i + 2] = iz * step - cell / 2;
      }
    }
    // Perimeter walk, clockwise seen from above. Ordered so that for every rim
    // edge (edge direction) x (down) points out of the chunk, which is what
    // makes the skirt quads face outward instead of being backface-culled.
    const rimIdx = new Int32Array(rim);
    let k = 0;
    for (let ix = 0; ix < seg; ix++) rimIdx[k++] = ix; // -z edge
    for (let iz = 0; iz < seg; iz++) rimIdx[k++] = iz * gw + seg; // +x edge
    for (let ix = seg; ix > 0; ix--) rimIdx[k++] = seg * gw + ix; // +z edge
    for (let iz = seg; iz > 0; iz--) rimIdx[k++] = iz * gw; // -x edge
    for (let p = 0; p < rim; p++) {
      const g = rimIdx[p] * 3,
        sk = (gw * gw + p) * 3;
      pos[sk] = pos[g];
      pos[sk + 2] = pos[g + 2];
    }

    const idx = [];
    for (let iz = 0; iz < seg; iz++) {
      for (let ix = 0; ix < seg; ix++) {
        const a = ix + gw * iz,
          b = ix + gw * (iz + 1);
        const c = ix + 1 + gw * (iz + 1),
          d = ix + 1 + gw * iz;
        idx.push(a, b, d, b, c, d);
      }
    }
    for (let p = 0; p < rim; p++) {
      const q = (p + 1) % rim;
      idx.push(rimIdx[p], rimIdx[q], gw * gw + p, rimIdx[q], gw * gw + q, gw * gw + p);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3));
    geo.setIndex(idx);
    geo.userData = { gw, rim, rimIdx };
    return geo;
  }

  buildChunk(lv, cx, cz) {
    let mesh = lv.free.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.makeChunkGeometry(lv.cell, CELL_SEGS[lv.L]), this.mat);
      mesh.frustumCulled = true;
      mesh.userData.level = lv.L;
      this.group.add(mesh);
    }
    mesh.castShadow = lv.cast;
    mesh.receiveShadow = true;

    const geo = mesh.geometry;
    const { gw, rim, rimIdx } = geo.userData;
    const seg = CELL_SEGS[lv.L],
      step = lv.step;
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const ox = (cx + 0.5) * lv.cell,
      oz = (cz + 0.5) * lv.cell;

    // Sample once onto a grid carrying a one-cell apron beyond the edge, then
    // take both vertex heights and central-difference normals from it. The
    // apron lets edge vertices difference against real neighbouring terrain, so
    // normals stay continuous across chunks. `step` is passed to heightAt so
    // each level only evaluates the octaves its spacing can actually resolve.
    const pw = seg + 3;
    if (!this.grid || this.grid.length < pw * pw) this.grid = new Float64Array(pw * pw);
    const grid = this.grid;
    const gx0 = ox - lv.cell / 2 - step,
      gz0 = oz - lv.cell / 2 - step;
    for (let gz = 0; gz < pw; gz++) {
      const wz = gz0 + gz * step,
        row = gz * pw;
      for (let gx = 0; gx < pw; gx++) grid[row + gx] = heightAt(gx0 + gx * step, wz, step);
    }

    for (let iz = 0; iz <= seg; iz++) {
      for (let ix = 0; ix <= seg; ix++) {
        const v = (iz * gw + ix) * 3;
        const g = (iz + 1) * pw + (ix + 1);
        pos[v + 1] = grid[g];
        const nx = grid[g - 1] - grid[g + 1];
        const ny = 2 * step;
        const nz = grid[g - pw] - grid[g + pw];
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nor[v] = nx * inv;
        nor[v + 1] = ny * inv;
        nor[v + 2] = nz * inv;
      }
    }
    const drop = step * 3;
    for (let p = 0; p < rim; p++) {
      const g = rimIdx[p] * 3,
        sk = (gw * gw + p) * 3;
      pos[sk + 1] = pos[g + 1] - drop;
      nor[sk] = nor[g];
      nor[sk + 1] = nor[g + 1];
      nor[sk + 2] = nor[g + 2];
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();
    mesh.position.set(ox, 0, oz);
    mesh.visible = true;
    return mesh;
  }

  cycleDebugMode() {
    this.debugMode = (this.debugMode + 1) % 4;
    this.mat.userData.shaderState.debugMode.value = this.debugMode;
    return ['BEAUTY', 'ELEVATION', 'SLOPE', 'BIOME WEIGHTS'][this.debugMode];
  }

  // The target configuration: which cells each level should own. Levels snap to
  // an even cell index, which is what makes a level's boundary land exactly on
  // a cell boundary of the next level out, so the rings nest with neither gap
  // nor overlap. `sig` lets an unchanged plan be detected without comparing sets.
  planFor(playerPos) {
    const H = RING / 2;
    const sets = [];
    let hole = null,
      sig = '';
    for (let L = 0; L < LEVELS; L++) {
      const c = this.levels[L].cell;
      const ci = 2 * Math.round(playerPos.x / (2 * c));
      const cj = 2 * Math.round(playerPos.z / (2 * c));
      sig += `${ci},${cj};`;
      const x0 = ci - H,
        x1 = ci + H,
        z0 = cj - H,
        z1 = cj + H;
      const set = new Set();
      for (let cx = x0; cx < x1; cx++) {
        for (let cz = z0; cz < z1; cz++) {
          if (hole && cx >= hole.x0 && cx < hole.x1 && cz >= hole.z0 && cz < hole.z1) continue;
          set.add(`${cx},${cz}`);
        }
      }
      sets.push(set);
      // x0/x1 are even, so halving lands on exact coarser-cell boundaries
      hole = { x0: x0 / 2, x1: x1 / 2, z0: z0 / 2, z1: z1 / 2 };
    }
    return { sets, sig };
  }

  update(playerPos, immediate = false) {
    const plan = this.planFor(playerPos);
    if (plan.sig !== this.sig) {
      this.sig = plan.sig;
      this.target = plan.sets;
      // release anything already staged that the new plan no longer wants
      for (let L = 0; L < LEVELS; L++) {
        const lv = this.levels[L];
        for (const [key, mesh] of lv.staged) {
          if (!plan.sets[L].has(key)) {
            lv.free.push(mesh);
            lv.staged.delete(key);
          }
        }
      }
      this.pending = [];
      for (let L = 0; L < LEVELS; L++) {
        const lv = this.levels[L];
        for (const key of plan.sets[L]) {
          if (!lv.chunks.has(key) && !lv.staged.has(key)) this.pending.push({ L, key });
        }
      }
      this.pi = 0;
    }

    // New chunks are built HIDDEN. Every level here is a ring, so a chunk that
    // is merely late leaves a hole straight through to the sky -- the old
    // trick of streaming chunks in as they finish does not work. Instead the
    // previous configuration stays whole and on screen until the replacement
    // is complete, then both swap in one step.
    const t0 = performance.now();
    while (this.pi < this.pending.length) {
      if (!immediate && performance.now() - t0 > BUILD_BUDGET_MS) break;
      const job = this.pending[this.pi++];
      const lv = this.levels[job.L];
      const comma = job.key.indexOf(',');
      const mesh = this.buildChunk(lv, +job.key.slice(0, comma), +job.key.slice(comma + 1));
      mesh.visible = false;
      lv.staged.set(job.key, mesh);
    }
    if (this.pending.length && this.pi >= this.pending.length) {
      this.commit();
      this.pending = [];
      this.pi = 0;
    }

    this.ocean.position.x = playerPos.x;
    this.ocean.position.z = playerPos.z;
  }

  commit() {
    for (let L = 0; L < LEVELS; L++) {
      const lv = this.levels[L],
        want = this.target[L];
      for (const [key, mesh] of lv.chunks) {
        if (!want.has(key)) {
          mesh.visible = false;
          lv.free.push(mesh);
          lv.chunks.delete(key);
        }
      }
      for (const [key, mesh] of lv.staged) {
        mesh.visible = true;
        lv.chunks.set(key, mesh);
      }
      lv.staged.clear();
    }
  }
}

// ---------------------------------------------------------------- sky
export function buildSky(scene, renderer) {
  // Radius has to clear the corner of the outermost clipmap level (~290 km),
  // otherwise the sky shell sits in front of the farthest terrain and hides it.
  const skyGeo = new THREE.SphereGeometry(320000, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    // Drawn first as a pure backdrop. It must not depth-test: this is a raw
    // ShaderMaterial, so it does not get three's logarithmic-depth chunks that
    // everything else now uses, and comparing the two depth encodings would let
    // the shell cut in front of distant terrain.
    depthTest: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x2e5fa3) },
      midColor: { value: new THREE.Color(0x87b8e8) },
      botColor: { value: new THREE.Color(0xc8d8e2) },
      sunDir: { value: new THREE.Vector3(0.45, 0.5, -0.6).normalize() },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 topColor, midColor, botColor, sunDir;
      void main() {
        float h = clamp(vDir.y, -1.0, 1.0);
        vec3 col = h > 0.0
          ? mix(midColor, topColor, pow(h, 0.62))
          : mix(midColor, botColor, pow(-h, 0.45));
        float sun = pow(max(dot(normalize(vDir), sunDir), 0.0), 620.0);
        float glow = pow(max(dot(normalize(vDir), sunDir), 0.0), 18.0) * 0.28;
        col += vec3(1.0, 0.94, 0.82) * (sun * 1.6 + glow);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}

// Cloud layer: a few dozen billboard puffs spread at fixed altitude, recycled
// around the player like terrain chunks (cheap volumetric feel).
export function buildClouds(scene) {
  const tex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(250,252,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    return t;
  })();

  const group = new THREE.Group();
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: 0.75,
  });
  const CELL = 9000,
    N = 5,
    PUFFS = 46;
  const rand = mulberry32(4242);
  const cloudData = [];
  for (let i = 0; i < PUFFS; i++) {
    const s = new THREE.Sprite(mat);
    const scale = 900 + rand() * 1800;
    s.scale.set(scale, scale * 0.4, 1);
    group.add(s);
    cloudData.push({
      sprite: s,
      ox: (rand() * 2 - 1) * CELL,
      oz: (rand() * 2 - 1) * CELL,
      y: 2600 + rand() * 1400,
    });
  }
  scene.add(group);

  return {
    update(playerPos) {
      const baseX = Math.round(playerPos.x / CELL) * CELL;
      const baseZ = Math.round(playerPos.z / CELL) * CELL;
      for (const c of cloudData) {
        c.sprite.position.set(baseX + c.ox, c.y, baseZ + c.oz);
      }
    },
  };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
