// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: this file is measured
// coordinate data - station half-widths, pontoon sections, panel positions - read off a
// six-view orthographic sheet. Any literal near a mathematical constant is a coincidence.

// auricomBuild.ts — AURICOM 07 anti-grav racer.
//
// Built from a six-view sheet (front, top, bottom, back, side, 45-degree render), which is
// the first reference here to include a BOTTOM view — so nothing is inferred, the underside
// included. Measured proportions: length 1.00, span 0.60, height 0.26, taken from the
// orthographic views rather than judged by eye.
//
// Everything learned on the previous craft is applied from the start:
//   · flat normals throughout; nothing is smoothed
//   · every mirrored part goes through mirrorX, which reverses winding as well as negating
//     x — negating alone lights the port side from inside
//   · facet density comes from discrete PLATES, never from chamfering the section, which
//     rounds a hard-surface craft into a manta
//   · a hard key with little fill, because a soft rig compresses adjacent facet values
//     until the creases vanish

import * as THREE from 'three';

export const SHIP = { length: 1.0, span: 0.60, height: 0.26 };

type Station = { z: number; hw: number; topY: number; botY: number; deckHW: number };

/**
 * Central fuselage, nose (+Z) to tail (-Z).
 *
 * The side view is the governing one here: a very thin spike low at the front, a top surface
 * that climbs steadily to a peak around 70% aft, and a flat underside the whole way. The
 * craft is a wedge on top of a plank, not a tube.
 */
const STATIONS: Station[] = [
  { z:  0.500, hw: 0.006, topY: -0.056, botY: -0.074, deckHW: 0.004 },
  { z:  0.430, hw: 0.022, topY: -0.030, botY: -0.078, deckHW: 0.012 },
  { z:  0.355, hw: 0.044, topY:  0.000, botY: -0.080, deckHW: 0.026 },
  { z:  0.270, hw: 0.068, topY:  0.032, botY: -0.082, deckHW: 0.042 },
  { z:  0.180, hw: 0.086, topY:  0.058, botY: -0.083, deckHW: 0.054 },
  { z:  0.080, hw: 0.098, topY:  0.078, botY: -0.084, deckHW: 0.062 },
  { z: -0.020, hw: 0.106, topY:  0.092, botY: -0.085, deckHW: 0.068 },
  { z: -0.130, hw: 0.112, topY:  0.101, botY: -0.086, deckHW: 0.072 },
  { z: -0.240, hw: 0.115, topY:  0.104, botY: -0.086, deckHW: 0.074 },
  { z: -0.340, hw: 0.122, topY:  0.104, botY: -0.086, deckHW: 0.082 },
  { z: -0.430, hw: 0.128, topY:  0.104, botY: -0.086, deckHW: 0.092 },
  { z: -0.500, hw: 0.130, topY:  0.100, botY: -0.086, deckHW: 0.098 },
];

/** Half-section: flat deck, straight flank, flat keel. Flat runs, hard corners. */
function profile(s: Station): [number, number][] {
  return [
    [0, s.topY],
    [s.deckHW, s.topY],                          // deck edge
    [s.hw, s.topY - (s.topY - s.botY) * 0.42],   // shoulder, part way down the flank
    [s.hw, s.botY + (s.topY - s.botY) * 0.12],   // lower flank
    [s.deckHW * 0.92, s.botY],                   // keel edge
    [0, s.botY],
  ];
}

const MAT = {
  // The sheet's hull is near-white with a distinctly darker grey underside and mid-tone
  // panels; the contrast between them is most of what reads as form.
  shell:  () => new THREE.MeshStandardMaterial({ color: 0xe9eaec, roughness: 0.46, metalness: 0.06, flatShading: true }),
  mid:    () => new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.50, metalness: 0.08, flatShading: true }),
  under:  () => new THREE.MeshStandardMaterial({ color: 0x6c7075, roughness: 0.55, metalness: 0.08, flatShading: true }),
  dark:   () => new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.52, metalness: 0.12, flatShading: true }),
  black:  () => new THREE.MeshStandardMaterial({ color: 0x141618, roughness: 0.60, metalness: 0.10, flatShading: true }),
  intake: () => new THREE.MeshStandardMaterial({ color: 0x1a3038, emissive: 0x7fdcf0, emissiveIntensity: 1.5, roughness: 0.35, flatShading: true }),
  accent: () => new THREE.MeshStandardMaterial({ color: 0xd9481f, roughness: 0.55, metalness: 0.05, flatShading: true }),
};

