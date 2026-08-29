// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: this file is almost
// entirely measured coordinate data - station half-widths, facet heights, light-channel
// paths - read off the reference sheet in slab-relative units. Any literal that happens to
// land near a mathematical constant does so by coincidence, and rewriting it as Math.PI/n
// would replace a measurement with a false claim about where the number came from.

// exis07Build.ts — subject-specific geometry for the EXIS 07 strike craft.
//
// The `refine-code` artifact. The generated factory owns materials, lights and camera
// helpers derived from the spec; it builds each component as a primitive box, which is
// what a blockout is. This craft's identity is its FACETING, so the hull is authored as
// explicit vertices instead: a series of cross-section stations lofted with flat normals.
// Every surface is therefore a real flat polygon meeting its neighbours at a hard crease,
// which reproduces the reference exactly rather than approximating a curved fuselage.
//
// Nothing here smooths a normal. `flatShading` is on for every hull material, and the
// station loft deliberately emits independent triangles.

import * as THREE from 'three';

// Height raised from 0.26 to 0.33 of length. Measured back off the reference's own side
// and rear views (height/length 250/760 = 0.33) rather than guessed - the first table was
// 20% too shallow, which is why the craft read as a flat dart and left no internal volume
// for the air intake to breathe into.
export const SHIP = { length: 1.0, span: 0.62, height: 0.33 };

/**
 * Hull cross-sections, nose (+Z) to tail (-Z).
 *
 * Each station is a half-section; the other half is a mirror, so the craft is bilaterally
 * symmetric by construction rather than by two hand-authored halves that could drift.
 * `chineY` is where the widest point sits: that edge is the chine rail the long emissive
 * run follows, so it is a station parameter rather than something added afterwards.
 */
type Station = { z: number; hw: number; topY: number; chineY: number; botY: number; topHW: number };
const STATIONS: Station[] = [
  // Reshaped after comparing planforms. The first table tapered smoothly from a long point
  // and read as a dart: max span arrived at z -0.28, three quarters of the way aft. The
  // reference is a DELTA - a near-straight leading edge that reaches most of its span by
  // mid-length, then holds a wide constant-width body to the tail. Span/length stays 0.62,
  // measured from the rear and side views (span/height 1.81, length/height 3.04).
  // Sixteen stations, with the deck width and chine height stepped rather than smoothly
  // interpolated. A smooth interpolation puts every intermediate station on the same
  // surface, so the extra quads are coplanar and invisible; stepping them makes each span a
  // distinct panel.
  { z:  0.500, hw: 0.010, topY: 0.0051, chineY: 0.0000, botY: -0.0077, topHW: 0.0050 },
  { z:  0.455, hw: 0.032, topY: 0.0262, chineY: 0.0034, botY: -0.0272, topHW: 0.0148 },
  { z:  0.410, hw: 0.062, topY: 0.0448, chineY: 0.0074, botY: -0.0410, topHW: 0.0308 },
  { z:  0.360, hw: 0.098, topY: 0.0666, chineY: 0.0098, botY: -0.0563, topHW: 0.0442 },
  { z:  0.305, hw: 0.136, topY: 0.0812, chineY: 0.0142, botY: -0.0638, topHW: 0.0594 },
  { z:  0.250, hw: 0.170, topY: 0.0922, chineY: 0.0160, botY: -0.0691, topHW: 0.0686 },
  { z:  0.185, hw: 0.208, topY: 0.1012, chineY: 0.0204, botY: -0.0736, topHW: 0.0748 },
  { z:  0.120, hw: 0.240, topY: 0.1075, chineY: 0.0212, botY: -0.0768, topHW: 0.0812 },
  { z:  0.050, hw: 0.270, topY: 0.1112, chineY: 0.0252, botY: -0.0788, topHW: 0.0806 },
  { z: -0.020, hw: 0.292, topY: 0.1126, chineY: 0.0236, botY: -0.0794, topHW: 0.0874 },
  { z: -0.095, hw: 0.305, topY: 0.1116, chineY: 0.0244, botY: -0.0784, topHW: 0.0842 },
  { z: -0.170, hw: 0.312, topY: 0.1101, chineY: 0.0222, botY: -0.0768, topHW: 0.0916 },
  { z: -0.240, hw: 0.311, topY: 0.1062, chineY: 0.0216, botY: -0.0744, topHW: 0.0868 },
  { z: -0.300, hw: 0.308, topY: 0.1024, chineY: 0.0186, botY: -0.0717, topHW: 0.0936 },
  { z: -0.410, hw: 0.272, topY: 0.0909, chineY: 0.0132, botY: -0.0640, topHW: 0.0846 },
  { z: -0.500, hw: 0.220, topY: 0.0768, chineY: 0.0077, botY: -0.0576, topHW: 0.0824 },
];

