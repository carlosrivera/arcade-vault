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

export const SHIP = { length: 1.0, span: 0.62, height: 0.26 };

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
  { z:  0.500, hw: 0.010, topY: 0.004, chineY:  0.000, botY: -0.006, topHW: 0.005 },
  { z:  0.430, hw: 0.052, topY: 0.030, chineY:  0.004, botY: -0.030, topHW: 0.024 },
  { z:  0.310, hw: 0.104, topY: 0.055, chineY:  0.008, botY: -0.046, topHW: 0.050 },
  { z:  0.160, hw: 0.175, topY: 0.076, chineY:  0.014, botY: -0.056, topHW: 0.070 },
  { z:  0.000, hw: 0.242, topY: 0.086, chineY:  0.018, botY: -0.060, topHW: 0.080 },
  { z: -0.150, hw: 0.292, topY: 0.086, chineY:  0.018, botY: -0.060, topHW: 0.086 },
  { z: -0.280, hw: 0.310, topY: 0.080, chineY:  0.014, botY: -0.055, topHW: 0.090 },
  { z: -0.400, hw: 0.268, topY: 0.070, chineY:  0.010, botY: -0.050, topHW: 0.086 },
  { z: -0.500, hw: 0.218, topY: 0.060, chineY:  0.006, botY: -0.045, topHW: 0.080 },
];

