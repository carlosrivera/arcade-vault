// render.js — WebGL renderer construction and viewport wiring.

import * as THREE from 'three';

/**
 * Build a renderer with the house defaults every game here shares: ACES
 * filmic tone mapping, sRGB output, soft shadows, and a capped pixel ratio.
 *
 * The cap is the important one. Uncapped, a 3x-DPR phone renders nine times
 * the fragments of a 1x display for no visible gain, which is the difference
 * between a smooth frame and a slideshow. Games raise or lower it to taste.
 *
 * Anything not named here (logarithmicDepthBuffer, alpha, stencil, ...) is
 * forwarded straight to the THREE.WebGLRenderer constructor.
 *
 * @throws if WebGL is unavailable — callers should catch and show a message.
 */
export function createRenderer(canvas, options = {}) {
  const {
    maxPixelRatio = 2,
    toneMappingExposure = 1.0,
    shadows = true,
    ...rendererOptions
  } = options;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, ...rendererOptions });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = toneMappingExposure;
  renderer.shadowMap.enabled = shadows;
  if (shadows) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/**
 * Keep camera aspect, renderer size, and any extra targets in sync with the
 * window. Pass the composer (or anything else exposing setSize) as an extra.
 *
 * Returns an unsubscribe function.
 */
export function handleResize(renderer, camera, ...extras) {
  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    renderer.setSize(w, h);
    // Read lazily each time: games swap composers when quality is stepped down,
    // so capturing the object once would keep resizing a discarded one.
    for (const extra of extras) {
      const target = typeof extra === 'function' ? extra() : extra;
      target?.setSize?.(w, h);
    }
  };
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}