/** The five profile points of a half-station, top centre round to bottom centre. */
function profile(s: Station): [number, number][] {
  const lower = s.chineY - s.botY;
  // Two extra points, and both are real CREASES rather than chamfers: a break part way down
  // the upper flank and one under the chine. I tried a nine-point version that chamfered
  // every corner and it turned the section into an ellipse - the craft came out a smooth
  // manta instead of a hard-surface racer. Flat runs meeting at hard corners is the whole
  // design language, so density has to come from breaks, never from rounding.
  return [
    [0, s.topY],
    [s.topHW, s.topY],                                    // deck edge, hard corner
    [s.topHW + (s.hw - s.topHW) * 0.62,                   // upper-flank crease
     s.chineY + (s.topY - s.chineY) * 0.30],
    [s.hw, s.chineY],                                     // the chine: widest point
    [s.hw * 0.93, s.chineY - lower * 0.40],               // break under the chine
    [s.topHW * 0.82, s.botY],
    [0, s.botY],
  ];
}

const MAT = {
  hull:      () => new THREE.MeshStandardMaterial({ color: 0x2f3d4d, roughness: 0.42, metalness: 0.15, flatShading: true }),
  hullDark:  () => new THREE.MeshStandardMaterial({ color: 0x16222d, roughness: 0.46, metalness: 0.15, flatShading: true }),
  canopy:    () => new THREE.MeshPhysicalMaterial({ color: 0x2a3645, roughness: 0.15, metalness: 0.30, clearcoat: 0.65, clearcoatRoughness: 0.06, flatShading: true }),
  // Emissive, not lit. The reference's strips stay at full brightness on faces turned away
  // from the key, which only an emitter does.
  emissive:  () => new THREE.MeshStandardMaterial({ color: 0x1b3550, emissive: 0x37c8ff, emissiveIntensity: 2.05, roughness: 0.3, flatShading: true }),
  glow:      () => new THREE.MeshStandardMaterial({ color: 0x123048, emissive: 0x7fe9ff, emissiveIntensity: 2.85, roughness: 0.25, flatShading: true }),
  // Deliberately NOT emissive: the vents take the full lighting solution in every view,
  // which is the only thing separating them from a second accent light.
  vent:      () => new THREE.MeshStandardMaterial({ color: 0xec761a, roughness: 0.60, metalness: 0.20, flatShading: true }),
};

/** Accumulate independent triangles; nothing is welded, so normals stay per-face. */
class Facets {
  pos: number[] = [];
  tri(a: number[], b: number[], c: number[]) { this.pos.push(...a, ...b, ...c); }
  quad(a: number[], b: number[], c: number[], d: number[]) { this.tri(a, b, c); this.tri(a, c, d); }
  mesh(material: THREE.Material, name: string): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals(); // per-face, because no vertices are shared
    const m = new THREE.Mesh(g, material);
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    return m;
  }
}

/** Loft the stations into the faceted hull, both halves plus nose and tail caps. */
export function buildHull(): THREE.Mesh {
  const f = new Facets();
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i], b = STATIONS[i + 1];
    const pa = profile(a), pb = profile(b);
    for (let k = 0; k < pa.length - 1; k++) {
      for (const sx of [1, -1]) {
        const A = [pa[k][0] * sx, pa[k][1], a.z];
        const B = [pa[k + 1][0] * sx, pa[k + 1][1], a.z];
        const C = [pb[k + 1][0] * sx, pb[k + 1][1], b.z];
        const D = [pb[k][0] * sx, pb[k][1], b.z];
        // Mirroring flips winding, so the port half is wound the other way round; without
        // this the whole left side renders as backfaces.
        if (sx > 0) f.quad(A, B, C, D); else f.quad(A, D, C, B);
      }
    }
  }
  // Tail cap, closing the aft station.
  const t = STATIONS[STATIONS.length - 1], pt = profile(t);
  for (let k = 0; k < pt.length - 1; k++) {
    f.quad([pt[k][0], pt[k][1], t.z], [pt[k + 1][0], pt[k + 1][1], t.z],
           [-pt[k + 1][0], pt[k + 1][1], t.z], [-pt[k][0], pt[k][1], t.z]);
  }
  return f.mesh(MAT.hull(), 'hull');
}

/** A convex prism from a half-profile, mirrored — the workhorse for spine, fins and pods. */
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
      flip ? f.tri(A, C, B) : f.tri(A, B, C);
    }
  };
  if (caps[0]) cap(sections[0], false);
  if (caps[1]) cap(sections[sections.length - 1], true);
  return f.mesh(material, name);
}

/**
 * Mirror a mesh across the centreline plane.
 *
 * Negating x is only half of a reflection: it also reverses the winding of every triangle,
 * so a part built by multiplying its x coordinates by -1 comes out with inverted normals.
 * That is exactly what made the craft asymmetric - the port fin, pod, feather plates and
 * light channels were all lit from the inside. Reversing each triangle's vertex order
 * restores the handedness, which is the same rule the skill states for `-l`/`-r` pairs:
 * a reflection, never a rotation.
 */
