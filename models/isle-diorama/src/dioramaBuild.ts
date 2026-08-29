// dioramaBuild.ts — subject-specific geometry for the isometric diorama island.
//
// This is the `refine-code` artifact of the structural and form passes. The generated
// factory (createIsleDioramaModel.ts) owns materials, lights and camera helpers derived
// from the spec; it builds each component as a primitive box, which is what a blockout is.
// The identity of this subject is not in its primitives, though — it is in a COASTLINE and
// a LAYOUT, so the real geometry is driven by layout.json, the plan-view biome and
// elevation grid recovered from the reference (see projection-route.md).
//
// Landform grammar: the reference is flat tables separated by near-vertical rock risers,
// not rolling hills. So the terrain is built terraced: elevation is quantised to discrete
// tiers, every land cell emits a flat top quad at its tier, and a vertical wall is emitted
// wherever a neighbour sits lower. The risers are therefore a consequence of the grammar
// rather than something dressed on afterwards.
//
// Shading is PAINTED, never cel: albedo carries the value structure through vertex colour,
// lighting stays broad and soft, and there is no gradient ramp, no posterisation and no
// outline pass anywhere in this file.

import * as THREE from 'three';

type Grid = string[];
type Layout = {
  planResolution: number;
  classCodes: Record<string, string>;
  grid: Grid;
  land: Grid;
  elevation: number[][];
  landmarksPlan: Record<string, [number, number]>;
};

export const DIORAMA = {
  size: 1.0,      // slab edge length, the spec's relative unit
  thickness: 0.12,
  maxHeight: 0.115, // peak above sea level
  seaY: 0.0,
  tiers: 7,       // discrete plateau levels; this is what makes risers appear
  waterBandFraction: 0.3, // of slab thickness, per the cut-face observation
};

// Palette measured from the reference crops (material-analysis.json), keyed by the biome
// class the layout classifier assigns. Two stops each: lit and shaded. The painting
// darkens every form toward its base, so the shade stop is what the vertical risers and
// the undersides get.
const BIOME: Record<string, { lit: number; shade: number; rough: number }> = {
  deepsea:   { lit: 0x1a5aa8, shade: 0x0d3268, rough: 0.22 },
  sea:       { lit: 0x2a8ed0, shade: 0x145690, rough: 0.20 },
  shallow:   { lit: 0x5fd8dc, shade: 0x2a9aa6, rough: 0.26 },
  foam:      { lit: 0xdff0f6, shade: 0xbcdfe9, rough: 0.55 },
  beach:     { lit: 0xe6d5a2, shade: 0xc9b47e, rough: 0.92 },
  grass:     { lit: 0x6cba46, shade: 0x3c7a38, rough: 0.93 },
  field:     { lit: 0x96ba5c, shade: 0x5f8a3e, rough: 0.93 },
  darkgrass: { lit: 0x3f8850, shade: 0x235238, rough: 0.94 },
  rock:      { lit: 0x8b8b93, shade: 0x54566a, rough: 0.88 },
  mesa:      { lit: 0xd9ab6c, shade: 0xa8814e, rough: 0.90 },
  mountain:  { lit: 0x7d9dd0, shade: 0x3d5a8c, rough: 0.84 },
  snow:      { lit: 0xf2f7ff, shade: 0xc6d6ea, rough: 0.74 },
  earth:     { lit: 0xa87048, shade: 0x6b4228, rough: 0.95 },
  cloud:     { lit: 0xffffff, shade: 0xdde6f0, rough: 0.95 },
};
const WATER = new Set(['deepsea', 'sea', 'shallow', 'foam']);

// Deterministic PRNG. Every scatter in this model is seeded, so the same island is
// rebuilt byte-for-byte on every load and a review screenshot is comparable to the last.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const col = new THREE.Color();
function pushColor(arr: number[], hex: number, shade = 0) {
  col.setHex(hex);
  if (shade) col.multiplyScalar(1 - shade);
  arr.push(col.r, col.g, col.b);
}

