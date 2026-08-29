// main.js — SKY STRIKE (2D Dogfights with 3D Cel-Shaded Graphics)
import * as THREE from 'three';
import { AudioKernel } from '#engine/audio.js';
import { createFeel } from '#engine/feel.js';
import { Keyboard } from '#engine/input.js';
import { clamp, damp } from '#engine/math.js';
import { PRNG } from '#engine/rng.js';

// --- Procedural 3-tone Toon Gradient Map ---
function createToonGradient() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#445566';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = '#88aacc';
  ctx.fillRect(1, 0, 2, 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(3, 0, 1, 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

// --- Cel-Shaded Materials & Outlines ---
function makeToonMat(colorHex, gradientMap) {
  return new THREE.MeshToonMaterial({
    color: colorHex,
    gradientMap,
  });
}

function addOutline(mesh, scale = 1.1) {
  const outlineMat = new THREE.MeshBasicMaterial({
    color: 0x0a1220,
    side: THREE.BackSide,
  });
  const outlineMesh = new THREE.Mesh(mesh.geometry, outlineMat);
  outlineMesh.scale.set(scale, scale, scale);
  mesh.add(outlineMesh);
  return outlineMesh;
}

// --- 3D Jet Construction ---
function createFighterMesh(primaryColor, canopyColor, gradientMap) {
  const group = new THREE.Group();
  group.rotation.order = 'ZYX';

  // Fuselage
  const bodyGeo = new THREE.ConeGeometry(0.7, 3.2, 6);
  bodyGeo.rotateZ(-Math.PI / 2);
  const bodyMat = makeToonMat(primaryColor, gradientMap);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  addOutline(body, 1.12);
  group.add(body);

  // Wings (Swept delta wings)
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.5, 0);
  wingShape.lineTo(-1.0, 2.4);
  wingShape.lineTo(-1.4, 2.2);
  wingShape.lineTo(-0.8, 0);
  wingShape.lineTo(-1.4, -2.2);
  wingShape.lineTo(-1.0, -2.4);
  wingShape.closePath();

  const extrudeSettings = { depth: 0.08, bevelEnabled: false };
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, extrudeSettings);
  wingGeo.rotateX(Math.PI / 2);
  wingGeo.center();
  const wing = new THREE.Mesh(wingGeo, bodyMat);
  wing.position.set(-0.2, 0, 0);
  addOutline(wing, 1.12);
  group.add(wing);

  // Twin Vertical Stabilizers (Canted fins)
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(-0.7, 0.9);
  finShape.lineTo(-1.0, 0.9);
  finShape.lineTo(-0.8, 0);
  finShape.closePath();

  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.05, bevelEnabled: false });
  finGeo.center();

  const fin1 = new THREE.Mesh(finGeo, bodyMat);
  fin1.position.set(-0.9, 0.5, 0.4);
  fin1.rotation.x = 0.25;
  addOutline(fin1, 1.15);
  group.add(fin1);

  const fin2 = new THREE.Mesh(finGeo, bodyMat);
  fin2.position.set(-0.9, 0.5, -0.4);
  fin2.rotation.x = -0.25;
  addOutline(fin2, 1.15);
  group.add(fin2);

  // Glass Canopy
  const canopyGeo = new THREE.SphereGeometry(0.4, 8, 6);
  canopyGeo.scale(1.8, 0.7, 0.7);
  const canopyMat = makeToonMat(canopyColor, gradientMap);
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.set(0.2, 0.35, 0);
  addOutline(canopy, 1.15);
  group.add(canopy);

  // Afterburner Nozzle & Flame
  const flameGeo = new THREE.ConeGeometry(0.35, 1.4, 6);
  flameGeo.rotateZ(Math.PI / 2);
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0xffa020,
    transparent: true,
    opacity: 0.85,
  });
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.position.set(-2.0, 0, 0);
  flame.visible = false;
  group.add(flame);

  // Muzzle Flash Sprite on Nose
  const muzzleCanvas = document.createElement('canvas');
  muzzleCanvas.width = 32;
  muzzleCanvas.height = 32;
  const mctx = muzzleCanvas.getContext('2d');
  mctx.fillStyle = '#ffffff';
  mctx.beginPath();
  mctx.arc(16, 16, 12, 0, Math.PI * 2);
  mctx.fill();
  mctx.fillStyle = '#22ffbb';
  mctx.beginPath();
  mctx.arc(16, 16, 7, 0, Math.PI * 2);
  mctx.fill();
  const muzzleTex = new THREE.CanvasTexture(muzzleCanvas);
  const muzzleMat = new THREE.SpriteMaterial({
    map: muzzleTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  const muzzleSprite = new THREE.Sprite(muzzleMat);
  muzzleSprite.position.set(1.8, 0, 0);
  muzzleSprite.scale.set(1.6, 1.6, 1);
  muzzleSprite.visible = false;
  group.add(muzzleSprite);

  return { root: group, flame, bodyMat, muzzleSprite };
}

// --- Dynamic Cel-Shaded Background ---
function createEnvironment(scene, rng, gradientMap) {
  const envGroup = new THREE.Group();

  // Sky Backdrop Quad
  const skyGeo = new THREE.PlaneGeometry(500, 160);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x1e8ce6) },
      bottomColor: { value: new THREE.Color(0x9ee8ff) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(mix(bottomColor, topColor, vUv.y), 1.0);
      }
    `,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.position.set(0, 0, -50);
  envGroup.add(sky);

  // Distant Layered Mountains & Rolling Green Hills
  const hillMat1 = makeToonMat(0x32a852, gradientMap);
  const hillMat2 = makeToonMat(0x278542, gradientMap);
  const hillMat3 = makeToonMat(0x2e666a, gradientMap);
  const waterMat = makeToonMat(0x358ab8, gradientMap);

  // Lake at bottom
  const lakeGeo = new THREE.PlaneGeometry(500, 16);
  const lake = new THREE.Mesh(lakeGeo, waterMat);
  lake.position.set(0, -22, -35);
  envGroup.add(lake);

  // Rolling Hills (Layer 3 - distant)
  for (let i = -240; i <= 240; i += 20) {
    const r = rng.range(14, 22);
    const h = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), hillMat3);
    h.position.set(i + rng.range(-5, 5), -24 - rng.range(2, 6), -42);
    h.scale.set(1.4, 0.7, 1);
    addOutline(h, 1.05);
    envGroup.add(h);
  }

  // Rolling Hills (Layer 2 - midground)
  for (let i = -240; i <= 240; i += 16) {
    const r = rng.range(10, 16);
    const h = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), hillMat2);
    h.position.set(i + rng.range(-4, 4), -22 - rng.range(1, 4), -38);
    h.scale.set(1.3, 0.65, 1);
    addOutline(h, 1.05);
    envGroup.add(h);
  }

  // Rolling Hills (Layer 1 - closer with small red roof houses)
  for (let i = -240; i <= 240; i += 12) {
    const r = rng.range(7, 12);
    const h = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), hillMat1);
    h.position.set(i + rng.range(-3, 3), -20 - rng.range(0, 3), -32);
    h.scale.set(1.2, 0.6, 1);
    addOutline(h, 1.05);
    envGroup.add(h);

    if (rng.chance(0.4)) {
      const houseGroup = new THREE.Group();
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.0, 1.2),
        makeToonMat(0xf0ece1, gradientMap),
      );
      addOutline(base, 1.1);
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(1.1, 0.9, 4),
        makeToonMat(0xcc3322, gradientMap),
      );
      roof.position.y = 0.9;
      roof.rotation.y = Math.PI / 4;
      addOutline(roof, 1.1);
      houseGroup.add(base);
      houseGroup.add(roof);
      houseGroup.position.set(i, -15 + rng.range(-1, 1), -30);
      envGroup.add(houseGroup);
    }
  }

  // Fluffy Anime Cumulus Clouds
  const clouds = [];
  const cloudMat = makeToonMat(0xffffff, gradientMap);

  for (let c = 0; c < 16; c++) {
    const cloudGroup = new THREE.Group();
    const clusterCount = Math.floor(rng.range(4, 9));
    for (let p = 0; p < clusterCount; p++) {
      const cr = rng.range(2.5, 5.5);
      const puff = new THREE.Mesh(new THREE.DodecahedronGeometry(cr, 1), cloudMat);
      puff.position.set(rng.range(-4, 4), rng.range(-2, 3), rng.range(-2, 2));
      addOutline(puff, 1.06);
      cloudGroup.add(puff);
    }
    const zDepth = rng.range(-25, -12);
    cloudGroup.position.set(rng.range(-120, 120), rng.range(0, 28), zDepth);
    cloudGroup.userData = { speed: rng.range(0.8, 2.5), zDepth };
    envGroup.add(cloudGroup);
    clouds.push(cloudGroup);
  }

  scene.add(envGroup);
  return { envGroup, clouds };
}

// --- Smoke Ribbon Trail System (Indexed Triangle Strip) ---
class RibbonTrail {
  constructor(scene, maxPoints = 80, color = 0xffffff, startWidth = 0.35) {
    this.scene = scene;
    this.maxPoints = maxPoints;
    this.points = [];
    this.startWidth = startWidth;

    const positions = new Float32Array(maxPoints * 2 * 3);
    const uvs = new Float32Array(maxPoints * 2 * 2);
    const indices = [];

    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices.push(a, b, c, c, b, d);
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(color) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        varying vec2 vUv;
        void main() {
          float alpha = (1.0 - vUv.x) * 0.65;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  addPoint(pos, normal = new THREE.Vector3(0, 0, 1)) {
    this.points.unshift({
      x: pos.x,
      y: pos.y,
      z: pos.z,
      nx: normal.x,
      ny: normal.y,
      nz: normal.z,
      age: 0,
    });
    if (this.points.length > this.maxPoints) {
      this.points.pop();
    }
    this.updateMesh();
  }

  update(dt) {
    for (let i = 0; i < this.points.length; i++) {
      this.points[i].age += dt;
      this.points[i].x -= 0.5 * dt;
    }
    this.updateMesh();
  }

  updateMesh() {
    const count = this.points.length;
    if (count < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const posAttr = this.geometry.attributes.position;
    const uvAttr = this.geometry.attributes.uv;

    let idx = 0;
    let uvIdx = 0;

    for (let i = 0; i < count; i++) {
      const p = this.points[i];
      const t = i / this.maxPoints;
      const w = this.startWidth * (1.0 - t * 0.7);

      posAttr.array[idx++] = p.x + p.nx * w;
      posAttr.array[idx++] = p.y + p.ny * w;
      posAttr.array[idx++] = p.z + p.nz * w;

      posAttr.array[idx++] = p.x - p.nx * w;
      posAttr.array[idx++] = p.y - p.ny * w;
      posAttr.array[idx++] = p.z - p.nz * w;

      uvAttr.array[uvIdx++] = t;
      uvAttr.array[uvIdx++] = 0;
      uvAttr.array[uvIdx++] = t;
      uvAttr.array[uvIdx++] = 1;
    }

    this.geometry.setDrawRange(0, (count - 1) * 6);
    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- Health Bar & Floating Text Sprites ---
function createHealthBarSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 12;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.2, 0.6, 1);

  function update(hp, maxHp, isPlayer = false) {
    ctx.clearRect(0, 0, 64, 12);
    ctx.fillStyle = '#060a12';
    ctx.fillRect(0, 0, 64, 12);
    ctx.fillStyle = '#3a0808';
    ctx.fillRect(2, 2, 60, 8);
    const pct = clamp(hp / maxHp, 0, 1);
    ctx.fillStyle = isPlayer ? '#00e676' : '#ff3d00';
    ctx.fillRect(2, 2, Math.floor(60 * pct), 8);
    texture.needsUpdate = true;
  }

  return { sprite, update, texture, material: mat };
}

function createDamageText(scene, text, pos, color = '#22ffbb') {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 36;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 22px monospace';
  ctx.fillStyle = '#060a12';
  ctx.fillText(text, 14, 26);
  ctx.fillStyle = color;
  ctx.fillText(text, 12, 24);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(pos);
  sprite.scale.set(3.6, 1.0, 1);
  scene.add(sprite);

  return {
    sprite,
    life: 0.8,
    update(dt) {
      this.life -= dt;
      this.sprite.position.y += 3.5 * dt;
      mat.opacity = Math.max(0, this.life / 0.8);
      if (this.life <= 0) {
        scene.remove(this.sprite);
        texture.dispose();
        mat.dispose();
        return false;
      }
      return true;
    },
  };
}

// --- Sound System Wrapper ---
class SoundManager {
  constructor() {
    this.audio = new AudioKernel({ masterGain: 0.45 });
    this.noiseBuf = null;
    this.engineDrone = null;
  }

  start() {
    if (this.audio.started) return;
    this.audio.start();
    this.noiseBuf = this.audio.noiseBuffer({ seconds: 1.5, type: 'brown' });
    this.engineDrone = this.audio.drone({ buffer: this.noiseBuf, frequency: 180, gain: 0.15 });
  }

  updateEngine(pitch) {
    if (this.engineDrone) {
      this.engineDrone.setFrequency(pitch, 0.08);
    }
  }

  playLaser() {
    this.audio.tone({ frequency: 920, sweepTo: 240, duration: 0.07, gain: 0.28 });
  }

  playEnemyLaser() {
    this.audio.tone({ frequency: 540, sweepTo: 160, duration: 0.08, gain: 0.16 });
  }

  playMissile() {
    this.audio.tone({
      frequency: 340,
      sweepTo: 960,
      duration: 0.18,
      gain: 0.38,
      type: 'sawtooth',
    });
  }

  playLockOn() {
    this.audio.tone({ frequency: 1200, duration: 0.06, gain: 0.25, type: 'sine' });
  }

  playDryFire() {
    this.audio.tone({ frequency: 160, duration: 0.04, gain: 0.15, type: 'square' });
  }

  playHit() {
    this.audio.tone({ frequency: 440, duration: 0.04, gain: 0.22 });
  }

  playPlayerHit() {
    this.audio.tone({ frequency: 140, duration: 0.1, gain: 0.45 });
  }

  playExplosion() {
    if (this.noiseBuf) {
      this.audio.burst({
        buffer: this.noiseBuf,
        duration: 0.45,
        frequency: 380,
        sweepTo: 50,
        gain: 0.65,
      });
    }
  }
}

// --- Arena and Weapons Config ---
const WORLD = { minX: -140, maxX: 140, groundY: -15, ceilY: 48 };

/**
 * Flight envelope.
 *
 * The old model let the nose swing at a fixed rate no matter how fast the
 * aircraft was going, so it handled like a helicopter: you could pirouette on
 * the spot and every fight collapsed into two planes rotating to face each
 * other. Nothing was traded, so nothing had to be flown around.
 *
 * These numbers make speed the currency. Turn rate is bought with airspeed,
 * airspeed is bought with altitude and throttle, and both are spent by
 * turning — which is what gives a dogfight its shape.
 */
const FLIGHT = {
  stallSpeed: 10, // below this the wing carries nothing and cannot turn at all
  nLimit: 7.0, // structural g limit — the airframe's own ceiling on the turn
  turnG: 19, // scales the turn; the pull available at one g of load
  maxSpeed: 46,
  thrust: 17, // full throttle
  idleThrust: 5.5,
  airbrake: 20,
  dragK: 0.0105, // grows with v², which is what caps top speed near 40
  gravity: 11, // trades altitude for speed, both directions
  turnDrag: 0.55, // hauling on the stick bleeds energy
};

/**
 * Turn rate at a given airspeed — the "doghouse" every real aircraft has.
 *
 * A wing turns by pulling g, and the g it can pull is limited by two different
 * things at different speeds. Slowly, by the lift available, which grows with
 * v²: at stall speed the wing can barely hold the aircraft up, let alone
 * bend its path, so the turn rate is zero. Quickly, by the airframe itself,
 * and since rate = g / v, the same g sweeps an ever wider arc the faster you
 * go.
 *
 * The two limits cross at corner speed, which is the fastest an aircraft can
 * ever change direction and the reason a pilot has a speed they want to fight
 * at. Fixed-rate steering has no such speed, which is exactly why the old
 * model flew like a helicopter and made every merge identical.
 */
const CORNER_SPEED = FLIGHT.stallSpeed * Math.sqrt(FLIGHT.nLimit);

function turnRateAt(speed) {
  if (speed <= FLIGHT.stallSpeed) return 0;
  const liftLimited = (speed / FLIGHT.stallSpeed) ** 2;
  const n = Math.min(liftLimited, FLIGHT.nLimit);
  return (FLIGHT.turnG * Math.sqrt(Math.max(0, n * n - 1))) / speed;
}

const CANNON_TIERS = [
  {
    name: 'DUAL LASER',
    cooldown: 0.1,
    damage: 18,
    shots: 2,
    spread: 0.04,
    speed: 80,
    color: 0x00ff88,
  },
  {
    name: 'TRI-PLASMA',
    cooldown: 0.085,
    damage: 22,
    shots: 3,
    spread: 0.08,
    speed: 88,
    color: 0x00ffcc,
  },
  {
    name: 'QUAD BEAM',
    cooldown: 0.075,
    damage: 26,
    shots: 4,
    spread: 0.12,
    speed: 95,
    color: 0x33ffff,
  },
  {
    name: 'HYPER OVERDRIVE',
    cooldown: 0.055,
    damage: 32,
    shots: 5,
    spread: 0.16,
    speed: 105,
    color: 0xff33cc,
  },
];

export function init({ renderer, state }) {
  const seed = state?.seed ?? `${Date.now()}`;
  const rng = new PRNG(seed);
  const toonGradient = createToonGradient();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 0, 32);
  const feel = createFeel();

  // Lighting
  const ambient = new THREE.AmbientLight(0xddeeff, 0.7);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfffaed, 1.4);
  sun.position.set(15, 30, 25);
  scene.add(sun);

  const rimLight = new THREE.DirectionalLight(0x70c0ff, 0.8);
  rimLight.position.set(-20, -10, 10);
  scene.add(rimLight);

  const env = createEnvironment(scene, rng, toonGradient);
  const sound = new SoundManager();
  const keys = new Keyboard();
  const menu = document.getElementById('menu');

  let running = state?.running ?? false;
  let score = state?.score ?? 0;
  let kills = state?.kills ?? 0;

  // --- Target Lock Indicator Mesh ---
  const lockCanvas = document.createElement('canvas');
  lockCanvas.width = 64;
  lockCanvas.height = 64;
  const lctx = lockCanvas.getContext('2d');
  lctx.strokeStyle = '#ff3344';
  lctx.lineWidth = 3;
  // Corner targeting brackets
  lctx.strokeRect(6, 6, 52, 52);
  lctx.fillStyle = '#ff3344';
  lctx.fillRect(28, 28, 8, 8);
  const lockTex = new THREE.CanvasTexture(lockCanvas);
  const lockMat = new THREE.SpriteMaterial({
    map: lockTex,
    depthTest: false,
    transparent: true,
  });
  const lockSprite = new THREE.Sprite(lockMat);
  lockSprite.scale.set(3.2, 3.2, 1);
  lockSprite.visible = false;
  scene.add(lockSprite);

  // --- Rich HUD Overlay ---
  let scoreEl = document.getElementById('hud-score');
  if (!scoreEl) {
    scoreEl = document.createElement('div');
    scoreEl.id = 'hud-score';
    scoreEl.style.cssText = `
      position: fixed; top: 16px; left: 20px; z-index: 40;
      font-family: ui-monospace, Menlo, monospace; font-size: 14px; font-weight: 800;
      color: #ffffff; text-shadow: 2px 2px 0 #0a1220;
      letter-spacing: 0.08em; pointer-events: none;
      background: rgba(8, 16, 28, 0.78); border: 2px solid #1a3050;
      border-radius: 4px; padding: 10px 16px;
      display: flex; flex-direction: column; gap: 6px;
    `;
    document.body.appendChild(scoreEl);
  }

  // Offscreen target arrows container
  let indicatorsEl = document.getElementById('hud-indicators');
  if (!indicatorsEl) {
    indicatorsEl = document.createElement('div');
    indicatorsEl.id = 'hud-indicators';
    indicatorsEl.style.cssText = `
      position: fixed; inset: 0; z-index: 35; pointer-events: none; overflow: hidden;
    `;
    document.body.appendChild(indicatorsEl);
  }

  const unbind = [];
  const on = (target, type, handler) => {
    if (!target) return;
    target.addEventListener(type, handler);
    unbind.push(() => target.removeEventListener(type, handler));
  };

  const startGame = () => {
    sound.start();
    running = true;
    if (menu) menu.classList.add('hidden');
  };

  const startBtn = document.getElementById('startBtn');
  if (startBtn) {
    on(startBtn, 'click', startGame);
  }
  on(window, 'keydown', (e) => {
    if (!running && (e.code === 'Space' || e.code === 'Enter')) {
      startGame();
    }
  });

  if (menu) {
    menu.classList.toggle('hidden', running);
  }

  // --- Entities ---
  const MAX_MISSILES = 4;
  const player = {
    ...createFighterMesh(0x22bb55, 0x00ffff, toonGradient),
    pos: new THREE.Vector2(state?.px ?? -10, state?.py ?? 16),
    vel: new THREE.Vector2(0, 0),
    angle: state?.pa ?? 0,
    speed: 18,
    hp: 100,
    maxHp: 100,
    trail: new RibbonTrail(scene, 100, 0xffffff, 0.4),
    healthBar: createHealthBarSprite(),
    fireTimer: 0,
    missiles: state?.missiles ?? MAX_MISSILES,
    missileRecharge: 0,
    cannonTier: state?.cannonTier ?? 0,
    lockedTarget: null,
    muzzleTimer: 0,
    hitFlash: 0,
    roll: state?.roll ?? 0,
    alive: true,
    deadFor: 0,
  };
  scene.add(player.root);
  scene.add(player.healthBar.sprite);

  const bullets = [];
  const missiles = [];
  const enemies = [];
  const pickups = [];
  const particles = [];
  const damageTexts = [];

  let spawnTimer = 0.5;

  // Airspeed readout. With a real envelope the player has to be able to see
  // where the edge of it is; without this, stalling is indistinguishable from
  // the controls simply breaking.
  let speedEl = document.getElementById('hud-speed');
  if (!speedEl) {
    speedEl = document.createElement('div');
    speedEl.id = 'hud-speed';
    speedEl.style.cssText = `
      position: fixed; top: 46px; left: 20px; z-index: 40;
      font-family: ui-monospace, Menlo, monospace; font-size: 15px; font-weight: 800;
      letter-spacing: 0.08em; pointer-events: none;
      text-shadow: 2px 2px 0 #0a1220, -1px -1px 0 #0a1220;
    `;
    document.body.appendChild(speedEl);
  }

  function refreshSpeed() {
    const v = player.speed;
    const stalling = v < FLIGHT.stallSpeed;
    // Corner speed is the number worth flying to, so it is called out rather
    // than left to be discovered by feel.
    const near = Math.abs(v - CORNER_SPEED) < 3.5;
    const color = stalling ? '#ff3355' : near ? '#00ff99' : '#cfd8e6';
    const tag = stalling ? ' STALL' : near ? ' CORNER' : '';
    speedEl.innerHTML = `<span style="color:${color}">SPD ${v.toFixed(0).padStart(2, '0')}${tag}</span>`;
  }

  function refreshHud() {
    const tier = CANNON_TIERS[player.cannonTier];
    const mslIcons = '🚀 '.repeat(player.missile);
    const mslEmpty = '⚪ '.repeat(MAX_MISSILES - player.missiles);
    const rechargePct = Math.floor((1 - player.missileRecharge / 1.4) * 100);

    const lockStatus = player.lockedTarget
      ? `<span style="color:#ff3355; font-weight:bold;">[ LOCKED: ${Math.round(player.pos.distanceTo(player.lockedTarget.pos))}m ]</span>`
      : `<span style="color:#667a99;">[ NO LOCK ]</span>`;

    scoreEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:20px; font-size:16px;">
        <span>SCORE: <span style="color:#00ff99;">${String(score).padStart(5, '0')}</span></span>
        <span>ACES: <span style="color:#ff5588;">${kills}</span></span>
      </div>
      <div style="display:flex; gap:16px; font-size:12px; border-top:1px solid #1a3050; padding-top:4px;">
        <span>CANNON: <span style="color:#00ffbb;">${tier.name}</span></span>
        <span>MISSILES: <span style="color:#ffaa00;">${mslIcons}</span><span style="opacity:0.35;">${mslEmpty}</span> ${player.missiles < MAX_MISSILES ? `(${rechargePct}%)` : ''}</span>
        ${lockStatus}
      </div>
    `;
  }
  refreshHud();

  function spawnExplosion(pos, count = 14, _color = 0xff6600) {
    sound.playExplosion();
    for (let i = 0; i < count; i++) {
      const geo = new THREE.DodecahedronGeometry(rng.range(0.4, 1.2), 0);
      const mat = makeToonMat(rng.choice([0xff3300, 0xffaa00, 0xffffff, 0x333333]), toonGradient);
      const pMesh = new THREE.Mesh(geo, mat);
      addOutline(pMesh, 1.15);
      pMesh.position.set(pos.x, pos.y, rng.range(-0.5, 0.5));
      scene.add(pMesh);

      const angle = rng.range(0, Math.PI * 2);
      const spd = rng.range(8, 26);
      particles.push({
        mesh: pMesh,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        rot: rng.range(-5, 5),
        life: rng.range(0.3, 0.7),
        maxLife: 0.7,
      });
    }
  }

  function spawnWaterSplash(pos) {
    for (let i = 0; i < 10; i++) {
      const geo = new THREE.DodecahedronGeometry(rng.range(0.3, 0.7), 0);
      const mat = makeToonMat(0x88e0ff, toonGradient);
      const pMesh = new THREE.Mesh(geo, mat);
      pMesh.position.set(pos.x + rng.range(-1, 1), WORLD.groundY + 1, 0);
      scene.add(pMesh);
      particles.push({
        mesh: pMesh,
        vx: rng.range(-6, 6),
        vy: rng.range(8, 16),
        rot: rng.range(-4, 4),
        life: 0.5,
        maxLife: 0.5,
      });
    }
  }

  function spawnEnemy() {
    const isAce = rng.chance(0.35);
    const spawnLeft = rng.chance(0.5);
    const enemyData = {
      ...createFighterMesh(isAce ? 0x9b30ff : 0x6030c0, 0xffd700, toonGradient),
      pos: new THREE.Vector2(
        clamp(player.pos.x + (spawnLeft ? -50 : 50), WORLD.minX + 8, WORLD.maxX - 8),
        rng.range(WORLD.groundY + 8, 32),
      ),
      vel: new THREE.Vector2(spawnLeft ? rng.range(10, 16) : -rng.range(10, 16), rng.range(-3, 3)),
      angle: spawnLeft ? 0 : Math.PI,
      // Start inside the envelope: 14 is below stall, which would have every
      // enemy spawn already falling out of the sky.
      speed: isAce ? 27 : 23,
      throttle: (isAce ? 0.95 : 0.8) * FLIGHT.thrust,
      hp: isAce ? 55 : 25,
      maxHp: isAce ? 55 : 25,
      isAce,
      roll: spawnLeft ? 0 : Math.PI,
      trail: new RibbonTrail(scene, 70, isAce ? 0xffbbff : 0xddddff, 0.3),
      healthBar: createHealthBarSprite(),
      fireTimer: rng.range(0.8, 2.0),
      hitFlash: 0,
      turnTimer: rng.range(1.0, 3.0),
    };
    scene.add(enemyData.root);
    scene.add(enemyData.healthBar.sprite);
    enemies.push(enemyData);
  }

  const camTarget = new THREE.Vector2(0, 0);

  // --- Minimap ---
  const MAP_W = 220;
  const MAP_H = 78;
  let mapEl = document.getElementById('hud-map');
  if (!mapEl) {
    mapEl = document.createElement('canvas');
    mapEl.id = 'hud-map';
    mapEl.width = MAP_W;
    mapEl.height = MAP_H;
    mapEl.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 40;
      width: ${MAP_W}px; height: ${MAP_H}px; pointer-events: none;
      border: 3px solid #0a1220; background: rgba(6, 14, 26, 0.75);
      box-shadow: 4px 4px 0 rgba(0,0,0,0.5);
      image-rendering: pixelated;
    `;
    document.body.appendChild(mapEl);
  }
  const mapCtx = mapEl.getContext('2d');

  const mapX = (worldX) => ((worldX - WORLD.minX) / (WORLD.maxX - WORLD.minX)) * MAP_W;
  const mapY = (worldY) =>
    MAP_H - ((worldY - WORLD.groundY) / (WORLD.ceilY - WORLD.groundY)) * MAP_H;

  function blip(x, y, size, color) {
    mapCtx.fillStyle = color;
    mapCtx.fillRect(mapX(x) - size / 2, mapY(y) - size / 2, size, size);
  }

  function drawMinimap() {
    mapCtx.clearRect(0, 0, MAP_W, MAP_H);
    mapCtx.fillStyle = '#2f6b3a';
    mapCtx.fillRect(0, MAP_H - 4, MAP_W, 4);

    const halfView = camera.position.z * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
    mapCtx.strokeStyle = 'rgba(255,255,255,0.25)';
    mapCtx.lineWidth = 1;
    mapCtx.strokeRect(
      mapX(camera.position.x - halfView),
      1,
      mapX(camera.position.x + halfView) - mapX(camera.position.x - halfView),
      MAP_H - 2,
    );

    for (const pu of pickups) {
      blip(pu.pos.x, pu.pos.y, 4, pu.kind === 'cannon' ? '#00ffbb' : '#ff9922');
    }
    for (const e of enemies) {
      blip(e.pos.x, e.pos.y, 5, e.isAce ? '#ff44aa' : '#b070ff');
    }

    if (player.alive) {
      const px = mapX(player.pos.x);
      const py = mapY(player.pos.y);
      mapCtx.save();
      mapCtx.translate(px, py);
      mapCtx.rotate(-player.angle);
      mapCtx.fillStyle = '#22ff88';
      mapCtx.beginPath();
      mapCtx.moveTo(6, 0);
      mapCtx.lineTo(-4, 4);
      mapCtx.lineTo(-4, -4);
      mapCtx.closePath();
      mapCtx.fill();
      mapCtx.restore();
    }
  }

  function spawnPickup(pos, kind) {
    const isCannon = kind === 'cannon';
    const geo = isCannon
      ? new THREE.OctahedronGeometry(0.8, 0)
      : new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const mesh = new THREE.Mesh(geo, makeToonMat(isCannon ? 0x00ffbb : 0xff9922, toonGradient));
    addOutline(mesh, 1.18);
    mesh.position.set(pos.x, pos.y, 0);
    scene.add(mesh);
    pickups.push({
      mesh,
      kind,
      pos: new THREE.Vector2(pos.x, pos.y),
      vy: 3,
      life: 16,
      spin: rng.range(2, 4),
    });
  }

  function killPlayer(reason) {
    if (!player.alive) return;
    player.alive = false;
    player.deadFor = 0;
    player.hp = 0;
    player.root.visible = false;
    spawnExplosion(player.pos, 34, 0x00ff99);
    feel.hitstop(0.16);
    feel.shake(1.5, 4.5);
    feel.timeScale(0.35, 1.6);
    damageTexts.push(createDamageText(scene, reason, player.pos, '#ff2255'));
  }

  function respawn() {
    player.alive = true;
    player.hp = player.maxHp;
    player.pos.set(rng.range(-20, 20), 22);
    player.vel.set(0, 0);
    player.angle = 0;
    player.root.visible = true;
    player.missiles = MAX_MISSILES;
    refreshHud();
  }

  // --- Off-Screen Bandit Indicators Update ---
  function updateOffscreenIndicators() {
    indicatorsEl.innerHTML = '';
    if (!player.alive) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const halfW =
      (camera.position.z * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect * w) / w;
    const halfH = camera.position.z * Math.tan((camera.fov * Math.PI) / 360);

    for (const e of enemies) {
      const dx = e.pos.x - camera.position.x;
      const dy = e.pos.y - camera.position.y;

      if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) {
        const screenX = clamp((dx / halfW) * (w / 2) + w / 2, 28, w - 28);
        const screenY = clamp((-dy / halfH) * (h / 2) + h / 2, 28, h - 28);
        const angle = Math.atan2(-dy, dx);
        const dist = Math.round(player.pos.distanceTo(e.pos));

        const arrow = document.createElement('div');
        arrow.style.cssText = `
          position: absolute; left: ${screenX}px; top: ${screenY}px;
          transform: translate(-50%, -50%);
          color: ${e.isAce ? '#ff44aa' : '#b070ff'};
          font-family: monospace; font-size: 11px; font-weight: 800;
          text-shadow: 1px 1px 0 #000;
          display: flex; flex-direction: column; align-items: center;
        `;
        arrow.innerHTML = `
          <div style="transform: rotate(${angle}rad); font-size: 16px; line-height: 1;">▶</div>
          <div>${dist}m</div>
        `;
        indicatorsEl.appendChild(arrow);
      }
    }
  }

  return {
    update(rawDt, _elapsed) {
      const dt = feel.step(rawDt);
      if (!running) {
        for (const cloud of env.clouds) {
          cloud.position.x -= cloud.userData.speed * dt;
          if (cloud.position.x < -70) cloud.position.x = 70;
        }
        renderer.render(scene, camera);
        return;
      }

      if (!player.alive) {
        player.deadFor += rawDt;
        if (player.deadFor > 2.2) respawn();
      }

      // --- Player Flight Control ---
      const steer = player.alive ? keys.axis(['ArrowRight', 'KeyD'], ['ArrowLeft', 'KeyA']) : 0;
      const throttle = player.alive && keys.anyDown('ArrowUp', 'KeyW');
      const brake = player.alive && keys.anyDown('ArrowDown', 'KeyS');

      // --- Energy ---
      // Climbing spends speed, diving earns it. sin(angle) is the climb
      // component of the nose, so a vertical pull drains the tanks and a dive
      // refills them — the whole basis of trading height for speed.
      const climb = Math.sin(player.angle);
      // The airbrake scales with airspeed, because a bouncing airbrake needs
      // air to bite on. A constant one lets you hold zero forever with the key
      // down — an aircraft hanging motionless in the sky, which is the
      // helicopter problem wearing a different hat.
      const brakeForce = FLIGHT.airbrake * Math.min(1, player.speed / 18);
      let accel = throttle ? FLIGHT.thrust : brake ? -brakeForce : FLIGHT.idleThrust;
      accel -= FLIGHT.gravity * climb;
      accel -= FLIGHT.dragK * player.speed * player.speed;
      // Hauling on the stick costs energy, so a sustained turn bleeds you.
      accel -= Math.abs(steer) * FLIGHT.turnDrag * player.speed * 0.1;

      player.speed = clamp(player.speed + accel * dt, 0, FLIGHT.maxSpeed);

      if (throttle) {
        player.flame.visible = true;
        player.flame.scale.set(rng.range(0.9, 1.4), rng.range(0.8, 1.2), 1);
      } else if (brake) {
        player.flame.visible = false;
      } else {
        player.flame.visible = rng.chance(0.25);
        player.flame.scale.set(0.6, 0.6, 1);
      }
      sound.updateEngine(120 + (player.speed / FLIGHT.maxSpeed) * 260);

      // --- Turn authority ---
      const stalled = player.speed < FLIGHT.stallSpeed;
      player.angle += steer * turnRateAt(player.speed) * dt;

      if (stalled) {
        // The nose falls through toward the vertical, which is both the
        // punishment and the way out — gravity hands the speed back.
        const severity = 1 - player.speed / FLIGHT.stallSpeed;
        let toDown = -Math.PI / 2 - player.angle;
        while (toDown < -Math.PI) toDown += Math.PI * 2;
        while (toDown > Math.PI) toDown -= Math.PI * 2;
        player.angle += toDown * severity * 1.6 * dt;
      }

      refreshSpeed();

      const fwdX = Math.cos(player.angle);
      const fwdY = Math.sin(player.angle);

      // Velocity trails the nose rather than snapping to it, so a hard pull
      // slides the aircraft through the turn instead of teleporting its
      // heading. That lag is what a reversal is fought against.
      player.vel.x = damp(player.vel.x, fwdX * player.speed, 6, dt);
      player.vel.y = damp(player.vel.y, fwdY * player.speed, 6, dt);

      player.pos.x += player.vel.x * dt;
      player.pos.y += player.vel.y * dt;

      // --- Forgiving Ground Grazing / Water Cushion ---
      if (player.pos.y <= WORLD.groundY) {
        player.pos.y = WORLD.groundY;
        if (player.vel.y < -16) {
          killPlayer('CRASHED');
        } else {
          // Bounce off water & create splash
          player.vel.y = Math.abs(player.vel.y) * 0.7 + 6;
          spawnWaterSplash(player.pos);
          feel.shake(0.3, 6);
        }
      }

      if (player.pos.y > WORLD.ceilY) {
        player.pos.y = WORLD.ceilY;
        player.vel.y = Math.min(player.vel.y, -4);
      }
      if (player.pos.x < WORLD.minX) {
        player.pos.x = WORLD.minX;
        player.vel.x = Math.abs(player.vel.x) * 0.5;
      }
      if (player.pos.x > WORLD.maxX) {
        player.pos.x = WORLD.maxX;
        player.vel.x = -Math.abs(player.vel.x) * 0.5;
      }

      // Visual Orientation & Auto-Righting Roll
      // In 2D plane: when heading left (cos(angle) < 0), local +Y (canopy) is pointed down.
      // If the player is not actively steering, auto-roll so canopy faces UP into the sky!
      const isHeadingLeft = Math.cos(player.angle) < 0;
      let targetRoll = 0;

      if (Math.abs(steer) > 0.05) {
        // While actively steering, bank dynamically into the turn
        targetRoll = (isHeadingLeft ? Math.PI : 0) - steer * 0.65;
      } else {
        // When NOT steering / releasing controls, auto-roll upright so canopy points toward the sky
        targetRoll = isHeadingLeft ? Math.PI : 0;
      }

      // Smooth shortest-arc interpolation for natural barrel rolls
      let rollDiff = targetRoll - player.roll;
      while (rollDiff < -Math.PI) rollDiff += Math.PI * 2;
      while (rollDiff > Math.PI) rollDiff -= Math.PI * 2;
      player.roll += rollDiff * Math.min(1, dt * 7.5);

      player.root.position.set(player.pos.x, player.pos.y, 0);
      player.root.rotation.z = player.angle;
      player.root.rotation.x = player.roll;

      // Muzzle flash visibility
      if (player.muzzleTimer > 0) {
        player.muzzleTimer -= dt;
        player.muzzleSprite.visible = true;
      } else {
        player.muzzleSprite.visible = false;
      }

      const wingTipPos = new THREE.Vector3(player.pos.x - fwdX * 0.8, player.pos.y - fwdY * 0.8, 0);
      player.trail.addPoint(wingTipPos, new THREE.Vector3(0, 0, 1));
      player.trail.update(dt);

      player.healthBar.sprite.position.set(player.pos.x, player.pos.y + 2.2, 0.5);
      player.healthBar.update(player.hp, player.maxHp, true);

      if (player.hitFlash > 0) {
        player.hitFlash -= dt;
        player.bodyMat.color.setHex(0xffffff);
      } else {
        player.bodyMat.color.setHex(0x22bb55);
      }

      // --- Target Lock-On Scanning ---
      let bestTarget = null;
      let bestDist = 45;
      for (const e of enemies) {
        const toEnemy = new THREE.Vector2().subVectors(e.pos, player.pos);
        const dist = toEnemy.length();
        if (dist < bestDist) {
          const angleToEnemy = Math.atan2(toEnemy.y, toEnemy.x);
          let diff = angleToEnemy - player.angle;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;

          if (Math.abs(diff) < 0.75) {
            bestDist = dist;
            bestTarget = e;
          }
        }
      }

      if (bestTarget !== player.lockedTarget) {
        player.lockedTarget = bestTarget;
        if (player.lockedTarget) sound.playLockOn();
        refreshHud();
      }

      if (player.lockedTarget && enemies.includes(player.lockedTarget)) {
        lockSprite.visible = true;
        lockSprite.position.set(player.lockedTarget.pos.x, player.lockedTarget.pos.y, 0.5);
        lockSprite.rotation.z += dt * 3;
      } else {
        lockSprite.visible = false;
      }

      // --- Missile Auto-Recharge ---
      if (player.missiles < MAX_MISSILES) {
        player.missileRecharge -= dt;
        if (player.missileRecharge <= 0) {
          player.missiles++;
          player.missileRecharge = 1.4;
          refreshHud();
        }
      }

      // --- Weapons: Primary Laser Cannon (Holding Space/J/Z) ---
      const cannon = CANNON_TIERS[player.cannonTier];
      player.fireTimer -= dt;
      if (player.alive && keys.anyDown('Space', 'KeyJ', 'KeyZ') && player.fireTimer <= 0) {
        player.fireTimer = cannon.cooldown;
        player.muzzleTimer = 0.05;
        sound.playLaser();
        feel.shake(0.08, 12);

        for (let shot = 0; shot < cannon.shots; shot++) {
          const offset = (shot - (cannon.shots - 1) / 2) * cannon.spread;
          const a = player.angle + offset;
          const ax = Math.cos(a);
          const ay = Math.sin(a);

          const laserMesh = new THREE.Mesh(
            new THREE.BoxGeometry(2.8, 0.26, 0.26),
            new THREE.MeshBasicMaterial({ color: cannon.color }),
          );
          laserMesh.rotation.z = a;
          const muzzle = new THREE.Vector2(player.pos.x + ax * 2.2, player.pos.y + ay * 2.2);
          laserMesh.position.set(muzzle.x, muzzle.y, 0);
          scene.add(laserMesh);

          bullets.push({
            mesh: laserMesh,
            pos: muzzle,
            vel: new THREE.Vector2(ax * cannon.speed, ay * cannon.speed),
            isPlayer: true,
            damage: cannon.damage,
            life: 1.4,
          });
        }
      }

      // --- Weapons: Homing Swarm Missiles (X / K / Shift) ---
      if (
        player.alive &&
        keys.anyDown('KeyX', 'KeyK', 'ShiftLeft', 'ShiftRight') &&
        player.fireTimer <= 0.1
      ) {
        if (player.missiles > 0) {
          player.missiles--;
          if (player.missileRecharge <= 0) player.missileRecharge = 1.4;
          refreshHud();
          sound.playMissile();
          feel.shake(0.2, 10);

          const mGeo = new THREE.ConeGeometry(0.35, 1.4, 6);
          mGeo.rotateZ(-Math.PI / 2);
          const mMat = makeToonMat(0xff7700, toonGradient);
          const mMesh = new THREE.Mesh(mGeo, mMat);
          addOutline(mMesh, 1.2);

          const mPos = new THREE.Vector2(player.pos.x, player.pos.y);
          mMesh.position.set(mPos.x, mPos.y, 0);
          scene.add(mMesh);

          missiles.push({
            mesh: mMesh,
            pos: mPos,
            vel: new THREE.Vector2(fwdX * 16, fwdY * 16),
            angle: player.angle + rng.range(-0.35, 0.35),
            speed: 18,
            damage: 42,
            life: 3.5,
            target: player.lockedTarget,
            trail: new RibbonTrail(scene, 50, 0xffeebb, 0.28),
          });
        } else if (rng.chance(0.1)) {
          sound.playDryFire();
        }
      }

      // --- Update Bullets ---
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.life -= dt;
        b.pos.x += b.vel.x * dt;
        b.pos.y += b.vel.y * dt;
        b.mesh.position.set(b.pos.x, b.pos.y, 0);

        let hit = false;
        if (b.isPlayer) {
          for (const e of enemies) {
            if (b.pos.distanceTo(e.pos) < 2.2) {
              e.hp -= b.damage;
              e.hitFlash = 0.08;
              damageTexts.push(createDamageText(scene, `-${b.damage}`, e.pos, '#00ff99'));
              sound.playHit();
              hit = true;
              break;
            }
          }
        } else {
          if (player.alive && b.pos.distanceTo(player.pos) < 1.8) {
            feel.hitstop(0.04);
            feel.shake(0.3, 10);
            player.hp -= b.damage;
            player.hitFlash = 0.1;
            damageTexts.push(createDamageText(scene, `-${b.damage}`, player.pos, '#ff3344'));
            sound.playPlayerHit();
            hit = true;
          }
        }

        // Broad arena boundaries check so bullets don't despawn mid-screen
        if (
          hit ||
          b.life <= 0 ||
          b.pos.x < WORLD.minX - 30 ||
          b.pos.x > WORLD.maxX + 30 ||
          b.pos.y < WORLD.groundY - 10 ||
          b.pos.y > WORLD.ceilY + 20
        ) {
          scene.remove(b.mesh);
          b.mesh.geometry.dispose();
          b.mesh.material.dispose();
          bullets.splice(i, 1);
        }
      }

      // --- Update Missiles ---
      for (let i = missiles.length - 1; i >= 0; i--) {
        const m = missiles[i];
        m.life -= dt;

        // Track target or nearest bandit
        let target = m.target && enemies.includes(m.target) ? m.target : null;
        if (!target) {
          let minDist = 40;
          for (const e of enemies) {
            const d = m.pos.distanceTo(e.pos);
            if (d < minDist) {
              minDist = d;
              target = e;
            }
          }
        }

        if (target) {
          const desiredAngle = Math.atan2(target.pos.y - m.pos.y, target.pos.x - m.pos.x);
          let diff = desiredAngle - m.angle;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          m.angle += clamp(diff, -5.5 * dt, 5.5 * dt);
        }

        m.speed = damp(m.speed, 38, 4, dt);
        m.pos.x += Math.cos(m.angle) * m.speed * dt;
        m.pos.y += Math.sin(m.angle) * m.speed * dt;

        m.mesh.position.set(m.pos.x, m.pos.y, 0);
        m.mesh.rotation.z = m.angle;

        m.trail.addPoint(new THREE.Vector3(m.pos.x, m.pos.y, 0), new THREE.Vector3(0, 0, 1));
        m.trail.update(dt);

        let hit = false;
        for (const e of enemies) {
          if (m.pos.distanceTo(e.pos) < 2.4) {
            e.hp -= m.damage;
            e.hitFlash = 0.15;
            feel.hitstop(0.06);
            feel.shake(0.4, 8);
            spawnExplosion(m.pos, 10, 0xffaa00);
            damageTexts.push(createDamageText(scene, `CRIT -${m.damage}`, e.pos, '#ffcc00'));
            hit = true;
            break;
          }
        }

        if (hit || m.life <= 0) {
          if (hit) spawnExplosion(m.pos, 12);
          scene.remove(m.mesh);
          m.mesh.geometry.dispose();
          m.mesh.material.dispose();
          m.trail.dispose();
          missiles.splice(i, 1);
        }
      }

      // --- Spawn Enemies Wave ---
      spawnTimer -= dt;
      if (spawnTimer <= 0 && enemies.length < 6) {
        spawnEnemy();
        spawnTimer = rng.range(1.5, 3.2);
      }

      // --- Update Enemies ---
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        e.turnTimer -= dt;

        const toPlayer = new THREE.Vector2().subVectors(player.pos, e.pos);
        const dist = toPlayer.length();

        let desiredAngle = Math.atan2(toPlayer.y, toPlayer.x);
        if (e.turnTimer <= 0) {
          e.turnTimer = rng.range(1.2, 2.5);
          if (e.isAce && dist < 12) {
            desiredAngle += Math.PI * 0.8;
          }
        }

        let diff = desiredAngle - e.angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;

        // Enemies fly the same envelope the player does. Leaving them on a
        // fixed turn rate would mean the only aircraft that had to manage
        // energy was yours — the fight would read as a handicap rather than a
        // contest, and every hard-won position could simply be rotated away.
        const eClimb = Math.sin(e.angle);
        const eAccel =
          (e.throttle ?? FLIGHT.thrust * 0.82) -
          FLIGHT.gravity * eClimb -
          FLIGHT.dragK * e.speed * e.speed;
        e.speed = clamp(e.speed + eAccel * dt, 0, FLIGHT.maxSpeed);

        const eTurn = turnRateAt(e.speed) * (e.isAce ? 1.0 : 0.86);
        e.angle += clamp(diff, -eTurn * dt, eTurn * dt);

        // Stalled AI drops its nose exactly as the player's does, so a rival
        // that over-pulls hands you the same opening you would hand it.
        if (e.speed < FLIGHT.stallSpeed) {
          const severity = 1 - e.speed / FLIGHT.stallSpeed;
          let eToDown = -Math.PI / 2 - e.angle;
          while (eToDown < -Math.PI) eToDown += Math.PI * 2;
          while (eToDown > Math.PI) eToDown -= Math.PI * 2;
          e.angle += eToDown * severity * 1.6 * dt;
        }

        const efwdX = Math.cos(e.angle);
        const efwdY = Math.sin(e.angle);

        e.vel.x = damp(e.vel.x, efwdX * e.speed, 6, dt);
        e.vel.y = damp(e.vel.y, efwdY * e.speed, 6, dt);

        e.pos.x += e.vel.x * dt;
        e.pos.y += e.vel.y * dt;

        const eIsLeft = Math.cos(e.angle) < 0;
        const eTargetRoll = (eIsLeft ? Math.PI : 0) - diff * 0.4;
        let eRollDiff = eTargetRoll - (e.roll || 0);
        while (eRollDiff < -Math.PI) eRollDiff += Math.PI * 2;
        while (eRollDiff > Math.PI) eRollDiff -= Math.PI * 2;
        e.roll = (e.roll || 0) + eRollDiff * Math.min(1, dt * 6.0);

        e.root.position.set(e.pos.x, e.pos.y, 0);
        e.root.rotation.z = e.angle;
        e.root.rotation.x = e.roll;

        e.trail.addPoint(
          new THREE.Vector3(e.pos.x - efwdX * 0.8, e.pos.y - efwdY * 0.8, 0),
          new THREE.Vector3(0, 0, 1),
        );
        e.trail.update(dt);

        e.healthBar.sprite.position.set(e.pos.x, e.pos.y + 2.0, 0.5);
        e.healthBar.update(e.hp, e.maxHp, false);

        if (e.hitFlash > 0) {
          e.hitFlash -= dt;
          e.bodyMat.color.setHex(0xffffff);
        } else {
          e.bodyMat.color.setHex(e.isAce ? 0x9b30ff : 0x6030c0);
        }

        // Enemy Shooting
        e.fireTimer -= dt;
        if (e.fireTimer <= 0 && dist < 30 && Math.abs(diff) < 0.45) {
          e.fireTimer = rng.range(1.2, 2.2);
          sound.playEnemyLaser();

          const laserGeo = new THREE.BoxGeometry(2.0, 0.22, 0.22);
          const laserMat = new THREE.MeshBasicMaterial({ color: 0xff3366 });
          const laserMesh = new THREE.Mesh(laserGeo, laserMat);
          laserMesh.rotation.z = e.angle;
          laserMesh.position.set(e.pos.x + efwdX * 1.8, e.pos.y + efwdY * 1.8, 0);
          scene.add(laserMesh);

          bullets.push({
            mesh: laserMesh,
            pos: new THREE.Vector2(e.pos.x + efwdX * 1.8, e.pos.y + efwdY * 1.8),
            vel: new THREE.Vector2(efwdX * 50, efwdY * 50),
            isPlayer: false,
            damage: 12,
            life: 1.6,
          });
        }

        if (e.pos.distanceTo(player.pos) < 2.2) {
          player.hp -= 25;
          e.hp = 0;
          spawnExplosion(e.pos, 16);
          damageTexts.push(createDamageText(scene, '-25 CRASH', player.pos, '#ff0055'));
        }

        if (e.hp <= 0) {
          spawnExplosion(e.pos, 18, e.isAce ? 0xff44aa : 0xff7700);
          feel.hitstop(0.06);
          feel.shake(0.4, 8);

          if (e.isAce ? rng.chance(0.8) : rng.chance(0.35)) {
            spawnPickup(e.pos, e.isAce && rng.chance(0.6) ? 'cannon' : 'missiles');
          }
          score += e.isAce ? 250 : 100;
          kills += 1;
          refreshHud();

          scene.remove(e.root);
          scene.remove(e.healthBar.sprite);
          e.healthBar.texture.dispose();
          e.healthBar.material.dispose();
          e.trail.dispose();
          enemies.splice(i, 1);
          continue;
        }

        if (
          Math.abs(e.pos.x - player.pos.x) > 110 ||
          e.pos.y < WORLD.groundY - 8 ||
          e.pos.y > WORLD.ceilY + 12
        ) {
          scene.remove(e.root);
          scene.remove(e.healthBar.sprite);
          e.healthBar.texture.dispose();
          e.healthBar.material.dispose();
          e.trail.dispose();
          enemies.splice(i, 1);
        }
      }

      // --- Update Particles ---
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.rotation.x += p.rot * dt;
        p.mesh.rotation.y += p.rot * dt;
        const scale = p.life / p.maxLife;
        p.mesh.scale.set(scale, scale, scale);

        if (p.life <= 0) {
          scene.remove(p.mesh);
          p.mesh.geometry.dispose();
          p.mesh.material.dispose();
          particles.splice(i, 1);
        }
      }

      // --- Update Damage Texts ---
      for (let i = damageTexts.length - 1; i >= 0; i--) {
        if (!damageTexts[i].update(dt)) {
          damageTexts.splice(i, 1);
        }
      }

      // --- Pickups ---
      for (let i = pickups.length - 1; i >= 0; i--) {
        const pu = pickups[i];
        pu.life -= dt;
        pu.vy = damp(pu.vy, 0, 1.5, dt);
        pu.pos.y += pu.vy * dt;
        pu.mesh.position.set(pu.pos.x, pu.pos.y, 0);
        pu.mesh.rotation.z += pu.spin * dt;
        pu.mesh.rotation.y += pu.spin * 0.6 * dt;
        pu.mesh.visible = pu.life > 2 || Math.floor(pu.life * 8) % 2 === 0;

        if (player.alive && pu.pos.distanceTo(player.pos) < 2.5) {
          if (pu.kind === 'cannon') {
            const was = player.cannonTier;
            player.cannonTier = Math.min(CANNON_TIERS.length - 1, player.cannonTier + 1);
            damageTexts.push(
              createDamageText(
                scene,
                was === player.cannonTier ? 'CANNON MAX' : CANNON_TIERS[player.cannonTier].name,
                pu.pos,
                '#00ffbb',
              ),
            );
          } else {
            player.missiles = MAX_MISSILES;
            damageTexts.push(createDamageText(scene, 'MISSILES RESTOCKED', pu.pos, '#ffaa00'));
          }
          sound.playHit();
          refreshHud();
          pu.life = 0;
        }

        if (pu.life <= 0) {
          scene.remove(pu.mesh);
          pu.mesh.geometry.dispose();
          pu.mesh.material.dispose();
          pickups.splice(i, 1);
        }
      }

      // --- Camera Follow ---
      const lookAhead = clamp(player.vel.x * 0.35, -10, 10);
      const halfView = camera.position.z * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
      camTarget.x = clamp(player.pos.x + lookAhead, WORLD.minX + halfView, WORLD.maxX - halfView);
      camTarget.y = clamp(player.pos.y * 0.6, WORLD.groundY + 10, WORLD.ceilY - 6);
      camera.position.x = damp(camera.position.x, camTarget.x, 3.5, rawDt);
      camera.position.y = damp(camera.position.y, camTarget.y, 2.5, rawDt);
      camera.position.x += feel.offset.x;
      camera.position.y += feel.offset.y;

      env.envGroup.position.x = camera.position.x * 0.75;

      drawMinimap();
      updateOffscreenIndicators();

      // --- Background Clouds Parallax ---
      for (const cloud of env.clouds) {
        cloud.position.x -= cloud.userData.speed * dt;
        if (cloud.position.x < camera.position.x - 90) {
          cloud.position.x = camera.position.x + 90;
          cloud.position.y = rng.range(0, 26);
        }
      }

      if (player.hp <= 0 && player.alive) killPlayer('SHOT DOWN');

      renderer.render(scene, camera);
    },

    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },

    getState() {
      return {
        seed,
        running,
        score,
        kills,
        px: player.pos.x,
        py: player.pos.y,
        pa: player.angle,
        roll: player.roll,
        cannonTier: player.cannonTier,
        missiles: player.missiles,
      };
    },

    dispose() {
      for (const off of unbind) off();
      keys.dispose();
      scoreEl?.remove();
      speedEl?.remove();
      mapEl?.remove();
      indicatorsEl?.remove();
      feel.reset();
      player.trail.dispose();
      player.healthBar.texture.dispose();
      player.healthBar.material.dispose();

      for (const e of enemies) {
        e.trail.dispose();
        e.healthBar.texture.dispose();
        e.healthBar.material.dispose();
      }

      scene.traverse((obj) => {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material)
          ? obj.material
          : obj.material
            ? [obj.material]
            : [];
        for (const m of mats) {
          for (const k of Object.keys(m)) m[k]?.isTexture && m[k].dispose();
          m.dispose();
        }
      });
      scene.clear();
    },
  };
}
