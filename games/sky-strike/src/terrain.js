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
import { PRNG } from '#engine/rng.js';

const { fbm } = createNoise2D(20260829);
const { smoothstep, clamp } = THREE.MathUtils;

// The strip is deep in Z and streamed in X. A side-on game never moves along
// Z, so depth is built once and only the play direction needs chunking.
export const TERRAIN = {
  near: -12, // closest edge, just behind the action
  far: -320, // horizon
  chunkWidth: 70, // X span of one chunk
  segmentsX: 44,
  segmentsZ: 42,
  baseY: -16, // datum the relief is measured from
  detailTile: 22, // world units per repeat of the ground texture
};

/** Height of the water plane. Hollows that fall below it become lakes. */
export const SEA_LEVEL = -30;

/**
 * Valley corridor.
 *
 * Full-amplitude country running right up to the flight line put hilltops
 * above the camera, so the aircraft appeared to fly below ground level with
 * the horizon looming over it. Damping the relief and dropping the floor as z
 * approaches the play plane opens a valley along the flight path: the near
 * ground stays under the arena, its hollows flood, and the country climbs away
 * behind it — which is both the fix and a better composition, because the eye
 * now travels from water at the bottom of frame up to ridges at the top.
 */
const CORRIDOR = { nearZ: 14, openZ: 130, damp: 0.28, depth: 13 };

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

  // Hills. Cubed toward the peak so summits round over rather than coming to
  // a point — downland, not mountains.
  const hillN = fbm(x * 0.011 + 31.7, z * 0.011 - 12.4, 4, 2.05, 0.52);
  const hills = Math.sign(hillN) * hillN * hillN * 34;

  // Fine relief, small enough to break up the silhouette without being read as
  // its own feature.
  const detail = fbm(x * 0.045 - 7.1, z * 0.045 + 22.3, 3, 2.1, 0.5) * 3.2;

  // Distant ground lifts so the far field reads as rising country meeting the
  // sky, rather than a plane running to a hard horizon.
  const distanceLift = Math.max(0, (-z - 90) / 210) ** 1.4 * 30;

  const open = smoothstep(-z, CORRIDOR.nearZ, CORRIDOR.openZ);
  const relief =
    (swell + hills + detail + distanceLift) * (CORRIDOR.damp + (1 - CORRIDOR.damp) * open);
  return TERRAIN.baseY + relief - CORRIDOR.depth * (1 - open);
}

/** Surface normal by central differences — used to tint slopes. */
function normalAt(x, z, e = 2.5) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return new THREE.Vector3(-hx, 2 * e, -hz).normalize();
}

/**
 * Highest ground in the near band, measured rather than guessed.
 *
 * The camera clamp is derived from this, so retuning the noise or the corridor
 * cannot silently put the camera back underneath a hill — the floor moves with
 * the terrain.
 */
export const NEAR_CREST = (() => {
  let peak = -Infinity;
  for (let x = -340; x <= 340; x += 4) {
    for (let z = TERRAIN.near; z >= -55; z -= 3) peak = Math.max(peak, heightAt(x, z));
  }
  return peak;
})();

const PALETTE = {
  lowland: new THREE.Color(0x4f9c3a),
  upland: new THREE.Color(0x3d8230),
  crest: new THREE.Color(0x76bd4a), // sunlit tops catch a lighter green
  slope: new THREE.Color(0x2f6b2c), // steep faces stay in shade
  rock: new THREE.Color(0x8b8578), // scree where the ground tips past grass
  sand: new THREE.Color(0xd9c99c), // the strand where the country meets water
  distant: new THREE.Color(0x86b6c4), // far ground washes toward the air
};

/**
 * Ground texture.
 *
 * Plane waves on integer frequencies are exactly periodic over the tile, so
 * this repeats across the whole strip with no seam, no edge blending and none
 * of the mirrored-tiling artefacts a noise bitmap would need. Summing enough
 * of them in random directions gives isotropic mottling rather than plaid.
 *
 * It is deliberately low-contrast and greyscale: it multiplies the vertex
 * colour, so it adds grain and hedgerow-scale variation to a surface whose
 * large structure and hue still come from the mesh. Anything stronger would
 * fight the toon banding instead of sitting under it.
 */