/** Quantise a normalised elevation to a tier, then to world Y. Values above 1 are allowed
 *  so the massif can rise past the plateau range without being clipped to it. */
function tierY(e: number): number {
  const step = 1 / (DIORAMA.tiers - 1);
  return Math.round(Math.max(0, e) / step) * step * DIORAMA.maxHeight;
}

// The dominant snow-capped massif is identity feature #2, and the elevation blur that
// fixed the spike problem also flattened it: class-derived elevation gave the peak the
// same 0.72 as its foothills, and four blur passes averaged that away. So the peak is
// re-asserted from its OBSERVED plan position rather than hoped for from the class grid.
// The profile is a squared falloff with a ridge term, which gives the faceted ridgelines
// the reference shows instead of a smooth cone.
// Broader and lower than the first attempt: gain 2.15 gave a jagged spire, where the
// reference shows a wide pyramidal massif whose flanks reach most of the way across the
// rear quarter. The ridge amplitude is halved for the same reason - at 0.22 the angular
// term cut deep notches into the summit silhouette.
const MASSIF = { radius: 0.36, gain: 1.35, ridge: 0.11 };
// Value noise, deterministic and cheap. Needed because quantising a SMOOTH radial falloff
// produces perfect concentric rings - the first massif read as a topographic contour model
// or a ziggurat, not a mountain. Perturbing the field before quantisation turns those rings
// into irregular spurs and gullies, which is what the reference's faceted ridges are.
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm2(x: number, y: number): number {
  return vnoise(x, y) * 0.6 + vnoise(x * 2.1, y * 2.1) * 0.27 + vnoise(x * 4.3, y * 4.3) * 0.13;
}

function massifUplift(u: number, v: number, peak: [number, number]): number {
  const d = Math.hypot(u - peak[0], v - peak[1]) / MASSIF.radius;
  if (d >= 1) return 0;
  const base = (1 - d * d) ** 1.6;
  const ang = Math.atan2(v - peak[1], u - peak[0]);
  const ridge = 1 + MASSIF.ridge * Math.cos(ang * 5) * (1 - d);
  // Two noise terms: a broad one that bends the whole flank, and a finer one that breaks
  // each terrace edge. Both fade to zero at the rim so the massif still meets the lowland
  // cleanly instead of fraying into it.
  const broad = (fbm2(u * 6.5, v * 6.5) - 0.5) * 0.55 * (1 - d);
  const fine = (fbm2(u * 17.0, v * 17.0) - 0.5) * 0.22 * (1 - d) * (1 - d);
  return Math.max(0, MASSIF.gain * base * ridge * (1 + broad) + fine);
}