function mirrorX(mesh: THREE.Mesh, name: string): THREE.Mesh {
  const src = mesh.geometry.getAttribute('position');
  const out = new Float32Array(src.count * 3);
  for (let t = 0; t < src.count; t += 3) {
    // Vertices 1 and 2 swap, which flips the winding back.
    const order = [0, 2, 1];
    for (let k = 0; k < 3; k++) {
      const i = t + order[k];
      out[(t + k) * 3 + 0] = -src.getX(i);
      out[(t + k) * 3 + 1] = src.getY(i);
      out[(t + k) * 3 + 2] = src.getZ(i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mesh.material);
  m.name = name;
  m.castShadow = mesh.castShadow;
  m.receiveShadow = mesh.receiveShadow;
  return m;
}

/** Build a starboard part and add it together with its true mirror. */
function addPair(g: THREE.Group, build: () => THREE.Mesh, base: string) {
  const r = build();
  r.name = `${base}-r`;
  g.add(r, mirrorX(r, `${base}-l`));
}

/** A ribbon of quads along a 3D polyline, used for every inset light channel. */
function ribbon(
  path: [number, number, number][], width: number, material: THREE.Material, name: string,
  widthDir: [number, number, number] = [0, 1, 0],
): THREE.Mesh {
  const f = new Facets();
  // The caller states which way the strip's WIDTH runs. Deriving it as cross(dir, up) laid
  // every ribbon flat in the horizontal plane, so the chine run - which follows a near
  // vertical crease - stuck out sideways and read as a fin of light instead of a line
  // inset into the hull side.
  const wd = new THREE.Vector3(...widthDir).normalize();
  for (let i = 0; i < path.length - 1; i++) {
    const p = new THREE.Vector3(...path[i]);
    const q = new THREE.Vector3(...path[i + 1]);
    const dir = q.clone().sub(p).normalize();
    // Re-orthogonalise against the segment so the band stays perpendicular to its run.
    const side = wd.clone().addScaledVector(dir, -wd.dot(dir));
    if (side.lengthSq() < 1e-9) side.copy(new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)));
    side.normalize().multiplyScalar(width / 2);
    f.quad(
      [p.x - side.x, p.y - side.y, p.z - side.z], [p.x + side.x, p.y + side.y, p.z + side.z],
      [q.x + side.x, q.y + side.y, q.z + side.z], [q.x - side.x, q.y - side.y, q.z - side.z],
    );
  }
  const m = f.mesh(material, name);
  m.castShadow = false; // an emitter should not cast; it would darken the channel it lights
  return m;
}

/** Interpolate a station's parameters at an arbitrary z. */
function stationAt(z: number): Station {
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i], b = STATIONS[i + 1];
    if (z <= a.z && z >= b.z) {
      const t = (a.z - z) / (a.z - b.z);
      const L = (p: keyof Station) => (a[p] as number) + ((b[p] as number) - (a[p] as number)) * t;
      return { z, hw: L('hw'), topY: L('topY'), chineY: L('chineY'), botY: L('botY'), topHW: L('topHW') };
    }
  }
  return STATIONS[STATIONS.length - 1];
}

/**
 * A point on the UPPER FLANK facet - the sloping panel between the top shoulder and the
 * chine - plus the in-facet direction the light channel's width should run along.
 *
 * The chine itself is the widest point of the section, so a strip placed exactly on it is
 * edge-on from above and disappears. In the reference the long run sits on the sloping
 * upper flank just inboard of the chine, where it is visible from every view that shows the
 * top. `t` is the fraction from shoulder to chine.
 */
function flankAt(z: number, t: number): { p: [number, number]; dir: [number, number] } {
  const s = stationAt(z);
  const S: [number, number] = [s.topHW, s.topY];
  const C: [number, number] = [s.hw, s.chineY];
  const p: [number, number] = [S[0] + (C[0] - S[0]) * t, S[1] + (C[1] - S[1]) * t];
  const dx = S[0] - C[0], dy = S[1] - C[1];
  const len = Math.hypot(dx, dy) || 1;
  return { p, dir: [dx / len, dy / len] };
}

/**
 * A point on the whole upper surface, parameterised by `u`.
 *
 * `u` 0..1 runs centreline to deck edge across the flat deck; 1..2 runs deck edge to chine
 * down the upper flank. One continuous parameter over both panels, so a plate can be laid
 * anywhere on the top of the craft without caring which facet it lands on.
 */
function surfaceAt(z: number, u: number): { p: [number, number]; n: [number, number] } {
  const s = stationAt(z);
  if (u <= 1) {
    const p: [number, number] = [s.topHW * u, s.topY];
    return { p, n: [0, 1] };                       // the deck faces straight up
  }
  const t = u - 1;
  const S: [number, number] = [s.topHW, s.topY];
  const C: [number, number] = [s.hw, s.chineY];
  const p: [number, number] = [S[0] + (C[0] - S[0]) * t, S[1] + (C[1] - S[1]) * t];
  const dx = C[0] - S[0], dy = C[1] - S[1];
  const len = Math.hypot(dx, dy) || 1;
  return { p, n: [-dy / len, dx / len] };          // outward normal of the upper flank
}

