// jet.js — F-22 rig: real GLB airframe (loaded via loadF22Model) plus the
// shared afterburner flame cones and the procedural missile model.

import * as THREE from 'three';
import { GLTFLoader } from '../../../shared/vendor/jsm/loaders/GLTFLoader.js';

// Shared GLB template (loaded once from main.js). New rigs pick it up
// automatically; existing rigs get swapped via applyJetTemplate().
let glbTemplate = null;

export function makeJetRig({ player = false } = {}) {
  const rig = new THREE.Group();
  rig.userData.flames = makeFlames();
  rig.userData.hostile = !player;
  if (glbTemplate) applyJetTemplate(rig, glbTemplate);
  return rig;
}

export function applyJetTemplate(rig, template) {
  if (rig.userData.usingGlb) return;
  const model = template.clone(true);
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    // Tint hostile jets: warm tan on airframe materials only.
    if (rig.userData.hostile && o.material && (o.material.name || '').startsWith('F-22-airframe')) {
      o.material = o.material.clone();
      o.material.color = new THREE.Color(0x8a7550);
    }
  });
  rig.add(model);
  // keep afterburner flames alive across the swap
  const flames = rig.userData.flames;
  if (flames) {
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const sign = i === 0 ? 1 : -1;
      f.position.set(sign * 0.57, -0.15, 8.45);
      f.userData.baseScale = new THREE.Vector3(1.35, 1.35, 0.75);
      f.scale.copy(f.userData.baseScale);
      rig.add(f);
    }
  }
  rig.userData.usingGlb = true;
  rig.userData.model = model;
}

// Normalize the loaded GLB: uniform scale to ~19 m length, centered,
// nose toward -Z (three.js forward). The source model is authored +Z forward.
export function loadF22Model(url) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, (gltf) => {
      const scene = gltf.scene;
      const box = new THREE.Box3().setFromObject(scene);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 19 / maxDim;
      const wrap = new THREE.Group();
      scene.rotation.y = Math.PI / 2; // authored +X forward -> -Z forward
      scene.scale.setScalar(scale);
      // recenter after rotation+scale
      const box2 = new THREE.Box3().setFromObject(scene);
      const center = box2.getCenter(new THREE.Vector3());
      scene.position.sub(center);
      wrap.add(scene);
      glbTemplate = wrap;
      resolve(wrap);
    }, undefined, reject);
  });
}

// afterburner shock-flame cones; positions are GLB-space and get re-set by
// applyJetTemplate when the model arrives
function makeFlames() {
  const flameMat = createAfterburnerMaterial();
  const outerGeo = new THREE.CylinderGeometry(0.03, 0.28, 2.0, 16, 8, true);
  outerGeo.rotateX(Math.PI / 2);
  outerGeo.translate(0, 0, 1.0);

  const innerGeo = new THREE.CylinderGeometry(0.015, 0.16, 1.5, 12, 4, true);
  innerGeo.rotateX(Math.PI / 2);
  innerGeo.translate(0, 0, 0.75);

  const flames = [];
  for (const x of [0.22, -0.22]) {
    const g = new THREE.Group();
    g.position.set(x, -0.05, 7.15);
    const mOuter = new THREE.Mesh(outerGeo, flameMat);
    const mInner = new THREE.Mesh(innerGeo, flameMat);
    mOuter.renderOrder = 100;
    mInner.renderOrder = 100;
    g.add(mOuter, mInner);
    g.userData.material = flameMat;
    g.visible = false;
    flames.push(g);
  }
  return flames;
}

export function createAfterburnerMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;

      float flameHash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float flameNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = flameHash(i);
        float b = flameHash(i + vec2(1.0, 0.0));
        float c = flameHash(i + vec2(0.0, 1.0));
        float d = flameHash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }

      void main() {
        #include <logdepthbuf_fragment>
        float y = vUv.y; // 0 = nozzle throat, 1 = tip
        
        // Fast scrolling supersonic gaseous turbulence
        vec2 uvScroll = vec2(vUv.x * 6.0, vUv.y * 14.0 - uTime * 36.0);
        float turb = flameNoise(uvScroll) * 0.65 + flameNoise(uvScroll * 2.2 - uTime * 20.0) * 0.35;
        float edgeErode = (turb - 0.5) * 0.4 * smoothstep(0.04, 0.5, y);

        // Supersonic shock diamond pulse waves
        float wave = sin(y * 32.0 - uTime * 44.0);
        float diamond = pow(max(0.0, wave + (turb - 0.5) * 0.35), 2.8) * (1.0 - y * 0.65);

        // Core white-cyan throat transitioning into electric blue and amber flame
        vec3 throatCol = vec3(0.95, 0.98, 1.0);      // White-hot plasma core
        vec3 blueCol   = vec3(0.35, 0.65, 1.0);     // Electric cyan/blue flame ring
        vec3 orangeCol = vec3(1.0, 0.55, 0.08);     // Fiery orange afterburner stream
        vec3 redCol    = vec3(0.95, 0.20, 0.02);    // Outer tip flame

        vec3 col = mix(throatCol, blueCol, smoothstep(0.0, 0.18, y));
        col = mix(col, orangeCol, smoothstep(0.15, 0.55, y));
        col = mix(col, redCol, smoothstep(0.55, 1.0, y));

        // Add bright shock diamonds into the core
        col += vec3(0.95, 0.98, 1.0) * diamond * 1.5 * (1.0 - y * 0.5);

        // Soft feathered flame with 0.25 alpha
        float tipFade = smoothstep(1.0 + edgeErode * 0.25, 0.65, y);
        float alpha = 0.25 * tipFade;

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}

export function buildMissile() {
  const m = new THREE.Group();
  const bodyMat = new THREE.MeshPhongMaterial({ color: 0xd8dce2, shininess: 60, flatShading: true });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.9, 8), bodyMat);
  body.rotation.x = Math.PI / 2;
  body.position.z = 0.2;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.4, 8), new THREE.MeshPhongMaterial({ color: 0x333940 }));
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.95;
  const fins = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.28, 0.34), bodyMat);
    fin.position.y = 0.16;
    const arm = new THREE.Group();
    arm.add(fin);
    arm.rotation.z = (i * Math.PI) / 2;
    arm.position.z = 1.0;
    fins.add(arm);
  }
  m.add(body, nose, fins);
  m.scale.setScalar(2.2);
  return m;
}