class Facets {
  pos: number[] = [];
  tri(a: number[], b: number[], c: number[]) { this.pos.push(...a, ...b, ...c); }
  quad(a: number[], b: number[], c: number[], d: number[]) { this.tri(a, b, c); this.tri(a, c, d); }
  mesh(material: THREE.Material, name: string): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    return m;
  }
}

/** Mirror across the centreline: negate x AND reverse winding, or the port side lights from inside. */
function mirrorX(mesh: THREE.Mesh, name: string): THREE.Mesh {
  const src = mesh.geometry.getAttribute('position');
  const out = new Float32Array(src.count * 3);
  for (let t = 0; t < src.count; t += 3) {
    for (const [k, o] of [0, 2, 1].entries()) {
      const i = t + o;
      out[(t + k) * 3] = -src.getX(i);
      out[(t + k) * 3 + 1] = src.getY(i);
      out[(t + k) * 3 + 2] = src.getZ(i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mesh.material);
  m.name = name; m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow;
  return m;
}
function addPair(g: THREE.Group, build: () => THREE.Mesh, base: string) {
  const r = build(); r.name = `${base}-r`;
  g.add(r, mirrorX(r, `${base}-l`));
}

/** Convex prism from stacked sections. */
function prism(
  sections: { z: number; pts: [number, number][] }[], material: THREE.Material, name: string,
  caps: [boolean, boolean] = [true, true],
): THREE.Mesh {
  const f = new Facets();
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    for (let k = 0; k < a.pts.length; k++) {
      const k2 = (k + 1) % a.pts.length;
      f.quad([a.pts[k][0], a.pts[k][1], a.z], [a.pts[k2][0], a.pts[k2][1], a.z],
             [b.pts[k2][0], b.pts[k2][1], b.z], [b.pts[k][0], b.pts[k][1], b.z]);
    }
  }
  const cap = (s: { z: number; pts: [number, number][] }, flip: boolean) => {
    for (let k = 1; k < s.pts.length - 1; k++) {
      const A = [s.pts[0][0], s.pts[0][1], s.z];
      const B = [s.pts[k][0], s.pts[k][1], s.z];
      const C = [s.pts[k + 1][0], s.pts[k + 1][1], s.z];
      if (flip) f.tri(A, C, B); else f.tri(A, B, C);
    }
  };
  if (caps[0]) cap(sections[0], false);
  if (caps[1]) cap(sections[sections.length - 1], true);
  return f.mesh(material, name);
}

/** The central fuselage: white shell above, darker keel below. */
function buildFuselage(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fuselage';
  const f = new Facets();          // upper shell
  const u = new Facets();          // keel, a separate mesh so it can take the darker tone
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i], b = STATIONS[i + 1];
    const pa = profile(a), pb = profile(b);
    for (let k = 0; k < pa.length - 1; k++) {
      // Split at the lower-flank index so the underside carries its own material — the
      // sheet's bottom view is markedly darker than its top, and one material for both
      // loses that.
      const target = k >= 3 ? u : f;
      for (const sx of [1, -1]) {
        const A = [pa[k][0] * sx, pa[k][1], a.z];
        const B = [pa[k + 1][0] * sx, pa[k + 1][1], a.z];
        const C = [pb[k + 1][0] * sx, pb[k + 1][1], b.z];
        const D = [pb[k][0] * sx, pb[k][1], b.z];
        if (sx > 0) target.quad(A, B, C, D); else target.quad(A, D, C, B);
      }
    }
  }
  const t = STATIONS[STATIONS.length - 1], pt = profile(t);
  for (let k = 0; k < pt.length - 1; k++) {
    u.quad([pt[k][0], pt[k][1], t.z], [pt[k + 1][0], pt[k + 1][1], t.z],
           [-pt[k + 1][0], pt[k + 1][1], t.z], [-pt[k][0], pt[k][1], t.z]);
  }
  g.add(f.mesh(MAT.shell(), 'fuselage-shell'), u.mesh(MAT.under(), 'fuselage-keel'));
  return g;
}

/**
 * Side pontoons.
 *
 * From the top view these run most of the length: narrow forward booms that widen into the
 * rear pods carrying the AURICOM lettering. Each has a cyan intake on its front face and a
 * dark exhaust at its tail — the two ends of one duct.
 */
