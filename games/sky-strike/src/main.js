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

  return { root: group, flame, bodyMat };
}

// --- Dynamic Cel-Shaded Background ---
function createEnvironment(scene, rng, gradientMap) {
  const envGroup = new THREE.Group();

  // Sky Backdrop Quad
  // Wide enough to cover the whole arena plus the camera's travel.
  const skyGeo = new THREE.PlaneGeometry(420, 140);
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
  const hillMat1 = makeToonMat(0x32a852, gradientMap); // foreground lush green
  const hillMat2 = makeToonMat(0x278542, gradientMap); // midground green
  const hillMat3 = makeToonMat(0x2e666a, gradientMap); // distant blue-green ridge
  const waterMat = makeToonMat(0x358ab8, gradientMap); // lake water

  // Lake at bottom
  const lakeGeo = new THREE.PlaneGeometry(420, 14);
  const lake = new THREE.Mesh(lakeGeo, waterMat);
  lake.position.set(0, -22, -35);
  envGroup.add(lake);

  // Rolling Hills (Layer 3 - distant)
  for (let i = -200; i <= 200; i += 20) {
    const r = rng.range(14, 22);
    const h = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), hillMat3);
    h.position.set(i + rng.range(-5, 5), -24 - rng.range(2, 6), -42);
    h.scale.set(1.4, 0.7, 1);
    addOutline(h, 1.05);
    envGroup.add(h);
  }

  // Rolling Hills (Layer 2 - midground)
  for (let i = -200; i <= 200; i += 16) {
    const r = rng.range(10, 16);
    const h = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), hillMat2);
    h.position.set(i + rng.range(-4, 4), -22 - rng.range(1, 4), -38);
    h.scale.set(1.3, 0.65, 1);
    addOutline(h, 1.05);
    envGroup.add(h);
  }

  // Rolling Hills (Layer 1 - closer with small red roof houses)
  for (let i = -200; i <= 200; i += 12) {
    const r = rng.range(7, 12);
    const h = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), hillMat1);
    h.position.set(i + rng.range(-3, 3), -20 - rng.range(0, 3), -32);
    h.scale.set(1.2, 0.6, 1);
    addOutline(h, 1.05);
    envGroup.add(h);

    // Little houses on hills
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

  for (let c = 0; c < 12; c++) {
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
    cloudGroup.position.set(rng.range(-60, 60), rng.range(0, 24), zDepth);
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
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 24px monospace';
  ctx.fillStyle = '#060a12';
  ctx.fillText(text, 14, 26);
  ctx.fillStyle = color;
  ctx.fillText(text, 12, 24);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(pos);
  sprite.scale.set(2.4, 1.2, 1);
  scene.add(sprite);

  return {
    sprite,
    life: 0.7,
    update(dt) {
      this.life -= dt;
      this.sprite.position.y += 3.5 * dt;
      mat.opacity = Math.max(0, this.life / 0.7);
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
    this.audio.tone({ frequency: 880, sweepTo: 220, duration: 0.08, gain: 0.25 });
  }

  playEnemyLaser() {
    this.audio.tone({ frequency: 600, sweepTo: 180, duration: 0.08, gain: 0.15 });
  }

  playMissile() {
    this.audio.tone({ frequency: 320, sweepTo: 900, duration: 0.15, gain: 0.35, type: 'sawtooth' });
  }

  playHit() {
    this.audio.tone({ frequency: 400, duration: 0.04, gain: 0.2 });
  }

  playPlayerHit() {
    this.audio.tone({ frequency: 150, duration: 0.1, gain: 0.4 });
  }

  playExplosion() {
    if (this.noiseBuf) {
      this.audio.burst({
        buffer: this.noiseBuf,
        duration: 0.4,
        frequency: 400,
        sweepTo: 60,
        gain: 0.6,
      });
    }
  }
}

// --- Main Init ---
/**
 * The arena is much wider than the camera can see (~52 units at z=32), so the
 * fight has somewhere to run to and the minimap has a job. Height is bounded
 * by ground and a stall ceiling rather than by the view.
 */
const WORLD = { minX: -120, maxX: 120, groundY: -15, ceilY: 44 };

/**
 * Cannon progression. You start with something deliberately weak — a slow,
 * single, low-damage pea-shooter — so that the first drop is felt rather than
 * merely collected.
 */
const CANNON_TIERS = [
  { name: 'MK-I', cooldown: 0.3, damage: 7, shots: 1, spread: 0, speed: 50, color: 0x9fe870 },
  { name: 'MK-II', cooldown: 0.2, damage: 10, shots: 1, spread: 0, speed: 58, color: 0x4dff88 },
  {
    name: 'MK-III',
    cooldown: 0.14,
    damage: 12,
    shots: 2,
    spread: 0.07,
    speed: 62,
    color: 0x00ffbb,
  },
  { name: 'MK-IV', cooldown: 0.1, damage: 14, shots: 3, spread: 0.11, speed: 68, color: 0x66ffff },
];

export function init({ renderer, state }) {
  const seed = state?.seed ?? `${Date.now()}`;
  const rng = new PRNG(seed);
  const toonGradient = createToonGradient();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 0, 32);
  // Hitstop, shake and slow-motion, shared with the other games.
  const feel = createFeel();

  // Cel Lighting Setup
  const ambient = new THREE.AmbientLight(0xddeeff, 0.7);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfffaed, 1.4);
  sun.position.set(15, 30, 25);
  scene.add(sun);

  const rimLight = new THREE.DirectionalLight(0x70c0ff, 0.8);
  rimLight.position.set(-20, -10, 10);
  scene.add(rimLight);

  // Build Environment
  const env = createEnvironment(scene, rng, toonGradient);

  // Sound Manager
  const sound = new SoundManager();

  // Input Handling
  const keys = new Keyboard();
  const menu = document.getElementById('menu');
  let running = state?.running ?? false;
  let score = state?.score ?? 0;
  let kills = state?.kills ?? 0;

  let scoreEl = document.getElementById('hud-score');
  if (!scoreEl) {
    scoreEl = document.createElement('div');
    scoreEl.id = 'hud-score';
    scoreEl.style.cssText = `
      position: fixed; top: 16px; left: 20px; z-index: 40;
      font-family: ui-monospace, Menlo, monospace; font-size: 20px; font-weight: 800;
      color: #ffffff; text-shadow: 2px 2px 0 #0a1220, -1px -1px 0 #0a1220;
      letter-spacing: 0.1em; pointer-events: none;
    `;
    document.body.appendChild(scoreEl);
  }
  const refreshHud = () => {
    const tier = CANNON_TIERS[player.cannonTier];
    scoreEl.innerHTML =
      `SCORE: <span style="color:#00ff99;">${String(score).padStart(5, '0')}</span>` +
      ` | ACES: <span style="color:#ff5588;">${kills}</span>` +
      ` | <span style="color:#00ffbb;">${tier.name}</span>` +
      ` | MSL: <span style="color:${player.missileAmmo ? '#ff9922' : '#66707f'};">${player.missileAmmo}</span>`;
  };

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
  // Player Setup
  const player = {
    ...createFighterMesh(0x22bb55, 0x00ffff, toonGradient),
    pos: new THREE.Vector2(state?.px ?? -10, state?.py ?? 16),
    vel: new THREE.Vector2(0, 0),
    angle: state?.pa ?? 0,
    speed: 16,
    hp: 100,
    maxHp: 100,
    trail: new RibbonTrail(scene, 100, 0xffffff, 0.4),
    healthBar: createHealthBarSprite(),
    fireTimer: 0,
    missileTimer: 0,
    hitFlash: 0,
    cannonTier: state?.cannonTier ?? 0,
    // Missiles are finite and start empty: they are a reward, not a default.
    missileAmmo: state?.missileAmmo ?? 0,
    alive: true,
    deadFor: 0,
  };
  scene.add(player.root);
  scene.add(player.healthBar.sprite);
  refreshHud();

  const bullets = [];
  const missiles = [];
  const enemies = [];
  const pickups = [];
  const particles = [];
  const damageTexts = [];

  let spawnTimer = 1.0;

  function spawnExplosion(pos, count = 12, _color = 0xff6600) {
    sound.playExplosion();
    for (let i = 0; i < count; i++) {
      const geo = new THREE.DodecahedronGeometry(rng.range(0.4, 1.2), 0);
      const mat = makeToonMat(rng.choice([0xff3300, 0xffaa00, 0xffffff, 0x333333]), toonGradient);
      const pMesh = new THREE.Mesh(geo, mat);
      addOutline(pMesh, 1.15);
      pMesh.position.set(pos.x, pos.y, rng.range(-0.5, 0.5));
      scene.add(pMesh);

      const angle = rng.range(0, Math.PI * 2);
      const spd = rng.range(6, 22);
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

  function spawnEnemy() {
    const isAce = rng.chance(0.3);
    const enemyData = {
      ...createFighterMesh(isAce ? 0x9b30ff : 0x6030c0, 0xffd700, toonGradient),
      pos: new THREE.Vector2(
        clamp(player.pos.x + (rng.chance(0.5) ? 42 : -42), WORLD.minX + 4, WORLD.maxX - 4),
        rng.range(WORLD.groundY + 6, 30),
      ),
      vel: new THREE.Vector2(-rng.range(10, 16), rng.range(-3, 3)),
      angle: Math.PI,
      speed: isAce ? 18 : 13,
      hp: isAce ? 60 : 30,
      maxHp: isAce ? 60 : 30,
      isAce,
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

  // --- Minimap ---------------------------------------------------------
  // The arena is four times the width of the view, so without this the
  // player has no idea where the fight is. Drawn in 2D over the canvas
  // rather than in the scene: it is chrome, not world.
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
      border: 3px solid #0a1220; background: rgba(6, 14, 26, 0.72);
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

    // Ground line — the thing that kills you, so it is drawn as a hazard.
    mapCtx.fillStyle = '#2f6b3a';
    mapCtx.fillRect(0, MAP_H - 4, MAP_W, 4);

    // The slice of the arena currently on screen.
    const halfView = camera.position.z * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
    mapCtx.strokeStyle = 'rgba(255,255,255,0.25)';
    mapCtx.lineWidth = 1;
    mapCtx.strokeRect(
      mapX(camera.position.x - halfView),
      1,
      mapX(camera.position.x + halfView) - mapX(camera.position.x - halfView),
      MAP_H - 2,
    );

    for (const pu of pickups)
      blip(pu.pos.x, pu.pos.y, 4, pu.kind === 'cannon' ? '#00ffbb' : '#ff9922');
    for (const e of enemies) blip(e.pos.x, e.pos.y, 5, e.isAce ? '#ff44aa' : '#b070ff');

    if (player.alive) {
      // Player drawn as a heading triangle: on a map this small, direction is
      // more useful than an exact position.
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

  /** Drop a collectable where an enemy died. */
  function spawnPickup(pos, kind) {
    const isCannon = kind === 'cannon';
    const geo = isCannon
      ? new THREE.OctahedronGeometry(0.7, 0)
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
      life: 14,
      spin: rng.range(2, 4),
    });
  }

  /**
   * Destroy the player. Used by both gunfire and terrain — a crash is not a
   * special case, it is simply lethal damage from the ground.
   */
  function killPlayer(reason) {
    if (!player.alive) return;
    player.alive = false;
    player.deadFor = 0;
    player.hp = 0;
    player.root.visible = false;
    spawnExplosion(player.pos, 34, 0x00ff99);
    // A crash should register in the body before it registers on the HUD.
    feel.hitstop(0.16);
    feel.shake(1.5, 4.5);
    feel.timeScale(0.35, 1.6);
    damageTexts.push(createDamageText(scene, reason, player.pos, '#ff2255'));
  }

  function respawn() {
    player.alive = true;
    player.hp = player.maxHp;
    player.pos.set(rng.range(-30, 30), 22);
    player.vel.set(0, 0);
    player.angle = 0;
    player.root.visible = true;
    // Crashing costs progress — the cannon drops a tier and missiles are lost,
    // so the drops you collected are worth protecting.
    player.cannonTier = Math.max(0, player.cannonTier - 1);
    player.missileAmmo = 0;
    refreshHud();
  }

  return {
    update(rawDt, _elapsed) {
      // One value governs hitstop, shake and slow-motion; everything below
      // integrates the result without knowing they exist.
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
        player.deadFor += rawDt; // real time: the world is in slow motion
        if (player.deadFor > 2.2) respawn();
      }

      // --- Player Flight Control ---
      const steer = player.alive ? keys.axis(['ArrowRight', 'KeyD'], ['ArrowLeft', 'KeyA']) : 0;
      const throttle = player.alive && keys.anyDown('ArrowUp', 'KeyW');
      const brake = player.alive && keys.anyDown('ArrowDown', 'KeyS');

      const turnSpeed = 3.8;
      player.angle += steer * turnSpeed * dt;

      let targetSpeed = 16;
      if (throttle) {
        targetSpeed = 26;
        player.flame.visible = true;
        player.flame.scale.set(rng.range(0.9, 1.4), rng.range(0.8, 1.2), 1);
        sound.updateEngine(320);
      } else if (brake) {
        targetSpeed = 8;
        player.flame.visible = false;
        sound.updateEngine(120);
      } else {
        player.flame.visible = rng.chance(0.2);
        player.flame.scale.set(0.6, 0.6, 1);
        sound.updateEngine(180);
      }

      player.speed = damp(player.speed, targetSpeed, 6, dt);

      const fwdX = Math.cos(player.angle);
      const fwdY = Math.sin(player.angle);

      player.vel.x = damp(player.vel.x, fwdX * player.speed, 5, dt);
      player.vel.y = damp(player.vel.y, fwdY * player.speed - 2.5, 4, dt);

      player.pos.x += player.vel.x * dt;
      player.pos.y += player.vel.y * dt;

      // Ground is lethal. Previously it bounced you, which taught the player
      // that the floor is furniture; now the terrain is the main hazard and
      // low passes are a real decision.
      if (player.pos.y <= WORLD.groundY) {
        player.pos.y = WORLD.groundY;
        killPlayer('CRASHED');
      }
      // The ceiling is thin air rather than a wall: you stall and sink back.
      if (player.pos.y > WORLD.ceilY) {
        player.pos.y = WORLD.ceilY;
        player.vel.y = Math.min(player.vel.y, -4);
      }
      // Arena walls turn you back hard instead of silently pinning you.
      if (player.pos.x < WORLD.minX) {
        player.pos.x = WORLD.minX;
        player.vel.x = Math.abs(player.vel.x) * 0.4;
      }
      if (player.pos.x > WORLD.maxX) {
        player.pos.x = WORLD.maxX;
        player.vel.x = -Math.abs(player.vel.x) * 0.4;
      }

      player.root.position.set(player.pos.x, player.pos.y, 0);
      player.root.rotation.z = player.angle;
      const targetRoll = -steer * 0.65;
      player.root.rotation.x = damp(player.root.rotation.x, targetRoll, 8, dt);

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

      // --- Weapons: Primary Laser ---
      const cannon = CANNON_TIERS[player.cannonTier];
      player.fireTimer -= dt;
      if (player.alive && keys.anyDown('Space', 'KeyJ', 'KeyZ') && player.fireTimer <= 0) {
        player.fireTimer = cannon.cooldown;
        sound.playLaser();

        // Higher tiers fan their shots, so the upgrade is visible in the air
        // and not only in the damage numbers.
        for (let shot = 0; shot < cannon.shots; shot++) {
          const offset = (shot - (cannon.shots - 1) / 2) * cannon.spread;
          const a = player.angle + offset;
          const ax = Math.cos(a);
          const ay = Math.sin(a);

          const laserMesh = new THREE.Mesh(
            new THREE.BoxGeometry(2.4, 0.22, 0.22),
            new THREE.MeshBasicMaterial({ color: cannon.color }),
          );
          laserMesh.rotation.z = a;
          const muzzle = new THREE.Vector2(player.pos.x + ax * 2.0, player.pos.y + ay * 2.0);
          laserMesh.position.set(muzzle.x, muzzle.y, 0);
          scene.add(laserMesh);

          bullets.push({
            mesh: laserMesh,
            pos: muzzle,
            vel: new THREE.Vector2(ax * cannon.speed, ay * cannon.speed),
            isPlayer: true,
            damage: cannon.damage,
            life: 1.2,
          });
        }
      }

      // --- Weapons: Swarm Missiles ---
      player.missileTimer -= dt;
      if (
        player.alive &&
        player.missileAmmo > 0 &&
        keys.anyDown('KeyX', 'KeyK', 'ShiftLeft', 'ShiftRight') &&
        player.missileTimer <= 0
      ) {
        player.missileTimer = 0.45;
        player.missileAmmo--;
        refreshHud();
        sound.playMissile();

        const mGeo = new THREE.ConeGeometry(0.3, 1.2, 5);
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
          vel: new THREE.Vector2(fwdX * 12, fwdY * 12),
          angle: player.angle + rng.range(-0.4, 0.4),
          speed: 15,
          damage: 35,
          life: 3.5,
          trail: new RibbonTrail(scene, 40, 0xffeebb, 0.25),
        });
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
            if (b.pos.distanceTo(e.pos) < 2.0) {
              e.hp -= b.damage;
              e.hitFlash = 0.08;
              damageTexts.push(createDamageText(scene, `-${b.damage}`, e.pos, '#00ff99'));
              sound.playHit();
              hit = true;
              break;
            }
          }
        } else {
          if (player.alive && b.pos.distanceTo(player.pos) < 1.6) {
            feel.hitstop(0.03);
            feel.shake(0.25, 10);
            player.hp -= b.damage;
            player.hitFlash = 0.1;
            damageTexts.push(createDamageText(scene, `-${b.damage}`, player.pos, '#ff3344'));
            sound.playPlayerHit();
            hit = true;
          }
        }

        if (hit || b.life <= 0 || Math.abs(b.pos.x) > 35 || Math.abs(b.pos.y) > 25) {
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

        let target = null;
        let minDist = 30;
        for (const e of enemies) {
          const d = m.pos.distanceTo(e.pos);
          if (d < minDist) {
            minDist = d;
            target = e;
          }
        }

        if (target) {
          const desiredAngle = Math.atan2(target.pos.y - m.pos.y, target.pos.x - m.pos.x);
          let diff = desiredAngle - m.angle;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          m.angle += clamp(diff, -5 * dt, 5 * dt);
        }

        m.speed = damp(m.speed, 35, 4, dt);
        m.pos.x += Math.cos(m.angle) * m.speed * dt;
        m.pos.y += Math.sin(m.angle) * m.speed * dt;

        m.mesh.position.set(m.pos.x, m.pos.y, 0);
        m.mesh.rotation.z = m.angle;

        m.trail.addPoint(new THREE.Vector3(m.pos.x, m.pos.y, 0), new THREE.Vector3(0, 0, 1));
        m.trail.update(dt);

        let hit = false;
        for (const e of enemies) {
          if (m.pos.distanceTo(e.pos) < 2.2) {
            e.hp -= m.damage;
            e.hitFlash = 0.15;
            spawnExplosion(m.pos, 8, 0xffaa00);
            damageTexts.push(createDamageText(scene, `CRIT -${m.damage}`, e.pos, '#ffcc00'));
            hit = true;
            break;
          }
        }

        if (hit || m.life <= 0) {
          if (hit) spawnExplosion(m.pos, 10);
          scene.remove(m.mesh);
          m.mesh.geometry.dispose();
          m.mesh.material.dispose();
          m.trail.dispose();
          missiles.splice(i, 1);
        }
      }

      // --- Spawn Enemies Wave ---
      spawnTimer -= dt;
      if (spawnTimer <= 0 && enemies.length < 5) {
        spawnEnemy();
        spawnTimer = rng.range(1.5, 3.5);
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
        e.angle += clamp(diff, -2.8 * dt, 2.8 * dt);

        const efwdX = Math.cos(e.angle);
        const efwdY = Math.sin(e.angle);

        e.vel.x = damp(e.vel.x, efwdX * e.speed, 3, dt);
        e.vel.y = damp(e.vel.y, efwdY * e.speed, 3, dt);

        e.pos.x += e.vel.x * dt;
        e.pos.y += e.vel.y * dt;

        e.root.position.set(e.pos.x, e.pos.y, 0);
        e.root.rotation.z = e.angle;
        e.root.rotation.x = damp(e.root.rotation.x, -diff * 0.4, 6, dt);

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

        e.fireTimer -= dt;
        if (e.fireTimer <= 0 && dist < 25 && Math.abs(diff) < 0.4) {
          e.fireTimer = rng.range(1.2, 2.4);
          sound.playEnemyLaser();

          const laserGeo = new THREE.BoxGeometry(1.8, 0.2, 0.2);
          const laserMat = new THREE.MeshBasicMaterial({ color: 0xff3366 });
          const laserMesh = new THREE.Mesh(laserGeo, laserMat);
          laserMesh.rotation.z = e.angle;
          laserMesh.position.set(e.pos.x + efwdX * 1.8, e.pos.y + efwdY * 1.8, 0);
          scene.add(laserMesh);

          bullets.push({
            mesh: laserMesh,
            pos: new THREE.Vector2(e.pos.x + efwdX * 1.8, e.pos.y + efwdY * 1.8),
            vel: new THREE.Vector2(efwdX * 45, efwdY * 45),
            isPlayer: false,
            damage: 10,
            life: 1.5,
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
          feel.hitstop(0.05);
          feel.shake(0.35, 8);
          // Aces are the ones worth hunting, so they carry the better drop.
          if (e.isAce ? rng.chance(0.75) : rng.chance(0.3)) {
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
          Math.abs(e.pos.x - player.pos.x) > 90 ||
          e.pos.y < WORLD.groundY - 6 ||
          e.pos.y > WORLD.ceilY + 10
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
        // Drift upward and settle, so a drop over open air stays reachable.
        pu.vy = damp(pu.vy, 0, 1.5, dt);
        pu.pos.y += pu.vy * dt;
        pu.mesh.position.set(pu.pos.x, pu.pos.y, 0);
        pu.mesh.rotation.z += pu.spin * dt;
        pu.mesh.rotation.y += pu.spin * 0.6 * dt;
        // Blink out the last two seconds rather than vanishing unannounced.
        pu.mesh.visible = pu.life > 2 || Math.floor(pu.life * 8) % 2 === 0;

        if (player.alive && pu.pos.distanceTo(player.pos) < 2.4) {
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
            player.missileAmmo += 3;
            damageTexts.push(createDamageText(scene, '+3 MISSILES', pu.pos, '#ff9922'));
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

      // --- Camera: follow the player across an arena wider than the view ---
      // Lead the camera in the direction of travel so you see where you are
      // going rather than where you have been.
      const lookAhead = clamp(player.vel.x * 0.35, -10, 10);
      const halfView = camera.position.z * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
      camTarget.x = clamp(player.pos.x + lookAhead, WORLD.minX + halfView, WORLD.maxX - halfView);
      camTarget.y = clamp(player.pos.y * 0.6, WORLD.groundY + 10, WORLD.ceilY - 6);
      camera.position.x = damp(camera.position.x, camTarget.x, 3.5, rawDt);
      camera.position.y = damp(camera.position.y, camTarget.y, 2.5, rawDt);
      // Shake is applied after the follow, or the damping would smooth it away.
      camera.position.x += feel.offset.x;
      camera.position.y += feel.offset.y;

      // Background follows the camera at a fraction of its speed for depth.
      env.envGroup.position.x = camera.position.x * 0.75;

      drawMinimap();

      // --- Background Clouds Parallax ---
      for (const cloud of env.clouds) {
        cloud.position.x -= cloud.userData.speed * dt;
        if (cloud.position.x < camera.position.x - 80) {
          cloud.position.x = camera.position.x + 80;
          cloud.position.y = rng.range(0, 24);
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
        cannonTier: player.cannonTier,
        missileAmmo: player.missileAmmo,
      };
    },

    dispose() {
      for (const off of unbind) off();
      keys.dispose();
      scoreEl?.remove();
      mapEl?.remove();
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
