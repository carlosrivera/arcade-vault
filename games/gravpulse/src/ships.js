import * as THREE from '../../../shared/vendor/three.module.js';
import { fitToShipSpace, loadModel } from './models.js';
import { WALL_LAT } from './track.js';

export const SHIP_SCHEMES = [
  { name: 'YOU', body: '#17e0c8', accent: '#ff2fd6', glass: '#0b2733' },
  { name: 'IXION', body: '#ff7a29', accent: '#ffd23f', glass: '#331608' },
  { name: 'VEGA-2', body: '#8a4dff', accent: '#38ffdc', glass: '#1d1040' },
  { name: 'K-NAUT', body: '#9dff2f', accent: '#00c2ff', glass: '#173309' },
];

// Written by main.js every frame; the player ship reads from here.
export const playerInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  airbrakeL: 0,
  airbrakeR: 0,
};

// Event hooks main.js can fill in (e.g. wall-scrape audio, shield pings).
export const shipEvents = {
  wallHit: null,
  wallScrape: null,
  obstacleHit: null,
  shieldPing: null,
  airbrake: null,
};

// High-speed spark particles for wall scraping & collisions
class SparkSystem {
  constructor(scene) {
    this.maxSparks = 180;
    this.geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.maxSparks * 3);
    this.colors = new Float32Array(this.maxSparks * 3);
    this.velocities = [];
    this.lifes = new Float32Array(this.maxSparks);

    for (let i = 0; i < this.maxSparks; i++) {
      this.lifes[i] = 0;
      this.velocities.push(new THREE.Vector3());
    }

    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const sparkTexCanvas = document.createElement('canvas');
    sparkTexCanvas.width = sparkTexCanvas.height = 32;
    const ctx = sparkTexCanvas.getContext('2d');
    const rad = ctx.createRadialGradient(16, 16, 2, 16, 16, 15);
    rad.addColorStop(0, 'rgba(255,255,255,1)');
    rad.addColorStop(0.4, 'rgba(255,180,60,0.8)');
    rad.addColorStop(1, 'rgba(255,50,0,0)');
    ctx.fillStyle = rad;
    ctx.fillRect(0, 0, 32, 32);
    const sparkTex = new THREE.CanvasTexture(sparkTexCanvas);