function buildPontoons(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pontoons';
  const S = (z: number, x0: number, x1: number, y0: number, y1: number) => {
    const cx = (x1 - x0) * 0.16, cy = (y1 - y0) * 0.18;
    return { z, pts: [
      [x0 + cx, y0], [x0, y0 + cy], [x0, y1 - cy], [x0 + cx, y1],
      [x1 - cx, y1], [x1, y1 - cy], [x1, y0 + cy], [x1 - cx, y0],
    ] as [number, number][] };
  };
  addPair(g, () => prism([
    S(0.340, 0.152, 0.222, -0.050, -0.004),
    S(0.240, 0.150, 0.238, -0.064,  0.018),
    S(0.100, 0.146, 0.262, -0.076,  0.032),
    S(-0.060, 0.142, 0.282, -0.082,  0.038),
    S(-0.220, 0.140, 0.296, -0.084,  0.042),
    S(-0.360, 0.142, 0.302, -0.084,  0.042),
    S(-0.470, 0.146, 0.302, -0.082,  0.036),
    S(-0.500, 0.150, 0.298, -0.078,  0.028),
  ], MAT.shell(), 'pontoon'), 'pontoon');

  // Cyan intake on the pontoon's front face — the one bright thing on an otherwise white
  // craft, and the front view's strongest cue.
  addPair(g, () => {
    const f = new Facets();
    const x0 = 0.134, x1 = 0.180, y0 = -0.044, y1 = -0.014, z = 0.341;
    f.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
    const m = f.mesh(MAT.intake(), 'intake');
    m.castShadow = false;
    return m;
  }, 'intake');

  // Exhaust: a dark recess in the pontoon tail rather than a painted rectangle.
  addPair(g, () => prism([
    { z: -0.498, pts: [[0.146, -0.062], [0.276, -0.062], [0.276, 0.006], [0.146, 0.006]] },
    { z: -0.430, pts: [[0.160, -0.050], [0.262, -0.050], [0.262, -0.004], [0.160, -0.004]] },
  ], MAT.black(), 'exhaust', [false, true]), 'exhaust');
  return g;
}

/** Dark canopy and spine block on the fuselage deck. */
function buildCanopy(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'canopy';
  const S = (z: number, hw: number, y0: number, y1: number) =>
    ({ z, pts: [[-hw, y0], [-hw * 0.64, y1], [hw * 0.64, y1], [hw, y0]] as [number, number][] });
  g.add(prism([
    S(0.190, 0.028, 0.056, 0.062),
    S(0.090, 0.056, 0.076, 0.096),
    S(-0.030, 0.070, 0.090, 0.116),
    S(-0.150, 0.072, 0.099, 0.124),
    S(-0.260, 0.064, 0.103, 0.120),
    S(-0.330, 0.044, 0.100, 0.110),
  ], MAT.dark(), 'canopy-glass'));
  // Engine housing: the raised block the top view shows between the rear pods.
  g.add(prism([
    S(-0.300, 0.062, 0.096, 0.112),
    S(-0.420, 0.070, 0.088, 0.118),
    S(-0.500, 0.068, 0.080, 0.108),
  ], MAT.mid(), 'engine-housing'));
  return g;
}

/** Central exhaust between the rear pods. */
function buildCentreExhaust(): THREE.Mesh {
  return prism([
    { z: -0.498, pts: [[-0.070, -0.078], [0.070, -0.078], [0.070, 0.062], [-0.070, 0.062]] },
    { z: -0.420, pts: [[-0.056, -0.066], [0.056, -0.066], [0.056, 0.048], [-0.056, 0.048]] },
  ], MAT.black(), 'centre-exhaust', [false, true]);
}

/** Surface point on the pontoon's outer flank, for laying plates and decals. */
function pontoonFlank(z: number, v: number): { p: [number, number]; n: [number, number] } {
  // Linear between the pontoon's own sections, sampled coarsely: enough to seat a panel on
  // the flank without duplicating the section table.
  const K: [number, number, number, number][] = [
    [0.340, 0.186, -0.052, -0.006], [0.240, 0.214, -0.066, 0.016], [0.100, 0.244, -0.076, 0.030],
    [-0.060, 0.272, -0.080, 0.036], [-0.220, 0.292, -0.082, 0.038], [-0.360, 0.300, -0.082, 0.034],
    [-0.470, 0.296, -0.080, 0.024], [-0.500, 0.286, -0.076, 0.014],
  ];
  let a = K[0], b = K[1];
  for (let i = 0; i < K.length - 1; i++) {
    if (z <= K[i][0] && z >= K[i + 1][0]) { a = K[i]; b = K[i + 1]; break; }
  }
  const t = (a[0] - z) / (a[0] - b[0] || 1);
  const x = a[1] + (b[1] - a[1]) * t;
  const y0 = a[2] + (b[2] - a[2]) * t;
  const y1 = a[3] + (b[3] - a[3]) * t;
  return { p: [x, y0 + (y1 - y0) * v], n: [1, 0] };
}