let detailTexture;
function groundTexture() {
  if (detailTexture !== undefined) return detailTexture;
  if (typeof document === 'undefined') {
    detailTexture = null; // headless: geometry tests do not need the image
    return null;
  }
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(S, S);

  const trng = new PRNG('sky-strike-ground');
  const waves = [];
  for (let i = 0; i < 22; i++) {
    const fx = Math.round(trng.range(-7, 7));
    const fz = Math.round(trng.range(-7, 7));
    if (fx === 0 && fz === 0) continue;
    // Amplitude falling as 1/f is what makes a wave sum read as natural
    // relief rather than as a pattern.
    waves.push({ fx, fz, phase: trng.range(0, Math.PI * 2), amp: 1 / Math.hypot(fx, fz) });
  }
  const norm = waves.reduce((s, w) => s + w.amp, 0);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      let n = 0;
      for (const w of waves) n += w.amp * Math.sin(2 * Math.PI * (w.fx * u + w.fz * v) + w.phase);
      n /= norm;
      // A touch of ordered dither on top: at flight altitude it reads as
      // ground cover, and it keeps the smooth wave sum from looking painted.
      const grain = (((x * 7 + y * 13) % 5) / 5 - 0.4) * 0.05;
      const shade = clamp(1 + n * 0.26 + grain, 0.62, 1.28);
      const i = (y * S + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.round(shade * 200);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  detailTexture = new THREE.CanvasTexture(canvas);
  detailTexture.wrapS = detailTexture.wrapT = THREE.RepeatWrapping;
  detailTexture.anisotropy = 4;
  // The map is a multiplier, so its own encoding must stay linear — tagging it
  // sRGB would apply a second transfer curve and darken every hill.
  detailTexture.colorSpace = THREE.NoColorSpace;
  return detailTexture;
}

/**
 * Build one chunk of the strip.
 *
 * Vertex colour carries the large structure: height banding, farmland
 * parcels, a lighter crest, darker steep faces, scree on the steepest high
 * ground, a strand at the waterline, and a wash toward the air colour with
 * distance. The tiled map adds the fine grain underneath it, and toon shading
 * then quantises the lighting on top — so the surface bands like the rest of
 * the game instead of rendering as a smooth gradient.
 */
function buildChunk(originX, gradientMap) {
  const { near, far, chunkWidth, segmentsX, segmentsZ, detailTile } = TERRAIN;
  const geo = new THREE.PlaneGeometry(chunkWidth, near - far, segmentsX, segmentsZ);
  geo.rotateX(-Math.PI / 2); // lie it flat: XZ plane, Y up

  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const centerZ = (near + far) / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + originX;
    const z = pos.getZ(i) + centerZ;
    const y = heightAt(x, z);
    pos.setY(i, y);

    // UVs in world space, not per-chunk: the texture then runs continuously
    // across chunk seams however the chunks are sized or streamed.
    uv.setXY(i, x / detailTile, z / detailTile);

    const n = normalAt(x, z);
    const steep = smoothstep(1 - n.y, 0.25, 0.75);
    const height01 = clamp((y - TERRAIN.baseY) / 55, 0, 1);

    c.copy(PALETTE.lowland).lerp(PALETTE.upland, height01);

    // Farmland parcels. Quantising a low-frequency field breaks the lowlands
    // into discrete blocks of crop and pasture, which is what actually reads
    // as cultivated country from the air — continuous green reads as a
    // billiard table. Parcels fade out on slopes and high ground, because
    // nothing is ploughed there.
    const parcelN = fbm(x * 0.017 + 90.2, z * 0.017 - 45.6, 2, 2.0, 0.5);
    const parcel = Math.round(parcelN * 2.5) / 2.5;
    const arable = (1 - steep) * (1 - smoothstep(height01, 0.35, 0.8));
    c.offsetHSL(parcel * 0.05 * arable, parcel * 0.11 * arable, parcel * 0.075 * arable);

    // Crest lightening keyed to height, so ridgelines read from the air.
    c.lerp(PALETTE.crest, smoothstep(height01, 0.55, 1) * 0.55);
    // Steepness darkens: n.y falls as the ground tips over.
    c.lerp(PALETTE.slope, steep * 0.6);
    // Past a certain angle grass does not hold at all and rock shows through.
    c.lerp(PALETTE.rock, smoothstep(1 - n.y, 0.42, 0.85) * smoothstep(height01, 0.4, 0.9) * 0.8);
    // A strand at the waterline. Ground meeting water with no transition is
    // the single clearest tell that a lake is a painted plane — but the band
    // has to be tight. Wide enough to catch gently shelving ground and the
    // whole valley floor turns to beach, because the corridor puts so much of
    // the near country close to sea level. Steep ground gets no strand at all:
    // sand does not lie on a cliff.
    const shore = 1 - smoothstep(Math.abs(y - SEA_LEVEL), 0.8, 3.2);
    c.lerp(PALETTE.sand, shore * (1 - steep) * 0.8);
    // Atmospheric perspective, applied per-vertex rather than per-layer.
    c.lerp(PALETTE.distant, smoothstep(-z, 70, 300) * 0.82);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, map: groundTexture() }),
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
    // The texture is shared by every chunk, so it outlives them by design and
    // is not disposed here.
  }
}