export function buildTerrain(layout: Layout): THREE.Group {
  const N = layout.planResolution;
  const cell = DIORAMA.size / N;
  const half = DIORAMA.size / 2;

  // Land and water accumulate into SEPARATE buffers. Merging them was convenient - one
  // mesh, one draw call - but it left the sea with no identity: the part-coverage gate
  // reported the spec's `sea-surface` component missing because nothing in the built tree
  // answered to it, and the diorama could not be taken apart along its most important
  // boundary.
  const pos: number[] = [];
  const colr: number[] = [];
  const seaPos: number[] = [];
  const seaColr: number[] = [];
  // Decode by the layout's explicit class codes. An earlier version decoded by first
  // letter, which collides on foam/field, sea/snow/shallow, deepsea/darkgrass and
  // mesa/mountain - and silently painted shallow-water cyan part way up the massif.
  const BY_CODE: Record<string, string> = Object.fromEntries(
    Object.entries(layout.classCodes).map(([name, code]) => [code as string, name]),
  );
  const classAt = (j: number, i: number) => BY_CODE[layout.grid[j][i]] ?? 'sea';
  const nameAt = (j: number, i: number): string => {
    const base = classAt(j, i);
    const e = elevAt(j, i);
    // Altitude bands win over the classifier on the massif: above the treeline the
    // surface is rock, and above the snowline it is snow, whatever biome the plan grid
    // recorded down at sea level under the cloud that covered the peak.
    // Inside the massif footprint a water class is a leftover from the cloud-inpainted
    // plan grid, not an observation - keeping it painted a cyan collar of foam and
    // shallows part-way up the mountainside.
    // Inside the massif footprint a water class is a leftover from the cloud-inpainted
    // plan grid, not an observation.
    const onMassif = massifUplift((i + 0.5) / N, (j + 0.5) / N, peak) > 0.35;
    if (e > 1.15) return 'snow';
    if (e > 0.70 || (onMassif && WATER.has(base))) return 'mountain';
    return base;
  };
  const peak = layout.landmarksPlan['mountain-peak'] as [number, number];
  const upliftAt = (j: number, i: number) =>
    massifUplift((i + 0.5) / N, (j + 0.5) / N, peak);
  const elevAt = (j: number, i: number) => {
    const e = layout.elevation[j][i];
    const up = upliftAt(j, i);
    // Inside the massif's core the plan grid is unreliable evidence: that is exactly the
    // region the reference's cloud bank covers, so cells there were inpainted and some
    // came back as water. Uplifting only the land cells left those as sea-level holes and
    // the massif rendered as a stand of isolated towers. Within the core the massif wins.
    if (up > 0.35) return Math.max(e, 0.05) + up;
    return e <= 0 ? e : e + up;
  };
  const heightAt = (j: number, i: number): number => {
    if (j < 0 || i < 0 || j >= N || i >= N) return DIORAMA.seaY;
    const e = elevAt(j, i);
    return e <= 0 ? DIORAMA.seaY : tierY(e);
  };

  const quad = (
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    hex: number, shade: number, water = false,
  ) => {
    const P = water ? seaPos : pos;
    const C = water ? seaColr : colr;
    P.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    for (let k = 0; k < 6; k++) pushColor(C, hex, shade);
  };

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const name = nameAt(j, i);
      const y = heightAt(j, i);
      const inMassif = upliftAt(j, i) > 0.35;
      // Plan (u,v) -> world. Solved from the reference's corner layout: with the camera
      // at azimuth 45, screen-right is (x - z) and screen-near is (x + z). The reference
      // shows W left, E right, N far, S near, and only x = u, z = 1 - v satisfies all
      // four. Mapping z = v directly (the obvious choice) put E nearest the camera and
      // laid the island down rotated a quarter turn.
      const x0 = -half + i * cell, x1 = x0 + cell;
      const z1 = half - j * cell, z0 = z1 - cell;
      let b = BIOME[name] ?? BIOME.sea;
      if (name === 'field' || name === 'grass') {
        // Rectilinear crop parcels. The reference's patchwork is an identity feature and
        // the plan grid alone renders it as undifferentiated green: parcels are a
        // land-use pattern, not a colour the classifier can see. Axis-aligned blocks of
        // ~9 cells, each block drawing one of four crop tints from a stable hash.
        const bu = Math.floor(i / 9), bv = Math.floor(j / 9);
        const pick = Math.floor(hash2(bu * 3.7, bv * 5.3) * 4);
        const CROP = [0x96ba5c, 0xc3c471, 0x6f9a45, 0x7fb04e];
        b = { lit: CROP[pick], shade: BIOME.field.shade, rough: 0.93 };
      }

      // Water cells stay flat at sea level; the sea is a surface, not a solid.
      const isWater = WATER.has(name) && !inMassif;
      const top = isWater ? DIORAMA.seaY : y;
      // Wound counter-clockwise seen from +Y so the top faces UP. The obvious ordering
      // (x0z0 -> x1z0 -> x1z1) gives a -Y normal, which renders every terrace as an
      // unlit backface - the whole island came out black.
      quad(x0, top, z0, x0, top, z1, x1, top, z1, x1, top, z0, b.lit, 0, isWater);

      if (isWater) continue;

      // Risers: wherever a neighbour is lower, close the gap with a vertical wall. This
      // is where the plateau-and-cliff grammar actually comes from.
      // Neighbour direction -> which edge of this cell it shares, and the winding that
      // makes the wall face outward. The z mapping is z = half - j*cell, so j DECREASES
      // as z increases: neighbour j-1 lies across the z1 edge and j+1 across z0. Getting
      // this backwards (the obvious j-1 -> z0) emits every riser on the wrong edge, which
      // leaves the real steps open and renders background straight through the massif.
      const sides: [number, number, number[], number[]][] = [
        [-1, 0, [x1, z1], [x0, z1]], // toward +z
        [1, 0, [x0, z0], [x1, z0]],      // toward -z
        [0, -1, [x0, z1], [x0, z0]],     // toward -x
        [0, 1, [x1, z0], [x1, z1]],      // toward +x
      ];
      for (const [dj, di, p, q] of sides) {
        const ny = heightAt(j + dj, i + di);
        if (ny >= top - 1e-6) continue;
        // Risers take the rock colour on tall steps and the biome's own shade on short
        // ones, so a field edge does not turn into a cliff face.
        const drop = top - ny;
        const tall = drop > DIORAMA.maxHeight / (DIORAMA.tiers - 1) * 1.5;
        // Rock on a real riser, the biome's own shade on a one-step edge. Using the dark
        // SHADE stop for rock made every wall read near-black; the lit stop with a modest
        // darkening is what the reference's sunlit cliff faces actually look like.
        const c = tall ? BIOME.rock.lit : b.shade;
        quad(p[0], top, p[1], q[0], top, q[1], q[0], ny, q[1], p[0], ny, p[1], c, tall ? 0.10 : 0.04);
      }
    }
  }

  const build = (P: number[], C: number[], name: string, rough: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: rough, metalness: 0.0,
    // Flat shading, not a toon ramp. Faceting is geometric here - it comes from the
    // terraced surface itself - which is how the painted look is reached without
    // quantising the lighting, the thing the user explicitly rejected.
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = name === 'landmass';
    mesh.receiveShadow = true;
    return mesh;
  };
  const g = new THREE.Group();
  g.name = 'terrain';
  // Sea roughness 0.2 against the land's 0.9: satin is the only non-matte response in the
  // scene, and it is what separates water from a painted blue field.
  g.add(build(pos, colr, 'landmass', 0.9), build(seaPos, seaColr, 'sea-surface', 0.2));
  return g;
}

