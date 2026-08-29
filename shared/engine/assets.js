// assets.js — shared asset cache that survives hot reloads.
//
// A game module graph is rebuilt on every hot swap, so any cache living in
// game code is rebuilt with it. For GLTF templates that is doubly wasteful:
// the model is re-parsed and re-uploaded, and the previous copy's geometries
// are unreachable from the scene graph — they were templates to clone, never
// added — so a scene-walking dispose can never find them. They leak.
//
// This module is reached through the '#engine/' import map entry, which the
// loader deliberately leaves alone, so it is evaluated once per page. The
// cache therefore outlives every reload: models are parsed once, and there is
// nothing per-reload left to leak.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const models = new Map();

// Geometries and materials belonging to cached templates.
//
// Object3D.clone() shares geometry and material with its source, so a clone
// added to a scene points at the template's resources. Disposing the scene
// would therefore destroy the cache from underneath itself, and the next
// reload would silently re-upload everything it thought it had kept.
// disposeScene() consults this and leaves them alone.
const owned = new WeakSet();

/** True when a geometry or material is owned by the persistent asset cache. */
export function isCachedAsset(resource) {
  return !!resource && owned.has(resource);
}

function claim(scene) {
  scene.traverse((obj) => {
    if (obj.geometry) owned.add(obj.geometry);
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) owned.add(m);
  });
  return scene;
}

/**
 * Load a GLTF/GLB and resolve to its scene, cached by URL for the page's life.
 *
 * The resolved scene is a shared template — clone it before adding it to a
 * scene, or two callers will fight over one object.
 *
 * @param {string} url
 * @returns {Promise<THREE.Group>}
 */
export function loadModel(url) {
  if (!models.has(url)) {
    models.set(
      url,
      new Promise((resolve, reject) => {
        loader.load(url, (gltf) => resolve(claim(gltf.scene)), undefined, reject);
      }),
    );
  }
  return models.get(url);
}

/** URLs currently cached — handy for leak accounting. */
export function cachedModels() {
  return [...models.keys()];
}

/**
 * Drop every cached model and release its GPU memory.
 *
 * Rarely wanted: the whole point of the cache is to persist. Use it when
 * swapping to an unrelated game on the same page, not between reloads of one.
 */
export function disposeModels() {
  for (const promise of models.values()) {
    promise.then((scene) => {
      scene.traverse((obj) => {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material)
          ? obj.material
          : obj.material
            ? [obj.material]
            : [];
        for (const m of mats) disposeMaterial(m);
      });
    });
  }
  models.clear();
}

/**
 * Dispose a material and every texture it holds.
 *
 * Walks uniforms as well as plain properties: a ShaderMaterial keeps its maps
 * under `uniforms.x.value`, which a property-only sweep misses entirely — and
 * those are exactly the textures procedural games generate at runtime.
 */
export function disposeMaterial(material) {
  if (!material) return;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value?.isTexture) value.dispose();
  }
  for (const uniform of Object.values(material.uniforms ?? {})) {
    const value = uniform?.value;
    if (value?.isTexture) value.dispose();
    else if (Array.isArray(value)) for (const v of value) v?.isTexture && v.dispose();
  }
  material.dispose();
}

/**
 * Release everything reachable from a scene: geometries, materials, and the
 * textures hiding in their uniforms. GPU memory is not garbage collected, so
 * a hot reload without this retains the whole world on every swap.
 */
export function disposeScene(scene) {
  if (!scene) return;
  scene.traverse((obj) => {
    if (obj.geometry && !owned.has(obj.geometry)) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) if (!owned.has(m)) disposeMaterial(m);
  });
  scene.environment?.dispose();
  scene.background?.isTexture && scene.background.dispose();
  scene.clear();
}
