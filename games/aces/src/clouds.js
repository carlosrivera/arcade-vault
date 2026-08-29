// clouds.js — Modern Volumetric Raymarched Atmospheric Cloud System
// 3D Worley/Perlin-Worley density field with real-time raymarching,
// dual-lobe Henyey-Greenstein phase scattering, Beer's law light marching,
// powder effect, and cumulus height profiling.

import * as THREE from 'three';

// ---------------------------------------------------------------- 2D puff fallback for trails
export function puffTexture(hardCore = false) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px / size - 0.5) * 2.0;
      const v = (py / size - 0.5) * 2.0;
      const r2 = u * u + v * v;
      if (r2 >= 1.0) continue;
      const falloff = Math.exp(-r2 * 3.2) * (1.0 - r2);
      const i = (py * size + px) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 252;
      img.data[i + 2] = 250;
      img.data[i + 3] = Math.round(Math.min(1.0, falloff * 1.5) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------- 3D Periodic Noise Texture
// Seeded so the JS-side density twin (cloudDensityAt) sees the SAME field as
// the GPU texture — used for the inside-cloud lens wetness detection.
const NOISE_SEED = 0xc10d5;
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let _grids = null;
function getWorleyGrids() {
  if (_grids) return _grids;
  const rnd = mulberry32(NOISE_SEED);
  const makeWorleyGrid = (numCells) => {
    const grid = [];
    for (let z = 0; z < numCells; z++) {
      for (let y = 0; y < numCells; y++) {
        for (let x = 0; x < numCells; x++) {
          grid.push([
            (x + 0.15 + 0.7 * rnd()) / numCells,
            (y + 0.15 + 0.7 * rnd()) / numCells,
            (z + 0.15 + 0.7 * rnd()) / numCells,
          ]);
        }
      }
    }
    return { numCells, grid };
  };
  _grids = {
    w4: makeWorleyGrid(8),
    w8: makeWorleyGrid(18),
    w16: makeWorleyGrid(32),
    w32: makeWorleyGrid(48),
  };
  return _grids;
}

function create3DNoiseTexture() {
  const S = 96; // 96^3 volume — doubled so the tile period can grow 3x without coarsening the puffs
  const data = new Uint8Array(S * S * S * 4);
  const { w4, w8, w16, w32 } = getWorleyGrids();

  function sampleWorley(gx, gy, gz, w) {
    const nc = w.numCells;
    const cx = Math.floor(gx * nc);
    const cy = Math.floor(gy * nc);
    const cz = Math.floor(gz * nc);
    let minDist = 999.0;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = (cx + dx + nc) % nc;
          const ny = (cy + dy + nc) % nc;
          const nz = (cz + dz + nc) % nc;
          const pt = w.grid[nz * nc * nc + ny * nc + nx];

          let ddx = gx - pt[0];
          if (ddx > 0.5) ddx -= 1;
          else if (ddx < -0.5) ddx += 1;
          let ddy = gy - pt[1];
          if (ddy > 0.5) ddy -= 1;
          else if (ddy < -0.5) ddy += 1;
          let ddz = gz - pt[2];
          if (ddz > 0.5) ddz -= 1;
          else if (ddz < -0.5) ddz += 1;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 < minDist) minDist = d2;
        }
      }
    }
    return 1.0 - Math.min(1.0, Math.sqrt(minDist) * nc * 0.9);
  }

  let idx = 0;
  for (let z = 0; z < S; z++) {
    const fz = z / S;
    for (let y = 0; y < S; y++) {
      const fy = y / S;
      for (let x = 0; x < S; x++) {
        const fx = x / S;
        const v1 = sampleWorley(fx, fy, fz, w4);
        const v2 = sampleWorley(fx, fy, fz, w8);
        const v3 = sampleWorley(fx, fy, fz, w16);
        const v4 = sampleWorley(fx, fy, fz, w32);
        const baseFbm = v1 * 0.588 + v2 * 0.235 + v3 * 0.118 + v4 * 0.059;
        data[idx++] = Math.round(baseFbm * 255); // R: Base cumulus billow shape
        data[idx++] = Math.round(v2 * 255); // G: Mid-frequency erosion
        data[idx++] = Math.round(v3 * 255); // B: High-frequency fluff
        data[idx++] = Math.round((v2 * 0.6 + v3 * 0.4) * 255); // A: Micro detail
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- Modern Volumetric Cloud System
export const CloudShader = {
  uniforms: {
    tDiffuse: { value: null },
    uNoiseTex: { value: null },
    uCameraPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0.45, 0.5, -0.6).normalize() },
    uTime: { value: 0 },
    uHBottom: { value: 2200.0 },
    uHTop: { value: 5400.0 },
    uProjInverse: { value: new THREE.Matrix4() },
    uViewInverse: { value: new THREE.Matrix4() },
    logDepthBufFC: { value: 2.0 / Math.log2(400000.0 + 1.0) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    precision highp sampler3D;

    // GLSL3: three.js does not inject gl_FragColor for explicit-GLSL3 materials
    layout(location = 0) out vec4 fragColor;

    uniform sampler2D tDiffuse;
    uniform sampler3D uNoiseTex;
    
    uniform vec3 uCameraPos;
    uniform vec3 uSunDir;
    uniform float uTime;
    uniform float uHBottom;
    uniform float uHTop;
    
    uniform mat4 uProjInverse;
    uniform mat4 uViewInverse;

    #ifdef USE_LOGDEPTHBUF
      uniform float logDepthBufFC;
    #endif

    varying vec2 vUv;

    // Henyey-Greenstein phase function
    float hg(float cosAngle, float g) {
      float g2 = g * g;
      return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
    }

    float heightGradient(float h) {
      float baseFade = smoothstep(0.0, 0.12, h);
      float topFade = smoothstep(1.0, 0.65, h);
      return baseFade * topFade * pow(h, 0.22);
    }


    // Regional weather mask: low-frequency 2D noise over XZ (tens of km
    // per cell) — some regions build a dense deck, others are cloud-free.
    // Drifts with the same wind as the density field so shadows stay synced.
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash2(i), b = hash2(i + vec2(1.0, 0.0));
      float c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float weather(vec2 xz) {
      vec2 q = (xz + vec2(uTime * 18.0, uTime * 12.0)) * (1.0 / 64000.0);
      float n = vnoise2(q) * 0.55 + vnoise2(q * 2.3 + 7.7) * 0.30 + vnoise2(q * 5.1 + 3.3) * 0.15;
      return n;
    }
    float weatherMod(vec2 xz, float d) {
      float w = weather(xz);
      d *= 0.15 + 1.55 * w;             // dense regions thicken
      d *= smoothstep(0.16, 0.42, w);   // low-weather regions go cloud-free
      return d;
    }

    float sampleDensity(vec3 p) {
      float h = (p.y - uHBottom) / (uHTop - uHBottom);
      if (h < 0.0 || h > 1.0) return 0.0;

      float hGrad = heightGradient(h);
      if (hGrad < 0.001) return 0.0;

      vec3 uvw = (p + vec3(uTime * 18.0, 0.0, uTime * 12.0)) * 0.00005;
      vec4 n = texture(uNoiseTex, uvw);

      float base = max(0.0, (n.r - 0.44) / 0.56);
      if (base <= 0.0) return 0.0;

      float erosion = (1.0 - n.g) * 0.30 + (1.0 - n.b) * 0.42;
      float d = max(0.0, base - erosion) * hGrad * 1.35;
      return weatherMod(p.xz, d);
    }

    bool intersectSlab(vec3 ro, vec3 rd, out float tMin, out float tMax) {
      if (abs(rd.y) < 1e-6) {
        if (ro.y < uHBottom || ro.y > uHTop) return false;
        tMin = 0.0;
        tMax = 50000.0;
        return true;
      }
      float t0 = (uHBottom - ro.y) / rd.y;
      float t1 = (uHTop - ro.y) / rd.y;
      tMin = max(0.0, min(t0, t1));
      tMax = max(t0, t1);

      if (tMax <= 0.0 || tMin >= tMax) return false;
      tMax = min(tMax, 60000.0);
      return true;
    }

    void main() {
      vec4 sceneColor = texture2D(tDiffuse, vUv);
      
      vec2 ndc = vUv * 2.0 - 1.0;
      vec4 target = uProjInverse * vec4(ndc, 1.0, 1.0);
      vec3 viewDir = target.xyz / target.w;
      vec3 rayDir = normalize((uViewInverse * vec4(viewDir, 0.0)).xyz);
      vec3 rayOrigin = uCameraPos;

      // Rays always march the full slab. Sampling the composer's depth texture
      // here would allow mountain occlusion of clouds, but depth-texture reads
      // proved driver-fragile (zeroed on some stacks, which clipped every ray
      // to nothing and silently disabled the whole system) — revisit with a
      // dedicated depth prepass if occlusion matters.
      const float maxRayLen = 100000.0;

      float tStart, tEnd;
      if (!intersectSlab(rayOrigin, rayDir, tStart, tEnd)) {
        fragColor = sceneColor;
        return;
      }

      // Clip ray to scene geometry! This flawlessly handles mountains without depth hacks.
      tEnd = min(tEnd, maxRayLen);
      float rayLen = tEnd - tStart;
      
      if (rayLen <= 0.0) {
        fragColor = sceneColor;
        return;
      }

      const int NUM_STEPS = 40;
      float stepSize = rayLen / float(NUM_STEPS);
      stepSize = min(stepSize, 700.0);

      float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      float t = tStart + stepSize * dither;

      vec3 sunDir = normalize(uSunDir);
      float cosTheta = dot(rayDir, sunDir);
      float phase = 0.72 * hg(cosTheta, 0.75) + 0.28 * hg(cosTheta, -0.22);

      vec3 colAcc = vec3(0.0);
      float transAcc = 1.0;

      for (int i = 0; i < NUM_STEPS; i++) {
        if (t >= tEnd || transAcc < 0.015) break;

        vec3 p = rayOrigin + rayDir * t;
        float density = sampleDensity(p);

        if (density > 0.001) {
          vec3 lightPos = p + sunDir * 380.0;
          float sunDensity = sampleDensity(lightPos) + sampleDensity(p + sunDir * 900.0) * 0.5;
          float sunTrans = exp(-sunDensity * 0.65);
          float powder = 1.0 - exp(-density * 3.5);

          float h = (p.y - uHBottom) / (uHTop - uHBottom);
          vec3 ambientCol = mix(vec3(0.55, 0.68, 0.82), vec3(0.92, 0.96, 1.0), h);

          vec3 sunCol = vec3(1.0, 0.96, 0.90) * (sunTrans * phase * powder * 2.4 + 0.12);
          vec3 stepLight = sunCol + ambientCol * 0.45;
          // Wispy edges read gray, dense cores stay bright — gives the puffs
          // internal mottling instead of uniform white fog.
          stepLight *= mix(0.55, 1.0, smoothstep(0.05, 0.28, density));

          float deltaTau = density * stepSize * 0.0016;
          float stepTrans = exp(-deltaTau);

          colAcc += stepLight * transAcc * (1.0 - stepTrans);
          transAcc *= stepTrans;
        }
        t += stepSize;
      }

      float alpha = 1.0 - transAcc;
      if (alpha < 0.01) {
        fragColor = sceneColor;
        return;
      }

      float distHaze = smoothstep(60000.0, 15000.0, tStart);
      alpha *= distHaze;

      fragColor = vec4(mix(sceneColor.rgb, colAcc / max(0.0001, alpha), alpha), 1.0);
    }
  `,
};

// JS twin of the GLSL density field (seeded grids above make them agree) —
// one sample per frame at the camera position drives the lens-wetness effect.
export function cloudDensityAt(px, py, pz, time) {
  const { w4, w8, w16, w32 } = getWorleyGrids();
  const S = 96;
  const sampleWorley = (gx, gy, gz, w) => {
    const nc = w.numCells;
    const cx = Math.floor(gx * nc),
      cy = Math.floor(gy * nc),
      cz = Math.floor(gz * nc);
    let minDist = 999.0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          // JS % keeps the sign — fold twice for GLSL-mod semantics
          const mz = (((cz + dz) % nc) + nc) % nc,
            my = (((cy + dy) % nc) + nc) % nc,
            mx = (((cx + dx) % nc) + nc) % nc;
          const pt = w.grid[mz * nc * nc + my * nc + mx];
          let ddx = gx - pt[0];
          if (ddx > 0.5) ddx -= 1;
          else if (ddx < -0.5) ddx += 1;
          let ddy = gy - pt[1];
          if (ddy > 0.5) ddy -= 1;
          else if (ddy < -0.5) ddy += 1;
          let ddz = gz - pt[2];
          if (ddz > 0.5) ddz -= 1;
          else if (ddz < -0.5) ddz += 1;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 < minDist) minDist = d2;
        }
    return 1.0 - Math.min(1.0, Math.sqrt(minDist) * nc * 0.9);
  };
  const uvw = [(px + time * 18.0) * 0.00005, py * 0.00005, (pz + time * 12.0) * 0.00005];
  const n = [
    sampleWorley(uvw[0], uvw[1], uvw[2], w4) * 0.588 +
      sampleWorley(uvw[0], uvw[1], uvw[2], w8) * 0.235 +
      sampleWorley(uvw[0], uvw[1], uvw[2], w16) * 0.118 +
      sampleWorley(uvw[0], uvw[1], uvw[2], w32) * 0.059,
    sampleWorley(uvw[0], uvw[1], uvw[2], w8),
    sampleWorley(uvw[0], uvw[1], uvw[2], w16),
  ];
  const h = (py - 2200.0) / (5400.0 - 2200.0);
  if (h < 0.0 || h > 1.0) return 0.0;
  const hGrad =
    Math.min(1, Math.max(0, (h - 0.0) / 0.12)) ** 1 *
    (1 - Math.min(1, Math.max(0, (h - 0.65) / 0.35))) *
    Math.pow(h, 0.22);
  if (hGrad < 0.001) return 0.0;
  let base = Math.max(0.0, (n[0] - 0.44) / 0.56);
  if (base <= 0.0) return 0.0;
  const erosion = (1 - n[1]) * 0.3 + (1 - n[2]) * 0.42;
  let d = Math.max(0.0, base - erosion) * hGrad * 1.35;
  // weather mask — same hash/vnoise the GLSL uses
  const hash2 = (x, y) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const vnoise2 = (qx, qy) => {
    const i = [Math.floor(qx), Math.floor(qy)],
      f = [qx - i[0], qy - i[1]];
    const u = [f[0] * f[0] * (3 - 2 * f[0]), f[1] * f[1] * (3 - 2 * f[1])];
    const a = hash2(i[0], i[1]),
      b = hash2(i[0] + 1, i[1]);
    const c = hash2(i[0], i[1] + 1),
      dd = hash2(i[0] + 1, i[1] + 1);
    return a + (b - a) * u[0] + (c + (dd - c) * u[0] - (a + (b - a) * u[0])) * u[1];
  };
  const qx = (px + time * 18.0) / 64000.0,
    qz = (pz + time * 12.0) / 64000.0;
  const w =
    vnoise2(qx, qz) * 0.55 +
    vnoise2(qx * 2.3 + 7.7, qz * 2.3 + 7.7) * 0.3 +
    vnoise2(qx * 5.1 + 3.3, qz * 5.1 + 3.3) * 0.15;
  d *= 0.15 + 1.55 * w;
  d *= Math.min(1, Math.max(0, (w - 0.16) / 0.26));
  return d; // raw density; temporal smoothing happens on the caller side
}

// Lens water: droplets refract the frame and a faint veil fogs the view,
// faded in by uWet (driven by cloudDensityAt at the camera).
export const DropletShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uWet: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uWet;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // One grid layer of lens drops. Drops slide RADIALLY AWAY from the screen
    // centre (aerodynamic flow off the canopy), fading in/out as they go.
    // xyz = refraction offset, w = drop mask
    vec4 dropLayer(vec2 uv, float scale, float t, float speed, float appear, float sizeMul) {
      vec4 acc = vec4(0.0);
      vec2 g = uv * scale;
      vec2 id = floor(g);
      vec2 f = fract(g) - vec2(0.5);
      float h = hash(id);
      if (h < appear) {
        float phase = fract(t * speed + h * 917.0);
        float vis = smoothstep(0.0, 0.15, phase) * smoothstep(1.0, 0.82, phase);
        // radial flow direction: away from screen centre, in cell space
        vec2 cellC = (id + 0.5) / scale - 0.5;
        vec2 flow = length(cellC) > 1e-4 ? normalize(cellC) : vec2(0.0, -1.0);
        vec2 pos = vec2((hash(id + 1.7) - 0.5) * 0.5, (hash(id + 3.1) - 0.5) * 0.5)
                 + flow * (phase * 1.40 - 0.55);
        vec2 rel = f - pos;
        rel.y *= 1.1;
        float d = length(rel);
        float r = (0.11 + h * 0.13) * sizeMul;
        float edge = smoothstep(r, r * 0.55, d) * vis;
        if (edge > 0.001) {
          vec2 dir = rel / max(d, 1e-4);
          float rim = sin(min(d / r, 1.0) * 3.14159);
          vec2 off = dir * rim * 0.55 - rel * 1.6;      // rim bend + magnify
          acc = vec4(off * edge, edge, edge);
        }
      }
      return acc;
    }

    // faint smear a sliding drop leaves along its radial path
    float streak(vec2 uv, float scale, float t, float speed, float appear) {
      vec2 g = uv * scale;
      vec2 id = floor(g);
      vec2 f = fract(g) - vec2(0.5);
      float h = hash(id + 11.3);
      if (h < appear) {
        float phase = fract(t * speed + h * 917.0);
        float vis = smoothstep(0.0, 0.2, phase) * smoothstep(1.0, 0.7, phase);
        vec2 cellC = (id + 0.5) / scale - 0.5;
        vec2 flow = length(cellC) > 1e-4 ? normalize(cellC) : vec2(0.0, -1.0);
        vec2 pos = vec2((hash(id + 1.7) - 0.5) * 0.5, (hash(id + 3.1) - 0.5) * 0.5)
                 + flow * (phase * 1.40 - 0.55);
        vec2 rel = f - pos;
        float along = dot(rel, -flow);            // distance behind the drop
        float perp = length(rel + flow * along);  // sideways from the path
        float m = smoothstep(0.045, 0.0, perp) * smoothstep(0.55, 0.05, along) * step(0.0, along);
        return m * vis * 0.6;
      }
      return 0.0;
    }

    void main() {
      vec2 uv = vUv;
      float wet = uWet;

      vec4 big = dropLayer(uv, 13.0, uTime, 0.10, mix(0.20, 0.75, wet), 1.15);
      vec4 small = dropLayer(uv + vec2(0.41, 0.23), 34.0, uTime * 1.45, 0.16, mix(0.15, 0.85, wet), 0.8);
      float trails = streak(uv + vec2(0.41, 0.23), 34.0, uTime * 1.45, 0.16, mix(0.05, 0.5, wet * wet));

      vec2 off = (big.xy * 0.060 + small.xy * 0.020) * wet;
      vec3 col = texture2D(tDiffuse, uv + off).rgb;

      // glass tint + rim shadow + glint: the drop must read on any backdrop
      float mask = clamp(big.z + small.z, 0.0, 1.0);
      col = mix(col, col * 0.80 + 0.03, mask * 0.70 * wet);
      col -= (big.z + small.z) * 0.14 * wet;
      col += (big.z + small.z) * 0.18 * wet;

      // runners leave a faint wet smear
      col = mix(col, col * 0.92 + 0.04, trails * wet);

      // wet-glass veil
      float grey = dot(col, vec3(0.333));
      col = mix(col, vec3(grey) * 1.06 + 0.035, wet * 0.35);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// Top-down cloud shadow map: for each texel (a world-space column), march the
// sun ray through the slab and store transmittance. The terrain shader looks
// this up by world XZ so the ground darkens under the deck. Rendered into a
// small 2D RT (2D textures sample fine in the terrain's GLSL1 shader — the 3D
// noise texture itself never leaves GLSL3 land).
const SHADOW_RANGE = 30000; // metres covered by the shadow map (per side)
const SHADOW_SIZE = 256;

export function buildCloudSystem(renderer) {
  const noiseTex = create3DNoiseTexture();
  const uTime = { value: 0 };

  const cloudMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      ...CloudShader.uniforms,
      uTime,
      uNoiseTex: { value: noiseTex },
    },
    vertexShader: CloudShader.vertexShader,
    fragmentShader: CloudShader.fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });

  // ---- cloud shadow map -------------------------------------------------
  const uCenter = { value: new THREE.Vector2() };
  const shadowMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uNoiseTex: { value: noiseTex },
      uTime,
      uCenter,
      uSunDir: CloudShader.uniforms.uSunDir,
      uHBottom: CloudShader.uniforms.uHBottom,
      uHTop: CloudShader.uniforms.uHTop,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler3D;
      layout(location = 0) out vec4 fragColor;

      uniform sampler3D uNoiseTex;
      uniform float uTime;
      uniform vec2 uCenter;
      uniform vec3 uSunDir;
      uniform float uHBottom;
      uniform float uHTop;
      varying vec2 vUv;


    // Regional weather mask: low-frequency 2D noise over XZ (tens of km
    // per cell) — some regions build a dense deck, others are cloud-free.
    // Drifts with the same wind as the density field so shadows stay synced.
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash2(i), b = hash2(i + vec2(1.0, 0.0));
      float c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float weather(vec2 xz) {
      vec2 q = (xz + vec2(uTime * 18.0, uTime * 12.0)) * (1.0 / 64000.0);
      float n = vnoise2(q) * 0.55 + vnoise2(q * 2.3 + 7.7) * 0.30 + vnoise2(q * 5.1 + 3.3) * 0.15;
      return n;
    }
    float weatherMod(vec2 xz, float d) {
      float w = weather(xz);
      d *= 0.15 + 1.55 * w;             // dense regions thicken
      d *= smoothstep(0.16, 0.42, w);   // low-weather regions go cloud-free
      return d;
    }

      float shadowDensity(vec3 p) {
        float h = (p.y - uHBottom) / (uHTop - uHBottom);
        if (h < 0.0 || h > 1.0) return 0.0;
        float hGrad = smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.65, h) * pow(h, 0.22);
        if (hGrad < 0.001) return 0.0;
        vec3 uvw = (p + vec3(uTime * 18.0, 0.0, uTime * 12.0)) * 0.00005;
        vec4 n = texture(uNoiseTex, uvw);
        float base = max(0.0, (n.r - 0.44) / 0.56);
        if (base <= 0.0) return 0.0;
        float erosion = (1.0 - n.g) * 0.30 + (1.0 - n.b) * 0.42;
        float d = max(0.0, base - erosion) * hGrad * 1.35;
        return weatherMod(p.xz, d);
      }

      void main() {
        vec2 xz = uCenter + (vUv - 0.5) * float(${SHADOW_RANGE});
        vec3 ro = vec3(xz.x, 0.0, xz.y);
        vec3 rd = normalize(uSunDir);
        float t0 = (uHBottom - ro.y) / rd.y;
        float t1 = (uHTop - ro.y) / rd.y;
        const int NS = 6;
        float stepLen = (t1 - t0) / float(NS);
        float dens = 0.0;
        for (int i = 0; i < NS; i++) {
          dens += shadowDensity(ro + rd * (t0 + (float(i) + 0.5) * stepLen));
        }
        float trans = exp(-dens * stepLen * 0.0028);
        // fade to unshadowed at the rim so the clamp never shows a hard edge
        float r = length(vUv - 0.5) * 2.0;
        float fade = 1.0 - smoothstep(0.75, 0.98, r);
        fragColor = vec4(mix(1.0, trans, fade), 1.0, 1.0, 1.0);
      }`,
  });

  const shadowRT = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE);
  const shadowScene = new THREE.Scene();
  shadowScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shadowMat));
  const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // lens water: wetness eases toward the cloud density at the camera
  const dropletMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uTime,
      uWet: { value: 0 },
    },
    vertexShader: DropletShader.vertexShader,
    fragmentShader: DropletShader.fragmentShader,
  });

  return {
    shader: cloudMat,
    dropletShader: dropletMat,
    shadowMap: shadowRT.texture,
    shadowRT,
    shadowUniforms: { uCenter, uRange: { value: SHADOW_RANGE } },
    update(renderer, camera, dt = 0) {
      uTime.value += dt;
      cloudMat.uniforms.uCameraPos.value.copy(camera.position);
      cloudMat.uniforms.uProjInverse.value.copy(camera.projectionMatrixInverse);
      cloudMat.uniforms.uViewInverse.value.copy(camera.matrixWorld);
      cloudMat.uniforms.logDepthBufFC.value = 2.0 / Math.log2(camera.far + 1.0);

      uCenter.value.set(camera.position.x, camera.position.z);
      const prevRT = renderer.getRenderTarget();
      renderer.setRenderTarget(shadowRT);
      renderer.render(shadowScene, shadowCam);
      renderer.setRenderTarget(prevRT);

      // Density is sparse — the visible deck is a ray-accumulation effect —
      // so "am I inside cloud" is measured as optical depth through the slab
      // along the sun direction, mirroring the shadow map march (a few
      // neighbouring columns, averaged).
      const cx = camera.position.x,
        cy = camera.position.y,
        cz = camera.position.z;
      const t = uTime.value;
      const sd = CloudShader.uniforms.uSunDir.value;
      // Only the slab segment within ~1200 m of the camera counts — otherwise
      // flying a safe margin ABOVE a dense deck still wets the lens.
      const t0 = Math.max(2200 / sd.y, (cy - 1200) / sd.y);
      const t1 = Math.min(5400 / sd.y, (cy + 1200) / sd.y);
      let od = 0;
      if (t1 > t0) {
        const len = (t1 - t0) / 6;
        for (const [ox, oz] of [
          [0, 0],
          [600, 600],
          [-600, -600],
        ]) {
          let sum = 0;
          for (let i = 0; i < 6; i++) {
            const tt = t0 + (i + 0.5) * len;
            sum += cloudDensityAt(cx + ox + sd.x * tt, sd.y * tt, cz + oz + sd.z * tt, t);
          }
          od += sum * len * 0.0028;
        }
        od /= 3;
      }
      const target = Math.min(1, Math.max(0, (od - 0.04) / 0.1));
      const uWet = dropletMat.uniforms.uWet;
      uWet.value += (target - uWet.value) * Math.min(1, dt * 2.5);
    },
  };
}
