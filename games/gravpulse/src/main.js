import * as THREE from 'three';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { disposeScene } from '#engine/assets.js';
import { damp } from '#engine/math.js';
import { disposeComposer, FULLSCREEN_VERTEX_SHADER } from '#engine/post.js';
import { createRenderer, handleResize } from '#engine/render.js';
import { Sound } from './audio.js';
import { buildEnvironment, loadSceneryModels, updateEnvironment } from './environment.js';
import { Hud } from './hud.js';
import { applyShipModels, playerInput, resolveShipCollisions, Ship, shipEvents } from './ships.js';
import { TRACK_CONFIGS, Track } from './track.js';
import { WeaponSystem } from './weapons.js';

/**
 * Entry point for shared/engine/host.js.
 *
 * The whole game is constructed inside init() rather than at module scope: a
 * hot swap evaluates this module again, and anything built on import would be
 * duplicated with no handle to tear it down.
 *
 * @param {{renderer?: THREE.WebGLRenderer, canvas?: HTMLCanvasElement, state?: object}} ctx
 */
export function init(ctx = {}) {
  // Listeners registered through on() are removed again by dispose(); a stray
  // one would keep steering a race that no longer exists.
  const _unbind = [];
  const on = (target, type, handler, options) => {
    if (!target) return;
    target.addEventListener(type, handler, options);
    _unbind.push(() => target.removeEventListener(type, handler, options));
  };

  // ---------------------------------------------------------------------------
  // renderer / scene
  // ---------------------------------------------------------------------------
  const canvas = ctx.canvas ?? document.getElementById('gl');
  let renderer;
  try {
    // The host owns the WebGL context so it survives hot swaps; fall back to
    // making one when this module is run standalone.
    renderer =
      ctx.renderer ?? createRenderer(canvas, { maxPixelRatio: 2, toneMappingExposure: 1.12 });
  } catch (e) {
    document.body.innerHTML =
      '<div style="color:#dffcff;font-family:monospace;padding:40px">' +
      'WebGL is not available in this browser, so the race cannot start.</div>';
    throw e;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.5, 6000);
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  // magenta rim light from behind-right: two-tone edge lighting on ships
  {
    const rim = new THREE.DirectionalLight('#ff4fa0', 0.4);
    rim.position.set(380, 160, -420);
    scene.add(rim);
    scene.add(rim.target);
  }

  // camera-mounted subtle fill light
  scene.add(camera);
  {
    const head = new THREE.DirectionalLight('#7fa8ff', 0.22);
    head.position.set(0, 6, 10);
    head.target.position.set(0, 0, -18);
    camera.add(head);
    camera.add(head.target);
  }

  // post-processing:
  // render -> subtle DOF -> motion blur (afterimage) -> zoom blur (boost) -> bloom -> output
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.4,
    0.4,
    0.8,
  );
  // Very subtle cinematic bokeh depth of field
  const bokehPass = new BokehPass(scene, camera, {
    focus: 15,
    aperture: 0.0000032,
    maxblur: 0.0014,
  });
  const afterimagePass = new AfterimagePass(0); // damp driven by speed each frame
  // radial blur from screen center while boost pads are active
  const ZoomBlurShader = {
    uniforms: {
      tDiffuse: { value: null },
      strength: { value: 0 }, // 0..1
    },
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float strength;
      varying vec2 vUv;
      void main() {
        vec2 dir = vUv - vec2(0.5);
        float dist = length(dir);
        // keep the screen center clean, ramp up toward the edges
        float amt = strength * 0.22 * smoothstep(0.05, 0.55, dist);
        vec4 sum = vec4(0.0);
        float total = 0.0;
        for (int i = 0; i < 12; i++) {
          float t = float(i) / 11.0;
          vec2 uv = vUv - dir * (amt * t);
          float w = 1.0 - t * 0.55;
          sum += texture2D(tDiffuse, uv) * w;
          total += w;
        }
        gl_FragColor = sum / total;
      }`,
  };
  const zoomPass = new ShaderPass(ZoomBlurShader);
  // Final cinematic grade: vignette + subtle chromatic aberration + film grain.
  // Runs after OutputPass so it grades the display-referred image.
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      vignette: { value: 0.42 },
      caAmount: { value: 0.0035 },
      grain: { value: 0.05 },
    },
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform vec3 uTint;
      uniform float vignette;
      uniform float caAmount;
      uniform float grain;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 dir = vUv - vec2(0.5);
        float dist = length(dir);
        // chromatic aberration grows toward the frame edge
        float ca = caAmount * smoothstep(0.15, 0.75, dist);
        vec2 caDir = normalize(dir + vec2(0.00001));
        float r = texture2D(tDiffuse, vUv - caDir * ca).r;
        vec4 base = texture2D(tDiffuse, vUv);
        float b = texture2D(tDiffuse, vUv + caDir * ca).b;
        vec3 col = vec3(r, base.g, b);
        // per-track color identity
        col *= uTint;
        // vignette
        col *= 1.0 - vignette * smoothstep(0.45, 0.95, dist);
        // animated film grain
        float g = hash(vUv * vec2(1613.0, 919.0) + fract(uTime) * 43.7) - 0.5;
        col += g * grain;
        gl_FragColor = vec4(col, base.a);
      }`,
  };
  const gradePass = new ShaderPass(GradeShader);
  function buildComposer(msaa) {
    const c = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
        type: THREE.HalfFloatType,
        samples: msaa ? 4 : 0,
      }),
    );
    c.setPixelRatio(renderer.getPixelRatio());
    c.setSize(window.innerWidth, window.innerHeight);
    c.addPass(new RenderPass(scene, camera));
    c.addPass(bokehPass);
    c.addPass(afterimagePass);
    c.addPass(zoomPass);
    c.addPass(bloomPass);
    c.addPass(new OutputPass());
    c.addPass(gradePass);
    return c;
  }
  let composer = buildComposer(true);

  // Adaptive quality for weak GPUs.
  //
  // Judged on a rolling window of recent frames, not a lifetime average: a
  // cumulative mean is diluted by every cheap menu frame already banked, so a
  // machine that only struggles once the race and its effects start could never
  // pull the average up far enough to trigger.
  //
  // Sampling also skips a warm-up. The first frames of a race include shader
  // compilation and texture upload, which are one-off costs -- judging on those
  // permanently strips effects from hardware that would have run them fine.
  const WARMUP_FRAMES = 45; // ~0.75s at 60fps: long enough to compile shaders
  const WINDOW_FRAMES = 45;
  const SLOW_FRAME = 0.028; // ~36fps sustained before shedding the next tier
  const perf = { warmup: 0, window: [], acc: 0, tier: 0 };

  /** Shed one tier of load. Cheapest-to-lose effects go first. */
  function degrade() {
    perf.tier++;
    if (perf.tier === 1) {
      // Screen-space blurs are full-resolution passes and the easiest big win.
      bokehPass.enabled = false;
      zoomPass.enabled = false;
      renderer.setPixelRatio(Math.min(renderer.getPixelRatio(), 1.25));
      composer = buildComposer(false); // also drops 4x MSAA
    } else {
      // Still slow: the shadow map costs a whole extra scene render.
      dirLight.castShadow = false;
      renderer.setPixelRatio(1);
      composer = buildComposer(false);
    }
    composer.setSize(window.innerWidth, window.innerHeight);
  }

  function adaptQuality(dt) {
    // Menu frames are far cheaper than racing ones; sampling them only hides
    // the load we actually care about.
    if (perf.tier >= 2 || dt <= 0 || state === S.MENU) return;
    if (perf.warmup < WARMUP_FRAMES) {
      perf.warmup++;
      return;
    }
    perf.window.push(dt);
    perf.acc += dt;
    if (perf.window.length < WINDOW_FRAMES) return;
    if (perf.acc / perf.window.length > SLOW_FRAME) {
      degrade();
      // Re-warm and start a fresh window. The rebuild itself costs a frame or
      // two, and the samples that triggered this tier must not also trigger the
      // next one -- otherwise a single slow patch cascades straight to minimum.
      perf.warmup = 0;
      perf.window.length = 0;
      perf.acc = 0;
      return;
    }
    perf.acc -= perf.window.shift();
  }

  // Unsubscribed by dispose(): the host keeps the window alive across swaps.
  _unbind.push(handleResize(renderer, camera, () => composer));

  const hud = new Hud();
  const audio = new Sound();

  let currentTrackIdx = 0;
  let track = new Track(scene, currentTrackIdx);
  const env = buildEnvironment(scene, renderer);
  loadSceneryModels(scene);
  const dirLight = env.dirLight;
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 50;
  dirLight.shadow.camera.far = 1600;
  dirLight.shadow.camera.left = -110;
  dirLight.shadow.camera.right = 110;
  dirLight.shadow.camera.top = 110;
  dirLight.shadow.camera.bottom = -110;
  dirLight.shadow.bias = -0.0004;
  dirLight.shadow.normalBias = 0.02;
  scene.add(dirLight.target);

  // ---------------------------------------------------------------------------
  // racers
  // ---------------------------------------------------------------------------
  const PLAYER = 0;
  const racers = [];
  for (let i = 0; i < 4; i++) racers.push(new Ship(scene, track, i, i === PLAYER));
  hud.setMinimapTrack(track.minimapPoints());
  hud.updateSelectedTrack(currentTrackIdx, TRACK_CONFIGS[currentTrackIdx]);
  applyTrackGrade(currentTrackIdx);
  applyShipModels(racers);

  // wall scrapes -> energy-bar sound (cooldown keeps it from machine-gunning)
  let lastScrapeT = -1;
  let lastBumpT = -1;
  shipEvents.wallHit = () => {
    const now = performance.now() / 1000;
    if (now - lastScrapeT > 0.25) {
      lastScrapeT = now;
      audio.wallScrape();
    }
  };
  shipEvents.obstacleHit = () => audio.obstacleHit();
  shipEvents.weaponPickup = (ship) => {
    if (ship.isPlayer) audio.weaponPickup();
  };
  shipEvents.weaponFire = (ship) => {
    if (ship.isPlayer) audio.rocketFire();
  };
  shipEvents.shieldPing = (ship) => {
    if (ship.isPlayer) audio.shieldPing();
  };
  shipEvents.explosion = (ship) => {
    if (ship.isPlayer || camera.position.distanceTo(ship.mesh.position) < 280) audio.explosion();
  };

  // combat system (weapon pads, rockets, mines, shields)
  let weapons = new WeaponSystem(scene, track);

  let totalLaps = 3;
  Ship.totalLaps = totalLaps;
  hud.setLapCount(totalLaps);

  // ---------------------------------------------------------------------------
  // track switching & lap options
  // ---------------------------------------------------------------------------
  function applyTrackGrade(index) {
    const cfg = TRACK_CONFIGS[index];
    if (cfg?.grade) gradePass.uniforms.uTint.value.setRGB(cfg.grade[0], cfg.grade[1], cfg.grade[2]);
  }

  function switchTrack(index) {
    if (index < 0 || index >= TRACK_CONFIGS.length) return;
    if (index === currentTrackIdx && track) return;
    currentTrackIdx = index;
    track.dispose();
    weapons.dispose();
    track = new Track(scene, currentTrackIdx);
    weapons = new WeaponSystem(scene, track);
    applyTrackGrade(index);
    for (let i = 0; i < racers.length; i++) {
      racers[i].track = track;
      racers[i].reset(i);
    }
    hud.setMinimapTrack(track.minimapPoints());
    hud.updateSelectedTrack(currentTrackIdx, TRACK_CONFIGS[currentTrackIdx]);
    hud.toast(`TRACK: ${TRACK_CONFIGS[currentTrackIdx].name}`);
    if (audio?.ctx) audio.beep(640, 0.05, 0.15);
    if (state === S.MENU) {
      chaseCam(0.016, true);
    }
  }

  function setTotalLaps(num) {
    totalLaps = Math.max(1, Math.min(15, num));
    Ship.totalLaps = totalLaps;
    hud.setLapCount(totalLaps);
    hud.toast(`RACE: ${totalLaps} ${totalLaps === 1 ? 'LAP' : 'LAPS'}`);
    if (audio?.ctx) audio.beep(520, 0.04, 0.15);
  }

  function goToMenu() {
    state = S.MENU;
    paused = false;
    raceTime = 0;
    countT = 0;
    lastCountShown = -1;
    thrustSince = null;
    finishMode = 'flyby';
    keys.clear();
    playerInput.throttle = 0;
    playerInput.brake = 0;
    playerInput.steer = 0;

    hud.reset(totalLaps);
    hud.showMenu(true);
    hud.updateSelectedTrack(currentTrackIdx, TRACK_CONFIGS[currentTrackIdx]);
    hud.drawMinimap(racers, track.length, true);
    hud.toast('MAIN MENU');

    weapons.clear();
    for (let i = 0; i < racers.length; i++) racers[i].reset(i);

    afterimagePass.uniforms.damp.value = 0;
    zoomPass.uniforms.strength.value = 0;
    audio.update(0, 0, false, false);
    window.arcadeNav?.setVisible(true);
    chaseCam(0.016, true);
  }

  // ---------------------------------------------------------------------------
  // race state
  // ---------------------------------------------------------------------------
  const S = { MENU: 'menu', COUNTDOWN: 'count', RACING: 'race', FINISHED: 'done' };
  let state = S.MENU;
  let countT = 0;
  let lastCountShown = -1;
  let raceTime = 0;
  let paused = false;

  function resetRace() {
    for (let i = 0; i < racers.length; i++) racers[i].reset(i);
    weapons.clear();
    raceTime = 0;
    countT = 3.9;
    lastCountShown = -1;
    finishMode = 'flyby';
    state = S.COUNTDOWN;
    chaseCam(0.016, true); // snap the camera onto the grid
  }

  function beginGame() {
    audio.ensure();
    audio.startMusic();
    resetRace();
    window.arcadeNav?.setVisible(false);
    hud.showMenu(false);
    hud.showHud(true);
    hud.showResults(false);
    setTimeout(() => hud.fadeHint(), 7000);
  }

  // dev convenience: /?autostart skips the menu (used by tooling)
  if (new URLSearchParams(location.search).has('autostart')) setTimeout(beginGame, 600);

  // ---------------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------------
  const keys = new Set();
  let thrustSince = null;
  on(window, 'keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key))
      e.preventDefault();

    if (e.code === 'Escape') {
      goToMenu();
      return;
    }

    // Menu navigation: Left/Right to switch tracks, Up/Down to adjust lap count
    if (state === S.MENU) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        switchTrack((currentTrackIdx - 1 + TRACK_CONFIGS.length) % TRACK_CONFIGS.length);
        return;
      }
      if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        switchTrack((currentTrackIdx + 1) % TRACK_CONFIGS.length);
        return;
      }
      if (e.code === 'ArrowUp' || e.code === 'KeyW') {
        setTotalLaps(totalLaps + 1);
        return;
      }
      if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        setTotalLaps(totalLaps - 1);
        return;
      }
    }

    keys.add(e.code);

    if (e.code === 'Enter' && state === S.MENU) beginGame();
    if (e.code === 'KeyR' && state !== S.MENU && !paused) {
      hud.showResults(false);
      resetRace();
    }
    if (['Digit1', 'Numpad1', 'Key1'].includes(e.code) || e.key === '1') switchTrack(0);
    if (['Digit2', 'Numpad2', 'Key2'].includes(e.code) || e.key === '2') switchTrack(1);
    if (['Digit3', 'Numpad3', 'Key3'].includes(e.code) || e.key === '3') switchTrack(2);
    if (e.code === 'KeyT' && (state === S.MENU || state === S.COUNTDOWN))
      switchTrack((currentTrackIdx + 1) % TRACK_CONFIGS.length);
    if (e.code === 'KeyM') {
      audio.ensure();
      audio.setMuted(!audio.muted);
      hud.toast(audio.muted ? 'SOUND OFF' : 'SOUND ON');
    }
    if (e.code === 'KeyC') {
      currentCamIdx = (currentCamIdx + 1) % CAM_MODES.length;
      hud.setCameraMode(CAM_MODES[currentCamIdx]);
      hud.toast(`CAM: ${CAM_MODES[currentCamIdx]}`);
      if (audio?.ctx) audio.beep(750, 0.04, 0.1);
    }
    if (e.code === 'KeyP' && !e.repeat && (state === S.RACING || paused)) {
      paused = !paused;
      hud.toast(paused ? 'PAUSED' : 'RESUMED');
    }
    if (e.code === 'Space' && !e.repeat && state === S.RACING) {
      weapons.fire(racers[PLAYER], racers);
    }
  });
  on(window, 'keyup', (e) => keys.delete(e.code));
  on(document.getElementById('menu'), 'click', (e) => {
    if (e.target.closest('.track-card') || e.target.closest('#lap-selector')) return;
    if (state === S.MENU) beginGame();
  });
  document.querySelectorAll('.track-card').forEach((card) => {
    on(card, 'click', (e) => {
      e.stopPropagation();
      const idx = parseInt(card.getAttribute('data-track'), 10);
      switchTrack(idx);
    });
  });
  on(document.getElementById('lap-inc'), 'click', (e) => {
    e.stopPropagation();
    setTotalLaps(totalLaps + 1);
  });
  on(document.getElementById('lap-dec'), 'click', (e) => {
    e.stopPropagation();
    setTotalLaps(totalLaps - 1);
  });

  function readPlayerInput() {
    const steer =
      (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) -
      (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    playerInput.steer = steer;
    const held = keys.has('ArrowUp') || keys.has('KeyW');
    if (held && thrustSince === null) thrustSince = raceTime;
    if (!held) thrustSince = null;
    playerInput.throttle = held ? 1 : state === S.RACING ? 0.35 : 0;
    playerInput.brake = keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0;

    // Dual Airbrakes (Q and E)
    const prevAirbrakeL = playerInput.airbrakeL;
    const prevAirbrakeR = playerInput.airbrakeR;
    playerInput.airbrakeL = keys.has('KeyQ') ? 1 : 0;
    playerInput.airbrakeR = keys.has('KeyE') ? 1 : 0;

    if ((playerInput.airbrakeL && !prevAirbrakeL) || (playerInput.airbrakeR && !prevAirbrakeR)) {
      audio.airbrakeHiss(0.6);
    }

    hud.setAirbrakes(playerInput.airbrakeL, playerInput.airbrakeR);
  }

  // ---------------------------------------------------------------------------
  // speed pads & hazards
  // ---------------------------------------------------------------------------
  function onPadHit(ship) {
    ship.boost(2.1);
    track.spawnRing(ship.s, ship.lat, '#ffb02e');
    if (ship.isPlayer) {
      audio.padBlip();
      hud.flashBoost();
    }
  }

  function onObstacleHit(ship, o) {
    ship.hitObstacle(o);
  }

  // ---------------------------------------------------------------------------
  // cameras & modes (Chase, Cockpit)
  // ---------------------------------------------------------------------------
  const CAM_MODES = ['CHASE', 'COCKPIT'];
  let currentCamIdx = 0;

  const _eye = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _upT = new THREE.Vector3();
  const camPos = new THREE.Vector3(520, 240, 260);
  const camLook = new THREE.Vector3(0, 30, 0);
  const _finishCamPos = new THREE.Vector3();
  const _lightOff = new THREE.Vector3(-360, 445, 220); // dirLight boom, matches its direction
  let finishMode = 'flyby';
  let orbitA = 0;

  function chaseCam(dt, snap = false) {
    const p = racers[PLAYER];
    const fr = p.lastFr;
    if (!fr) return;
    const spN = Math.min(1, p.speed / 400);
    const mode = CAM_MODES[currentCamIdx];

    // Hide ship on cockpit camera, show on chase camera
    p.mesh.visible = mode !== 'COCKPIT';

    if (mode === 'COCKPIT') {
      // 1st Person Cockpit / Nose View (clean road view ahead)
      _eye.copy(p.mesh.position).addScaledVector(fr.tan, 2.4).addScaledVector(fr.up, 0.42);
      _look.copy(p.mesh.position).addScaledVector(fr.tan, 45).addScaledVector(fr.up, 0.35);
      _upT.copy(fr.up);
    } else {
      // Dynamic 3rd Person Chase View
      const back = 8.8 + spN * 2.2 + p.speed * 0.012;
      const up = 3.9 + spN * 0.4;
      _eye.copy(p.mesh.position).addScaledVector(fr.tan, -back).addScaledVector(fr.up, up);
      _look.copy(p.mesh.position).addScaledVector(fr.tan, 20).addScaledVector(fr.up, 1.4);
      _upT.lerpVectors(WORLD_UP, fr.up, 0.26).normalize();
    }

    // Camera high-speed shake & collision jolt
    if (p.obstCd > 0.5) {
      const sh = (p.obstCd - 0.5) * 9;
      _eye.x += (Math.random() - 0.5) * sh;
      _eye.y += (Math.random() - 0.5) * sh;
      _eye.z += (Math.random() - 0.5) * sh;
    } else if (p.speed > 260) {
      const vib = (p.speed - 260) * 0.0004;
      _eye.x += (Math.random() - 0.5) * vib;
      _eye.y += (Math.random() - 0.5) * vib;
      _eye.z += (Math.random() - 0.5) * vib;
    }

    if (snap) {
      camPos.copy(_eye);
      camLook.copy(_look);
    } else {
      camPos.lerp(_eye, 1 - Math.exp(-dt * 52));
      camLook.lerp(_look, 1 - Math.exp(-dt * 62));
    }
    camera.position.copy(camPos);
    camera.up.copy(_upT);
    camera.lookAt(camLook);

    // Dynamic FOV Warp
    const baseFov = mode === 'COCKPIT' ? 76 : 66;
    const fovT = baseFov + spN * 16 + (p.boostTime > 0 ? 10 : 0);
    camera.fov = damp(camera.fov, fovT, 6, dt);
    camera.updateProjectionMatrix();
  }

  function menuCam(dt) {
    racers[PLAYER].mesh.visible = true;
    orbitA += dt * 0.07;
    camera.position.set(
      Math.cos(orbitA) * 830,
      330 + Math.sin(orbitA * 0.7) * 50,
      Math.sin(orbitA) * 830,
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 20, 0);
    camera.fov = damp(camera.fov, 55, 2, dt);
    camera.updateProjectionMatrix();
  }

  // Finish: static trackside flyby while the ship is still fast, then a slow
  // beauty orbit once it has pulled up.
  function finishCam(dt) {
    const p = racers[PLAYER];
    if (finishMode === 'flyby') {
      camera.position.copy(_finishCamPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(p.mesh.position);
      camera.fov = damp(camera.fov, 62, 3, dt);
      camera.updateProjectionMatrix();
      if (p.speed < 45) {
        finishMode = 'beauty';
        orbitA = Math.atan2(
          camera.position.z - p.mesh.position.z,
          camera.position.x - p.mesh.position.x,
        );
      }
    } else {
      orbitA += dt * 0.28;
      _eye.set(
        p.mesh.position.x + Math.cos(orbitA) * 17,
        p.mesh.position.y + 6.5,
        p.mesh.position.z + Math.sin(orbitA) * 17,
      );
      camPos.lerp(_eye, 1 - Math.exp(-dt * 2.5));
      camera.position.copy(camPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(p.mesh.position);
    }
  }

  // ---------------------------------------------------------------------------
  // results panel (finished ships ranked by finish time, rest by progress)
  // ---------------------------------------------------------------------------
  function updateResultsPanel() {
    const rows = racers.map((r) => ({
      name: r.name,
      me: r.isPlayer,
      best: r.bestLap,
      total: r.finished ? r.finishTime : null,
    }));
    rows.sort((a, b) => {
      if (a.total !== null && b.total !== null) return a.total - b.total;
      if (a.total !== null) return -1;
      if (b.total !== null) return 1;
      return b.coveredSoFar - a.coveredSoFar;
    });
    hud.results(rows.map((r) => ({ ...r, total: r.total ?? raceTime })));
  }
  for (const r of racers)
    Object.defineProperty(r, 'coveredSoFar', {
      get() {
        return this.covered;
      },
      configurable: true,
    });

  // ---------------------------------------------------------------------------
  // main loop
  // ---------------------------------------------------------------------------
  function tick(rawDt) {
    const dt = paused ? 0 : rawDt;

    if (state === S.MENU) {
      menuCam(dt);
      hud.drawMinimap(racers, track.length, true);
    } else {
      readPlayerInput();

      if (state === S.COUNTDOWN) {
        countT -= dt;
        raceTime += dt;
        const n = Math.ceil(countT - 0.9);
        if (n !== lastCountShown && n >= 1 && n <= 3) {
          lastCountShown = n;
          hud.message(String(n));
          audio.beep(n === 1 ? 500 : 420, 0.16);
        }
        if (countT <= 0.9 && lastCountShown !== 0) {
          lastCountShown = 0;
          hud.message('GO!', '#9dff2f');
          audio.beep(880, 0.5, 0.42);
          state = S.RACING;
          // launch boosts: AI reacts semi-randomly; a player who gets on the
          // throttle within the last half-second of the count launches harder
          for (const r of racers) if (!r.isPlayer) r.boost(0.4 + Math.random());
          const heldNow = keys.has('ArrowUp') || keys.has('KeyW');
          if (heldNow && thrustSince !== null && raceTime - thrustSince <= 0.5) {
            racers[PLAYER].boost(1.6);
            hud.flashBoost();
            hud.toast('PERFECT START +BOOST');
            audio.beep(1200, 0.3, 0.3);
          }
          thrustSince = null;
        }
      } else {
        raceTime += dt;
      }

      const racingGo = state === S.RACING || state === S.FINISHED;
      for (const r of racers) r.lastFr = r.update(dt, raceTime, racers[PLAYER].covered, racingGo);
      resolveShipCollisions(racers, (pos, strength, a, b) => {
        weapons.spark(pos, 0.5 + strength * 1.6);
        if (a.isPlayer || b.isPlayer) {
          const nowS = performance.now() / 1000;
          if (nowS - lastBumpT > 0.18) {
            lastBumpT = nowS;
            if (racers[PLAYER].shieldTime > 0) {
              audio.shieldPing();
            } else {
              audio.shipBump(strength);
              racers[PLAYER].obstCd = Math.max(racers[PLAYER].obstCd, 0.2 + strength * 0.3);
            }
          }
        }
      });
      track.update(dt, racers, onPadHit, onObstacleHit);
      weapons.update(dt, racers, state === S.RACING);

      const order = [...racers].sort((a, b) => b.covered - a.covered);
      const pos = order.indexOf(racers[PLAYER]) + 1;

      const pl = racers[PLAYER];
      if (state === S.RACING && pl.finished) {
        state = S.FINISHED;
        const ffr = track.frameAt(pl.s + 90);
        _finishCamPos.copy(ffr.pos).addScaledVector(ffr.right, 15).addScaledVector(ffr.up, 6.5);
        finishMode = 'flyby';
        audio.finishJingle();
        hud.message(`P${pos}`, '#ffd23f');
        setTimeout(() => {
          updateResultsPanel();
          hud.showResults(true);
        }, 1400);
      }

      if (state === S.FINISHED) finishCam(dt);
      else chaseCam(dt);

      hud.setStatus(
        Math.max(1, Math.min(pl.lap, totalLaps)),
        pos,
        raceTime,
        pl.finished ? 0 : raceTime - pl._lapStartT,
        pl.bestLap,
        pl.speed,
        Math.max(0, pl.boostTime / 2.1),
        totalLaps,
      );
      hud.drawMinimap(order, track.length);
      hud.setCombat(pl.weapon, pl.shieldTime);

      audio.update(Math.min(1, pl.speed / 288), pl.throttle, pl.boostTime > 0, state === S.RACING);
    }

    // motion blur ramps with speed (extra while boosting); zoom blur on pads
    const plp = racers[PLAYER];
    const dampT =
      state === S.RACING || state === S.FINISHED
        ? Math.min(0.62, Math.max(0, (plp.speed - 90) / 288) * 0.5 + (plp.boostTime > 0 ? 0.2 : 0))
        : 0;
    const zoomT = state === S.RACING && plp.boostTime > 0 ? 0.55 : 0;
    const blendK = Math.min(1, dt * 7);
    afterimagePass.uniforms.damp.value += (dampT - afterimagePass.uniforms.damp.value) * blendK;
    zoomPass.uniforms.strength.value += (zoomT - zoomPass.uniforms.strength.value) * blendK;

    // keep the sharp focal plane locked on the player ship (or road ahead in cockpit view)
    bokehPass.uniforms.focus.value =
      CAM_MODES[currentCamIdx] === 'COCKPIT' ? 65.0 : camera.position.distanceTo(plp.mesh.position);

    // shadow frustum follows the player so the 2k map stays tight around the action
    dirLight.position.copy(plp.mesh.position).add(_lightOff);
    dirLight.target.position.copy(plp.mesh.position);
    dirLight.target.updateMatrixWorld();
    gradePass.uniforms.uTime.value = performance.now() / 1000;

    updateEnvironment(dt);
    adaptQuality(dt);
    composer.render();
  }

  hud.showHud(false);
  // The DOM outlives a hot swap, so a menu hidden by the previous instance
  // would stay hidden while this one sits in S.MENU -- a running game behind
  // an invisible menu, with no way back in.
  goToMenu();

  return {
    update: (dt) => tick(dt),
    getState: () => ({ trackIndex: currentTrackIdx, laps: totalLaps }),
    dispose() {
      for (const off of _unbind) off();
      _unbind.length = 0;
      clearInterval(audio._musicTimer);
      track?.dispose?.();
      weapons?.dispose?.();
      disposeComposer(composer);
      disposeScene(scene);
      composer = null;
    },
  };
}
