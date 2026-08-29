// terrain.js — real 3D countryside, built the way STRIKEVECTOR builds its
// landscape and shaded the way SKY STRIKE shades everything else.
//
// The previous backdrop was flat cut-out silhouettes: five painted layers with
// haze between them. That reads at a glance and then stops — the layers never
// occlude each other correctly, nothing sits ON a hill, and flying gives no
// parallax beyond a fixed scroll rate, because there is no depth to move
// through.
//
// This is a heightfield instead. Height comes from layered fbm exactly as it
// does in STRIKEVECTOR, so the same technique produces the same believable
// undulation — just tuned for downland rather than alpine. Depth is real, so
// perspective, occlusion and parallax all come free, and props stand on the
// surface because there is a surface to stand on.

import * as THREE from 'three';
import { createNoise2D } from '#engine/noise.js';

const { fbm } = createNoise2D(20260829);

// The strip is deep in Z and streamed in X. A side-on game never moves along
// Z, so depth is built once and only the play direction needs chunking.
export const TERRAIN = {
  near: -12, // closest edge, just behind the action
  far: -300, // horizon
  chunkWidth: 70, // X span of one chunk
  segmentsX: 40,
  segmentsZ: 34,
  baseY: -16, // sea level, just under the play area's floor
};

/**
 * Ground height at a point.
 *
 * Three scales, coarse to fine: broad downland swells, the hills that read as
 * hills, and a fine layer that keeps silhouettes from looking machined. Ridges
 * are deliberately soft — this is farmland, and sharpening the crests here
 * would fight the villages and hedgerows sitting on them.
 */
export function heightAt(x, z) {
  // Rolling country: wide, gentle swells.
  const swell = fbm(x * 0.0035, z * 0.0035, 3, 2.0, 0.5) * 26;

  // Hills. Squared toward the peak so summits round over rather than coming to
  // a point — downland, not mountains.
  const hillN = fbm(x * 0.011 + 31.7, z * 0.011 - 12.4, 4, 2.05, 0.52);
  const hills = Math.sign(hillN) * hillN * hillN * 34;

  // Fine relief, small enough to break up the silhouette without being read as
  // its own feature.
  const detail = fbm(x * 0.045 - 7.1, z * 0.045 + 22.3, 3, 2.1, 0.5) * 3.2;

  // Distant ground lifts slightly so the far field reads as rising country
  // meeting the sky, rather than a plane running to a hard horizon.
  const distanceLift = Math.max(0, (-z - 90) / 210) ** 1.4 * 30;

  return TERRAIN.baseY + swell + hills + detail + distanceLift;
}

/** Surface normal by central differences — used to tint slopes. */
function normalAt(x, z, e = 2.5) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return new THREE.Vector3(-hx, 2 * e, -hz).normalize();
}

const PALETTE = {
  lowland: new THREE.Color(0x4f9c3a),
  upland: new THREE.Color(0x3d8230),
  crest: new THREE.Color(0x76bd4a), // sunlit tops catch a lighter green
  slope: new THREE.Color(0x2f6b2c), // steep faces stay in shade
  distant: new THREE.Color(0x86b6c4), // far ground washes toward the air
};

/**
 * Build one chunk of the strip.
 *
 * Vertex colour carries what a texture normally would: height banding, a
 * lighter crest, darker steep faces, and a wash toward the air colour with
 * distance. Toon shading then quantises the lighting on top, so the surface
 * bands like the rest of the game instead of rendering as a smooth gradient.
 */
function buildChunk(originX, gradientMap) {
  const { near, far, chunkWidth, segmentsX, segmentsZ } = TERRAIN;
  const geo = new THREE.PlaneGeometry(chunkWidth, near - far, segmentsX, segmentsZ);
  geo.rotateX(-Math.PI / 2); // lie it flat: XZ plane, Y up

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const centerZ = (near + far) / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + originX;
    const z = pos.getZ(i) + centerZ;
    const y = heightAt(x, z);
    pos.setY(i, y);

    const n = normalAt(x, z);
    const height01 = THREE.MathUtils.clamp((y - TERRAIN.baseY) / 55, 0, 1);
    c.copy(PALETTE.lowland).lerp(PALETTE.upland, height01);
    // Crest lightening keyed to height, so ridgelines read from the air.
    c.lerp(PALETTE.crest, THREE.MathUtils.smoothstep(height01, 0.55, 1) * 0.55);
    // Steepness darkens: n.y falls as the ground tips over.
    c.lerp(PALETTE.slope, THREE.MathUtils.smoothstep(1 - n.y, 0.25, 0.75) * 0.6);
    // Atmospheric perspective, applied per-vertex rather than per-layer.
    c.lerp(PALETTE.distant, THREE.MathUtils.smoothstep(-z, 70, 280) * 0.82);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshToonMaterial({ vertexColors: true, gradientMap }),
  );
  mesh.position.set(originX, 0, centerZ);
  mesh.userData.originX = originX;
  return mesh;
}

/**
 * Streamed strip of terrain.
 *
 * Chunks are built around the player and recycled as they fall behind, the
 * same pattern STRIKEVECTOR uses for its chunk grid — the difference is that
 * one axis suffices here.
 */
export class Terrain {
  constructor(scene, gradientMap, { radius = 3 } = {}) {
    this.scene = scene;
    this.gradientMap = gradientMap;
    this.radius = radius;
    this.chunks = new Map(); // chunk index -> mesh
  }

  update(centerX) {
    const i0 = Math.round(centerX / TERRAIN.chunkWidth);
    for (let i = i0 - this.radius; i <= i0 + this.radius; i++) {
      if (this.chunks.has(i)) continue;
      const mesh = buildChunk(i * TERRAIN.chunkWidth, this.gradientMap);
      this.scene.add(mesh);
      this.chunks.set(i, mesh);
    }
    for (const [i, mesh] of this.chunks) {
      if (Math.abs(i - i0) <= this.radius + 1) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      this.chunks.delete(i);
    }
  }

  dispose() {
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.chunks.clear();
  }
}
