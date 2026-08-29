// main.js — STRIKEVECTOR: scene, input, camera, targeting, game flow.

import { Keyboard } from '#engine/input.js';
import { damp } from '#engine/math.js';
import { createComposer, FULLSCREEN_VERTEX_SHADER } from '#engine/post.js';
import { createRenderer, handleResize } from '#engine/render.js';
import * as THREE from 'three';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Audio } from './audio.js';
import { buildCloudSystem } from './clouds.js';
import {
  Cannon,
  Enemy,
  ExhaustFX,
  explode,
  Missiles,
  resetKills,
  updateExplosions,
  VaporTrails,
} from './combat.js';
import { FlightModel } from './flight.js';
import { Hud } from './hud.js';
import { applyJetTemplate, loadF22Model, makeJetRig } from './jet.js';
import { buildSky, Terrain, terrainHeightAt } from './terrain.js';

// ---------------------------------------------------------------- setup
const glCanvas = document.getElementById('gl');
const hudCanvas = document.getElementById('hud');
const overlay = document.getElementById('menu');
const msgEl = document.getElementById('msg');

// Logarithmic depth: at continental range a conventional depth buffer with a
// 1 m near plane has hundreds of metres of granularity past 100 km, which
// z-fights terrain against the ocean plane.
const renderer = createRenderer(glCanvas, {
  logarithmicDepthBuffer: true,
  maxPixelRatio: 1.35,
  toneMappingExposure: 1.06,
});

const scene = new THREE.Scene();
// Fog carries to the edge of the streamed field so the outermost level
// dissolves into haze instead of ending at a visible line.
scene.fog = new THREE.Fog(0xa8c2d8, 15000, 150000);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 1, 400000);
const START_ALTITUDE = 3300;

// Post: speed-reactive motion blur + gentle bokeh.
const composer = createComposer(renderer, scene, camera, { depth: true });

// Clouds raymarch the scene depth, so they run immediately after the render
// pass: they always read the untouched scene + its depth texture here, and
// write into the other buffer — regardless of how many passes are enabled
// after them (the swap parity stays fixed). Motion blur and heat haze then
// apply on top, blurring the clouds too.
const cloudSystem = buildCloudSystem(renderer);
const cloudPass = new ShaderPass(cloudSystem.shader);
// The cloud pass reads no depth texture (see clouds.js), so it only depends
// on sitting before the tone-mapping OutputPass.
composer.addPass(cloudPass);

// Player plane over clouds: the jet lives on render layer 1 (excluded from the
// main scene render and therefore from the cloud raymarch's coverage), and this
// pass draws it back on top after the clouds composite. Depth is cleared so the
// jet always wins; terrain/enemies/trails stay on layer 0 and occlude normally.
class JetOverlayPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    // Renders into readBuffer (like RenderPass): the jet is composited onto
    // the same buffer that carries the cloud output, so later passes (blur,
    // heat, tone map) see the finished image. needsSwap stays false.
    this.needsSwap = false;
  }
  render(renderer, _writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    this.camera.layers.set(1);
    renderer.render(this.scene, this.camera);
    this.camera.layers.set(0);
    renderer.autoClear = oldAutoClear;
  }
}
const blurPass = new AfterimagePass(0.0); // damp set per-frame from speed
composer.addPass(blurPass);

const bokehPass = new BokehPass(scene, camera, {
  focus: 2500,
  aperture: 0.00006,
  maxblur: 0.005,
});
bokehPass.enabled = true;
composer.addPass(bokehPass);

// The jet overlay sits AFTER the motion blur AND the DOF, so the airframe
// never picks up either — the world blurs with speed and distance, the plane
// stays sharp.
const jetOverlayPass = new JetOverlayPass(scene, camera);
composer.addPass(jetOverlayPass);

