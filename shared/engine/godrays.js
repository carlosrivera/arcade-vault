// godrays.js — crepuscular rays, the shafts of light that fan out from a sun
// behind cloud or terrain.
//
// Done in screen space rather than by marching the light volume. The honest
// trade: a true volumetric march is physically right but expensive and only
// as good as the shadow data feeding it, whereas radially blurring the bright
// parts of the frame away from the sun costs one pass and reads convincingly
// for the same reason the real effect is visible — shafts appear exactly
// where something bright is partially occluded.
//
// Consequences of that choice, worth knowing before tuning:
//   - Rays only exist where the sun is ON SCREEN. Off-screen suns produce
//     nothing, which is why `visible` fades them out near the edge instead of
//     letting them pop.
//   - The occluder mask is luminance, not geometry. Bright terrain (snow,
//     desert) contributes a little; that reads as haze rather than error.

import * as THREE from 'three';
import { FULLSCREEN_VERTEX_SHADER } from '#engine/post.js';

export const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null },
    /** Sun position in screen UV space. */
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    /** 0 when the sun is behind the camera or off-screen; fades the effect. */
    uVisible: { value: 0 },
    uIntensity: { value: 0.85 },
    /** Luminance above which a pixel is treated as a light source. */
    uThreshold: { value: 0.55 },
    uDecay: { value: 0.96 },
    uDensity: { value: 0.9 },
    uColor: { value: new THREE.Color(1.0, 0.94, 0.82) },
  },
  vertexShader: FULLSCREEN_VERTEX_SHADER,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunUv;
    uniform float uVisible;
    uniform float uIntensity;
    uniform float uThreshold;
    uniform float uDecay;
    uniform float uDensity;
    uniform vec3 uColor;
    varying vec2 vUv;

    const int STEPS = 48;

    void main() {
      vec4 scene = texture2D(tDiffuse, vUv);
      if (uVisible <= 0.001) {
        gl_FragColor = scene;
        return;
      }

      // March from this pixel toward the sun, accumulating whatever is bright
      // along the way. Each step is weighted less than the last, so a bright
      // patch smears into a shaft that fades with distance from its source.
      vec2 delta = (vUv - uSunUv) * (uDensity / float(STEPS));
      vec2 coord = vUv;
      float illumination = 1.0;
      vec3 shaft = vec3(0.0);

      // Dither the start so banding becomes noise, which the eye forgives.
      float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      coord -= delta * jitter;

      for (int i = 0; i < STEPS; i++) {
        coord -= delta;
        vec3 s = texture2D(tDiffuse, clamp(coord, 0.0, 1.0)).rgb;
        // Only bright pixels emit. Everything else is an occluder by omission,
        // which is what carves the shafts around terrain and through gaps.
        float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
        float emit = smoothstep(uThreshold, 1.0, lum);
        shaft += s * emit * illumination;
        illumination *= uDecay;
      }

      shaft *= uIntensity / float(STEPS);
      // Additive: light adds, it does not replace what is behind it.
      gl_FragColor = vec4(scene.rgb + shaft * uColor * uVisible, scene.a);
    }
  `,
};

/**
 * Project a world-space sun direction to screen UV and work out how much of
 * the effect should be showing.
 *
 * @param {THREE.Camera} camera
 * @param {THREE.Vector3} sunDirection normalized, pointing at the sun
 * @param {object} uniforms the pass's uniforms object
 */
export function updateGodRays(camera, sunDirection, uniforms) {
  // Place the virtual sun INSIDE the frustum. Projecting a point past the far
  // plane returns z > 1 regardless of direction, so a naive "z > 1 means
  // behind the camera" test is true even when the sun is dead ahead — the
  // effect then never draws and looks like a broken shader rather than a
  // clipping mistake.
  const distance = (camera.far ?? 1000) * 0.5;
  _v.copy(camera.position).addScaledVector(sunDirection, distance);
  _v.project(camera);

  // Facing is decided by direction, not by projected depth.
  _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const behind = _forward.dot(sunDirection) <= 0;

  const uv = uniforms.uSunUv.value;
  uv.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);

  // Fade out toward the screen edge. A hard cut would pop the whole effect on
  // and off as the sun crosses the border during a turn.
  const edge = Math.max(Math.abs(_v.x), Math.abs(_v.y));
  const onScreen = behind ? 0 : 1 - Math.min(1, Math.max(0, (edge - 0.7) / 0.6));
  uniforms.uVisible.value = onScreen;
}

const _v = new THREE.Vector3();
const _forward = new THREE.Vector3();