/** The slab: a cut block whose side faces show a water band over an ochre earth stratum. */
export function buildSlab(): THREE.Mesh {
  const half = DIORAMA.size / 2;
  const bottom = -DIORAMA.thickness;
  const bandY = bottom + DIORAMA.thickness * DIORAMA.waterBandFraction;
  const rnd = mulberry32(0x51ab);

  const pos: number[] = [];
  const colr: number[] = [];
  const tri = (a: number[], b: number[], c: number[], hex: number, shade: number) => {
    pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) pushColor(colr, hex, shade);
  };
  const STEPS = 64;
  // Each of the four faces, walked in segments so the water/earth interface can wander.
  const faces: [number[], number[], number][] = [
    [[-half, -half], [half, -half], 0.10],
    [[half, -half], [half, half], 0.00],
    [[half, half], [-half, half], 0.06],
    [[-half, half], [-half, -half], 0.16],
  ];
  for (const [a, b, shade] of faces) {
    let prevY = bandY;
    for (let s = 0; s < STEPS; s++) {
      const t0 = s / STEPS, t1 = (s + 1) / STEPS;
      const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      // Ragged interface, deliberately. A level band reads as a printed stripe, which is
      // the single clearest tell that the slab is a box rather than a cut piece of world.
      const y0 = prevY;
      const y1 = s === STEPS - 1 ? bandY
        : bandY + (rnd() - 0.5) * DIORAMA.thickness * 0.16;
      prevY = y1;
      // water band above the interface
      tri([p0[0], DIORAMA.seaY, p0[1]], [p1[0], DIORAMA.seaY, p1[1]], [p1[0], y1, p1[1]], 0x2f8fd0, shade);
      tri([p0[0], DIORAMA.seaY, p0[1]], [p1[0], y1, p1[1]], [p0[0], y0, p0[1]], 0x2f8fd0, shade);
      // earth stratum below it
      tri([p0[0], y0, p0[1]], [p1[0], y1, p1[1]], [p1[0], bottom, p1[1]], 0x8c5c38, shade);
      tri([p0[0], y0, p0[1]], [p1[0], bottom, p1[1]], [p0[0], bottom, p0[1]], 0x8c5c38, shade);
    }
  }
  // Flat underside; hidden in the reference, stated as an assumption in the spec.
  tri([-half, bottom, -half], [half, bottom, half], [half, bottom, -half], 0x5a3822, 0.3);
  tri([-half, bottom, -half], [-half, bottom, half], [half, bottom, half], 0x5a3822, 0.3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true,
  }));
  mesh.name = 'slab-base';
  mesh.receiveShadow = true;
  return mesh;
}