// Heat haze: screen-space refraction ripples behind engines + acceleration shockwave
const HeatShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uPoints: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uShock: { value: new THREE.Vector4(0, 0, 0, 0) }, // xy: center screen uv, z: radius, w: intensity
  },
  vertexShader: FULLSCREEN_VERTEX_SHADER,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect;
    uniform vec4 uPoints[6]; // xy: screen uv, z: strength, w: radius
    uniform vec4 uShock;     // xy: center uv, z: radius, w: intensity
    varying vec2 vUv;
    void main() {
      vec2 off = vec2(0.0);
      float totalStr = 0.0;
      vec3 fireGlow = vec3(0.0);

      // 1. Supersonic Acceleration Shockwave Ring Distortion
      if (uShock.w > 0.001) {
        vec2 sd = (vUv - uShock.xy) * vec2(uAspect, 1.0);
        float sr = length(sd);
        float diff = sr - uShock.z;
        float waveProfile = sin(diff * 75.0) * exp(-diff * diff * 1600.0);
        vec2 shockOff = (sr > 0.0001 ? sd / sr : vec2(0.0)) * waveProfile * 0.024 * uShock.w;
        off += shockOff;
        totalStr += abs(waveProfile) * uShock.w * 1.5;
      }

      for (int i = 0; i < 6; i++) {
        vec4 p = uPoints[i];
        if (p.z <= 0.0 && p.w <= 0.0) continue;
        vec2 d = (vUv - p.xy) * vec2(uAspect, 1.0);
        float r = length(d);
        float fall = smoothstep(p.w, 0.0, r);
        float t = uTime * 28.0 + r * 45.0 + float(i) * 2.3;

        // 2. Refraction heat distortion
        vec2 wave = vec2(
          sin(t * 1.2 + d.y * 65.0) + cos(t * 0.8 + d.x * 55.0) * 0.5,
          cos(t * 1.4 + d.x * 65.0) + sin(t * 0.9 + d.y * 55.0) * 0.5
        );
        float heatIntensity = max(p.z, 0.25);
        off += wave * 0.0024 * fall * heatIntensity;
        totalStr += fall * heatIntensity;

        // 3. Fire post FX: ONLY active when afterburner (p.z > 0.05) is engaged
        if (p.z > 0.05) {
          float normR = r / max(0.001, p.w);
          float coreGlow  = exp(-normR * 5.0) * 1.6;
          float outerGlow = exp(-normR * 2.2) * 0.85;
          float wideGlow  = exp(-normR * 0.9) * 0.35;
          float streak    = exp(-abs(d.y) * 95.0) * exp(-abs(d.x) * 10.0 / max(0.001, p.w)) * 0.6;
          float flicker   = 0.92 + sin(uTime * 48.0 + float(i) * 3.7) * 0.08;

          vec3 flameRGB = vec3(1.0, 0.96, 0.88) * coreGlow
                        + vec3(1.0, 0.55, 0.12) * outerGlow
                        + vec3(0.92, 0.18, 0.02) * wideGlow
                        + vec3(0.35, 0.70, 1.0) * streak;

          fireGlow += flameRGB * p.z * flicker;
        }
      }

      vec4 baseCol;
      if (totalStr > 0.01) {
        // Multi-tap turbulent fire diffusion & heat smear across the flame cone
        vec4 s0 = texture2D(tDiffuse, vUv + off);
        vec4 s1 = texture2D(tDiffuse, vUv + off * 1.35 + vec2(0.0016, 0.0008) * totalStr);
        vec4 s2 = texture2D(tDiffuse, vUv + off * 0.70 - vec2(0.0016, 0.0008) * totalStr);
        vec4 s3 = texture2D(tDiffuse, vUv + off * 1.15 + vec2(-0.0008, 0.0016) * totalStr);
        vec4 s4 = texture2D(tDiffuse, vUv + off * 0.85 - vec2(-0.0008, 0.0016) * totalStr);
        baseCol = s0 * 0.36 + (s1 + s2 + s3 + s4) * 0.16;

        // Chromatic dispersion
        baseCol.r = texture2D(tDiffuse, vUv + off * 1.22).r;
        baseCol.b = texture2D(tDiffuse, vUv + off * 0.78).b;
      } else {
        baseCol = texture2D(tDiffuse, vUv);
      }

      gl_FragColor = vec4(baseCol.rgb + fireGlow, 1.0);
    }`,
};
const heatPass = new ShaderPass(HeatShader);
composer.addPass(heatPass);

const sun = new THREE.DirectionalLight(0xfff2dd, 1.5);
const SUN_DIR = new THREE.Vector3(0.45, 0.5, -0.6).normalize();
sun.position.copy(SUN_DIR).multiplyScalar(10000);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SC = 4200; // shadow frustum half-extent around the player
sun.shadow.camera.left = -SC;
sun.shadow.camera.right = SC;
sun.shadow.camera.top = SC;
sun.shadow.camera.bottom = -SC;
sun.shadow.camera.near = 100;
sun.shadow.camera.far = 30000;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target); // target must be in the scene for light.updateMatrixWorld
const hemi = new THREE.HemisphereLight(0xbcd7f0, 0x3a4635, 0.85);
scene.add(hemi);

const sky = buildSky(scene);
const terrain = new Terrain(scene, cloudSystem);

// Lens water: droplets fade in when the camera is inside dense cloud
// (wetness driven by cloudDensityAt in cloudSystem.update). After heat so
// the refraction ripples don't smear the droplets; before tone mapping.
const dropletPass = new ShaderPass(cloudSystem.dropletShader);
composer.addPass(dropletPass);
composer.addPass(new OutputPass());

const hud = new Hud(hudCanvas);
const audio = new Audio();

// ---------------------------------------------------------------- player
const playerJet = makeJetRig({ player: true });
playerJet.traverse((o) => {
  if (o.isMesh) o.castShadow = true;
});
scene.add(playerJet);
// The player airframe renders on layer 1 so the JetOverlayPass can draw it
// over the clouds (see the pass above). Must be re-applied whenever the GLB
// template swaps in new child nodes — they default back to layer 0.
function setPlayerJetLayer() {
  playerJet.traverse((o) => o.layers.set(1));
}
setPlayerJetLayer();
// Lights need layer 1 enabled or the jet renders unlit in the overlay pass.
sun.layers.enable(1);
hemi.layers.enable(1);

// Upgrade to the real F-22 model when it arrives; keep procedural fallback.
loadF22Model('assets/models/f22.glb')
  .then((template) => {
    applyJetTemplate(playerJet, template);
    setPlayerJetLayer();
    for (const e of world.enemies) applyJetTemplate(e.mesh, template);
  })
  .catch(() => {
    /* procedural jets stay */
  });

const player = new FlightModel();
Object.assign(player, {
  gunAmmo: 650,
  missileCount: 8,
  hull: 100,
  alive: true,
});
player.reset(new THREE.Vector3(0, START_ALTITUDE, 0), 0);

// chase-camera rig
const _chaseOffset = new THREE.Vector3(0, 4.5, 26);
let camMode = 'chase'; // 'chase' | 'cockpit'

// ---------------------------------------------------------------- world state
const cannon = new Cannon(scene);
const missiles = new Missiles(scene);
const vapor = new VaporTrails(scene);
const exhaust = new ExhaustFX(scene);

const world = {
  enemies: [],
  enemyMissiles: [],
  target: null,
  lockState: 'none', // 'none' | 'locking' | 'locked'
  lockProgress: 0,
  time: 0,
  wave: 0,
  killTimer: 0,
};

function spawnWave(n) {
  world.wave++;
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 5000 + Math.random() * 5000;
    const pos = new THREE.Vector3(
      player.position.x + Math.cos(ang) * dist,
      Math.max(
        terrainHeightAt(
          player.position.x + Math.cos(ang) * dist,
          player.position.z + Math.sin(ang) * dist,
        ) + 1500,
        2000,
      ) +
        Math.random() * 1500,
      player.position.z + Math.sin(ang) * dist,
    );
    const e = new Enemy(scene, pos, Math.random() * 360, 0.8 + world.wave * 0.12);
    world.enemies.push(e);
  }
  showMsg(`WAVE ${world.wave} — ${n} BANDITS INBOUND`, 2.6);
}

function showMsg(text, secs) {
  msgEl.textContent = text;
  msgEl.style.opacity = 1;
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => {
    msgEl.style.opacity = 0;
  }, secs * 1000);
}

// ---------------------------------------------------------------- input
const keys = new Keyboard();
keys.onPress('KeyC', () => {
  camMode = camMode === 'chase' ? 'cockpit' : 'chase';
});
keys.onPress('KeyT', () => cycleTarget(1));
keys.onPress('KeyY', () => cycleTarget(-1));
keys.onPress('KeyF', () => fireMissile());
keys.onPress('KeyH', () => showMsg(`TERRAIN VIEW // ${terrain.cycleDebugMode()}`, 1.5));
keys.onPress('KeyR', () => restart());