    this.mat = new THREE.PointsMaterial({
      size: 1.2,
      map: sparkTex,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(this.geo, this.mat);
    scene.add(this.mesh);
  }

  emit(pos, dir, count = 6, colorHex = '#ffaa33') {
    const col = new THREE.Color(colorHex);
    let spawned = 0;
    for (let i = 0; i < this.maxSparks && spawned < count; i++) {
      if (this.lifes[i] <= 0) {
        this.lifes[i] = 0.25 + Math.random() * 0.35;
        const idx3 = i * 3;
        this.positions[idx3] = pos.x + (Math.random() - 0.5) * 0.6;
        this.positions[idx3 + 1] = pos.y + (Math.random() - 0.5) * 0.4;
        this.positions[idx3 + 2] = pos.z + (Math.random() - 0.5) * 0.6;

        this.colors[idx3] = col.r;
        this.colors[idx3 + 1] = col.g;
        this.colors[idx3 + 2] = col.b;

        const v = this.velocities[i];
        v.copy(dir)
          .multiplyScalar(-0.4 - Math.random() * 0.6)
          .add(
            new THREE.Vector3(
              (Math.random() - 0.5) * 18,
              Math.random() * 12 + 2,
              (Math.random() - 0.5) * 18,
            ),
          );
        spawned++;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  update(dt) {
    let active = false;
    for (let i = 0; i < this.maxSparks; i++) {
      if (this.lifes[i] > 0) {
        this.lifes[i] -= dt;
        active = true;
        const idx3 = i * 3;
        const v = this.velocities[i];
        v.y -= 38 * dt; // gravity on sparks
        this.positions[idx3] += v.x * dt;
        this.positions[idx3 + 1] += v.y * dt;
        this.positions[idx3 + 2] += v.z * dt;

        // fade color
        const alpha = Math.max(0, this.lifes[i] / 0.5);
        this.colors[idx3] *= alpha;
        this.colors[idx3 + 1] *= alpha;
        this.colors[idx3 + 2] *= alpha;
      }
    }
    if (active) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }
}

let globalSparks = null;

// Public spark helper for other modules (weapons, obstacles).
export function sparkBurst(pos, count = 8, colorHex = '#ffaa33') {
  if (globalSparks) globalSparks.emit(pos, new THREE.Vector3(0, 1, 0), count, colorHex);
}

// Fading light-ribbon drawn behind each ship from its twin thrusters.
class ExhaustTrail {
  constructor(scene, colorHex) {
    this.N = 34;
    this.pts = [];
    for (let i = 0; i < this.N; i++) this.pts.push(new THREE.Vector3());
    this.up = new THREE.Vector3(0, 1, 0);
    this.initialized = false;

    this.pos = new Float32Array(this.N * 2 * 3);
    this.alp = new Float32Array(this.N * 2);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alp, 1));
    const idx = [];
    for (let i = 0; i < this.N - 1; i++) {
      const a = i * 2,
        b = a + 1,
        c = a + 2,
        d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(colorHex) }, uOpacity: { value: 0 } },
      vertexShader: `
        attribute float aAlpha;
        varying float vA;
        void main() {
          vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vA;
        void main() {
          gl_FragColor = vec4(uColor * 1.35, vA * uOpacity);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  resetTo(pos) {
    for (const p of this.pts) p.copy(pos);
    this.initialized = true;
    this._write();
  }

  push(pos, up, opacity) {
    if (!this.initialized) {
      for (const p of this.pts) p.copy(pos);
      this.initialized = true;
    }
    for (let i = this.N - 1; i > 0; i--) this.pts[i].copy(this.pts[i - 1]);
    this.pts[0].copy(pos);
    this.up.copy(up);
    this.mat.uniforms.uOpacity.value = opacity;
    this._write();
  }

  _write() {
    for (let i = 0; i < this.N; i++) {
      const w = 0.05 + 0.15 * (1 - i / this.N);
      const p = this.pts[i];
      const o = i * 6;
      this.pos[o] = p.x - this.up.x * w;
      this.pos[o + 1] = p.y - this.up.y * w;
      this.pos[o + 2] = p.z - this.up.z * w;
      this.pos[o + 3] = p.x + this.up.x * w;
      this.pos[o + 4] = p.y + this.up.y * w;
      this.pos[o + 5] = p.z + this.up.z * w;
      const a = (1 - i / this.N) ** 1.6;
      this.alp[i * 2] = a;
      this.alp[i * 2 + 1] = a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

export function createShipMesh(scheme, isPlayer = false) {
  const g = new THREE.Group();

  // Physically-based hull: metallic paint with a clearcoat layer, lit by the
  // night-sky environment map.
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: scheme.body,
    metalness: 0.72,
    roughness: 0.3,
    clearcoat: 1.0,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.1,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: '#0a0c16',
    metalness: 0.66,
    roughness: 0.42,
    envMapIntensity: 0.9,
  });
  const accMat = new THREE.MeshStandardMaterial({
    color: scheme.accent,
    emissive: scheme.accent,
    emissiveIntensity: 0.85,
    metalness: 0.4,
    roughness: 0.35,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: scheme.glass,
    metalness: 0.2,
    roughness: 0.08,
    clearcoat: 1.0,
    envMapIntensity: 1.3,
  });

  // Nose aerodynamic cone
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.64, 2.8, 4), bodyMat);
  nose.geometry.rotateX(Math.PI / 2);
  nose.geometry.rotateZ(Math.PI / 4);
  nose.scale.set(1, 0.55, 1);
  nose.position.z = 2.4;
  g.add(nose);

  // Main chassis hull
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.52, 3.45), bodyMat);
  hull.position.z = -0.18;
  g.add(hull);

  // Tail diffuser
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.36, 1.25), darkMat);
  tail.position.set(0, 0.12, -1.88);
  g.add(tail);

  // Cockpit canopy
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 10), glassMat);
  cockpit.scale.set(0.9, 0.58, 1.75);
  cockpit.position.set(0, 0.35, 0.78);
  g.add(cockpit);

  // Articulated dual airbrake flaps
  let flapL = null;
  let flapR = null;

  // Wings, stabilizer fins, & airbrakes
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.75, 0.09, 1.2), bodyMat);
    wing.position.set(side * 1.68, -0.05, -0.75);
    wing.rotation.z = side * 0.13;
    wing.rotation.y = side * 0.22;
    g.add(wing);

    // Mechanical airbrake flap attached on top of wing
    const flapPivot = new THREE.Group();
    flapPivot.position.set(side * 1.85, 0.04, -0.9);
    flapPivot.rotation.z = side * 0.13;
    flapPivot.rotation.y = side * 0.22;

    const flapMesh = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.55), accMat);
    flapMesh.position.set(0, 0.03, -0.28);
    flapPivot.add(flapMesh);
    g.add(flapPivot);

    if (side === -1) flapL = flapPivot;
    else flapR = flapPivot;

    // Wingtip vertical stabilizer fin
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.98), accMat);
    fin.position.set(side * 2.8, 0.24, -1.05);
    fin.rotation.y = side * 0.22;
    g.add(fin);

    // Engine thruster pod
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.29, 1.05, 8), darkMat);
    pod.geometry.rotateX(Math.PI / 2);
    pod.position.set(side * 0.74, -0.04, -1.72);
    g.add(pod);
  }

  // Twin LED headlights
  const headLightGeo = new THREE.SphereGeometry(0.08, 8, 6);
  const headLightMat = new THREE.MeshBasicMaterial({ color: '#35f0ff' });
  for (const side of [-0.45, 0.45]) {
    const hl = new THREE.Mesh(headLightGeo, headLightMat);
    hl.position.set(side, 0.08, 3.4);
    g.add(hl);
  }

  // Dynamic ground underglow light for player craft
  let underglow = null;
  if (isPlayer) {
    underglow = new THREE.PointLight(new THREE.Color(scheme.body), 1.2, 9);
    underglow.position.set(0, -0.4, 0);
    g.add(underglow);
  }

  // Exhaust discs + dual animated jet flames
  const flames = [];
  for (const side of [-1, 1]) {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 12),
      new THREE.MeshBasicMaterial({ color: scheme.accent }),
    );
    disc.rotation.y = Math.PI;
    disc.position.set(side * 0.74, -0.04, -2.25);
    g.add(disc);

    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 1.7, 8),
      new THREE.MeshBasicMaterial({
        color: scheme.accent,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    flame.geometry.rotateX(-Math.PI / 2);
    flame.position.set(side * 0.74, -0.04, -3.05);
    g.add(flame);
    flames.push(flame);
  }

  // Anti-grav hover halo disks
  const haloTexC = document.createElement('canvas');
  haloTexC.width = haloTexC.height = 64;
  const hg = haloTexC.getContext('2d');
  const grad = hg.createRadialGradient(32, 32, 4, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(53,240,255,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  hg.fillStyle = grad;
  hg.fillRect(0, 0, 64, 64);
  const haloTex = new THREE.CanvasTexture(haloTexC);

  for (const x of [-0.75, 0.75]) {
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 2.8),
      new THREE.MeshBasicMaterial({
        map: haloTex,
        color: scheme.accent,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(x, -0.52, -0.1);
    g.add(halo);
  }

  // Solid hull parts cast real shadows; additive glow bits do not.
  const hullParts = [];
  g.traverse((o) => {
    if (o.isMesh && !(o.material.transparent && o.material.blending === THREE.AdditiveBlending)) {
      o.castShadow = true;
      hullParts.push(o);
    }
  });
  // Kenney CC0 model swap target (see applyShipModels)
  g.userData.hullParts = hullParts;

  return { group: g, flames, flapL, flapR, underglow };
}

// Kenney Space Kit (CC0) ship bodies, fitted into ship space (+Z forward).
// Loading is async: the procedural hull stays visible until the model lands,
// and remains as fallback if the fetch fails.
// Model bodies available for the debug cycle (P). Names double as HUD labels.
export const SHIP_MODEL_FILES = [
  { file: 'craft_racer' },
  { file: 'craft_speederA', yaw: Math.PI },
  { file: 'craft_speederB', yaw: Math.PI },
  { file: 'craft_speederC', yaw: Math.PI },
  { file: 'craft_speederD', yaw: Math.PI },
  { file: 'craft_miner' },
];

// Retheme a Kenney model onto a ship scheme while PRESERVING its own tonal
// pattern: every part keeps its original lightness, only hue/saturation move
// to the pilot's colors. Flat-shaded so the low-poly facets catch light.
function recolorModel(root, scheme) {
  const accentHSL = { h: 0, s: 0, l: 0 };
  new THREE.Color(scheme.accent).getHSL(accentHSL);
  const bodyHSL = { h: 0, s: 0, l: 0 };
  new THREE.Color(scheme.body).getHSL(bodyHSL);

  const mats = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      m.flatShading = true;
      m.metalness = 0.3;
      m.roughness = 0.45;
      m.envMapIntensity = 1.15;
      m.needsUpdate = true;
      if (!mats.has(m)) mats.set(m, m);
    }
  });

  const entries = [...mats.values()].map((m) => {
    const c = m.color ? m.color.clone() : new THREE.Color(0.5, 0.5, 0.5);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    return { m, lum: 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, hsl };
  });
  entries.sort((a, b) => a.lum - b.lum);
  entries.forEach((e, i) => {
    const t = entries.length === 1 ? 0.5 : i / (entries.length - 1);
    const m = e.m;
    if (t < 0.18) {
      // darkest: near-black chassis tinted toward the accent
      m.color.setHSL(accentHSL.h, 0.3, 0.09);
    } else if (t > 0.88 && entries.length > 2) {
      // single brightest part: accent trim with a soft glow
      m.color.set(scheme.accent);
      if ('emissive' in m) {
        m.emissive = new THREE.Color(scheme.accent);
        m.emissiveIntensity = 0.55;
      }
    } else {
      // body panels: pilot's body hue, model's own lightness preserved
      const l = THREE.MathUtils.clamp(0.16 + e.hsl.l * 0.85, 0.16, 0.6);
      m.color.setHSL(bodyHSL.h, Math.max(0.4, bodyHSL.s), l);
      if ('emissive' in m) {
        m.emissive = new THREE.Color(scheme.accent);
        m.emissiveIntensity = 0.1;
      }
    }
  });
}

export function applyShipModelFile(ship, def) {
  const cfg = typeof def === 'string' ? { file: def } : def;
  ship.modelName = cfg.file;
  loadModel(`assets/models/${cfg.file}.glb`)
    .then((loaded) => {
      // IMPORTANT: clone per ship — the loader cache returns the same scene
      // object, and re-parenting it would steal the model from its current ship
      const model = loaded.clone(true);
      if (ship.mesh.userData.modelWrapper) ship.mesh.remove(ship.mesh.userData.modelWrapper);
      recolorModel(model, ship.scheme);
      const wrapper = fitToShipSpace(model, 5.3, cfg.yaw || 0);
      wrapper.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
      ship.mesh.add(wrapper);
      ship.mesh.userData.modelWrapper = wrapper;
      for (const part of ship.mesh.userData.hullParts || []) part.visible = false;
    })
    .catch(() => {
      // offline / missing file: keep whatever hull is present
    });
}

// The three approved bodies (speederA re-used for the 4th slot, recolored
// per scheme so it reads differently).
const RACE_MODEL_FILES = [
  { file: 'craft_speederA', yaw: Math.PI },
  { file: 'craft_speederC', yaw: Math.PI },
  { file: 'craft_speederD', yaw: Math.PI },
  { file: 'craft_speederA', yaw: Math.PI },
];

export function applyShipModels(racers) {
  racers.forEach((r, i) => {
    r.modelIdx = SHIP_MODEL_FILES.findIndex((m) => m.file === RACE_MODEL_FILES[i].file);
    applyShipModelFile(r, RACE_MODEL_FILES[i]);
  });
}

// ---------------------------------------------------------------------------
// Simulation parameters (Balanced to 60% of original high-velocity speed)
// ---------------------------------------------------------------------------
const V_MAX = 204; // top speed u/s (~408 km/h)
const ACCEL = 58;
const BRAKE = 96;
const AIRBRAKE_DRAG = 33;
const DRAG_K = ACCEL / (V_MAX * V_MAX);
const BOOST_ACCEL = 84;
const BOOST_VMAX = 312;
const STEER_LAT = 19.2;
const AIRBRAKE_LAT = 13.2;
const DRIFT_K = 0.15;
const SCRUB_K = 0.52;
const HOVER_H = 1.38;

export class Ship {
  static totalLaps = 3;
  static _q = new THREE.Quaternion();
  static _m = new THREE.Matrix4();
  static _r = new THREE.Vector3();
  static _u = new THREE.Vector3();
  static _fwd = new THREE.Vector3();
  static _trailV = new THREE.Vector3();

  constructor(scene, track, idx, isPlayer) {
    this.track = track;
    this.idx = idx;
    this.isPlayer = isPlayer;
    this.scheme = SHIP_SCHEMES[idx];

    if (!globalSparks) {
      globalSparks = new SparkSystem(scene);
    }

    const built = createShipMesh(this.scheme, isPlayer);
    this.mesh = built.group;
    this.flames = built.flames;
    this.flapL = built.flapL;
    this.flapR = built.flapR;
    this.underglow = built.underglow;
    scene.add(this.mesh);
    this.trail = new ExhaustTrail(scene, this.scheme.accent);

    this.name = this.scheme.name;
    this.s = 0;
    this.lat = 0;
    this.speed = 0;
    this.latVel = 0;
    this.lap = 0;
    this.covered = 0;
    this.prevS = 0;
    this.boostTime = 0;
    this.finished = false;
    this.finishTime = 0;
    this.bestLap = Infinity;
    this._lapStartT = 0;
    this.bobPhase = Math.random() * Math.PI * 2;

    // Suspension & orientation smoothing
    this.suspensionY = 0;
    this.suspensionVel = 0;
    this.rollVis = 0;
    this.pitchVis = 0;

    // Inputs
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.airbrakeL = 0;
    this.airbrakeR = 0;

    this.obstCd = 0;
    this.weapon = null;
    this.shieldTime = 0;
    this.weaponPadCd = 0;
    this.fireCd = 0;

    this.lastFr = {
      pos: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      bank: 0,
    };

    if (!isPlayer) {
      this.baseSpeed = [NaN, 195, 186, 179][idx] ?? 183;
      this.latAmp = 3 + Math.random() * 3.5;
      this.latFreq = 0.14 + Math.random() * 0.12;
      this.phase = Math.random() * 100;
    }
    this.reset(idx);
  }

  reset(gridIdx) {
    const L = this.track.length;
    this.s = (((L - 14 - gridIdx * 8) % L) + L) % L;
    this.lat = gridIdx % 2 === 0 ? -4.5 : 4.5;
    this.speed = 0;
    this.latVel = 0;
    this.lap = 0;
    this.covered = 0;
    this.prevS = this.s;
    this.boostTime = 0;
    this.finished = false;
    this.finishTime = 0;
    this.bestLap = Infinity;
    this._lapStartT = 0;
    this.obstCd = 0;
    this.weapon = null;
    this.shieldTime = 0;
    this.weaponPadCd = 0;
    this.fireCd = 0;
    this.suspensionY = 0;
    this.suspensionVel = 0;
    this.airbrakeL = 0;
    this.airbrakeR = 0;
    this.rollVis = 0;
    this.pitchVis = 0;

    if (this._shieldMesh) this._shieldMesh.visible = false;
    this.track.frameAt(this.s, this.lastFr);
    this.applyTransform(this.lastFr, 0.016);
    if (this.trail) this.trail.resetTo(this.mesh.position);
  }

  boost(power = 2.2) {
    this.boostTime = Math.max(this.boostTime, power);
  }

  hitObstacle(o) {
    if (this.obstCd > 0) return;
    if (this.isPlayer && this.shieldTime > 0) {
      this.obstCd = 0.35;
      shipEvents.shieldPing?.(this);
      sparkBurst(this.mesh.position, 6, '#49b7ff');
      return;
    }
    this.obstCd = 1.1;
    this.speed *= 0.42;
    const side = Math.sign(this.lat - o.lat) || (Math.random() < 0.5 ? -1 : 1);
    this.latVel += side * 14;
    this.lat += side * 0.9;
    this.suspensionVel -= 6.0; // bottom out shock
    sparkBurst(this.mesh.position, 12, '#ff7a3a');
    if (this.isPlayer) shipEvents.obstacleHit?.(this);
  }

  update(dt, raceTime, playerCovered, go = true) {
    if (globalSparks && this.isPlayer) {
      globalSparks.update(dt);
    }

    if (this.finished) {
      this.throttle = 0;
      this.brake = 0.5;
      this.steer *= 0.95;
      this.airbrakeL *= 0.9;
      this.airbrakeR *= 0.9;
    } else if (this.isPlayer) {
      this.throttle = playerInput.throttle;
      this.brake = playerInput.brake;
      this.steer = playerInput.steer;
      this.airbrakeL = playerInput.airbrakeL || 0;
      this.airbrakeR = playerInput.airbrakeR || 0;
    } else {
      this._ai(dt, playerCovered);
    }

    if (!go) {
      this.throttle = 0;
      this.brake = 0;
      this.steer = 0;
      this.airbrakeL = 0;
      this.airbrakeR = 0;
      this.speed = 0;
      this.latVel = 0;
    }

    // ---- Longitudinal Physics ----
    let vExtra = 0;
    let aBoost = 0;
    if (this.boostTime > 0) {
      vExtra = BOOST_VMAX - V_MAX;
      aBoost = BOOST_ACCEL;
      this.boostTime -= dt;
    }

    const totalAirbrake = this.airbrakeL + this.airbrakeR;
    const drag = DRAG_K * this.speed * this.speed;
    const airbrakeDecel = totalAirbrake * AIRBRAKE_DRAG;
    this.speed += (this.throttle * ACCEL + aBoost - drag - airbrakeDecel) * dt;

    if (vExtra && this.speed > V_MAX + vExtra) this.speed = V_MAX + vExtra;
    if (this.brake > 0) this.speed -= BRAKE * dt;
    if (this.speed < 0) this.speed = 0;

    // Sideways sliding scrubs speed
    this.speed -= Math.abs(this.latVel) * SCRUB_K * dt;
    if (!vExtra && this.speed > V_MAX * 1.02) this.speed -= 160 * dt;

    // ---- Lateral Steering & Dual Airbrakes ----
    const grip = Math.min(1, this.speed / 50);
    const airbrakeBite = (this.airbrakeR - this.airbrakeL) * AIRBRAKE_LAT * grip;
    const latTarget = this.steer * STEER_LAT * grip + airbrakeBite;
    this.latVel += (latTarget - this.latVel) * Math.min(1, dt * 8.5);

    // Centrifugal drift in curves
    const iK = Math.floor(this.s / this.track.ds) % this.track.n;
    const drift = this.track.kappaV[iK] * this.speed * this.speed * DRIFT_K;
    this.latVel += drift * dt;
    this.lat += this.latVel * dt;

    // Wall collision & scrape sparks
    if (Math.abs(this.lat) > WALL_LAT) {
      const side = this.lat < 0 ? -1 : 1;
      this.lat = THREE.MathUtils.clamp(this.lat, -WALL_LAT, WALL_LAT);
      this.latVel *= -0.3;

      const sapRate = this.speed > 42 ? 1.4 : 0.3;
      this.speed *= Math.max(0, 1 - sapRate * dt);
      this.track.bumpWall(side);

      // Emit sparks
      if (globalSparks && this.speed > 30) {
        const scrapePos = this.mesh.position.clone().addScaledVector(this.lastFr.right, side * 1.8);
        globalSparks.emit(scrapePos, this.lastFr.tan, 5, this.scheme.accent);
      }

      if (this.isPlayer && this.speed > 24) {
        shipEvents.wallHit?.(this);
      }
    }

    // ---- Hover Suspension Spring Simulation ----
    const springK = 42.0;
    const damping = 7.5;
    const targetY = this.speed > 35 ? Math.sin(this.bobPhase * 1.4) * 0.06 : 0;
    const springForce = -springK * (this.suspensionY - targetY) - damping * this.suspensionVel;
    this.suspensionVel += springForce * dt;
    this.suspensionY += this.suspensionVel * dt;
    this.suspensionY = THREE.MathUtils.clamp(this.suspensionY, -0.6, 0.8);

    // ---- Lap Bookkeeping ----
    this.prevS = this.s;
    this.obstCd = Math.max(0, this.obstCd - dt);
    this.s += this.speed * dt;

    if (this.s >= this.track.length) {
      this.s -= this.track.length;
      if (this.lap >= 1) {
        const lapT = raceTime - this._lapStartT;
        if (lapT < this.bestLap) this.bestLap = lapT;
      }
      this._lapStartT = raceTime;
      this.lap += 1;
      if (this.lap > Ship.totalLaps) {
        this.finished = true;
        this.finishTime = raceTime;
      }
    }

    let d = this.s - this.prevS;
    if (d < -this.track.length / 2) d += this.track.length;
    this.covered += d;

    // ---- Transform & Animation ----
    const fr = this.lastFr;
    this.track.frameAt(this.s, fr);
    this.bobPhase += dt * 3.2;
    this.applyTransform(fr, dt);
    // exhaust light-ribbon: record the thruster world position every frame
    const trailOp =
      Math.min(1, Math.max(0, (this.speed - 100) / 170)) * 0.6 + (this.boostTime > 0 ? 0.3 : 0);
    Ship._trailV.set(0, -0.05, -2.9);
    this.mesh.localToWorld(Ship._trailV);
    this.trail.push(Ship._trailV, fr.up, Math.min(1, trailOp));
    return fr;
  }

  _ai(dt, playerCovered) {
    void dt;
    const trk = this.track;
    const curvAhead = trk.curvatureAhead(this.s + this.speed * 0.55, 90);
    const cornerFactor = 1 / (1 + curvAhead * 32);
    let target = this.baseSpeed * cornerFactor;

    if (playerCovered - this.covered > 150) target *= 1.07;
    else if (this.covered - playerCovered > 150) target *= 0.94;

    this.throttle = this.speed < target ? 1 : 0.15;
    this.brake = 0;

    // AI airbrake into heavy curves
    if (curvAhead > 0.018 && this.speed > 132) {
      const iK = Math.floor(this.s / trk.ds) % trk.n;
      const bendDir = Math.sign(trk.kappaV[iK] || 0);
      if (bendDir < 0) {
        this.airbrakeL = 0.85;
        this.airbrakeR = 0;
      } else if (bendDir > 0) {
        this.airbrakeR = 0.85;
        this.airbrakeL = 0;
      }
    } else {
      this.airbrakeL = 0;
      this.airbrakeR = 0;
    }

    const t = performance.now() / 1000;
    const iK = Math.floor(this.s / trk.ds) % trk.n;
    const bend = -(trk.kappaV[iK] || 0) * 900;
    let desiredLat = Math.sin(t * this.latFreq * 2 * Math.PI + this.phase) * this.latAmp + bend;

    for (const o of trk.obstacles) {
      const ds = o.s - this.s;
      if (ds > 5 && ds < 85 && Math.abs(desiredLat - o.lat) < 5) {
        desiredLat += (desiredLat >= o.lat ? 1 : -1) * 6.5;
        break;
      }
    }
    desiredLat = THREE.MathUtils.clamp(desiredLat, -WALL_LAT + 1.5, WALL_LAT - 1.5);
    const drift = (trk.kappaV[iK] || 0) * this.speed * this.speed * DRIFT_K;
    this.steer = THREE.MathUtils.clamp((desiredLat - this.lat) * 0.2 - drift / STEER_LAT, -1, 1);
  }

  applyTransform(fr, dt) {
    const bob = Math.sin(this.bobPhase) * 0.08;
    this.mesh.position
      .copy(fr.pos)
      .addScaledVector(fr.right, this.lat)
      .addScaledVector(fr.up, HOVER_H + this.suspensionY + bob);

    // Dynamic Banking & Roll with Airbrake influence
    const airbrakeRoll = (this.airbrakeR - this.airbrakeL) * 0.25;
    const lean = THREE.MathUtils.clamp(this.latVel * 0.016, -0.3, 0.3);
    const targetRoll = fr.bank * 0.9 + lean + airbrakeRoll;
    this.rollVis += (targetRoll - this.rollVis) * Math.min(1, Math.max(dt, 0.0001) * 11);

    // Longitudinal Pitch Inertia (Nose dips on acceleration, pitches up on hard braking)
    const targetPitch =
      this.throttle * -0.06 + this.brake * 0.12 + (this.airbrakeL + this.airbrakeR) * 0.08;
    this.pitchVis += (targetPitch - this.pitchVis) * Math.min(1, Math.max(dt, 0.0001) * 9);

    // Build rotation matrix from banked vectors
    Ship._q.setFromAxisAngle(fr.tan, this.rollVis);
    Ship._u.copy(fr.up).applyQuaternion(Ship._q);
    Ship._r.copy(Ship._u).cross(fr.tan).normalize();
    Ship._fwd.copy(fr.tan);

    // Apply pitch around right vector
    if (Math.abs(this.pitchVis) > 0.001) {
      const pitchQ = new THREE.Quaternion().setFromAxisAngle(Ship._r, this.pitchVis);
      Ship._u.applyQuaternion(pitchQ);
      Ship._fwd.applyQuaternion(pitchQ);
    }

    Ship._m.makeBasis(Ship._r, Ship._u, Ship._fwd);
    this.mesh.quaternion.setFromRotationMatrix(Ship._m);

    // Articulate mechanical airbrake flaps
    if (this.flapL) {
      this.flapL.rotation.x = this.airbrakeL * 0.72;
    }
    if (this.flapR) {
      this.flapR.rotation.x = this.airbrakeR * 0.72;
    }

    // Dynamic thruster plumes
    const thr = this.throttle * 0.7 + (this.boostTime > 0 ? 1.5 : 0) + Math.random() * 0.18;
    for (const f of this.flames) {
      f.scale.set(1, Math.max(0.12, thr * (this.speed > 5 ? 1 : 0.25)), 1);
    }
  }
}

function wrapTrackDist(d, L) {
  if (d > L / 2) d -= L;
  else if (d < -L / 2) d += L;
  return d;
}

export function resolveShipCollisions(racers, onBump) {
  const L = racers[0].track.length;
  const LONG = 3.4;
  const LATW = 2.1;
  for (let i = 0; i < racers.length; i++) {
    for (let j = i + 1; j < racers.length; j++) {
      const a = racers[i];
      const b = racers[j];
      const ds = wrapTrackDist(b.s - a.s, L);
      const dlat = b.lat - a.lat;
      if (Math.abs(ds) >= LONG || Math.abs(dlat) >= LATW) continue;

      const aProtected = a.isPlayer && a.shieldTime > 0;
      const bProtected = b.isPlayer && b.shieldTime > 0;

      const overlapLat = LATW - Math.abs(dlat);
      const overlapS = LONG - Math.abs(ds);
      const mid = a.mesh.position.clone().add(b.mesh.position).multiplyScalar(0.5);
      let strength = 0;

      if (overlapLat < overlapS) {
        const dir = dlat >= 0 ? 1 : -1;
        const aShare = aProtected ? 0 : bProtected ? 1 : 0.5;
        const push = overlapLat + 0.08;
        a.lat -= dir * push * aShare;
        b.lat += dir * push * (1 - aShare);
        const rel = (b.latVel - a.latVel) * dir;
        if (rel < 0) {
          const jImp = -rel * 0.6;
          if (aProtected) {
            b.latVel += dir * jImp * 2;
          } else if (bProtected) {
            a.latVel -= dir * jImp * 2;
          } else {
            a.latVel -= dir * jImp;
            b.latVel += dir * jImp;
          }
          strength = Math.min(1, -rel / 12);
        } else {
          strength = 0.15;
        }
      } else {
        const dir = ds >= 0 ? 1 : -1;
        const front = dir > 0 ? b : a;
        const rear = dir > 0 ? a : b;
        const frontProtected = front.isPlayer && front.shieldTime > 0;
        const rearProtected = rear.isPlayer && rear.shieldTime > 0;

        const push = overlapS * 0.5 + 0.05;
        if (frontProtected) {
          rear.s = (((rear.s - dir * push * 1.5) % L) + L) % L;
          rear.speed = Math.max(30, rear.speed * 0.85);
          rear.suspensionVel -= 3.0;
        } else if (rearProtected) {
          front.s = (((front.s + dir * push * 1.5) % L) + L) % L;
          front.speed += 18;
          front.suspensionVel -= 2.0;
        } else {
          front.s = (((front.s + dir * push * 0.5) % L) + L) % L;
          rear.s = (((rear.s - dir * push * 0.5) % L) + L) % L;
          const gain = Math.min(18, Math.max(0, (rear.speed - front.speed) * 0.25 + 6));
          front.speed += gain;
          rear.speed = Math.max(30, rear.speed * 0.93);
        }

        const side = dlat === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dlat);
        if (aProtected) {
          b.latVel += side * 8;
        } else if (bProtected) {
          a.latVel -= side * 8;
        } else {
          a.latVel -= side * 5;
          b.latVel += side * 5;
        }
        strength = 0.5;
      }

      if (globalSparks && strength > 0.15) {
        globalSparks.emit(mid, a.lastFr.tan, 8, '#ffffff');
      }

      if (strength > 0.12 && onBump) onBump(mid, strength, a, b);
    }
  }
}