/**
 * Panel plates.
 *
 * Density comes from discrete plates with hard-edged walls, not from subdividing the loft
 * (smaller pieces of the same plane) or chamfering the section (which rounds it). The sheet
 * shows exactly this: the pontoon flanks are broken into lettered panels with visible seams.
 */
function buildPlates(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'hull-plates';
  const plate = (z0: number, z1: number, v0: number, v1: number, thick: number,
                 mat: THREE.Material, name: string) => {
    const f = new Facets();
    const corner = (z: number, v: number, lift: number) => {
      const { p, n } = pontoonFlank(z, v);
      return [p[0] + n[0] * lift, p[1], z];
    };
    const eps = 0.0012;
    const lo = [corner(z0, v0, eps), corner(z0, v1, eps), corner(z1, v1, eps), corner(z1, v0, eps)];
    const hi = [corner(z0, v0, eps + thick), corner(z0, v1, eps + thick),
                corner(z1, v1, eps + thick), corner(z1, v0, eps + thick)];
    f.quad(hi[0], hi[1], hi[2], hi[3]);
    for (let k = 0; k < 4; k++) f.quad(lo[k], lo[k2(k)], hi[k2(k)], hi[k]);
    return f.mesh(mat, name);
  };
  const k2 = (k: number) => (k + 1) % 4;
  const PANELS: [number, number, number, number, number, boolean][] = [
    [ 0.320,  0.180, 0.18, 0.86, 0.0026, false],
    [ 0.160,  0.010, 0.14, 0.90, 0.0030, false],
    [-0.010, -0.170, 0.16, 0.88, 0.0030, true],
    [-0.190, -0.340, 0.14, 0.86, 0.0028, false],
    [-0.360, -0.470, 0.18, 0.82, 0.0026, true],
  ];
  PANELS.forEach(([z0, z1, v0, v1, t, dark], i) => {
    addPair(g, () => plate(z0, z1, v0, v1, t, dark ? MAT.mid() : MAT.shell(), `plate-${i}`), `plate-${i}`);
  });
  // Orange accent tabs, as on the rear pods and the back view.
  addPair(g, () => plate(-0.300, -0.360, 0.30, 0.62, 0.0030, MAT.accent(), 'accent'), 'accent-tab');
  return g;
}

/** Decals drawn to a canvas: AURICOM wordmark and the 07 numerals. */
function decalTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas context unavailable; decals cannot be generated');
  x.clearRect(0, 0, 1024, 256);
  x.fillStyle = '#1b1d20';
  x.textBaseline = 'middle';
  x.font = 'bold 74px "Helvetica Neue", Arial, sans-serif';
  x.fillText('AURICOM', 40, 128);
  x.font = 'bold 118px "Helvetica Neue", Arial, sans-serif';
  x.fillText('07', 470, 126);
  // The red block lettering the sheet carries aft of the numerals, as a mark rather than
  // legible text — it is below the reference's resolution to read.
  x.fillStyle = '#d9481f';
  x.font = 'bold 64px "Helvetica Neue", Arial, sans-serif';
  x.fillText('/////////', 660, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildDecals(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'decal-set';
  const tex = decalTexture();
  for (const [sx, side] of [[1, 'r'], [-1, 'l']] as [number, string][]) {
    const { p } = pontoonFlank(-0.10, 0.55);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.30, 0.072),
      new THREE.MeshStandardMaterial({
        map: tex, transparent: true, alphaTest: 0.4, roughness: 0.5, metalness: 0.04,
        // alphaTest, not transparency alone: with only `transparent` the cleared areas of
        // the canvas still rasterised as opaque black and the decal read as a dark slab
        // covering the whole pontoon flank.
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }),
    );
    // Text runs toward the tail on starboard and toward the nose on port, so it reads the
    // same way round from either side.
    m.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    // 0.009 clear of the flank: the panel plates stand ~0.004 proud, so a smaller offset
    // put the decal behind them and clipped the numerals.
    m.position.set((p[0] + 0.009) * sx, p[1] + 0.006, -0.13);
    m.name = `decal-${side}`;
    g.add(m);
  }
  return g;
}

/** Assemble the craft. */
export function createAuricom07(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'AURICOM 07';
  root.add(buildFuselage());
  root.add(buildPontoons());
  root.add(buildCanopy());
  root.add(buildPlates());
  root.add(buildDecals());
  const prop = new THREE.Group();
  prop.name = 'propulsion';
  prop.add(buildCentreExhaust());
  root.add(prop);
  return root;
}