// --------------------------------------------------------------------------- props
const MAT = {
  wall:   () => new THREE.MeshStandardMaterial({ color: 0xf0e8dc, roughness: 0.9, flatShading: true }),
  roof:   () => new THREE.MeshStandardMaterial({ color: 0xc2452c, roughness: 0.85, flatShading: true }),
  stone:  () => new THREE.MeshStandardMaterial({ color: 0x9a9aa6, roughness: 0.9, flatShading: true }),
  tree:   () => new THREE.MeshStandardMaterial({ color: 0x2a6d4e, roughness: 0.95, flatShading: true }),
  trunk:  () => new THREE.MeshStandardMaterial({ color: 0x5c4530, roughness: 0.95, flatShading: true }),
  timber: () => new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.9, flatShading: true }),
  water:  () => new THREE.MeshStandardMaterial({ color: 0xe8f4fa, roughness: 0.4, flatShading: true }),
  cloud:  () => new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.95, flatShading: true }),
};

/** Sampler over the recovered grid, in plan coordinates (u,v in 0..1). */
function makeSampler(layout: Layout) {
  const N = layout.planResolution;
  const peak = layout.landmarksPlan['mountain-peak'] as [number, number];
  const half = DIORAMA.size / 2;
  const idx = (u: number, v: number) => [
    Math.max(0, Math.min(N - 1, Math.floor(v * N))),
    Math.max(0, Math.min(N - 1, Math.floor(u * N))),
  ];
  return {
    N,
    /** Plan (u,v) -> world (x,z). */
    world: (u: number, v: number): [number, number] =>
      [-half + u * DIORAMA.size, half - v * DIORAMA.size],
    heightUV: (u: number, v: number) => {
      const [j, i] = idx(u, v);
      const e = layout.elevation[j][i];
      if (e <= 0) return DIORAMA.seaY;
      return tierY(e + massifUplift(u, v, peak));
    },
    classUV: (u: number, v: number) => {
      const [j, i] = idx(u, v);
      const byCode: Record<string, string> = Object.fromEntries(
        Object.entries(layout.classCodes).map(([n, c]) => [c as string, n]));
      return { name: byCode[layout.grid[j][i]] ?? 'sea', e: layout.elevation[j][i] };
    },
    isLandUV: (u: number, v: number) => {
      const [j, i] = idx(u, v);
      return layout.land[j][i] === '1' && layout.elevation[j][i] > 0;
    },
  };
}