/**
 * A raised panel lying on the upper surface.
 *
 * This is where facet density comes from. Subdividing the loft finer only makes smaller
 * pieces of the SAME plane, and chamfering the section rounds it - both were tried. What
 * the reference actually has is many distinct plates with hard edges: each one adds a top
 * face plus four side walls at a real angle to the hull, so it reads as a break even under
 * flat light. Eight plates a side add more visible facets than doubling the station count.
 */
function plate(
  z0: number, z1: number, u0: number, u1: number, thick: number,
  material: THREE.Material, name: string,
): THREE.Mesh {
  const f = new Facets();
  const corner = (z: number, u: number, lift: number): number[] => {
    const { p, n } = surfaceAt(z, u);
    return [p[0] + n[0] * lift, p[1] + n[1] * lift, z];
  };
  const eps = 0.0015;
  const lo = [corner(z0, u0, eps), corner(z0, u1, eps), corner(z1, u1, eps), corner(z1, u0, eps)];
  const hi = [corner(z0, u0, eps + thick), corner(z0, u1, eps + thick),
              corner(z1, u1, eps + thick), corner(z1, u0, eps + thick)];
  f.quad(hi[0], hi[1], hi[2], hi[3]);                       // top face
  for (let k = 0; k < 4; k++) {                             // four hard-edged walls
    const k2 = (k + 1) % 4;
    f.quad(lo[k], lo[k2], hi[k2], hi[k]);
  }
  return f.mesh(material, name);
}

/** The panel network: discrete plates that give the hull its facet density. */
function buildPlates(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'hull-plates';
  // z0, z1, u0, u1, thickness. Laid out to follow the craft's own structure: nose plates
  // stepping back from the tip, deck panels either side of the spine, flank strakes running
  // the chine, and a wing panel aft.
  const PANELS: [number, number, number, number, number][] = [
    [ 0.470,  0.395, 0.10, 0.85, 0.0026],   // nose crown
    [ 0.470,  0.395, 1.15, 1.85, 0.0024],   // nose cheek
    [ 0.385,  0.290, 0.15, 0.80, 0.0028],   // forward deck
    [ 0.385,  0.290, 1.10, 1.90, 0.0026],   // forward flank
    [ 0.275,  0.150, 0.55, 0.95, 0.0028],   // deck, outboard of the spine
    [ 0.275,  0.150, 1.20, 1.92, 0.0028],   // mid flank strake
    [ 0.130, -0.030, 0.60, 0.96, 0.0026],   // mid deck
    [ 0.130, -0.030, 1.30, 1.94, 0.0028],   // long chine strake
    [-0.050, -0.200, 0.62, 0.97, 0.0026],   // aft deck
    [-0.050, -0.200, 1.25, 1.92, 0.0028],   // aft flank
    [-0.220, -0.360, 0.55, 0.95, 0.0024],   // tail deck
    [-0.220, -0.360, 1.20, 1.88, 0.0026],   // tail flank
  ];
  PANELS.forEach(([z0, z1, u0, u1, t], i) => {
    // Mostly hull, with an occasional darker plate. Every third one dark read as patches of
    // black rather than as panelling.
    const mat = i % 5 === 3 ? MAT.hullDark() : MAT.hull();
    addPair(g, () => plate(z0, z1, u0, u1, t, mat, `plate-${i}`), `plate-${i}`);
  });
  return g;
}

/** Raised dorsal spine: what the canopy is recessed into and the fins spring from. */
function buildSpine(): THREE.Mesh {
  const S = (z: number, hw: number, y0: number, y1: number): { z: number; pts: [number, number][] } =>
    ({ z, pts: [[-hw, y0], [-hw * 0.7, y1], [hw * 0.7, y1], [hw, y0]] });
  return prism([
    S(0.300, 0.030, 0.067, 0.077),
    S(0.180, 0.072, 0.092, 0.110),
    S(0.020, 0.082, 0.108, 0.120),
    S(-0.170, 0.078, 0.108, 0.138),
    S(-0.300, 0.058, 0.100, 0.123),
  ], MAT.hull(), 'dorsal-spine');
}

/** Canopy: an elongated faceted hexagon set INTO the spine, not sitting on it. */
function buildCanopy(): THREE.Mesh {
  const S = (z: number, hw: number, y0: number, y1: number): { z: number; pts: [number, number][] } =>
    ({ z, pts: [[-hw, y0], [-hw * 0.62, y1], [hw * 0.62, y1], [hw, y0]] });
  const m = prism([
    S(0.250, 0.018, 0.097, 0.110),
    S(0.175, 0.058, 0.108, 0.151),
    S(0.065, 0.072, 0.115, 0.169),
    S(-0.045, 0.060, 0.115, 0.159),
    S(-0.100, 0.024, 0.110, 0.133),
  ], MAT.canopy(), 'canopy');
  return m;
}