function readControls(dt) {
  const c = player.controls;
  const ease = 7;

  // S/Down pulls back on the stick, so pitch is inverted relative to screen up.
  const pitchIn = keys.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
  const rollIn = keys.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
  const yawIn = keys.axis('KeyQ', 'KeyE');

  c.pitch = damp(c.pitch, pitchIn, ease, dt);
  c.roll = damp(c.roll, rollIn, ease, dt);
  c.yaw = damp(c.yaw, yawIn, ease, dt);

  const thrUp = keys.anyDown('ShiftLeft', 'ShiftRight');
  const thrDn = keys.anyDown('ControlLeft', 'ControlRight', 'KeyZ');
  const rate = 0.55;
  if (thrUp) c.throttle = Math.min(1, c.throttle + rate * dt);
  if (thrDn) c.throttle = Math.max(0, c.throttle - rate * dt);
  c.afterburner = c.throttle > 0.97 && thrUp;
  c.airbrake = !!thrDn && c.throttle < 0.05;

  if (keys.isDown('Space') && player.gunAmmo > 0) {
    gunTimer -= dt;
    if (gunTimer <= 0) {
      gunTimer = 0.075;
      player.gunAmmo--;
      const muzzle = player.position
        .clone()
        .addScaledVector(player.forward, 14)
        .addScaledVector(player.up, -0.6);
      cannon.fire(muzzle, player.forward, player.speed, true);
      audio.gun();
    }
  }
}

