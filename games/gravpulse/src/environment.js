import * as THREE from '../../../shared/vendor/three.module.js';
import { fitToShipSpace, loadModel } from './models.js';
import { TRACK_CONFIGS } from './track.js';

let skyUniforms = null;
let starSkyUniforms = null;

// Track clearance: sampled centerlines of ALL tracks (they have very
// different footprints), so city/scenery placement never intersects any of
// them regardless of which track is selected.
let trackClearance = null;
function ensureTrackClearance() {
  if (trackClearance) return trackClearance;
  trackClearance = TRACK_CONFIGS.map((cfg) => {
    const curve = new THREE.CatmullRomCurve3(cfg.generatePoints(), true, 'centripetal', 0.5);
    return curve.getSpacedPoints(200);
  });
  return trackClearance;
}

function clearOfTracks(x, z, clearance = 130) {
  const tracks = ensureTrackClearance();
  for (const pts of tracks) {
    for (const p of pts) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < clearance * clearance) return false;
    }
  }
  return true;
}



// Builds a small procedural night-sky scene and bakes it into a PMREM
// environment map, giving every PBR material believable neon-blue ambient
// reflections without any external HDR assets.
function buildEnvironmentLighting(renderer, scene) {
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      cTop: { value: new THREE.Color('#060a1c') },
      cMid: { value: new THREE.Color('#101838') },
      cHor: { value: new THREE.Color('#2a2050') },
      cGround: { value: new THREE.Color('#05050c') },
      cCity: { value: new THREE.Color('#1a1440') },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cHor;
      uniform vec3 cGround; uniform vec3 cCity;
      void main() {
        vec3 dir = normalize(vPos);
        float h = dir.y;
        vec3 col = mix(cMid, cTop, smoothstep(0.05, 0.6, h));
        col = mix(cHor, col, smoothstep(0.0, 0.1, h));
        col = mix(col, cGround, smoothstep(0.0, -0.25, h));
        // dim smudges of city glow around the horizon
        float city = smoothstep(0.12, 0.0, abs(h + 0.02)) * (0.5 + 0.5 * sin(dir.x * 40.0) * sin(dir.z * 31.0));
        col += cCity * city * 0.5;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  envScene.add(new THREE.Mesh(geo, mat));

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  scene.environment = envTex;
}

// High-Fidelity Cyberpunk Cosmic Atmosphere, Starfield, Cityscape & Lighting
export function buildEnvironment(scene, renderer) {
  const group = new THREE.Group();
  scene.add(group);

  // Image-based lighting from the procedural night sky + reduced analytic lights
  buildEnvironmentLighting(renderer, scene);

  // Atmospheric Cyber Lighting
  scene.add(new THREE.HemisphereLight('#2e4b85', '#080514', 0.45));
  const dir = new THREE.DirectionalLight('#c8e2ff', 1.3);
  dir.position.set(-420, 520, 260);
  scene.add(dir);
  scene.add(new THREE.AmbientLight('#1a1c38', 0.55));

  // Seamless Full-Sphere Cosmic Atmosphere & Horizon Sky Shader (No Cutoff / No Black Seams)
  {
    skyUniforms = {
      uTime: { value: 0 },
      cTop: { value: new THREE.Color('#010208') },
      cMid: { value: new THREE.Color('#080b26') },
      cBot: { value: new THREE.Color('#151b4d') },
      cGround: { value: new THREE.Color('#040614') },
      cNebulaA: { value: new THREE.Color('#00e5ff') },
      cNebulaB: { value: new THREE.Color('#4635e8') },
    };

    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: skyUniforms,
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vPos;
        uniform float uTime;
        uniform vec3 cTop;
        uniform vec3 cMid;
        uniform vec3 cBot;
        uniform vec3 cGround;
        uniform vec3 cNebulaA;
        uniform vec3 cNebulaB;

        // 3D Simplex-like noise helper
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
        vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

        float snoise(vec3 v) {
          const vec2 C = vec2(1.0/6.0, 1.0/3.0);
          const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
          vec3 i  = floor(v + dot(v, C.yyy));
          vec3 x0 = v - i + dot(i, C.xxx);
          vec3 g = step(x0.yzx, x0.xyz);
          vec3 l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy);
          vec3 i2 = max(g.xyz, l.zxy);
          vec3 x1 = x0 - i1 + C.xxx;
          vec3 x2 = x0 - i2 + C.yyy;
          vec3 x3 = x0 - D.yyy;
          i = mod289(i);
          vec4 p = permute(permute(permute(
                    i.z + vec4(0.0, i1.z, i2.z, 1.0))
                  + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                  + i.x + vec4(0.0, i1.x, i2.x, 1.0));
          float n_ = 0.142857142857;
          vec3  ns = n_ * D.wyz - D.xzx;
          vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
          vec4 x_ = floor(j * ns.z);
          vec4 y_ = floor(j - 7.0 * x_);
          vec4 x = x_ *ns.x + ns.yyyy;
          vec4 y = y_ *ns.x + ns.yyyy;
          vec4 h = 1.0 - abs(x) - abs(y);
          vec4 b0 = vec4(x.xy, y.xy);
          vec4 b1 = vec4(x.zw, y.zw);
          vec4 s0 = floor(b0)*2.0 + 1.0;
          vec4 s1 = floor(b1)*2.0 + 1.0;
          vec4 sh = -step(h, vec4(0.0));
          vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
          vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
          vec3 p0 = vec3(a0.xy, h.x);
          vec3 p1 = vec3(a0.zw, h.y);
          vec3 p2 = vec3(a1.xy, h.z);
          vec3 p3 = vec3(a1.zw, h.w);
          vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
          p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
          vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
          m = m * m;
          return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
        }

        // Fractional Brownian Motion for subtle cosmic stardust
        float fbm(vec3 p) {
          float val = 0.0;
          float amp = 0.5;
          for (int i = 0; i < 3; i++) {
            val += amp * snoise(p);
            p = p * 2.1 + vec3(1.2, 3.4, 5.6);
            amp *= 0.5;
          }
          return val;
        }

        void main() {
          vec3 dir = normalize(vPos);
          float h = dir.y;

          vec3 baseColor;
          if (h >= 0.0) {
            // Upper Hemisphere: Pristine Cosmic Deep Space Gradient
            baseColor = mix(cBot, cMid, smoothstep(0.0, 0.28, h));
            baseColor = mix(baseColor, cTop, smoothstep(0.28, 0.75, h));
          } else {
            // Lower Hemisphere: Seamless Horizon Blend into Deep Cyber Abyss
            baseColor = mix(cBot, cGround, smoothstep(0.0, -0.45, h));
          }

          // Crisp, Elegant Horizon Twilight Atmosphere Belt
          float horizonGlow = exp(-abs(h) * 12.0) * 0.28;
          baseColor += cNebulaB * horizonGlow;

          // Very subtle, ethereal celestial stardust shimmer in deep space
          if (h > 0.08) {
            vec3 p = dir * 2.0 + vec3(uTime * 0.005, uTime * 0.003, uTime * -0.006);
            float dust = smoothstep(0.45, 0.85, fbm(p)) * 0.12 * smoothstep(0.08, 0.55, h);
            baseColor += cNebulaA * dust;
          }

          // Subtle Dithering to eliminate color banding
          float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * (1.0 / 255.0);
          baseColor += dither;

          gl_FragColor = vec4(baseColor, 1.0);
        }
      `,
    });

    const sky = new THREE.Mesh(new THREE.SphereGeometry(4400, 64, 48), skyMat);
    sky.renderOrder = -10;
    scene.add(sky);
  }

  // Fog matching the ground and horizon twilight seamlessly
  scene.background = new THREE.Color('#040614');
  scene.fog = new THREE.FogExp2('#040614', 0.00088);

  // Dense Multi-Temperature Cel-Shaded Starfield
  {
    const n = 2400;
    const posArr = new Float32Array(n * 3);
    const colArr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 0.94);
      const r = 3600;
      posArr[i * 3] = r * Math.sin(ph) * Math.cos(th);
      posArr[i * 3 + 1] = r * Math.cos(ph) * 0.85 + 110;
      posArr[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);

      // Pure crisp white stars
      colArr[i * 3] = 1.0;
      colArr[i * 3 + 1] = 1.0;
      colArr[i * 3 + 2] = 1.0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));

    const starUniforms = { uTime: { value: 0 } };
    starSkyUniforms = starUniforms;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: starUniforms,
      vertexShader: `
        attribute vec3 color;
        varying vec3 vColor;
        varying float vTwinkle;
        uniform float uTime;

        void main() {
          vColor = color;
          vTwinkle = sin(position.x * 0.04 + position.y * 0.04 + uTime * 2.6) * 0.35 + 0.65;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (28.0 + sin(position.z * 0.05 + uTime * 3.0) * 8.0) * (260.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vTwinkle;

        void main() {
          vec2 coord = gl_PointCoord - vec2(0.5);
          float d = length(coord);
          if (d > 0.5) discard;

          // Smooth circular Gaussian core
          float core = smoothstep(0.5, 0.04, d);

          // 4-Point Anime Celestial Cross-Diffraction Spikes
          float spikeH = max(0.0, 1.0 - abs(coord.y) * 14.0) * max(0.0, 1.0 - abs(coord.x) * 2.4);
          float spikeV = max(0.0, 1.0 - abs(coord.x) * 14.0) * max(0.0, 1.0 - abs(coord.y) * 2.4);
          float animeFlare = (spikeH + spikeV) * 0.75;

          float intensity = (core + animeFlare) * vTwinkle;
          gl_FragColor = vec4(vColor * 1.6, intensity);
        }
      `,
    });
    scene.add(new THREE.Points(geo, mat));
  }

  // Ground: dark wet-asphalt plane catching sky/neon reflections, with a
  // faint grid ghost for the game's identity. (The old bright Tron grids are
  // gone — they clashed with the real-model city.)
  {
    // subtle ripple normal map from a noise height field
    const hc = document.createElement('canvas');
    hc.width = hc.height = 256;
    const hctx = hc.getContext('2d');
    hctx.fillStyle = '#808080';
    hctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) {
      const v = 100 + ((Math.random() * 56) | 0);
      hctx.fillStyle = `rgb(${v},${v},${v})`;
      hctx.fillRect((Math.random() * 256) | 0, (Math.random() * 256) | 0, 2, 1);
    }
    const hw = 256, hh = 256;
    const src = hctx.getImageData(0, 0, hw, hh).data;
    const nc = document.createElement('canvas');
    nc.width = nc.height = 256;
    const nctx = nc.getContext('2d');
    const img = nctx.createImageData(hw, hh);
    const at = (x, y) => src[(((y + hh) % hh) * hw + ((x + hw) % hw)) * 4] / 255;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const dx = (at(x - 1, y) - at(x + 1, y)) * 1.6;
        const dy = (at(x, y - 1) - at(x, y + 1)) * 1.6;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const o = (y * hw + x) * 4;
        img.data[o] = (dx * inv * 0.5 + 0.5) * 255;
        img.data[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
        img.data[o + 2] = inv * 255;
        img.data[o + 3] = 255;
      }
    }
    nctx.putImageData(img, 0, 0);
    const ripple = new THREE.CanvasTexture(nc);
    ripple.wrapS = ripple.wrapT = THREE.RepeatWrapping;
    ripple.repeat.set(140, 140);

    const groundMat = new THREE.MeshStandardMaterial({
      color: '#05070d',
      roughness: 0.32,
      metalness: 0.7,
      normalMap: ripple,
      normalScale: new THREE.Vector2(0.5, 0.5),
      envMapIntensity: 0.55,
    });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(4200, 48), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -160.5;
    scene.add(ground);

    // identity ghost: the old grid at a whisper of its former brightness
    const ghost = new THREE.GridHelper(8400, 84, '#1a3a5c', '#0d1f38');
    ghost.position.y = -159.5;
    ghost.material.transparent = true;
    ghost.material.opacity = 0.12;
    scene.add(ghost);
  }

  // Real-model night city: Kenney City Kit Commercial buildings (CC0),
  // scattered with track clearance. Cyberpunk layer = procedural neon signs.
  // Procedural-canvas skyline removed — see git history.
  {
    const CITY_FILES = [];
    for (const s of 'abcdefgijklmn') CITY_FILES.push(`building-${s}`);
    for (let k = 0; k < 5; k++) CITY_FILES.push(`building-skyscraper-${'abcde'[k]}`);

    // neon sign textures: one canvas per text, vertical or horizontal
    const SIGN_TEXTS = [
      'NEO-KOTO', 'SYNTH', 'RAMEN 24H', ' deltaX', 'PULSE', 'OVERDRIVE',
      'NØVA', 'CYBERIA', 'OSAKA-9', 'VOLT', 'GHOST', 'ZEN-5', 'AXIOM', 'KURO',
    ];
    const makeSign = (text, color) => {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#05060c';
      g.fillRect(0, 0, 512, 128);
      g.font = 'bold 72px "SF Mono", Menlo, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.shadowColor = color;
      g.shadowBlur = 22;
      g.fillStyle = color;
      g.fillText(text, 256, 68);
      g.shadowBlur = 8;
      g.fillStyle = '#ffffff';
      g.globalAlpha = 0.85;
      g.fillText(text, 256, 68);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const SIGN_COLORS = ['#35f0ff', '#ff2fd6', '#ffb02e', '#7dff5a'];

    const base = -160;
    const cityGroup = new THREE.Group();
    scene.add(cityGroup);

    let placed = 0;
    const perModel = 5;
    const signMatCache = [];
    for (let f = 0; f < CITY_FILES.length && placed < 74; f++) {
      const file = CITY_FILES[f];
      loadModel(`assets/models/city/${file}.glb`)
        .then((model) => {
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          for (let n = 0; n < perModel; n++) {
            const inst = model.clone(true);
            const ang = Math.random() * Math.PI * 2;
            let x = 0, z = 0;
            const isSkyR = file.includes('skyscraper');
            for (let attempt = 0; attempt < 14; attempt++) {
              const rad = (isSkyR ? 1150 : 900) + Math.random() * (isSkyR ? 1000 : 850) + attempt * 45;
              x = Math.cos(ang) * rad;
              z = Math.sin(ang) * rad;
              if (clearOfTracks(x, z, 150)) break;
            }
            if (!clearOfTracks(x, z, 150)) continue;
            // source models are ~1-4 units tall — scale by TARGET height
            const isSky = file.includes('skyscraper');
            const targetH = isSky ? 240 + Math.random() * 200 : 90 + Math.random() * 110;
            const s = targetH / Math.max(size.y, 0.001);
            inst.scale.setScalar(s);
            inst.rotation.y = Math.random() * Math.PI * 2;
            inst.position.set(x, base, z);
            inst.traverse((o) => {
              if (o.isMesh) {
                if (o.material) {
                  o.material = o.material.clone();
                  o.material.envMapIntensity = 0.5;
                }
                o.castShadow = false;
              }
            });
            cityGroup.add(inst);

            // neon sign hung near the roofline, facing outward-ish
            if (Math.random() < 0.7) {
              const text = SIGN_TEXTS[(Math.random() * SIGN_TEXTS.length) | 0];
              const color = SIGN_COLORS[(Math.random() * SIGN_COLORS.length) | 0];
              let mat = signMatCache.find((m) => m.text === text && m.color === color);
              if (!mat) {
                mat = { text, color, m: new THREE.MeshBasicMaterial({ map: makeSign(text, color), transparent: true, side: THREE.DoubleSide, depthWrite: false }) };
                signMatCache.push(mat);
              }
              const sign = new THREE.Mesh(new THREE.PlaneGeometry(size.x * s * 0.85, (size.x * s * 0.85) / 4), mat.m);
              sign.position.set(x, base + size.y * s * 0.82, z);
              sign.rotation.y = -ang + Math.PI / 2 + (Math.random() - 0.5) * 0.6;
              cityGroup.add(sign);
            }
            placed++;
          }
        })
        .catch(() => {
          // offline: city just doesn't populate
        });
    }
  }

  // Architectural Night-City Skyline: 4 tower archetypes + a low-rise inner
  // ring, geometry merged per archetype (one draw call each), with blinking
  // rooftop beacons. Windows: only a minority are lit (see facade generator).

  // Giant Celestial Cyber Moon with Multi-Ring Corona
  {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 30, 128, 128, 126);
    grad.addColorStop(0, 'rgba(235,248,255,1)');
    grad.addColorStop(0.28, 'rgba(100,210,255,0.75)');
    grad.addColorStop(0.65, 'rgba(85,120,255,0.32)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);

    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        fog: false,
        depthWrite: false,
      }),
    );
    spr.scale.setScalar(900);
    spr.position.set(-1600, 980, -2100);
    scene.add(spr);

  }

  // Flying traffic: real Kenney craft (CC0) on orbit lanes, engine glow
  // sprites instead of the old colored boxes. Loaded async; no traffic if
  // the models can't be fetched.
  {
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 32;
    const gc = glowCanvas.getContext('2d');
    const grad = gc.createRadialGradient(16, 16, 1, 16, 16, 15);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.35, 'rgba(90,220,255,0.6)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    gc.fillStyle = grad;
    gc.fillRect(0, 0, 32, 32);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    trafficVehicles = [];
    const TRAFFIC_FILES = ['craft_speederB', 'craft_miner', 'craft_speederB'];
    Promise.all(TRAFFIC_FILES.map((f) => loadModel(`assets/models/${f}.glb`)))
      .then((models) => {
        const count = 42;
        for (let i = 0; i < count; i++) {
          const proto = models[i % models.length];
          // normalize nose to +Z (Kenney craft face various directions raw)
          const inst = fitToShipSpace(proto.clone(true), 6 + Math.random() * 4);
          // engine glow: cyan trailing, red leading nav dot
          const tailGlow = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: glowTex,
              color: '#35f0ff',
              transparent: true,
              opacity: 0.9,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          tailGlow.scale.setScalar(3.2);
          tailGlow.position.set(0, 0.2, -2.2);
          inst.add(tailGlow);
          group.add(inst);
          trafficVehicles.push({
            mesh: inst,
            rad: 700 + Math.random() * 1250,
            speed: (0.04 + Math.random() * 0.08) * (i % 2 === 0 ? 1 : -1),
            alt: 25 + Math.random() * 190,
            angle: (i / count) * Math.PI * 2 + Math.random() * 0.2,
          });
        }
      })
      .catch(() => {
        // offline: no sky traffic
      });
  }

  // Reusable PMREM-safe cleanup note: envTex lives on scene.environment.
  return { dirLight: dir };
}

// CC0 Kenney scenery props: ground clutter in the city ring + floating
// meteors near the track for parallax. Fire-and-forget; silently skips
// itself if the models can't be fetched.
const SCENERY_MODELS = [
  { file: 'satelliteDish_detailed', count: 5, scaleMin: 10, scaleMax: 20 },
  { file: 'hangar_roundA', count: 4, scaleMin: 24, scaleMax: 44 },
  { file: 'machine_generatorLarge', count: 6, scaleMin: 10, scaleMax: 20 },
  { file: 'meteor_detailed', count: 9, scaleMin: 5, scaleMax: 14, floating: true },
  { file: 'rock_largeA', count: 8, scaleMin: 14, scaleMax: 34 },
  { file: 'gate_complex', count: 3, scaleMin: 22, scaleMax: 40 },
];

export function loadSceneryModels(scene) {
  for (const def of SCENERY_MODELS) {
    loadModel(`assets/models/${def.file}.glb`)
      .then((model) => {
        for (let i = 0; i < def.count; i++) {
          const inst = model.clone(true);
          const ang = Math.random() * Math.PI * 2;
          let x = 0, z = 0;
          for (let attempt = 0; attempt < 12; attempt++) {
            const rad = 700 + Math.random() * 1200 + attempt * 40;
            x = Math.cos(ang) * rad;
            z = Math.sin(ang) * rad;
            if (clearOfTracks(x, z, 130)) break;
          }
          const s = def.scaleMin + Math.random() * (def.scaleMax - def.scaleMin);
          inst.scale.setScalar(s);
          inst.rotation.y = Math.random() * Math.PI * 2;
          const y = def.floating ? 30 + Math.random() * 190 : -160;
          inst.position.set(x, y, z);
          scene.add(inst);
        }
      })
      .catch(() => {
        // offline: procedural skyline alone is fine
      });
  }
}

let trafficVehicles = null;

export function updateEnvironment(dt) {
  if (skyUniforms) {
    skyUniforms.uTime.value += dt;
  }
  if (starSkyUniforms) {
    starSkyUniforms.uTime.value += dt;
  }
  if (trafficVehicles) {
    for (const v of trafficVehicles) {
      v.angle += v.speed * dt;
      v.mesh.position.set(Math.cos(v.angle) * v.rad, v.alt, Math.sin(v.angle) * v.rad);
      // nose (+Z) along the orbit tangent
      v.mesh.rotation.y = -v.angle + (v.speed > 0 ? 0 : Math.PI);
    }
  }
}