/** Twin swept dorsal fins, splayed outboard. Mirrored, never rotated. */
function buildFins(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'dorsal-fins';
  // Built once on the starboard side and reflected. Multiplying x by -1 in place, as the
  // first version did, reverses the winding of every triangle and lights the port fin from
  // the inside - which is where the craft's asymmetry came from.
  const buildFin = () => {
    const f = new Facets();
    // Root and tip outlines in (z, y); the fin is a thin swept plate.
    const root: [number, number][] = [[-0.180, 0.128], [-0.300, 0.123], [-0.430, 0.118], [-0.360, 0.113]];
    const tip: [number, number][]  = [[-0.250, 0.286], [-0.320, 0.279], [-0.400, 0.238], [-0.330, 0.231]];
    const xr = 0.052, xt = 0.088, th = 0.009;
    for (let k = 0; k < root.length; k++) {
      const k2 = (k + 1) % root.length;
      for (const o of [-th / 2, th / 2]) {
        f.quad([xr + o, root[k][1], root[k][0]], [xr + o, root[k2][1], root[k2][0]],
               [xt + o, tip[k2][1], tip[k2][0]], [xt + o, tip[k][1], tip[k][0]]);
      }
      f.quad([xr - th / 2, root[k][1], root[k][0]], [xr + th / 2, root[k][1], root[k][0]],
             [xr + th / 2, root[k2][1], root[k2][0]], [xr - th / 2, root[k2][1], root[k2][0]]);
      f.quad([xt - th / 2, tip[k][1], tip[k][0]], [xt + th / 2, tip[k][1], tip[k][0]],
             [xt + th / 2, tip[k2][1], tip[k2][0]], [xt - th / 2, tip[k2][1], tip[k2][0]]);
    }
    return f.mesh(MAT.hull(), 'dorsal-fin');
  };
  addPair(g, buildFin, 'dorsal-fin');
  // Emissive strip ON the outer face, parallel to the swept leading edge.
  addPair(g, () => ribbon([
    [0.076, 0.148, -0.208], [0.076, 0.208, -0.238], [0.076, 0.256, -0.270],
  ], 0.016, MAT.emissive(), 'fin-strip', [0, 0, 1]), 'fin-strip');
  return g;
}

/** Wingtip pods: faceted blocks terminating each wing, housing an outboard engine. */
function buildPods(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'wingtip-pods';
  // Eight-point section with SHALLOW corner cuts. Deep chamfers (0.24+) round a nacelle
  // into a pill; 0.12 keeps the sides flat and just breaks the corners, which is what adds
  // facets without softening the form.
  const S = (z: number, x0: number, x1: number, y0: number, y1: number) => {
    const cx = (x1 - x0) * 0.12, cy = (y1 - y0) * 0.13;
    return { z, pts: [
      [x0 + cx, y0], [x0, y0 + cy], [x0, y1 - cy], [x0 + cx, y1],
      [x1 - cx, y1], [x1, y1 - cy], [x1, y0 + cy], [x1 - cx, y0],
    ] as [number, number][] };
  };
  // The pod is a NACELLE: inlet lip at the nose, nozzle at the tail, one duct between.
  // Enlarged on review from ~0.06 wide by 0.095 tall to ~0.13 by 0.17, and carried further
  // forward, so it reads as its own mass rather than a fairing on the wingtip.
  addPair(g, () => prism([
    S(0.150, 0.244, 0.324, -0.038, 0.048),
    S(0.040, 0.234, 0.348, -0.062, 0.076),
    S(-0.080, 0.228, 0.362, -0.078, 0.094),
    S(-0.210, 0.226, 0.366, -0.080, 0.096),
    S(-0.330, 0.230, 0.360, -0.072, 0.086),
    S(-0.410, 0.238, 0.344, -0.056, 0.066),
    S(-0.455, 0.250, 0.324, -0.040, 0.046),
  ], MAT.hull(), 'wingtip-pod'), 'wingtip-pod');
  // Emissive slot on the pod's outer flank.
  addPair(g, () => ribbon([[0.360, 0.012, -0.110], [0.364, 0.012, -0.250]], 0.034,
                          MAT.emissive(), 'tip-slot'), 'tip-slot');
  return g;
}

