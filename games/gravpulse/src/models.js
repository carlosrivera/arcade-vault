import * as THREE from 'three';

// Small GLTF loading layer. Everything is CC0 Kenney Space Kit
// (kenney.nl/assets/space-kit); models live in assets/models/.
// Loading is async + cached: if it fails (e.g. offline), callers keep
// their procedural fallbacks.
//
// The cache lives in the engine rather than here on purpose. This module is
// rebuilt on every hot reload, so a local cache re-parsed every model and
// stranded the previous copies: templates are cloned into the scene, never
// added to it, so a scene-walking dispose could never reach them.
export { loadModel } from '#engine/assets.js';

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