/** The five profile points of a half-station, top centre round to bottom centre. */
function profile(s: Station): [number, number][] {
  return [
    [0, s.topY],
    [s.topHW, s.topY],
    [s.hw, s.chineY],      // the chine: widest point, and where the light channel runs
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

/** Raised dorsal spine: what the canopy is recessed into and the fins spring from. */
function buildSpine(): THREE.Mesh {
  const S = (z: number, hw: number, y0: number, y1: number): { z: number; pts: [number, number][] } =>
    ({ z, pts: [[-hw, y0], [-hw * 0.7, y1], [hw * 0.7, y1], [hw, y0]] });
  return prism([
    S(0.300, 0.030, 0.052, 0.060),
    S(0.180, 0.072, 0.072, 0.086),
    S(0.020, 0.082, 0.084, 0.094),
    S(-0.170, 0.078, 0.084, 0.108),
    S(-0.300, 0.058, 0.078, 0.096),
  ], MAT.hull(), 'dorsal-spine');
}

/** Canopy: an elongated faceted hexagon set INTO the spine, not sitting on it. */
function buildCanopy(): THREE.Mesh {
  const S = (z: number, hw: number, y0: number, y1: number): { z: number; pts: [number, number][] } =>
    ({ z, pts: [[-hw, y0], [-hw * 0.62, y1], [hw * 0.62, y1], [hw, y0]] });
  const m = prism([
    S(0.250, 0.018, 0.076, 0.086),
    S(0.175, 0.058, 0.084, 0.118),
    S(0.065, 0.072, 0.090, 0.132),
    S(-0.045, 0.060, 0.090, 0.124),
    S(-0.100, 0.024, 0.086, 0.104),
  ], MAT.canopy(), 'canopy');
  return m;
}

/** Twin swept dorsal fins, splayed outboard. Mirrored, never rotated. */
function buildFins(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'dorsal-fins';
  for (const sx of [1, -1]) {
    const f = new Facets();
    // Root and tip outlines in (z, y); the fin is a thin swept plate.
    const root: [number, number][] = [[-0.180, 0.100], [-0.300, 0.096], [-0.430, 0.092], [-0.360, 0.088]];
    const tip: [number, number][]  = [[-0.250, 0.238], [-0.320, 0.232], [-0.400, 0.196], [-0.330, 0.190]];
    const xr = 0.052 * sx, xt = 0.088 * sx, th = 0.009;
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
    g.add(f.mesh(MAT.hull(), sx > 0 ? 'dorsal-fin-r' : 'dorsal-fin-l'));
    // Emissive strip ON the outer face, parallel to the swept leading edge. The first
    // version ran along the fin's top edge at y 0.196-0.236, which put it above the plate
    // rather than on it - it read as a glowing hook floating over the tail.
    const finX = 0.070 * sx + 0.006 * sx;
    g.add(ribbon([
      [finX, 0.118, -0.208], [finX, 0.170, -0.238], [finX, 0.212, -0.270],
    ], 0.016, MAT.emissive(), sx > 0 ? 'fin-strip-r' : 'fin-strip-l', [0, 0, 1]));
  }
  return g;
}

/** Wingtip pods: faceted blocks terminating each wing, housing an outboard engine. */
function buildPods(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'wingtip-pods';
  for (const sx of [1, -1]) {
    const S = (z: number, x0: number, x1: number, y0: number, y1: number) =>
      ({ z, pts: [[x0 * sx, y0], [x0 * sx, y1], [x1 * sx, y1], [x1 * sx, y0]] as [number, number][] });
    const pod = prism([
      S(-0.120, 0.272, 0.300, -0.014, 0.020),
      S(-0.240, 0.268, 0.320, -0.034, 0.038),
      S(-0.360, 0.262, 0.316, -0.032, 0.036),
      S(-0.430, 0.268, 0.300, -0.022, 0.024),
    ], MAT.hull(), sx > 0 ? 'wingtip-pod-r' : 'wingtip-pod-l');
    g.add(pod);
    // Emissive slot on the pod leading face.
    g.add(ribbon([[0.286 * sx, 0.004, -0.130], [0.292 * sx, 0.004, -0.215]], 0.026,
                 MAT.emissive(), sx > 0 ? 'tip-slot-r' : 'tip-slot-l'));
  }
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
function buildFeathers(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'feather-plates';
  for (const sx of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const f = new Facets();
      const x0 = (0.150 + t * 0.055) * sx, x1 = (0.255 + t * 0.055) * sx;
      const z0 = -0.400 - t * 0.020, z1 = -0.510 - t * 0.055;
      const y = 0.030 + t * 0.030, th = 0.012;
      const quadAt = (yy: number) => f.quad(
        [x0, yy, z0], [x1, yy, z0 - 0.030], [x1, yy, z1], [x0, yy, z1 + 0.020]);
      quadAt(y - th / 2); quadAt(y + th / 2);
      // Side walls, so each plate reads as a solid slab with a visible edge.
      f.quad([x0, y - th/2, z0], [x0, y + th/2, z0], [x0, y + th/2, z1 + 0.020], [x0, y - th/2, z1 + 0.020]);
      f.quad([x1, y - th/2, z0 - 0.030], [x1, y - th/2, z1], [x1, y + th/2, z1], [x1, y + th/2, z0 - 0.030]);
      g.add(f.mesh(MAT.hullDark(), `feather-${sx > 0 ? 'r' : 'l'}-${i}`));
    }
  }
  return g;
}

/** Orange intake vents, seated in recessed sockets: two on the spine, one per side aft. */
function buildVents(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'vents';
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const socketMat = new THREE.MeshStandardMaterial({ color: 0x0e161e, roughness: 0.85, flatShading: true });
  const place = (x: number, y: number, z: number, w: number, h: number, d: number, rz: number, name: string) => {
    // A dark socket slightly larger than the vent, sunk below it, so the orange block reads
    // as sitting IN a recess. Boxes sitting on the surface read as cargo strapped to the
    // hull, which is what the first version looked like.
    // The socket must sit BELOW the vent, not around it: at 1.1x height centred only
    // 0.42h down, its top cleared the vent's and the orange block disappeared into a
    // black box.
    const socket = new THREE.Mesh(box(w * 1.34, h * 0.9, d * 1.22), socketMat);
    socket.position.set(x, y - h * 0.62, z); socket.rotation.z = rz;
    socket.name = `${name}-socket`; socket.receiveShadow = true;
    const m = new THREE.Mesh(box(w, h * 0.62, d), MAT.vent());
    m.position.set(x, y - h * 0.12, z); m.rotation.z = rz; m.name = name;
    m.castShadow = true; m.receiveShadow = true;
    g.add(socket, m);
  };
  for (const sx of [1, -1]) {
    place(0.086 * sx, 0.100, 0.150, 0.030, 0.016, 0.070, -0.16 * sx, `vent-spine-${sx > 0 ? 'r' : 'l'}`);
    place(0.152 * sx, 0.050, -0.140, 0.028, 0.014, 0.060, -0.22 * sx, `vent-mid-${sx > 0 ? 'r' : 'l'}`);
  }
  return g;
}

/** The cyan channel network: chine run, nose chevron, wing loop. */
function buildLightChannels(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'light-channels';
  for (const sx of [1, -1]) {
    // The long run, nose to tail, riding the upper flank facet just inboard of the chine.
    const chine: [number, number, number][] = [];
    let flankDir: [number, number] = [0, 1];
    for (let z = 0.44; z >= -0.42; z -= 0.02) {
      const { p, dir } = flankAt(z, 0.72);
      flankDir = dir;
      // Lifted off the facet along its own outward sense so it never z-fights the hull.
      chine.push([(p[0] + 0.006) * sx, p[1] + 0.004, z]);
    }
    g.add(ribbon(chine, 0.021, MAT.emissive(), `chine-strip-${sx > 0 ? 'r' : 'l'}`,
                 [flankDir[0] * sx, flankDir[1], 0]));
    // Nose chevron, apex forward, wrapping the underside of the nose.
    g.add(ribbon([
      [0.008 * sx, -0.006, 0.474], [0.078 * sx, -0.016, 0.336], [0.156 * sx, -0.020, 0.196],
    ], 0.018, MAT.emissive(), `nose-chevron-${sx > 0 ? 'r' : 'l'}`, [0, 1, 0]));
    // Wing loop: angular, following panel breaks. Corners stay hard - the reference has no
    // curved light runs anywhere.
    const loop: [number, number, number][] = [
      [0.148, 0.048, -0.055], [0.238, 0.052, -0.150], [0.278, 0.048, -0.268],
      [0.236, 0.044, -0.352], [0.150, 0.052, -0.318],
    ];
    g.add(ribbon(loop.map(([x, y, z]) => [x * sx, y, z] as [number, number, number]),
                 0.019, MAT.emissive(), `wing-loop-${sx > 0 ? 'r' : 'l'}`, [0, 0, 1]));
  }
  return g;
}

/** Decals drawn to a canvas at build time — generated, never projected. */
function decalTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas context unavailable; decals cannot be generated');
  x.clearRect(0, 0, 512, 256);
  // Measured off the reference: the ink is off-white (#F2F5F8), not pure white.
  x.fillStyle = '#f2f5f8';
  x.font = 'bold 132px "Helvetica Neue", Arial, sans-serif';
  x.textBaseline = 'middle';
  x.fillText('07', 330, 128);
  x.font = 'bold 44px "Helvetica Neue", Arial, sans-serif';
  x.fillText('EXIS', 190, 138);
  // Arrow-in-triangle logo. An approximation: the mark's internal geometry is below the
  // reference's resolution, which the spec records as an accepted approximation.
  x.beginPath();
  x.moveTo(96, 74); x.lineTo(140, 152); x.lineTo(52, 152); x.closePath();
  x.strokeStyle = '#f2f5f8'; x.lineWidth = 9; x.stroke();
  x.beginPath();
  x.moveTo(96, 100); x.lineTo(116, 140); x.lineTo(76, 140); x.closePath();
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildDecals(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'decal-set';
  const tex = decalTexture();
  for (const sx of [1, -1]) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.17),
      new THREE.MeshStandardMaterial({
        map: tex, transparent: true, roughness: 0.55, metalness: 0.05,
        // Pushed toward the camera so the decal never z-fights the hull facet under it.
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
    );
    m.position.set(0.190 * sx, 0.044, 0.010);
    m.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    m.rotation.z = -0.06;
    m.name = `decal-${sx > 0 ? 'r' : 'l'}`;
    g.add(m);
  }
  return g;
}

/** Assemble the craft. */
export function createExis07(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'EXIS 07';
  root.add(buildHull());
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
  const feathers = buildFeathers(); feathers.name = 'feather-plate';
  wing.add(pods, feathers);
  root.add(wing);

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
  outboard.add(buildNozzle(0.290, 0.000, -0.430, 0.060, 4, 'engine-outboard-r'));
  outboard.add(buildNozzle(-0.290, 0.000, -0.430, 0.060, 4, 'engine-outboard-l'));
  prop.add(outboard);
  root.add(prop);
  return root;
}