/** One octagonal nozzle: a recessed housing with horizontal emissive grille bars. */
function buildNozzle(x: number, y: number, z: number, r: number, bars: number, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  const oct = (rad: number, ry: number): [number, number][] =>
    Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      return [Math.cos(a) * rad, Math.sin(a) * ry] as [number, number];
    });
  // A RECESS, not a boss. The first version capped both ends of the housing prism, which
  // made each nozzle a closed octagonal solid: no opening, and the grille sealed inside
  // where nothing could see it. The walls now funnel FORWARD into the hull from the tail
  // face, both ends open, with the grille closing the far end.
  // The housing protrudes AFT of the tail face and funnels forward, so the octagonal rim
  // is the aftmost thing on the craft and the grille sits just behind it. Funnelling
  // forward from the tail face instead put the whole recess inside the hull, where the
  // solid tail cap occluded it - the nozzles rendered as flat dark octagons.
  const lip = z - 0.048;      // rim, aft of the tail face
  const depth = 0.058;        // funnel depth, running forward toward the tail face
  const housing = prism([
    { z: lip,               pts: oct(r,        r * 0.80) },
    { z: lip + depth * 0.45, pts: oct(r * 0.86, r * 0.68) },
    { z: lip + depth,       pts: oct(r * 0.74, r * 0.58) },
  ], MAT.hullDark(), `${name}-housing`, [false, false]);
  housing.material.side = THREE.DoubleSide; // the recess is seen from inside
  g.add(housing);
  const f = new Facets();
  const bw = r * 0.58, bh = r * 0.095, gap = r * 0.068;
  const total = bars * bh + (bars - 1) * gap;
  for (let i = 0; i < bars; i++) {
    const by = -total / 2 + i * (bh + gap) + bh / 2;
    // Wound to face AFT (-Z). The natural counter-clockwise-in-XY order gives a +Z normal,
    // so every bar was a backface from the only direction that can see into the nozzle.
    f.quad([-bw, by + bh / 2, 0], [bw, by + bh / 2, 0], [bw, by - bh / 2, 0], [-bw, by - bh / 2, 0]);
  }
  const grille = f.mesh(MAT.glow(), `${name}-grille`);
  // A fixed 20mm inside the rim, not a fraction of the funnel depth. As a fraction the
  // central nozzle's grille landed at z -0.498, forward of the hull's tail cap at -0.500,
  // so the cap occluded it and only the outboard pair lit up.
  grille.position.set(0, 0, lip + 0.020);
  grille.castShadow = false;
  g.add(grille);
  // No backing plate: the hull's own tail cap sits directly behind the grille and does the
  // job, and an extra plane would z-fight it.
  g.position.set(x, y, 0);
  return g;
}

/** Layered plates fanning aft from each wing trailing edge, four per side. */
/**
 * Trailing plates — REMOVED after review.
 *
 * The reviewer deleted all eight (four per side) in the inspector, which is an unambiguous
 * verdict on the implementation: they were built as flat shelves cantilevered off the wing
 * trailing edge and read as shipping pallets bolted to the back of the craft, not as the
 * reference's layered swept blades.
 *
 * The reference DOES carry this feature — the side view clearly shows three or four stacked
 * plates fanning aft. So this is a removal of a bad implementation, not of the feature. A
 * correct version needs each plate tapered in chord, swept to a point, and integrated INTO
 * the trailing edge rather than hung off it; until that exists the craft is better without.
 * Recorded in the spec's risks so it cannot quietly disappear from the plan.
 */
function buildFeathers(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'feather-plate';
  return g;
}

/** Orange intake vents, seated in recessed sockets: two on the spine, one per side aft. */
/**
 * Air intakes: a recessed opening on each lower flank, forward of the wing.
 *
 * Added at the reviewer's note that the craft needs the volume for one. It is also what the
 * extra hull height is FOR — a 0.26-deep hull had nowhere to put a duct, and raising the
 * section to 0.33 without opening an intake would just have made a fatter dart.
 *
 * Built as a lip and a throat that funnels inward and aft, with a dark interior, so the
 * opening reads as a duct going somewhere rather than a black rectangle painted on.
 */
function buildIntakes(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'air-intakes';
  const throatMat = new THREE.MeshStandardMaterial({ color: 0x0a1017, roughness: 0.9, flatShading: true });

  const buildIntake = () => {
    const f = new Facets();
    // The inlet is cut into the POD'S NOSE and ducts aft toward its engine, so intake and
    // nozzle are the two ends of one nacelle. Sized just inside the pod's leading section
    // (x 0.276-0.302, y -0.026..0.033) so the lip sits in the pod face rather than floating
    // beside it.
    const lip: [number, number][] = [[0.252, -0.030], [0.318, -0.030], [0.318, 0.042], [0.252, 0.042]];
    const back: [number, number][] = [[0.266, -0.014], [0.304, -0.014], [0.304, 0.026], [0.266, 0.026]];
    const zLip = 0.148, zBack = -0.020;
    for (let k = 0; k < lip.length; k++) {
      const k2 = (k + 1) % lip.length;
      f.quad([lip[k][0], lip[k][1], zLip], [lip[k2][0], lip[k2][1], zLip],
             [back[k2][0], back[k2][1], zBack], [back[k][0], back[k][1], zBack]);
    }
    // Closed back wall, so the duct is a cavity and not a hole through the hull - an open
    // one shows as an interior hole in the turntable gate, and correctly so.
    for (let k = 1; k < back.length - 1; k++) {
      f.tri([back[0][0], back[0][1], zBack], [back[k + 1][0], back[k + 1][1], zBack],
            [back[k][0], back[k][1], zBack]);
    }
    const m = f.mesh(throatMat, 'air-intake');
    m.material.side = THREE.DoubleSide; // the throat is seen from inside
    return m;
  };
  addPair(g, buildIntake, 'air-intake');

  // A thin emissive sliver across the inlet's upper lip, matching the reference's habit of
  // outlining every opening.
  addPair(g, () => ribbon([
    [0.254, 0.046, 0.149], [0.316, 0.046, 0.149],
  ], 0.012, MAT.emissive(), 'intake-lip', [0, 0, 1]), 'intake-lip');
  return g;
}