/** Conifers, instanced. Density follows the biome, so they cluster where the reference does. */
function buildTrees(layout: Layout, s: ReturnType<typeof makeSampler>): THREE.Group {
  const rnd = mulberry32(20260829);
  const g = new THREE.Group();
  g.name = 'conifer-scatter';
  const placed: { x: number; y: number; z: number; h: number }[] = [];
  const TARGET = 1400;
  for (let attempt = 0; attempt < TARGET * 40 && placed.length < TARGET; attempt++) {
    const u = rnd(), v = rnd();
    if (!s.isLandUV(u, v)) continue;
    const { name, e } = s.classUV(u, v);
    if (massifUplift(u, v, (layout.landmarksPlan['mountain-peak'] as [number, number])) > 0.55) continue;
    // Weights straight off the observation: forests sit on grass and dark grass, thin out
    // on farmland, and do not grow on sand, bare rock, snow or the arid mesa.
    const w = name === 'darkgrass' ? 0.95 : name === 'grass' ? 0.55 : name === 'field' ? 0.10 : 0.0;
    if (w === 0 || rnd() > w) continue;
    if (e > 0.62) continue; // no treeline on the peaks
    const [x, z] = s.world(u, v);
    placed.push({ x, y: s.heightUV(u, v), z, h: 0.011 + rnd() * 0.011 });
  }
  const cone = new THREE.ConeGeometry(0.34, 1, 6);
  const mesh = new THREE.InstancedMesh(cone, MAT.tree(), placed.length);
  const m = new THREE.Matrix4();
  placed.forEach((p, k) => {
    m.makeScale(p.h, p.h, p.h);
    // Seated slightly into the ground: a prop resting exactly on a terrace shows a
    // hairline gap wherever the cell below it steps down.
    m.setPosition(p.x, p.y + p.h * 0.45 - 0.0015, p.z);
    mesh.setMatrixAt(k, m);
  });
  mesh.castShadow = true;
  mesh.name = 'conifers';
  g.add(mesh);
  return g;
}

/** One house: a rendered wall block under a gable roof. */
function makeHouse(scale = 1): THREE.Group {
  const h = new THREE.Group();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.010, 0.012), MAT.wall());
  wall.position.y = 0.005;
  // Gable, not a cone: a triangular profile extruded along the ridge.
  const shape = new THREE.Shape();
  shape.moveTo(-0.009, 0); shape.lineTo(0.009, 0); shape.lineTo(0, 0.008); shape.closePath();
  const roof = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: 0.016, bevelEnabled: false }), MAT.roof());
  roof.rotation.y = Math.PI / 2;
  roof.position.set(0.008, 0.010, 0);
  wall.name = 'house-unit';
  roof.name = 'house-roof';
  h.add(wall, roof);
  h.scale.setScalar(scale);
  h.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return h;
}

/** Hamlets: clusters of 3-8 houses, never singles. */
function buildHamlets(layout: Layout, s: ReturnType<typeof makeSampler>): THREE.Group {
  const rnd = mulberry32(20260830);
  const g = new THREE.Group();
  g.name = 'hamlet-clusters';
  const centres: [number, number][] = [
    ...Object.entries(layout.landmarksPlan)
      .filter(([k]) => k.startsWith('hamlet') || k === 'village-east')
      .map(([, p]) => p as [number, number]),
  ];
  // A few more clusters seeded on flat lowland, to match the reference's spread.
  for (let attempt = 0; attempt < 4000 && centres.length < 9; attempt++) {
    const u = rnd(), v = rnd();
    if (!s.isLandUV(u, v)) continue;
    const { e } = s.classUV(u, v);
    if (e > 0.3) continue;
    if (centres.some(([cu, cv]) => Math.hypot(cu - u, cv - v) < 0.16)) continue;
    centres.push([u, v]);
  }
  for (const [cu, cv] of centres) {
    const n = 3 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
      const u = cu + (rnd() - 0.5) * 0.055;
      const v = cv + (rnd() - 0.5) * 0.055;
      if (!s.isLandUV(u, v)) continue;
      const [x, z] = s.world(u, v);
      const house = makeHouse(0.85 + rnd() * 0.4);
      house.position.set(x, s.heightUV(u, v) - 0.0008, z);
      house.rotation.y = rnd() * Math.PI * 2;
      g.add(house);
    }
  }
  return g;
}

