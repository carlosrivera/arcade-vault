// model-viewer.js — the standard viewer for everything under models/.
//
// One implementation, so every reconstruction is inspected the same way: free orbit and
// zoom, the same HUD, the same capture flags, and the same programmatic camera API the
// review gates drive. Each model supplies only its geometry and its solved camera.
//
// Query flags:
//   ?bg=key     black backdrop, HUD hidden, bloom OFF, camera locked to the solved review
//               pose. Required for any capture a deterministic gate will segment: the
//               studio backdrop is saturated enough to classify as subject, and a bloom
//               halo is counted as silhouette (it inflated measured area to 0.86 of frame).
//   ?nocloud=1  hide a group named `cloud-layer`, for hole checks on the solid body.
//   ?az=  ?el=  ?dist=   override the camera pose, in degrees and bounding-radius units.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const KEY_BG = 0x000000;

/**
 * @param {object} opts
 * @param {THREE.Object3D} opts.model
 * @param {string} opts.title            shown in the HUD
 * @param {object} opts.camera           solved pose: {azimuth, elevation, distanceFactor,
 *                                       viewDistanceFactor, fov, orthographic}
 * @param {Array}  opts.lights           THREE lights to add
 * @param {object} [opts.bloom]          {strength, radius, threshold} or null for none
 * @param {number} [opts.background]     studio backdrop colour
 */
export function createModelViewer(opts) {
  const q = new URLSearchParams(location.search);
  const gate = q.get('bg') === 'key';
  const noCloud = q.get('nocloud') === '1';

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(gate ? KEY_BG : (opts.background ?? 0x0b0e13));
  scene.add(opts.model);
  for (const l of opts.lights ?? []) scene.add(l);
  if (noCloud) {
    const c = opts.model.getObjectByName('cloud-layer');
    if (c) c.visible = false;
  }

  const box = new THREE.Box3().setFromObject(opts.model);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
  const cam = opts.camera ?? {};
  const aspect = innerWidth / innerHeight;

  let camera;
  if (cam.orthographic) {
    const h = cam.halfHeight ?? radius;
    camera = new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, 0.01, radius * 40);
  } else {
    camera = new THREE.PerspectiveCamera(cam.fov ?? 35, aspect, radius * 0.01, radius * 40);
  }

  // The review pose is the solved one; free viewing starts further out because a pose
  // framed to match a tight reference crop is uncomfortably close to fly around in.
  const reviewDist = radius * (cam.distanceFactor ?? 2.5);
  const freeDist = radius * (cam.viewDistanceFactor ?? (cam.distanceFactor ?? 2.5) * 1.6);
  const az0 = Number(q.get('az') ?? cam.azimuth ?? 38);
  const el0 = Number(q.get('el') ?? cam.elevation ?? 25);
  const d0 = q.get('dist') ? Number(q.get('dist')) * radius : (gate ? reviewDist : freeDist);

  function pose(azDeg, elDeg, dist) {
    const a = THREE.MathUtils.degToRad(azDeg);
    const e = THREE.MathUtils.degToRad(elDeg);
    camera.position.set(
      centre.x + dist * Math.cos(e) * Math.sin(a),
      centre.y + dist * Math.sin(e),
      centre.z + dist * Math.cos(e) * Math.cos(a),
    );
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
  }
  pose(az0, el0, d0);

  // Free orbit and zoom. Damping on, because a hard-edged faceted model shows every
  // camera step and an undamped drag reads as stuttering.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(centre);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = radius * 0.6;
  controls.maxDistance = radius * 12;
  controls.update();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (opts.bloom && !gate) {
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      opts.bloom.strength, opts.bloom.radius, opts.bloom.threshold));
  }
  composer.addPass(new OutputPass());

  let hud = null;
  if (!gate) {
    hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML = `<b>${opts.title ?? 'MODEL'}</b><br><span id="stat">…</span>` +
      '<br><span class="hint">drag orbit · scroll zoom · shift-drag pan</span>';
    document.body.appendChild(hud);
  }

  addEventListener('resize', () => {
    const a = innerWidth / innerHeight;
    if (camera.isOrthographicCamera) {
      const h = camera.top;
      camera.left = -h * a; camera.right = h * a;
    } else {
      camera.aspect = a;
    }
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  });

  renderer.setAnimationLoop(() => { controls.update(); composer.render(); });
  if (hud) {
    setInterval(() => {
      const i = renderer.info.render;
      const el = document.getElementById('stat');
      // The composer's final fullscreen pass is what renderer.info reports, so the scene's
      // own totals are counted during the RenderPass instead.
      if (el) el.textContent = `${i.calls} calls · ${i.triangles.toLocaleString()} tris`;
    }, 500);
  }

  // Programmatic camera control for the review gates. Setting a pose detaches damping for
  // one frame so a capture taken immediately after is at the pose asked for, not easing
  // toward it.
  const api = {
    THREE, scene, camera, renderer, controls, model: opts.model, centre, radius,
    setAzimuth(deg) { this._az = deg; pose(deg, this._el, this._d); controls.update(); },
    setElevation(deg) { this._el = deg; pose(this._az, deg, this._d); controls.update(); },
    setDistance(factor) { this._d = radius * factor; pose(this._az, this._el, this._d); controls.update(); },
    setPose(azDeg, elDeg, factor) {
      this._az = azDeg; this._el = elDeg; this._d = radius * factor;
      pose(azDeg, elDeg, this._d); controls.update();
    },
    _az: az0, _el: el0, _d: d0,
  };
  window.__viewer = api;

  // Inspection is on for normal viewing and off for gate captures: the highlight overlay
  // and mark pins are geometry, and a segmenter would count them as part of the subject.
  if (!gate && opts.inspect !== false) {
    import('./model-inspect.js')
      .then((m) => m.attachInspector(api, { storageKey: opts.title ?? location.pathname }))
      .catch((err) => console.warn('inspector unavailable:', err));
  }
  return api;
}