function buildVents(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'vents';
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const socketMat = new THREE.MeshStandardMaterial({ color: 0x0e161e, roughness: 0.85, flatShading: true });
  const place = (x: number, y: number, z: number, w: number, h: number, d: number, rz: number, name: string) => {
    // A dark socket sunk BELOW the vent, so the orange block reads as sitting in a recess.
    // Sized 1.1x tall and centred only 0.42h down, the socket's top cleared the vent's and
    // swallowed it into a black box.
    const socket = new THREE.Mesh(box(w * 1.34, h * 0.9, d * 1.22), socketMat);
    socket.position.set(x, y - h * 0.62, z); socket.rotation.z = rz;
    socket.name = `${name}-socket`; socket.receiveShadow = true;
    const m = new THREE.Mesh(box(w, h * 0.62, d), MAT.vent());
    m.position.set(x, y - h * 0.12, z); m.rotation.z = rz; m.name = name;
    m.castShadow = true; m.receiveShadow = true;
    g.add(socket, m);
  };
  // Boxes are symmetric in themselves, so mirroring these needs only the sign flip on x
  // and on the roll angle - there is no winding to reverse in a BoxGeometry.
  for (const sx of [1, -1]) {
    const side = sx > 0 ? 'r' : 'l';
    place(0.086 * sx, 0.128, 0.150, 0.030, 0.016, 0.070, -0.16 * sx, `vent-spine-${side}`);
    place(0.152 * sx, 0.066, -0.140, 0.028, 0.014, 0.060, -0.22 * sx, `vent-mid-${side}`);
  }
  return g;
}

/** The cyan channel network: chine run, nose chevron, wing loop. */
function buildLightChannels(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'light-channels';
  // The long run, nose to tail, riding the upper flank facet just inboard of the chine.
  const chine: [number, number, number][] = [];
  let flankDir: [number, number] = [0, 1];
  for (let z = 0.44; z >= -0.42; z -= 0.02) {
    const { p, dir } = flankAt(z, 0.72);
    flankDir = dir;
    // Lifted off the facet along its own outward sense so it never z-fights the hull.
    chine.push([p[0] + 0.006, p[1] + 0.004, z]);
  }
  addPair(g, () => ribbon(chine, 0.021, MAT.emissive(), 'chine-strip',
                          [flankDir[0], flankDir[1], 0]), 'chine-strip');
  // Nose chevron, apex forward, wrapping the underside of the nose.
  addPair(g, () => ribbon([
    [0.008, -0.006, 0.474], [0.078, -0.016, 0.336], [0.156, -0.020, 0.196],
  ], 0.018, MAT.emissive(), 'nose-chevron', [0, 1, 0]), 'nose-chevron');
  // Wing loop: angular, following panel breaks. Corners stay hard - the reference has no
  // curved light runs anywhere.
  addPair(g, () => ribbon([
    [0.148, 0.048, -0.055], [0.238, 0.052, -0.150], [0.278, 0.048, -0.268],
    [0.236, 0.044, -0.352], [0.150, 0.052, -0.318],
  ], 0.019, MAT.emissive(), 'wing-loop', [0, 0, 1]), 'wing-loop');
  return g;
}

