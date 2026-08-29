// post.js — full-screen shader scaffolding for post-processing chains.
//
// The pass *stacks* stay in the games: STRIKEVECTOR raymarches clouds against
// scene depth and overlays the jet on a separate layer, GRAVPULSE grades and
// zoom-blurs on boost. Those orders encode gameplay, not engine policy. What
// is shared is the boilerplate below, which every custom pass re-typed.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

/**
 * The only vertex shader a full-screen pass ever needs: pass uv through and
 * emit the quad. Identical in every screen-space effect, so it lives here.
 */
export const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Build a ShaderPass-compatible definition from just uniforms and a fragment
 * shader, filling in the vertex shader above.
 *
 * @param {{uniforms: object, fragmentShader: string}} definition
 */
export function fullscreenShader({ uniforms, fragmentShader }) {
  return { uniforms, vertexShader: FULLSCREEN_VERTEX_SHADER, fragmentShader };
}

/**
 * Composer + RenderPass, the two lines that open every chain.
 *
 * `depth: true` attaches a half-float target with a depth texture, which is
 * what screen-space effects need to reconstruct world position (raymarched
 * clouds, fog, SSAO). Skip it when nothing reads depth — it costs memory.
 */
export function createComposer(renderer, scene, camera, { depth = false } = {}) {
  let target;
  if (depth) {
    target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      type: THREE.HalfFloatType,
    });
    target.depthTexture = new THREE.DepthTexture();
    target.depthTexture.type = THREE.UnsignedShortType;
  }
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  return composer;
}
