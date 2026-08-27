import { GLTFLoader } from '../../../shared/vendor/jsm/loaders/GLTFLoader.js';
import * as THREE from '../../../shared/vendor/three.module.js';

// Small GLTF loading layer. Everything is CC0 Kenney Space Kit
// (kenney.nl/assets/space-kit); models live in assets/models/.
// Loading is async + cached: if it fails (e.g. offline), callers keep
// their procedural fallbacks.

const loader = new GLTFLoader();
const cache = new Map();

export function loadModel(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      new Promise((resolve, reject) => {
        loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
      }),
    );
  }
  return cache.get(url);
}

// Normalizes a loaded scene for ship space: centered, longest horizontal
// axis pointed down +Z, scaled to targetLen world units. Returns a wrapper
// group to add to a ship.
export function fitToShipSpace(scene, targetLen = 5.3, yaw = 0) {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  scene.position.sub(center);

  const wrapper = new THREE.Group();
  wrapper.add(scene);
  const baseYaw = size.x > size.z ? -Math.PI / 2 : 0; // long axis -> forward
  wrapper.rotation.y = baseYaw + yaw;

  const long = Math.max(size.x, size.z, 0.001);
  wrapper.scale.setScalar(targetLen / long);
  return wrapper;
}