/** Decals drawn to a canvas at build time — generated, never projected. */
function decalTexture(kind: 'nose' | 'hull'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas context unavailable; decals cannot be generated');
  x.clearRect(0, 0, 512, 256);
  // Measured off the reference: the ink is off-white (#F2F5F8), not pure white.
  x.fillStyle = '#f2f5f8';
  x.strokeStyle = '#f2f5f8';
  if (kind === 'nose') {
    // Arrow-in-triangle logo over "07", as carried on the forward flank. The mark's
    // internal geometry is below the reference's resolution; this is the approximation the
    // spec records, not a claim to have read it.
    x.beginPath();
    x.moveTo(256, 34); x.lineTo(324, 150); x.lineTo(188, 150); x.closePath();
    x.lineWidth = 12; x.stroke();
    x.beginPath();
    x.moveTo(256, 70); x.lineTo(288, 132); x.lineTo(224, 132); x.closePath();
    x.fill();
    x.font = 'bold 96px "Helvetica Neue", Arial, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'top';
    x.fillText('07', 256, 158);
  } else {
    // "EXIS" wordmark with the large "07" aft of it, as on the mid-hull flank.
    x.textAlign = 'left'; x.textBaseline = 'middle';
    x.font = 'bold 52px "Helvetica Neue", Arial, sans-serif';
    x.fillText('EXIS', 26, 132);
    x.font = 'bold 150px "Helvetica Neue", Arial, sans-serif';
    x.fillText('07', 220, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildDecals(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'decal-set';

  /**
   * Seat a decal ON the upper flank facet at a given station.
   *
   * The first version placed a plane at a fixed x with a 90-degree Y rotation, which put it
   * inside the hull and facing sideways - so the marks were half-buried and clipped. This
   * craft has no vertical flanks: its section is 0.15 tall against 0.29 half-width, so the
   * "side" the reference letters onto is a shallow sloping deck. The decal therefore has to
   * be built on that facet's own frame: normal outward, text running along the fuselage.
   */
  const place = (
    z: number, t: number, w: number, h: number, tex: THREE.CanvasTexture, name: string, sx: number,
  ) => {
    const { p, dir } = flankAt(z, t);
    // dir runs chine -> shoulder within the facet. Its perpendicular in the XY plane, taken
    // the outboard way, is the facet's outward normal. The whole FRAME is mirrored for the
    // port side, not just the position: flipping position alone leaves the plane facing
    // starboard, so the port marks were seen from behind and read backwards.
    const n = new THREE.Vector3(-dir[1], dir[0], 0).normalize();
    if (n.x < 0) n.negate();
    n.x *= sx;
    // Text runs along the plane's local +X. On starboard that is toward the TAIL, so the
    // wordmark starts at the nose and reads forward-to-aft. Viewed from port the nose is on
    // the other side of the screen, so the same reading order needs the opposite direction -
    // mirroring only the normal left the glyphs reversed ("SIX3", "L0").
    const along = new THREE.Vector3(0, 0, -sx);
    const across = new THREE.Vector3().crossVectors(n, along).normalize();
    const basis = new THREE.Matrix4().makeBasis(along, across, n);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({
        map: tex, transparent: true, roughness: 0.55, metalness: 0.05,
        // Lifted off the facet AND depth-offset: a decal coplanar with a flat-shaded facet
        // z-fights across the whole quad, not just at its edges.
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }),
    );
    mesh.quaternion.setFromRotationMatrix(basis);
    mesh.position.set(p[0] + n.x * 0.004, p[1] + n.y * 0.004, z);
    mesh.name = name;
    return mesh;
  };

  const noseTex = decalTexture('nose');
  const hullTex = decalTexture('hull');
  // Two marks per side, at the stations the reference carries them: the logo block on the
  // forward flank, the wordmark and numerals on the mid-hull.
  for (const [sx, side] of [[1, 'r'], [-1, 'l']] as [number, string][]) {
    for (const [z, t, w, h, tex, base] of [
      [0.250, 0.46, 0.150, 0.075, noseTex, 'decal-nose'],
      [-0.045, 0.42, 0.300, 0.150, hullTex, 'decal-hull'],
    ] as [number, number, number, number, THREE.CanvasTexture, string][]) {
      const m = place(z, t, w, h, tex, `${base}-${side}`, sx);
      m.position.x = Math.abs(m.position.x) * sx;
      g.add(m);
    }
  }
  return g;
}

/** Assemble the craft. */
export function createExis07(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'EXIS 07';
  root.add(buildHull());
  root.add(buildPlates());
  root.add(buildSpine());
  root.add(buildCanopy());
  root.add(buildFins());
  root.add(buildVents());
  root.add(buildDecals());

  // Grouped to match the spec's component tree so the craft is explodable along the same
  // boundaries the spec describes. `wing` is the interesting case: its SKIN is part of the
  // hull loft (the wing is the hull's flare, not a bolted-on part, which is what the spec's
  // topologyRationale says), so the group holds the things that are structurally the wing -
  // pods, trailing plates and the wing light loop - rather than a separate wing surface.
  const wing = new THREE.Group();
  wing.name = 'wing';
  const pods = buildPods(); pods.name = 'wingtip-pod';
  // The feather group is still added, empty: the spec lists the component, and an empty
  // named group records that it was removed on review rather than never specified.
  const feathers = buildFeathers(); feathers.name = 'feather-plate';
  wing.add(pods, feathers);
  root.add(wing);
  root.add(buildIntakes());

  const channels = buildLightChannels();
  const chevron = new THREE.Group();
  chevron.name = 'nose-chevron';
  for (const c of [...channels.children]) {
    if (c.name.startsWith('nose-chevron-')) chevron.add(c);
  }
  channels.add(chevron);
  root.add(channels);

  const prop = new THREE.Group();
  prop.name = 'propulsion';
  // Three nozzles: one large central, two smaller outboard inside the wingtip pods.
  prop.add(buildNozzle(0, 0.012, -0.500, 0.088, 5, 'engine-central'));
  const outboard = new THREE.Group();
  outboard.name = 'engine-outboard';
  outboard.add(buildNozzle(0.296, 0.009, -0.458, 0.090, 4, 'engine-outboard-r'));
  outboard.add(buildNozzle(-0.296, 0.009, -0.458, 0.090, 4, 'engine-outboard-l'));
  prop.add(outboard);
  root.add(prop);
  return root;
}