let gunTimer = 0;
let fpsAccum = 0,
  fpsFrames = 0,
  qualityLevel = 2;

// ---------------------------------------------------------------- targeting
function cycleTarget(dir) {
  const alive = world.enemies.filter((e) => e.alive);
  if (!alive.length) {
    world.target = null;
    return;
  }
  let idx = alive.indexOf(world.target);
  idx = (idx + dir + alive.length) % alive.length;
  world.target = alive[idx];
  world.lockProgress = 0;
  world.lockState = 'locking';
}

function nearestThreat() {
  let best = null,
    bestD = Infinity;
  for (const e of world.enemies) {
    if (!e.alive) continue;
    const d = e.fm.position.distanceTo(player.position);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function updateLock(dt) {
  if (!world.target?.alive) {
    world.target = nearestThreat();
    world.lockState = world.target ? 'locking' : 'none';
    world.lockProgress = 0;
  }
  if (!world.target) {
    audio.setLockTone('off');
    return;
  }

  const t = world.target;
  const dist = t.fm.position.distanceTo(player.position);
  const angle = player.forward.angleTo(t.fm.position.clone().sub(player.position).normalize());

  const inCone = angle < 0.35 && dist < 6500;
  if (world.lockState === 'locking') {
    if (inCone) {
      world.lockProgress += dt / (1.1 + angle * 2.5);
      if (world.lockProgress >= 1) {
        world.lockProgress = 1;
        world.lockState = 'locked';
      }
    } else {
      world.lockProgress = Math.max(0, world.lockProgress - dt * 1.4);
      if (world.lockProgress <= 0 && !inCone && angle > 0.9) {
        world.lockState = 'none';
      }
    }
  } else if (world.lockState === 'locked') {
    if (!inCone) {
      world.lockProgress -= dt * 1.2;
      if (world.lockProgress <= 0.2) {
        world.lockProgress = 0;
        world.lockState = 'locking';
      }
    } else {
      world.lockProgress = 1;
    }
  } else if (inCone) {
    world.lockState = 'locking';
  }
  audio.setLockTone(
    world.lockState === 'locked' ? 'locked' : world.lockState === 'locking' ? 'locking' : 'off',
  );
}

function fireMissile() {
  if (!player.alive) return;
  if (player.missileCount <= 0) {
    showMsg('MISSILES EXPENDED', 1.2);
    return;
  }
  if (world.lockState !== 'locked' || !world.target || !world.target.alive) {
    showMsg('NO LOCK', 1.2);
    return;
  }
  player.missileCount--;
  const from = player.position.clone().addScaledVector(player.right, player.orbitSide ? -8 : 8);
  player.orbitSide = !player.orbitSide;
  missiles.launch(from, player.forward, player.speed + 60, world.target, true);
  audio.missile();
}

// callbacks for enemy fire
const combatCallbacks = {
  onEnemyFire(enemy, _playerFm, mis, can) {
    // fire an AI missile ~40% of the time, otherwise gun burst
    if (Math.random() < 0.4) {
      const from = enemy.fm.position.clone().addScaledVector(enemy.fm.forward, 12);
      const m = mis.launch(
        from,
        enemy.fm.forward,
        enemy.fm.speed + 40,
        {
          position: player.position,
          velocity: player.velocity,
          alive: player.alive,
        },
        false,
      );
      world.enemyMissiles.push(m);
      audio.warningBeep(); // HUD draws the blinking MISSILE — EVADE warning
    } else {
      for (let i = 0; i < 6; i++) {
        setTimeout(() => {
          if (!enemy.alive || !player.alive) return;
          can.fire(
            enemy.fm.position.clone().addScaledVector(enemy.fm.forward, 12),
            enemy.fm.forward
              .clone()
              .lerp(player.position.clone().sub(enemy.fm.position).normalize(), 0.55)
              .normalize(),
            enemy.fm.speed,
            false,
          );
        }, i * 90);
      }
    }
  },
  onHit(m) {
    if (m.friendly) {
      if (m.target?.damage) m.target.damage(60, 'missile');
      explode(scene, m.pos, 1.4, { onExplode: () => audio.explosion(1) });
    } else {
      damagePlayer(28);
      explode(scene, m.pos, 1.2, { onExplode: () => audio.explosion(1) });
    }
  },
  onExplode() {
    audio.explosion(1);
  },
};

function damagePlayer(amount) {
  if (!player.alive) return;
  player.hull -= amount;
  if (player.hull <= 0) killPlayer('AIRCRAFT DESTROYED');
}

function killPlayer(reason) {
  if (!player.alive) return;
  player.alive = false;
  explode(scene, player.position, 2, { onExplode: () => audio.explosion(2) });
  playerJet.visible = false;
  setTimeout(() => showDeathScreen(reason), 1200);
}

function showDeathScreen(reason) {
  overlay.innerHTML = `
    <div id="deathTitle">${reason}</div>
    <div id="deathStats">
      BANDITS DOWN: ${Enemy.kills} &nbsp;·&nbsp; WAVES CLEARED: ${Math.max(0, world.wave - 1)}<br>
      PRESS <b style="color:#eaf4ff">R</b> TO RE-ARM AND RESTART
    </div>
    <button id="startBtn">FLY AGAIN</button>`;
  overlay.classList.remove('hidden');
  overlay.querySelector('#startBtn').addEventListener('click', restart);
  audio.setLockTone('off');
}

function restart() {
  for (const e of world.enemies) if (e.alive) scene.remove(e.mesh);
  world.enemies.length = 0;
  for (const m of missiles.list) scene.remove(m.obj);
  missiles.list.length = 0;
  world.enemyMissiles.length = 0;
  world.target = null;
  world.lockState = 'none';
  world.wave = 0;
  resetKills();
  player.reset(new THREE.Vector3(0, START_ALTITUDE, 0), 0);
  player.gunAmmo = 650;
  player.missileCount = 8;
  player.hull = 100;
  player.alive = true;
  player.controls.throttle = 0.7;
  playerJet.visible = true;
  overlay.classList.add('hidden');
  spawnWave(3);
  showMsg('WEAPONS FREE — GOOD HUNTING', 2.6);
}

// ---------------------------------------------------------------- camera
function updateCamera(dt) {
  if (camMode === 'cockpit') {
    // Rigid: camera is welded to the airframe.
    camera.position
      .copy(player.position)
      .addScaledVector(player.forward, 4.2)
      .addScaledVector(player.up, 0.95);
    camera.quaternion.copy(player.quaternion);
  } else {
    // Rigid chase: exact follow in the jet's body frame — no lag at any speed.
    camera.position
      .copy(player.position)
      .addScaledVector(player.forward, -18.5)
      .addScaledVector(player.up, 4.4);
    const lookAt = player.position
      .clone()
      .addScaledVector(player.forward, 70)
      .addScaledVector(player.up, 0.8);
    const m = new THREE.Matrix4().lookAt(camera.position, lookAt, player.up);
    camera.quaternion.setFromRotationMatrix(m);
  }
  // subtle FOV kick with speed / afterburner
  const targetFov = 66 + Math.min(player.speed / 22, 14) + (player.controls.afterburner ? 4 : 0);
  camera.fov = damp(camera.fov, targetFov, 3, dt);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- warnings
function collectWarnings() {
  const list = [];
  const agl = player.altitude - terrainHeightAt(player.position.x, player.position.z);
  if (player.alive) {
    if (player.stalled) list.push({ text: 'STALL — STALL', level: 'danger' });
    if (agl < 400 && player.velocity.y < -10) list.push({ text: 'PULL UP', level: 'danger' });
    if (player.hull < 35) list.push({ text: 'HULL CRITICAL', level: 'danger' });
    if (world.enemyMissiles.length) list.push({ text: 'MISSILE — EVADE', level: 'danger' });
    else if (
      world.lockState === 'locked' &&
      world.target &&
      world.target.fm.position.distanceTo(player.position) < 2000
    ) {
      list.push({ text: 'IN RANGE — BANDIT LOCKED', level: 'warn' });
    }
  }
  return list;
}

// ---------------------------------------------------------------- loop
let last = performance.now();
let running = false;
let shockTimer = 1.0;
const shockOrigin = new THREE.Vector2(0.5, 0.5);
let lastAB = false;
let lastSpeed = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (!running) return;
  world.time += dt;

  if (player.alive) {
    readControls(dt);
    player.update(dt, terrainHeightAt);
    playerJet.position.copy(player.position);
    playerJet.quaternion.copy(player.quaternion);
    playerJet.visible = camMode !== 'cockpit';
    if (player.crashed) killPlayer('CONTROLLED FLIGHT INTO TERRAIN');
    // High-AoA airframe buffet — visual shake only, flight state untouched.
    const buffet = THREE.MathUtils.clamp(
      (THREE.MathUtils.radToDeg(Math.abs(player.aoa)) - 14) / 8,
      0,
      1,
    );
    if (buffet > 0) {
      const t = world.time * 37;
      playerJet.rotation.setFromQuaternion(playerJet.quaternion, 'XYZ');
      playerJet.rotation.x += Math.sin(t) * 0.012 * buffet;
      playerJet.rotation.z += Math.cos(t * 1.3) * 0.014 * buffet;
    }
    // Wingtip vapor when pulling G (or pulling hard near the stall)
    const gPull = Math.max(0, (Math.abs(player.gLoad) - 2.0) / 4.5); // vapor emission
    vapor.update(dt, player, Math.min(1, gPull + buffet * 0.7));
    exhaust.update(dt, player, playerJet.userData.flames);
    const abOn = !!player.controls.afterburner;
    for (const f of playerJet.userData.flames) {
      f.visible = abOn;
      f.traverse((child) => {
        child.visible = abOn;
      });
      if (abOn) {
        if (f.userData.material) f.userData.material.uniforms.uTime.value = world.time;
        const bs = f.userData.baseScale || { x: 1, y: 1, z: 1 };
        const flutter = 0.96 + Math.sin(world.time * 60.0) * 0.06;
        f.scale.set(bs.x, bs.y, bs.z * flutter);
      }
    }
  }

  // enemies
  for (let i = world.enemies.length - 1; i >= 0; i--) {
    const e = world.enemies[i];
    if (e.alive) {
      e.update(dt, player, missiles, cannon, combatCallbacks);
      // skip exhaust particles for distant enemies — the trails give them away
      if (e.fm.position.distanceTo(player.position) < 5000) {
        exhaust.update(dt, e.fm, e.mesh.userData.flames);
      }
    } else world.enemies.splice(i, 1);
  }

  // wave management
  if (world.enemies.length === 0 && player.alive) {
    world.killTimer += dt;
    if (world.killTimer > 4) {
      world.killTimer = 0;
      spawnWave(Math.min(3 + world.wave, 6));
    }
  }

  // bullets
  cannon.update(dt);
  // bullet hits
  for (const r of cannon.rounds) {
    if (r.player) {
      for (const e of world.enemies) {
        if (!e.alive) continue;
        if (r.pos.distanceTo(e.fm.position) < 30) {
          e.damage(6 + Math.random() * 4, 'gun');
          r.life = 0;
          break;
        }
      }
    } else if (r.pos.distanceTo(player.position) < 26) {
      damagePlayer(4);
      r.life = 0;
    }
  }

  // enemy missile bookkeeping (remove spent ones from the warning list)
  world.enemyMissiles = world.enemyMissiles.filter((m) => missiles.list.includes(m));

  missiles.update(dt, combatCallbacks);
  updateExplosions(dt);

  updateLock(dt);
  updateCamera(dt);
  terrain.update(player.position);
  // keep the sun direction constant wherever we fly (target follows player)
  sun.position.copy(player.position).addScaledVector(SUN_DIR, 10000);
  sun.target.position.copy(player.position);
  sun.target.updateMatrixWorld();
  sky.position.copy(camera.position);
  cloudSystem.update(renderer, camera, dt);

  // HUD
  player._agl = player.altitude - terrainHeightAt(player.position.x, player.position.z);
  hud.setProjection(camera, player.speed > 1 ? player.velocity.clone().normalize() : null);
  hud.draw(dt, player, world, collectWarnings());

  audio.updateEngine(
    player.alive ? player.controls.throttle : 0,
    player.alive && player.controls.afterburner,
    player.speed,
  );

  // Heat haze points: player + nearest enemies' nozzles projected to screen
  heatPass.uniforms.uTime.value = world.time;
  heatPass.uniforms.uAspect.value = camera.aspect;
  const heatSrc = [[player, player.alive, playerJet.userData.flames]];
  for (const e of world.enemies) if (e.alive) heatSrc.push([e.fm, true, e.mesh.userData.flames]);
  let hi = 0;
  for (const [fmv, alive, flames] of heatSrc) {
    if (hi >= 6 || !alive) continue;
    for (const f of flames) {
      if (hi >= 6) break;
      const nozzle = new THREE.Vector3();
      f.getWorldPosition(nozzle);
      // Place the fire glow & heat distortion center right at the engine nozzle exits
      const plumePos = nozzle.addScaledVector(fmv.forward, fmv.controls.afterburner ? -0.15 : 0.0);
      const v = plumePos.clone().project(camera);
      if (
        v.z < 1 &&
        Math.abs(v.x) < 1.2 &&
        Math.abs(v.y) < 1.2 &&
        (fmv.controls.afterburner || fmv.controls.throttle > 0.05)
      ) {
        const dist = camera.position.distanceTo(plumePos);
        const strength = fmv.controls.afterburner ? 1.0 : 0.0;
        heatPass.uniforms.uPoints.value[hi++].set(
          v.x * 0.5 + 0.5,
          v.y * 0.5 + 0.5,
          strength,
          THREE.MathUtils.clamp(55 / dist, 0.015, 0.085),
        );
      }
    }
  }
  for (; hi < 6; hi++) heatPass.uniforms.uPoints.value[hi].set(0, 0, 0, 0);

  // Acceleration shockwave triggering
  const abNow = !!(player.alive && player.controls.afterburner);
  const accel = (player.speed - lastSpeed) / Math.max(dt, 0.001);
  lastSpeed = player.speed;

  // Trigger shockwave on afterburner ignition kick or sudden acceleration surge
  if ((abNow && !lastAB) || (abNow && accel > 45 && shockTimer >= 0.75)) {
    shockTimer = 0.0;
    const jetScr = player.position.clone().addScaledVector(player.forward, -1.5).project(camera);
    if (jetScr.z < 1) {
      shockOrigin.set(jetScr.x * 0.5 + 0.5, jetScr.y * 0.5 + 0.5);
    } else {
      shockOrigin.set(0.5, 0.5);
    }
  }
  lastAB = abNow;

  // Animate the expanding sonic shockwave ring
  if (shockTimer < 1.0) {
    shockTimer += dt * 2.3; // ~0.43s expansion
    const progress = Math.min(1.0, shockTimer);
    const radius = progress * 0.65;
    const intensity = (1.0 - progress) ** 1.6;
    heatPass.uniforms.uShock.value.set(shockOrigin.x, shockOrigin.y, radius, intensity);
  } else {
    heatPass.uniforms.uShock.value.set(0, 0, 0, 0);
  }

  // Motion blur scales with speed: off at a crawl, strong in the merge
  blurPass.uniforms.damp.value = THREE.MathUtils.clamp((player.speed - 120) / 700, 0, 0.62);

  // Perf guard: if the real frame rate sags, shed the expensive effects.
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 2) {
    const fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
    if (fps < 26 && qualityLevel > 0) {
      qualityLevel--;
      if (qualityLevel === 1) bokehPass.enabled = false;
      if (qualityLevel === 0) {
        blurPass.enabled = false;
        renderer.setPixelRatio(1);
        composer.setPixelRatio?.(1);
      }
    }
  }
  // Focus locked to the jet so the airframe stays razor sharp; the tiny
  // aperture/maxblur is what keeps the DOF subtle and far-field only.
  // Focus locked far (the jet is composited after DOF, so it can't be
  // blurred). The 8 km start puts the blur ring squarely on the far
  // low-poly terrain, softening its silhouettes into the horizon.
  bokehPass.uniforms.focus.value = Math.max(camera.position.distanceTo(player.position), 8000);

  composer.render();
}

// ---------------------------------------------------------------- boot
document.getElementById('startBtn').addEventListener('click', () => {
  audio.start();
  overlay.classList.add('hidden');
  if (!running) {
    running = true;
    resetKills();
    spawnWave(3);
    showMsg('WEAPONS FREE — GOOD HUNTING', 2.6);
    requestAnimationFrame(frame);
  }
});

handleResize(renderer, camera, composer);

// render one static frame behind the menu; build the whole field up front
// here, where a pause is free, rather than streaming it in after ENGAGE
terrain.update(player.position, true);
updateCamera(0.016);
composer.render();

// debug/testing handle
window.__dbg = {
  player,
  world,
  terrain,
  camModeRef: { get: () => camMode },
  scene,
  camera,
  renderer,
  composer,
  cloudSystem,
};