/** The named landmarks, placed at their un-projected plan positions. */
function buildLandmarks(layout: Layout, s: ReturnType<typeof makeSampler>): THREE.Group {
  const g = new THREE.Group();
  g.name = 'structures';
  const at = (key: string) => {
    const p = layout.landmarksPlan[key];
    const [x, z] = s.world(p[0], p[1]);
    return { x, z, y: s.heightUV(p[0], p[1]) };
  };

  // Castle: cream walls with cylindrical towers under red conical caps.
  {
    const p = at('castle');
    const c = new THREE.Group();
    const keep = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.020, 0.026), MAT.wall());
    keep.position.y = 0.010;
    c.add(keep);
    // Tower offsets and heights in slab units, read off the reference.
    const towers: [number, number, number][] = [
      [-0.013, 0.030, -0.010],
      [0.013, 0.024, -0.010],
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: a tower height, not a constant.
      [0.000, 0.036, 0.012],
    ];
    for (const [dx, th, dz] of towers) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0075, th, 10), MAT.wall());
      t.position.set(dx, th / 2, dz);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.0095, 0.013, 10), MAT.roof());
      cap.position.set(dx, th + 0.0065, dz);
      c.add(t, cap);
    }
    c.position.set(p.x, p.y, p.z);
    c.name = 'castle';
    g.add(c);
  }

  // Lighthouse: tapered tower, dark gallery band, red cap.
  {
    const p = at('lighthouse');
    const c = new THREE.Group();
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0085, 0.038, 12), MAT.wall());
    tower.position.y = 0.019;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0068, 0.004, 12),
      new THREE.MeshStandardMaterial({ color: 0x3a4550, roughness: 0.85, flatShading: true }));
    band.position.y = 0.036;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.0080, 0.011, 12), MAT.roof());
    cap.position.y = 0.0435;
    c.add(tower, band, cap);
    c.position.set(p.x, p.y, p.z);
    c.name = 'lighthouse';
    g.add(c);
  }

  // Windmill: tapering tower, conical cap, four lattice sails on a hub.
  {
    const p = at('windmill');
    const c = new THREE.Group();
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.0070, 0.0110, 0.040, 12), MAT.wall());
    tower.position.y = 0.020;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.0095, 0.010, 12), MAT.roof());
    cap.position.y = 0.045;
    c.add(tower, cap);
    const hub = new THREE.Group();
    hub.position.set(0, 0.042, 0.009);
    for (let k = 0; k < 4; k++) {
      const sail = new THREE.Mesh(new THREE.BoxGeometry(0.0035, 0.030, 0.0012), MAT.timber());
      sail.position.y = 0.015;
      const arm = new THREE.Group();
      arm.rotation.z = (k / 4) * Math.PI * 2;
      arm.add(sail);
      hub.add(arm);
    }
    hub.name = 'windmill-sails';
    c.add(hub);
    c.position.set(p.x, p.y, p.z);
    c.name = 'windmill';
    g.add(c);
  }

  // Two mesa watchtowers.
  for (const key of ['watchtower-a', 'watchtower-b']) {
    const p = at(key);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.0060, 0.0075, 0.026, 9), MAT.stone());
    t.position.set(p.x, p.y + 0.013, p.z);
    t.name = key;
    g.add(t);
  }

  // Stone ring: an upright annulus, broken at the base.
  {
    const p = at('stone-ring');
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.030, 0.0055, 8, 28, Math.PI * 1.72), MAT.stone());
    ring.position.set(p.x, p.y + 0.030, p.z);
    ring.rotation.z = -Math.PI * 0.36;
    ring.rotation.y = Math.PI * 0.15;
    ring.name = 'stone-ring';
    g.add(ring);
  }

  // Multi-arch bridge: a repeated arch on piers, spanning the central strait.
  {
    const p = at('arch-bridge');
    const c = new THREE.Group();
    const SPAN = 0.115, ARCHES = 6;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(SPAN, 0.0045, 0.014), MAT.stone());
    deck.position.y = 0.030;
    c.add(deck);
    for (let k = 0; k < ARCHES; k++) {
      const x = -SPAN / 2 + (k + 0.5) * (SPAN / ARCHES);
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.0075, 0.030, 0.012), MAT.stone());
      pier.position.set(x, 0.015, 0);
      c.add(pier);
    }
    c.position.set(p.x, p.y, p.z);
    c.rotation.y = Math.PI * 0.22;
    c.name = 'arch-bridge';
    g.add(c);
  }

  // Waterfall: a thin curtain off the west cliff with a spray disc where it lands.
  {
    const p = at('waterfall');
    const c = new THREE.Group();
    const drop = Math.max(0.02, p.y - DIORAMA.seaY);
    const curtain = new THREE.Mesh(new THREE.BoxGeometry(0.016, drop, 0.004), MAT.water());
    curtain.position.y = drop / 2;
    const spray = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.010, 0.004, 12), MAT.water());
    spray.position.y = 0.002;
    c.add(curtain, spray);
    c.position.set(p.x, DIORAMA.seaY, p.z);
    c.name = 'waterfall';
    g.add(c);
  }

  // Timber pier on posts.
  {
    const p = at('pier');
    const c = new THREE.Group();
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.0022, 0.011), MAT.timber());
    deck.position.y = 0.006;
    c.add(deck);
    for (let k = 0; k < 5; k++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, 0.012, 6), MAT.timber());
      post.position.set(-0.019 + k * 0.0095, 0.0, 0);
      c.add(post);
    }
    c.position.set(p.x, DIORAMA.seaY, p.z);
    c.name = 'pier';
    g.add(c);
  }

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** Cumulus masses: puffs on a common flat base, at and below plateau height. */
function buildClouds(): THREE.Group {
  const rnd = mulberry32(20260833);
  const g = new THREE.Group();
  g.name = 'cloud-layer';
  const geo = new THREE.IcosahedronGeometry(1, 1);
  for (let c = 0; c < 13; c++) {
    const mass = new THREE.Group();
    const puffs = 5 + Math.floor(rnd() * 5);
    const scale = 0.020 + rnd() * 0.026;
    for (let p = 0; p < puffs; p++) {
      const r = scale * (0.55 + rnd() * 0.6);
      const puff = new THREE.Mesh(geo, MAT.cloud());
      // Flat base: puffs are pinned to a common baseline and squashed, which is what
      // separates a cumulus from a pile of spheres.
      puff.position.set((p - puffs / 2) * scale * 0.75 + (rnd() - 0.5) * scale * 0.4,
                        rnd() * scale * 0.35, (rnd() - 0.5) * scale * 0.7);
      puff.scale.set(r * 1.25, r * 0.62, r * 1.1);
      mass.add(puff);
    }
    const ang = rnd() * Math.PI * 2;
    const rad = 0.30 + rnd() * 0.34;
    mass.position.set(Math.cos(ang) * rad,
                      DIORAMA.maxHeight * (1.15 + rnd() * 1.35),
                      Math.sin(ang) * rad);
    g.add(mass);
  }
  return g;
}

/** Assemble the diorama. */
export async function createIsleDiorama(layoutUrl = './layout.json'): Promise<THREE.Group> {
  const layout: Layout = await (await fetch(layoutUrl)).json();
  const s = makeSampler(layout);
  const root = new THREE.Group();
  root.name = 'Isle Diorama';
  root.add(buildSlab());
  root.add(buildTerrain(layout));
  root.add(buildTrees(layout, s));
  root.add(buildHamlets(layout, s));
  root.add(buildLandmarks(layout, s));
  root.add(buildClouds());
  return root;
}
