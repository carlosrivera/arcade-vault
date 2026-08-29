import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Isometric Diorama Island
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createIsometricDioramaIslandModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Isometric Diorama Island";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "projection": "orthographic", "fovDegrees": 0.0, "aspect": 1.5, "orientation": {"azimuthDegrees": 45.0, "elevationDegrees": 30.0, "rollDegrees": 0.0}, "positionHint": [1.0, 0.62, 1.0], "note": "Isometric: slab edges stay parallel in the reference, so the projection is orthographic. Azimuth 45 puts a corner toward the viewer; elevation ~30 matches the observed ratio of the slab side face to its top face."}, "approximationNotes": []};
  root.userData.materialPipeline = {"schemaVersion": 1, "status": "probe", "registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "analysisArtifact": "/Users/carlos/code/wipeout/models/isle-diorama/material-analysis.json", "targetThreshold": 0.7, "unresolvedNotObservedMaterials": [], "regions": [{"componentId": "sea-surface", "regionId": "sea", "specMaterialId": "sea", "profileId": "glass.clear", "status": "proceed"}, {"componentId": "slab-water-band", "regionId": "slab-water", "specMaterialId": "slab-water", "profileId": "glass.clear", "status": "proceed"}, {"componentId": "foam-ring", "regionId": "foam", "specMaterialId": "foam", "profileId": "glass.frosted", "status": "proceed"}, {"componentId": "beach-band", "regionId": "beach-sand", "specMaterialId": "beach-sand", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "landmass", "regionId": "grass", "specMaterialId": "grass", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "farmland", "regionId": "field-crop", "specMaterialId": "field-crop", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "cliff-band", "regionId": "cliff-rock", "specMaterialId": "cliff-rock", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "ne-mesa", "regionId": "mesa-stone", "specMaterialId": "mesa-stone", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "mountain-massif", "regionId": "mountain-rock", "specMaterialId": "mountain-rock", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "mountain-massif", "regionId": "snow", "specMaterialId": "snow", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "slab-earth-stratum", "regionId": "earth-stratum", "specMaterialId": "earth-stratum", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "house-roof", "regionId": "roof-tile", "specMaterialId": "roof-tile", "profileId": "ceramic.glazed", "status": "proceed"}, {"componentId": "house-unit", "regionId": "wall-plaster", "specMaterialId": "wall-plaster", "profileId": "ceramic.glazed", "status": "proceed"}, {"componentId": "conifer-unit", "regionId": "conifer", "specMaterialId": "conifer", "profileId": "stone.natural", "status": "probe"}, {"componentId": "cloud-puff", "regionId": "cloud-mass", "specMaterialId": "cloud-mass", "profileId": "stone.natural", "status": "proceed"}, {"componentId": "pier", "regionId": "timber", "specMaterialId": "timber", "profileId": "wood.unfinished", "status": "proceed"}, {"componentId": "waterfall", "regionId": "waterfall", "specMaterialId": "waterfall", "profileId": "glass.frosted", "status": "proceed"}], "controlledViewsRequired": ["albedo-unlit", "backlight-transmission", "environment-reflection", "grazing", "neutral-studio", "reference-beauty"]};
  root.userData.materialReferenceRegistry = "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["sea"] = createSculptMaterial(
    "sea",
    {"id": "sea", "name": "Open sea", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#1e70ba", "color": "#1e70ba", "albedo": {"dominant": "#1e70ba", "secondary": ["#14468c", "#2f8fd0"], "samplingNotes": "Satin, the only non-matte surface in the scene. Colour is depth-graded, not flat. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#1e70ba", "#14468c", "#2f8fd0"], "pattern": "depth-graded", "amplitude": 0.45, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.45, "detail": "Overall open sea mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.248, "detail": "depth-graded variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.081, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.16, "value": 0.16, "map": "material-evidence/pbr-00-sea/sea_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "depth-gradient", "description": "Deep blue offshore grading through cyan to pale turquoise in the shallows; keyed to water depth, not to distance from camera.", "channel": "albedo"}, {"id": "shallow-shelf", "description": "A turquoise shelf band hugs every shore before the foam line.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Satin, the only non-matte surface in the scene. Colour is depth-graded, not flat. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.793, "verdict": "pass", "measuredAlbedo": "#1C87AB", "palette": ["#0276B2", "#0395C1", "#B7B26E", "#45715A", "#3BBDDA"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "assignedProfile": "glass.clear", "source": "reference-pixel-extraction", "estimatedFidelity": 0.793, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-00-sea/sea_albedo.png", "url": "material-evidence/pbr-00-sea/sea_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-00-sea/sea_roughness.png", "url": "material-evidence/pbr-00-sea/sea_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-00-sea/sea_height.png", "url": "material-evidence/pbr-00-sea/sea_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-00-sea/sea_normal.png", "url": "material-evidence/pbr-00-sea/sea_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-00-sea/sea_ao.png", "url": "material-evidence/pbr-00-sea/sea_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-00-sea/sea_normal.png", "aoMap": "material-evidence/pbr-00-sea/sea_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["foam"] = createSculptMaterial(
    "foam",
    {"id": "foam", "name": "Shore foam", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#dceef5", "color": "#dceef5", "albedo": {"dominant": "#dceef5", "secondary": ["#ffffff", "#bcdfe9"], "samplingNotes": "Opaque white band at every land/water contact including islets. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#dceef5", "#ffffff", "#bcdfe9"], "pattern": "contour-band", "amplitude": 0.2, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.2, "detail": "Overall shore foam mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.11, "detail": "contour-band variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.036, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.9, "value": 0.9, "map": "material-evidence/pbr-02-foam/foam_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "foam-crest", "description": "Brightest at the contact line, dissolving outward over roughly one cell.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Opaque white band at every land/water contact including islets. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.855, "verdict": "pass", "measuredAlbedo": "#B4E6E3", "palette": ["#3BC5CC", "#91D9D1", "#C6E9D6", "#58CDCD", "#65C2C3"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/02-foam.png", "assignedProfile": "glass.frosted", "source": "reference-pixel-extraction", "estimatedFidelity": 0.855, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-02-foam/foam_albedo.png", "url": "material-evidence/pbr-02-foam/foam_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-02-foam/foam_roughness.png", "url": "material-evidence/pbr-02-foam/foam_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-02-foam/foam_height.png", "url": "material-evidence/pbr-02-foam/foam_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-02-foam/foam_normal.png", "url": "material-evidence/pbr-02-foam/foam_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-02-foam/foam_ao.png", "url": "material-evidence/pbr-02-foam/foam_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-02-foam/foam_normal.png", "aoMap": "material-evidence/pbr-02-foam/foam_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["beach-sand"] = createSculptMaterial(
    "beach-sand",
    {"id": "beach-sand", "name": "Beach sand", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#e2d09e", "color": "#e2d09e", "albedo": {"dominant": "#e2d09e", "secondary": ["#f0e4c0", "#c9b47e"], "samplingNotes": "Pale cream band between lowland grass and foam, present only where the coast is low. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#e2d09e", "#f0e4c0", "#c9b47e"], "pattern": "banded", "amplitude": 0.18, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.18, "detail": "Overall beach sand mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.099, "detail": "banded variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.032, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.92, "value": 0.92, "map": "material-evidence/pbr-03-beach-sand/beach-sand_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Pale cream band between lowland grass and foam, present only where the coast is low. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.86, "verdict": "pass", "measuredAlbedo": "#9DC797", "palette": ["#F6E593", "#10A7C7", "#64994C", "#B9CA5E", "#5BCBC7"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/03-beach-sand.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.86, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-03-beach-sand/beach-sand_albedo.png", "url": "material-evidence/pbr-03-beach-sand/beach-sand_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-03-beach-sand/beach-sand_roughness.png", "url": "material-evidence/pbr-03-beach-sand/beach-sand_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-03-beach-sand/beach-sand_height.png", "url": "material-evidence/pbr-03-beach-sand/beach-sand_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-03-beach-sand/beach-sand_normal.png", "url": "material-evidence/pbr-03-beach-sand/beach-sand_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-03-beach-sand/beach-sand_ao.png", "url": "material-evidence/pbr-03-beach-sand/beach-sand_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-03-beach-sand/beach-sand_normal.png", "aoMap": "material-evidence/pbr-03-beach-sand/beach-sand_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["grass"] = createSculptMaterial(
    "grass",
    {"id": "grass", "name": "Lowland grass", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#60a846", "color": "#60a846", "albedo": {"dominant": "#60a846", "secondary": ["#7ebc50", "#36763a"], "samplingNotes": "Saturated yellow-green sunlit, deepening to blue-green in shade. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#60a846", "#7ebc50", "#36763a"], "pattern": "mottled", "amplitude": 0.22, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.22, "detail": "Overall lowland grass mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.121, "detail": "mottled variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.04, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.93, "value": 0.93, "map": "material-evidence/pbr-04-grass/grass_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "slope-shade", "description": "Steeper ground darkens toward the blue-green stop.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Saturated yellow-green sunlit, deepening to blue-green in shade. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.829, "verdict": "pass", "measuredAlbedo": "#579247", "palette": ["#6CBA46", "#1C4A3A", "#306E4C", "#BBD458", "#498B45"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/04-grass.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.829, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-04-grass/grass_albedo.png", "url": "material-evidence/pbr-04-grass/grass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-04-grass/grass_roughness.png", "url": "material-evidence/pbr-04-grass/grass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-04-grass/grass_height.png", "url": "material-evidence/pbr-04-grass/grass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-04-grass/grass_normal.png", "url": "material-evidence/pbr-04-grass/grass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-04-grass/grass_ao.png", "url": "material-evidence/pbr-04-grass/grass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-04-grass/grass_normal.png", "aoMap": "material-evidence/pbr-04-grass/grass_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["field-crop"] = createSculptMaterial(
    "field-crop",
    {"id": "field-crop", "name": "Farm parcel", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#96ba5c", "color": "#96ba5c", "albedo": {"dominant": "#96ba5c", "secondary": ["#c8c471", "#6f9a45"], "samplingNotes": "Parcels alternate green, olive and wheat-tan with hard straight boundaries. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#96ba5c", "#c8c471", "#6f9a45"], "pattern": "rectilinear-patches", "amplitude": 0.35, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.35, "detail": "Overall farm parcel mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.193, "detail": "rectilinear-patches variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.063, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.93, "value": 0.93, "map": "material-evidence/pbr-05-field-crop/field-crop_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "parcel-boundary", "description": "Hard rectilinear edges between parcels; no blending across a boundary.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Parcels alternate green, olive and wheat-tan with hard straight boundaries. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.829, "verdict": "pass", "measuredAlbedo": "#72A947", "palette": ["#67B743", "#A1CF4C", "#1D4B3B", "#D7DA64", "#417A3D"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/05-field-crop.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.829, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-05-field-crop/field-crop_albedo.png", "url": "material-evidence/pbr-05-field-crop/field-crop_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-05-field-crop/field-crop_roughness.png", "url": "material-evidence/pbr-05-field-crop/field-crop_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-05-field-crop/field-crop_height.png", "url": "material-evidence/pbr-05-field-crop/field-crop_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-05-field-crop/field-crop_normal.png", "url": "material-evidence/pbr-05-field-crop/field-crop_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-05-field-crop/field-crop_ao.png", "url": "material-evidence/pbr-05-field-crop/field-crop_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-05-field-crop/field-crop_normal.png", "aoMap": "material-evidence/pbr-05-field-crop/field-crop_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["cliff-rock"] = createSculptMaterial(
    "cliff-rock",
    {"id": "cliff-rock", "name": "Cliff rock", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#7e808c", "color": "#7e808c", "albedo": {"dominant": "#7e808c", "secondary": ["#9a9aa6", "#54566a"], "samplingNotes": "Grey-violet with vertical fluting and cavity-darkened lines; grass caps the lip hard. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#7e808c", "#9a9aa6", "#54566a"], "pattern": "vertical-fluting", "amplitude": 0.3, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.3, "detail": "Overall cliff rock mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.165, "detail": "vertical-fluting variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.054, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.88, "value": 0.88, "map": "material-evidence/pbr-06-cliff-rock/cliff-rock_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flute-shadow", "description": "Vertical grooves read as darker lines running the full riser height.", "channel": "albedo"}, {"id": "grass-lip", "description": "A hard, unblended edge where grass meets the top of the riser.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Grey-violet with vertical fluting and cavity-darkened lines; grass caps the lip hard. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.86, "verdict": "pass", "measuredAlbedo": "#7B9873", "palette": ["#C0AF89", "#9BC951", "#3C6250", "#729262", "#057FB1"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/06-cliff-rock.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.86, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-06-cliff-rock/cliff-rock_albedo.png", "url": "material-evidence/pbr-06-cliff-rock/cliff-rock_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-06-cliff-rock/cliff-rock_roughness.png", "url": "material-evidence/pbr-06-cliff-rock/cliff-rock_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-06-cliff-rock/cliff-rock_height.png", "url": "material-evidence/pbr-06-cliff-rock/cliff-rock_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-06-cliff-rock/cliff-rock_normal.png", "url": "material-evidence/pbr-06-cliff-rock/cliff-rock_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-06-cliff-rock/cliff-rock_ao.png", "url": "material-evidence/pbr-06-cliff-rock/cliff-rock_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-06-cliff-rock/cliff-rock_normal.png", "aoMap": "material-evidence/pbr-06-cliff-rock/cliff-rock_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["mesa-stone"] = createSculptMaterial(
    "mesa-stone",
    {"id": "mesa-stone", "name": "Mesa sandstone", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#cea86a", "color": "#cea86a", "albedo": {"dominant": "#cea86a", "secondary": ["#e0c088", "#a8814e"], "samplingNotes": "Arid ochre sandstone in horizontal terraces - a different biome from the green lowland. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#cea86a", "#e0c088", "#a8814e"], "pattern": "horizontal-strata", "amplitude": 0.3, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.3, "detail": "Overall mesa sandstone mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.165, "detail": "horizontal-strata variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.054, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.9, "value": 0.9, "map": "material-evidence/pbr-07-mesa-stone/mesa-stone_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "terrace-strata", "description": "Horizontal bedding lines follow each terrace step.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Arid ochre sandstone in horizontal terraces - a different biome from the green lowland. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.86, "verdict": "pass", "measuredAlbedo": "#A99880", "palette": ["#F1BC72", "#4B5F7F", "#BC9C7A", "#F8DB90", "#707685"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/07-mesa-stone.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.86, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-07-mesa-stone/mesa-stone_albedo.png", "url": "material-evidence/pbr-07-mesa-stone/mesa-stone_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-07-mesa-stone/mesa-stone_roughness.png", "url": "material-evidence/pbr-07-mesa-stone/mesa-stone_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-07-mesa-stone/mesa-stone_height.png", "url": "material-evidence/pbr-07-mesa-stone/mesa-stone_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-07-mesa-stone/mesa-stone_normal.png", "url": "material-evidence/pbr-07-mesa-stone/mesa-stone_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-07-mesa-stone/mesa-stone_ao.png", "url": "material-evidence/pbr-07-mesa-stone/mesa-stone_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-07-mesa-stone/mesa-stone_normal.png", "aoMap": "material-evidence/pbr-07-mesa-stone/mesa-stone_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["mountain-rock"] = createSculptMaterial(
    "mountain-rock",
    {"id": "mountain-rock", "name": "Mountain rock", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#587ab0", "color": "#587ab0", "albedo": {"dominant": "#587ab0", "secondary": ["#8098c8", "#3d5a8c"], "samplingNotes": "Blue-violet, faceted, reading colder and bluer with altitude. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#587ab0", "#8098c8", "#3d5a8c"], "pattern": "faceted", "amplitude": 0.3, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.3, "detail": "Overall mountain rock mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.165, "detail": "faceted variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.054, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.82, "value": 0.82, "map": "material-evidence/pbr-08-mountain-rock/mountain-rock_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Blue-violet, faceted, reading colder and bluer with altitude. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.86, "verdict": "pass", "measuredAlbedo": "#92BFE4", "palette": ["#64B6ED", "#3390DA", "#2A6CB2", "#B9D9F0", "#597AAB"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/08-mountain-rock.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.86, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-08-mountain-rock/mountain-rock_albedo.png", "url": "material-evidence/pbr-08-mountain-rock/mountain-rock_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-08-mountain-rock/mountain-rock_roughness.png", "url": "material-evidence/pbr-08-mountain-rock/mountain-rock_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-08-mountain-rock/mountain-rock_height.png", "url": "material-evidence/pbr-08-mountain-rock/mountain-rock_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-08-mountain-rock/mountain-rock_normal.png", "url": "material-evidence/pbr-08-mountain-rock/mountain-rock_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-08-mountain-rock/mountain-rock_ao.png", "url": "material-evidence/pbr-08-mountain-rock/mountain-rock_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-08-mountain-rock/mountain-rock_normal.png", "aoMap": "material-evidence/pbr-08-mountain-rock/mountain-rock_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["snow"] = createSculptMaterial(
    "snow",
    {"id": "snow", "name": "Summit snow", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#e6eef8", "color": "#e6eef8", "albedo": {"dominant": "#e6eef8", "secondary": ["#ffffff", "#c6d6ea"], "samplingNotes": "Reaches down the gullies in tongues; the snowline follows drainage, not a level contour. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#e6eef8", "#ffffff", "#c6d6ea"], "pattern": "tongued", "amplitude": 0.18, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.18, "detail": "Overall summit snow mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.099, "detail": "tongued variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.032, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.72, "value": 0.72, "map": "material-evidence/pbr-09-snow/snow_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "gully-tongue", "description": "Snow descends further in gullies than on ridges.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Reaches down the gullies in tongues; the snowline follows drainage, not a level contour. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.86, "verdict": "pass", "measuredAlbedo": "#CBE0F2", "palette": ["#509ADA", "#C8E3F8", "#9CCCEE", "#78B3E2", "#4276B3"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/09-snow.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.86, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-09-snow/snow_albedo.png", "url": "material-evidence/pbr-09-snow/snow_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-09-snow/snow_roughness.png", "url": "material-evidence/pbr-09-snow/snow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-09-snow/snow_height.png", "url": "material-evidence/pbr-09-snow/snow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-09-snow/snow_normal.png", "url": "material-evidence/pbr-09-snow/snow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-09-snow/snow_ao.png", "url": "material-evidence/pbr-09-snow/snow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-09-snow/snow_normal.png", "aoMap": "material-evidence/pbr-09-snow/snow_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["earth-stratum"] = createSculptMaterial(
    "earth-stratum",
    {"id": "earth-stratum", "name": "Slab earth stratum", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#8c5c38", "color": "#8c5c38", "albedo": {"dominant": "#8c5c38", "secondary": ["#a87048", "#6b4228"], "samplingNotes": "Warm ochre-brown on the slab cut faces, below the water band. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#8c5c38", "#a87048", "#6b4228"], "pattern": "ragged-band", "amplitude": 0.25, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.25, "detail": "Overall slab earth stratum mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.138, "detail": "ragged-band variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.045, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.95, "value": 0.95, "map": "material-evidence/pbr-10-earth-stratum/earth-stratum_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "ragged-interface", "description": "The top edge of the earth against the water band is ragged along its length, never level - a straight line reads as a printed stripe.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Warm ochre-brown on the slab cut faces, below the water band. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.802, "verdict": "pass", "measuredAlbedo": "#4C7A84", "palette": ["#0A6696", "#8C6C58", "#0FA9CE", "#715C51", "#C5AE81"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/10-earth-stratum.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.802, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-10-earth-stratum/earth-stratum_albedo.png", "url": "material-evidence/pbr-10-earth-stratum/earth-stratum_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-10-earth-stratum/earth-stratum_roughness.png", "url": "material-evidence/pbr-10-earth-stratum/earth-stratum_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-10-earth-stratum/earth-stratum_height.png", "url": "material-evidence/pbr-10-earth-stratum/earth-stratum_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-10-earth-stratum/earth-stratum_normal.png", "url": "material-evidence/pbr-10-earth-stratum/earth-stratum_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-10-earth-stratum/earth-stratum_ao.png", "url": "material-evidence/pbr-10-earth-stratum/earth-stratum_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-10-earth-stratum/earth-stratum_normal.png", "aoMap": "material-evidence/pbr-10-earth-stratum/earth-stratum_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["slab-water"] = createSculptMaterial(
    "slab-water",
    {"id": "slab-water", "name": "Slab cut-face water band", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#2f8fd0", "color": "#2f8fd0", "albedo": {"dominant": "#2f8fd0", "secondary": ["#4fa8dc", "#1e6ca8"], "samplingNotes": "The sea seen in section on the slab side, brighter than the top surface. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#2f8fd0", "#4fa8dc", "#1e6ca8"], "pattern": "vertical-gradient", "amplitude": 0.2, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.2, "detail": "Overall slab cut-face water band mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.11, "detail": "vertical-gradient variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.036, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.35, "value": 0.35, "map": "material-evidence/pbr-01-slab-water/slab-water_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "The sea seen in section on the slab side, brighter than the top surface. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.82, "verdict": "pass", "measuredAlbedo": "#1F98BD", "palette": ["#056499", "#2AB7D6", "#56D7E2", "#119FC8", "#0C81B2"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/01-slab-water.png", "assignedProfile": "glass.clear", "source": "reference-pixel-extraction", "estimatedFidelity": 0.82, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-01-slab-water/slab-water_albedo.png", "url": "material-evidence/pbr-01-slab-water/slab-water_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-01-slab-water/slab-water_roughness.png", "url": "material-evidence/pbr-01-slab-water/slab-water_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-01-slab-water/slab-water_height.png", "url": "material-evidence/pbr-01-slab-water/slab-water_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-01-slab-water/slab-water_normal.png", "url": "material-evidence/pbr-01-slab-water/slab-water_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-01-slab-water/slab-water_ao.png", "url": "material-evidence/pbr-01-slab-water/slab-water_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-01-slab-water/slab-water_normal.png", "aoMap": "material-evidence/pbr-01-slab-water/slab-water_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["roof-tile"] = createSculptMaterial(
    "roof-tile",
    {"id": "roof-tile", "name": "Roof tile", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#c2452c", "color": "#c2452c", "albedo": {"dominant": "#c2452c", "secondary": ["#d9603f", "#9a3320"], "samplingNotes": "Red-orange, the strongest colour accent in the scene and how hamlets read at distance. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#c2452c", "#d9603f", "#9a3320"], "pattern": "flat", "amplitude": 0.12, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.12, "detail": "Overall roof tile mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.066, "detail": "flat variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.022, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.85, "value": 0.85, "map": "material-evidence/pbr-11-roof-tile/roof-tile_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Red-orange, the strongest colour accent in the scene and how hamlets read at distance. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.829, "verdict": "pass", "measuredAlbedo": "#A86C58", "palette": ["#AE533D", "#7A4139", "#BF8A72", "#895E4D", "#E1CAA5"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/11-roof-tile.png", "assignedProfile": "ceramic.glazed", "source": "reference-pixel-extraction", "estimatedFidelity": 0.829, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-11-roof-tile/roof-tile_albedo.png", "url": "material-evidence/pbr-11-roof-tile/roof-tile_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-11-roof-tile/roof-tile_roughness.png", "url": "material-evidence/pbr-11-roof-tile/roof-tile_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-11-roof-tile/roof-tile_height.png", "url": "material-evidence/pbr-11-roof-tile/roof-tile_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-11-roof-tile/roof-tile_normal.png", "url": "material-evidence/pbr-11-roof-tile/roof-tile_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-11-roof-tile/roof-tile_ao.png", "url": "material-evidence/pbr-11-roof-tile/roof-tile_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-11-roof-tile/roof-tile_normal.png", "aoMap": "material-evidence/pbr-11-roof-tile/roof-tile_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["wall-plaster"] = createSculptMaterial(
    "wall-plaster",
    {"id": "wall-plaster", "name": "Wall plaster", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#f0e8dc", "color": "#f0e8dc", "albedo": {"dominant": "#f0e8dc", "secondary": ["#ffffff", "#d6caba"], "samplingNotes": "Cream-white rendered walls on houses, castle, lighthouse and windmill. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#f0e8dc", "#ffffff", "#d6caba"], "pattern": "flat", "amplitude": 0.1, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.1, "detail": "Overall wall plaster mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.055, "detail": "flat variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.018, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.9, "value": 0.9, "map": "material-evidence/pbr-12-wall-plaster/wall-plaster_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Cream-white rendered walls on houses, castle, lighthouse and windmill. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.784, "verdict": "pass", "measuredAlbedo": "#EDEAD8", "palette": ["#C2C39E", "#DAD9B7", "#E1DEC7", "#9CA37B", "#B4BCA1"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/12-wall-plaster.png", "assignedProfile": "ceramic.glazed", "source": "reference-pixel-extraction", "estimatedFidelity": 0.784, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-12-wall-plaster/wall-plaster_albedo.png", "url": "material-evidence/pbr-12-wall-plaster/wall-plaster_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-12-wall-plaster/wall-plaster_roughness.png", "url": "material-evidence/pbr-12-wall-plaster/wall-plaster_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-12-wall-plaster/wall-plaster_height.png", "url": "material-evidence/pbr-12-wall-plaster/wall-plaster_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-12-wall-plaster/wall-plaster_normal.png", "url": "material-evidence/pbr-12-wall-plaster/wall-plaster_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-12-wall-plaster/wall-plaster_ao.png", "url": "material-evidence/pbr-12-wall-plaster/wall-plaster_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-12-wall-plaster/wall-plaster_normal.png", "aoMap": "material-evidence/pbr-12-wall-plaster/wall-plaster_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["conifer"] = createSculptMaterial(
    "conifer",
    {"id": "conifer", "name": "Conifer foliage", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#2e6b40", "color": "#2e6b40", "albedo": {"dominant": "#2e6b40", "secondary": ["#3f8850", "#1e4d2e"], "samplingNotes": "Dark blue-green, darker than the grass it stands on so canopies read as mass. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#2e6b40", "#3f8850", "#1e4d2e"], "pattern": "clustered", "amplitude": 0.28, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.28, "detail": "Overall conifer foliage mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.154, "detail": "clustered variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.05, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.95, "value": 0.95, "map": "material-evidence/pbr-13-conifer/conifer_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Dark blue-green, darker than the grass it stands on so canopies read as mass. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.829, "verdict": "pass", "measuredAlbedo": "#568F4D", "palette": ["#2A6D4E", "#1D5141", "#75B948", "#478847", "#B3D759"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/13-conifer.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.829, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-13-conifer/conifer_albedo.png", "url": "material-evidence/pbr-13-conifer/conifer_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-13-conifer/conifer_roughness.png", "url": "material-evidence/pbr-13-conifer/conifer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-13-conifer/conifer_height.png", "url": "material-evidence/pbr-13-conifer/conifer_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-13-conifer/conifer_normal.png", "url": "material-evidence/pbr-13-conifer/conifer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-13-conifer/conifer_ao.png", "url": "material-evidence/pbr-13-conifer/conifer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-13-conifer/conifer_normal.png", "aoMap": "material-evidence/pbr-13-conifer/conifer_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["cloud-mass"] = createSculptMaterial(
    "cloud-mass",
    {"id": "cloud-mass", "name": "Cloud mass", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#f8fafc", "color": "#f8fafc", "albedo": {"dominant": "#f8fafc", "secondary": ["#ffffff", "#dde6f0"], "samplingNotes": "Opaque painted white with a soft grey underside. Not volumetric and not translucent. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#f8fafc", "#ffffff", "#dde6f0"], "pattern": "billowed", "amplitude": 0.15, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.15, "detail": "Overall cloud mass mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.083, "detail": "billowed variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.027, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.95, "value": 0.95, "map": "material-evidence/pbr-14-cloud-mass/cloud-mass_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Opaque painted white with a soft grey underside. Not volumetric and not translucent. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.797, "verdict": "pass", "measuredAlbedo": "#EDF2F3", "palette": ["#CAE0F6", "#2F84B9", "#48A9EA", "#71A1C9", "#9DC6E3"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/14-cloud-mass.png", "assignedProfile": "stone.natural", "source": "reference-pixel-extraction", "estimatedFidelity": 0.797, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-14-cloud-mass/cloud-mass_albedo.png", "url": "material-evidence/pbr-14-cloud-mass/cloud-mass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-14-cloud-mass/cloud-mass_roughness.png", "url": "material-evidence/pbr-14-cloud-mass/cloud-mass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-14-cloud-mass/cloud-mass_height.png", "url": "material-evidence/pbr-14-cloud-mass/cloud-mass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-14-cloud-mass/cloud-mass_normal.png", "url": "material-evidence/pbr-14-cloud-mass/cloud-mass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-14-cloud-mass/cloud-mass_ao.png", "url": "material-evidence/pbr-14-cloud-mass/cloud-mass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-14-cloud-mass/cloud-mass_normal.png", "aoMap": "material-evidence/pbr-14-cloud-mass/cloud-mass_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["timber"] = createSculptMaterial(
    "timber",
    {"id": "timber", "name": "Timber", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#8a6440", "color": "#8a6440", "albedo": {"dominant": "#8a6440", "secondary": ["#a07850", "#6a4a30"], "samplingNotes": "Pier decking and posts. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#8a6440", "#a07850", "#6a4a30"], "pattern": "planked", "amplitude": 0.15, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.15, "detail": "Overall timber mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.083, "detail": "planked variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.027, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.9, "value": 0.9, "map": "material-evidence/pbr-15-timber/timber_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Pier decking and posts. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.851, "verdict": "pass", "measuredAlbedo": "#584A51", "palette": ["#694B4B", "#403B4B", "#403141", "#737E87", "#4B4A61"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/15-timber.png", "assignedProfile": "wood.unfinished", "source": "reference-pixel-extraction", "estimatedFidelity": 0.851, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-15-timber/timber_albedo.png", "url": "material-evidence/pbr-15-timber/timber_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-15-timber/timber_roughness.png", "url": "material-evidence/pbr-15-timber/timber_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-15-timber/timber_height.png", "url": "material-evidence/pbr-15-timber/timber_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-15-timber/timber_normal.png", "url": "material-evidence/pbr-15-timber/timber_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-15-timber/timber_ao.png", "url": "material-evidence/pbr-15-timber/timber_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-15-timber/timber_normal.png", "aoMap": "material-evidence/pbr-15-timber/timber_ao.png", "opacity": {"base": 1.0}},
    options
  );
  materialMap["waterfall"] = createSculptMaterial(
    "waterfall",
    {"id": "waterfall", "name": "Falling water", "type": "standard", "shaderModel": "MeshStandardMaterial / painted albedo", "baseColor": "#e8f4fa", "color": "#e8f4fa", "albedo": {"dominant": "#e8f4fa", "secondary": ["#ffffff", "#bcdcea"], "samplingNotes": "White vertical streaking, brightest at the lip and at the spray disc. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface."}, "colorVariation": {"palette": ["#e8f4fa", "#ffffff", "#bcdcea"], "pattern": "streaked", "amplitude": 0.22, "heightCorrelation": 0.45}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.6, "amplitude": 0.22, "detail": "Overall falling water mass and its value gradient."}, {"id": "meso", "frequency": 4.0, "amplitude": 0.121, "detail": "streaked variation across the region."}, {"id": "micro", "frequency": 22.0, "amplitude": 0.04, "detail": "Painted grain; no physical microstructure exists in the source, so the micro band is deliberately shallow rather than invented."}], "roughness": {"base": 0.4, "value": 0.4, "map": "material-evidence/pbr-16-waterfall/waterfall_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries the variation; the scalar is the authored mean for this painted material."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "White vertical streaking, brightest at the lip and at the spray disc. Hand-painted finish, not PBR: the value structure lives in the albedo and the lighting stays broad and soft. No toon ramp and no ink outline - the user explicitly rejected cel shading - and no specular hotspot on any matte surface.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "/Users/carlos/.claude/skills/img2threejs/docs/materials/material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.45, "variation": 0.0}, "referencePbr": {"usable": true, "confidence": 0.86, "verdict": "pass", "measuredAlbedo": "#94B5C9", "palette": ["#3E5373", "#8CCAEE", "#B7E4F4", "#6BADCD", "#3886AB"], "cropPath": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/16-waterfall.png", "assignedProfile": "glass.frosted", "source": "reference-pixel-extraction", "estimatedFidelity": 0.86, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-16-waterfall/waterfall_albedo.png", "url": "material-evidence/pbr-16-waterfall/waterfall_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-16-waterfall/waterfall_roughness.png", "url": "material-evidence/pbr-16-waterfall/waterfall_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-16-waterfall/waterfall_height.png", "url": "material-evidence/pbr-16-waterfall/waterfall_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-16-waterfall/waterfall_normal.png", "url": "material-evidence/pbr-16-waterfall/waterfall_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-16-waterfall/waterfall_ao.png", "url": "material-evidence/pbr-16-waterfall/waterfall_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2D8B7E", "#1799C1", "#0078B8", "#1789B1", "#0E506A"], "paletteHueRisk": [{"stop": "#0078B8", "hueRisk": "blue-collapse", "suggestedRgb": [184, 120, 0]}, {"stop": "#1789B1", "hueRisk": "blue-collapse", "suggestedRgb": [177, 137, 23]}, {"stop": "#0E506A", "hueRisk": "blue-collapse", "suggestedRgb": [106, 80, 14]}], "gradientAxis": "vertical", "stats": {"meanLum": 103.5, "meanSaturation": 0.85, "gradientStrength": 0.331, "mottle": 0.023, "streakRatio": 0.58, "hueSpread": 0.078, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "sea-surface", "regionId": "sea", "crop": {"path": "/Users/carlos/code/wipeout/models/isle-diorama/material-evidence/00-sea.png", "bbox": {"x": 772, "y": 796, "width": 150, "height": 150}, "sourceWidth": 1536, "sourceHeight": 1024, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sea-surface", "regionId": "sea", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "normalMap": "material-evidence/pbr-16-waterfall/waterfall_normal.png", "aoMap": "material-evidence/pbr-16-waterfall/waterfall_ao.png", "opacity": {"base": 1.0}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Isometric Diorama Island__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Isometric Diorama Island", "level": "macro", "role": "assembly-root", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The whole diorama is a bounded rectangular block; the root is that bounding volume.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 0.12, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Isometric Diorama Island";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Isometric Diorama Island", "level": "macro", "role": "assembly-root", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The whole diorama is a bounded rectangular block; the root is that bounding volume.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 0.12, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_slab_base_1 = makeAttachmentEndpoint(null);
  const node_slab_base_1 = new THREE.Group();
  node_slab_base_1.name = "Diorama slab__pivot";
  node_slab_base_1.scale.set(1, 1, 1);
  if (endpoint_slab_base_1) {
    node_slab_base_1.position.copy(endpoint_slab_base_1.start);
    node_slab_base_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_slab_base_1.position.set(0.0, -0.06, 0.0);
    node_slab_base_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_slab_base_1.userData.sculptComponent = {"id": "slab-base", "name": "Diorama slab", "level": "macro", "role": "base-volume", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A cut block with four flat vertical faces and sharp corners - a box is exactly what it is.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.12, 0.0], "embedDepth": 0.0072, "overlap": 0.006, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 1, "height": 0.12, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, -0.06, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["earth-stratum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cut-face-strata", "description": "Blue water band over ochre earth on all four faces, ragged interface, water band ~0.3 of thickness.", "evidenceRef": "crops/slab-edge.png"}, {"id": "sharp-corner", "description": "Corners are square, unbevelled - the block reads as cut, not moulded.", "evidenceRef": "crops/east-windmill.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "earth-stratum", "colorMaterialRecipe": {"baseColor": "#8c5c38", "dominantAlbedo": "rgba(140, 92, 56, 1.0)", "secondaryAlbedo": "rgba(168, 112, 72, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#8c5c38"}, {"position": 0.5, "color": "#a87048"}, {"position": 1.0, "color": "#6b4228"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_slab_base_1.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["root"] ?? root).add(node_slab_base_1);
  nodes["slab-base"] = node_slab_base_1;
  const mesh_slab_base_1Geometry = endpoint_slab_base_1
    ? new THREE.CylinderGeometry(endpoint_slab_base_1.endRadius, endpoint_slab_base_1.baseRadius, endpoint_slab_base_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_slab_base_1) {
    mesh_slab_base_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_slab_base_1 = new THREE.Mesh(
    mesh_slab_base_1Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_slab_base_1.name = "Diorama slab";
  if (endpoint_slab_base_1) {
    mesh_slab_base_1.position.copy(endpoint_slab_base_1.midpoint);
    mesh_slab_base_1.quaternion.copy(endpoint_slab_base_1.quaternion);
  }
  mesh_slab_base_1.castShadow = options.castShadow ?? true;
  mesh_slab_base_1.receiveShadow = options.receiveShadow ?? true;
  mesh_slab_base_1.userData.sculptComponent = {"id": "slab-base", "name": "Diorama slab", "level": "macro", "role": "base-volume", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A cut block with four flat vertical faces and sharp corners - a box is exactly what it is.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.12, 0.0], "embedDepth": 0.0072, "overlap": 0.006, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 1, "height": 0.12, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, -0.06, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["earth-stratum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cut-face-strata", "description": "Blue water band over ochre earth on all four faces, ragged interface, water band ~0.3 of thickness.", "evidenceRef": "crops/slab-edge.png"}, {"id": "sharp-corner", "description": "Corners are square, unbevelled - the block reads as cut, not moulded.", "evidenceRef": "crops/east-windmill.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "earth-stratum", "colorMaterialRecipe": {"baseColor": "#8c5c38", "dominantAlbedo": "rgba(140, 92, 56, 1.0)", "secondaryAlbedo": "rgba(168, 112, 72, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#8c5c38"}, {"position": 0.5, "color": "#a87048"}, {"position": 1.0, "color": "#6b4228"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_slab_base_1.add(mesh_slab_base_1);
  meshes["slab-base"] = mesh_slab_base_1;
  colliders["slab-base"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_slab_base_1);

  const endpoint_slab_water_band_2 = makeAttachmentEndpoint(null);
  const node_slab_water_band_2 = new THREE.Group();
  node_slab_water_band_2.name = "Water band on cut face__pivot";
  node_slab_water_band_2.scale.set(1, 1, 1);
  if (endpoint_slab_water_band_2) {
    node_slab_water_band_2.position.copy(endpoint_slab_water_band_2.start);
    node_slab_water_band_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_slab_water_band_2.position.set(0.0, 0.042, 0.0);
    node_slab_water_band_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_slab_water_band_2.userData.sculptComponent = {"id": "slab-water-band", "name": "Water band on cut face", "level": "meso", "role": "strata-band", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A band on the slab face; a box face section, not a surface carved into it.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "slab-base", "attachment": {"parentId": "slab-base", "parentSocket": "slab-base-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.036, 0.0], "embedDepth": 0.0021599999999999996, "overlap": 0.0018, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.036, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.042, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["slab-water"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "slab-water", "colorMaterialRecipe": {"baseColor": "#2f8fd0", "dominantAlbedo": "rgba(47, 143, 208, 1.0)", "secondaryAlbedo": "rgba(79, 168, 220, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#2f8fd0"}, {"position": 0.5, "color": "#4fa8dc"}, {"position": 1.0, "color": "#1e6ca8"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_slab_water_band_2.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["slab-base"] ?? root).add(node_slab_water_band_2);
  nodes["slab-water-band"] = node_slab_water_band_2;
  const mesh_slab_water_band_2Geometry = endpoint_slab_water_band_2
    ? new THREE.CylinderGeometry(endpoint_slab_water_band_2.endRadius, endpoint_slab_water_band_2.baseRadius, endpoint_slab_water_band_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_slab_water_band_2) {
    mesh_slab_water_band_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_slab_water_band_2 = new THREE.Mesh(
    mesh_slab_water_band_2Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_slab_water_band_2.name = "Water band on cut face";
  if (endpoint_slab_water_band_2) {
    mesh_slab_water_band_2.position.copy(endpoint_slab_water_band_2.midpoint);
    mesh_slab_water_band_2.quaternion.copy(endpoint_slab_water_band_2.quaternion);
  }
  mesh_slab_water_band_2.castShadow = options.castShadow ?? true;
  mesh_slab_water_band_2.receiveShadow = options.receiveShadow ?? true;
  mesh_slab_water_band_2.userData.sculptComponent = {"id": "slab-water-band", "name": "Water band on cut face", "level": "meso", "role": "strata-band", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A band on the slab face; a box face section, not a surface carved into it.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "slab-base", "attachment": {"parentId": "slab-base", "parentSocket": "slab-base-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.036, 0.0], "embedDepth": 0.0021599999999999996, "overlap": 0.0018, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.036, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.042, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["slab-water"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "slab-water", "colorMaterialRecipe": {"baseColor": "#2f8fd0", "dominantAlbedo": "rgba(47, 143, 208, 1.0)", "secondaryAlbedo": "rgba(79, 168, 220, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#2f8fd0"}, {"position": 0.5, "color": "#4fa8dc"}, {"position": 1.0, "color": "#1e6ca8"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_slab_water_band_2.add(mesh_slab_water_band_2);
  meshes["slab-water-band"] = mesh_slab_water_band_2;
  colliders["slab-water-band"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_slab_water_band_2);

  const endpoint_slab_earth_stratum_3 = makeAttachmentEndpoint(null);
  const node_slab_earth_stratum_3 = new THREE.Group();
  node_slab_earth_stratum_3.name = "Earth stratum on cut face__pivot";
  node_slab_earth_stratum_3.scale.set(1, 1, 1);
  if (endpoint_slab_earth_stratum_3) {
    node_slab_earth_stratum_3.position.copy(endpoint_slab_earth_stratum_3.start);
    node_slab_earth_stratum_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_slab_earth_stratum_3.position.set(0.0, -0.018, 0.0);
    node_slab_earth_stratum_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_slab_earth_stratum_3.userData.sculptComponent = {"id": "slab-earth-stratum", "name": "Earth stratum on cut face", "level": "meso", "role": "strata-band", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The lower band of the same cut face.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "slab-base", "attachment": {"parentId": "slab-base", "parentSocket": "slab-base-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.084, 0.0], "embedDepth": 0.00504, "overlap": 0.004200000000000001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.084, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.018, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["earth-stratum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ragged-top-edge", "description": "Its top edge against the water band varies along the run.", "evidenceRef": "crops/slab-edge.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "earth-stratum", "colorMaterialRecipe": {"baseColor": "#8c5c38", "dominantAlbedo": "rgba(140, 92, 56, 1.0)", "secondaryAlbedo": "rgba(168, 112, 72, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#8c5c38"}, {"position": 0.5, "color": "#a87048"}, {"position": 1.0, "color": "#6b4228"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_slab_earth_stratum_3.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["slab-base"] ?? root).add(node_slab_earth_stratum_3);
  nodes["slab-earth-stratum"] = node_slab_earth_stratum_3;
  const mesh_slab_earth_stratum_3Geometry = endpoint_slab_earth_stratum_3
    ? new THREE.CylinderGeometry(endpoint_slab_earth_stratum_3.endRadius, endpoint_slab_earth_stratum_3.baseRadius, endpoint_slab_earth_stratum_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_slab_earth_stratum_3) {
    mesh_slab_earth_stratum_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_slab_earth_stratum_3 = new THREE.Mesh(
    mesh_slab_earth_stratum_3Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_slab_earth_stratum_3.name = "Earth stratum on cut face";
  if (endpoint_slab_earth_stratum_3) {
    mesh_slab_earth_stratum_3.position.copy(endpoint_slab_earth_stratum_3.midpoint);
    mesh_slab_earth_stratum_3.quaternion.copy(endpoint_slab_earth_stratum_3.quaternion);
  }
  mesh_slab_earth_stratum_3.castShadow = options.castShadow ?? true;
  mesh_slab_earth_stratum_3.receiveShadow = options.receiveShadow ?? true;
  mesh_slab_earth_stratum_3.userData.sculptComponent = {"id": "slab-earth-stratum", "name": "Earth stratum on cut face", "level": "meso", "role": "strata-band", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The lower band of the same cut face.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "slab-base", "attachment": {"parentId": "slab-base", "parentSocket": "slab-base-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.084, 0.0], "embedDepth": 0.00504, "overlap": 0.004200000000000001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.084, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.018, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["earth-stratum"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ragged-top-edge", "description": "Its top edge against the water band varies along the run.", "evidenceRef": "crops/slab-edge.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "earth-stratum", "colorMaterialRecipe": {"baseColor": "#8c5c38", "dominantAlbedo": "rgba(140, 92, 56, 1.0)", "secondaryAlbedo": "rgba(168, 112, 72, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#8c5c38"}, {"position": 0.5, "color": "#a87048"}, {"position": 1.0, "color": "#6b4228"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_slab_earth_stratum_3.add(mesh_slab_earth_stratum_3);
  meshes["slab-earth-stratum"] = mesh_slab_earth_stratum_3;
  colliders["slab-earth-stratum"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_slab_earth_stratum_3);

  const endpoint_sea_surface_4 = makeAttachmentEndpoint(null);
  const node_sea_surface_4 = new THREE.Group();
  node_sea_surface_4.name = "Sea surface__pivot";
  node_sea_surface_4.scale.set(1, 1, 1);
  if (endpoint_sea_surface_4) {
    node_sea_surface_4.position.copy(endpoint_sea_surface_4.start);
    node_sea_surface_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sea_surface_4.position.set(0.0, 0.0, 0.0);
    node_sea_surface_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_sea_surface_4.userData.sculptComponent = {"id": "sea-surface", "name": "Sea surface", "level": "macro", "role": "water-plane", "importance": 0.9, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A single displaced plane flush with the slab top; relief on a host surface, not a volume.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 5e-05, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.001, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["sea"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "depth-grade", "description": "Colour graded by depth from the land mask.", "evidenceRef": "layout-mask.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "sea", "colorMaterialRecipe": {"baseColor": "#1e70ba", "dominantAlbedo": "rgba(30, 112, 186, 1.0)", "secondaryAlbedo": "rgba(20, 70, 140, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#1e70ba"}, {"position": 0.5, "color": "#14468c"}, {"position": 1.0, "color": "#2f8fd0"}], "finishStyle": "satin", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_sea_surface_4.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["root"] ?? root).add(node_sea_surface_4);
  nodes["sea-surface"] = node_sea_surface_4;
  const mesh_sea_surface_4Geometry = endpoint_sea_surface_4
    ? new THREE.CylinderGeometry(endpoint_sea_surface_4.endRadius, endpoint_sea_surface_4.baseRadius, endpoint_sea_surface_4.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_sea_surface_4) {
    mesh_sea_surface_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sea_surface_4 = new THREE.Mesh(
    mesh_sea_surface_4Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sea_surface_4.name = "Sea surface";
  if (endpoint_sea_surface_4) {
    mesh_sea_surface_4.position.copy(endpoint_sea_surface_4.midpoint);
    mesh_sea_surface_4.quaternion.copy(endpoint_sea_surface_4.quaternion);
  }
  mesh_sea_surface_4.castShadow = options.castShadow ?? true;
  mesh_sea_surface_4.receiveShadow = options.receiveShadow ?? true;
  mesh_sea_surface_4.userData.sculptComponent = {"id": "sea-surface", "name": "Sea surface", "level": "macro", "role": "water-plane", "importance": 0.9, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A single displaced plane flush with the slab top; relief on a host surface, not a volume.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 5e-05, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.001, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["sea"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "depth-grade", "description": "Colour graded by depth from the land mask.", "evidenceRef": "layout-mask.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "sea", "colorMaterialRecipe": {"baseColor": "#1e70ba", "dominantAlbedo": "rgba(30, 112, 186, 1.0)", "secondaryAlbedo": "rgba(20, 70, 140, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#1e70ba"}, {"position": 0.5, "color": "#14468c"}, {"position": 1.0, "color": "#2f8fd0"}], "finishStyle": "satin", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_sea_surface_4.add(mesh_sea_surface_4);
  meshes["sea-surface"] = mesh_sea_surface_4;
  colliders["sea-surface"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_sea_surface_4);

  const endpoint_shallow_shelf_5 = makeAttachmentEndpoint(null);
  const node_shallow_shelf_5 = new THREE.Group();
  node_shallow_shelf_5.name = "Shallow shelf band__pivot";
  node_shallow_shelf_5.scale.set(1, 1, 1);
  if (endpoint_shallow_shelf_5) {
    node_shallow_shelf_5.position.copy(endpoint_shallow_shelf_5.start);
    node_shallow_shelf_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shallow_shelf_5.position.set(0.0, 0.0, 0.0);
    node_shallow_shelf_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_shallow_shelf_5.userData.sculptComponent = {"id": "shallow-shelf", "name": "Shallow shelf band", "level": "meso", "role": "water-band", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A contour band on the water plane.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "sea-surface", "attachment": {"parentId": "sea-surface", "parentSocket": "sea-surface-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 5e-05, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.001, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["sea"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "sea", "colorMaterialRecipe": {"baseColor": "#1e70ba", "dominantAlbedo": "rgba(30, 112, 186, 1.0)", "secondaryAlbedo": "rgba(20, 70, 140, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#1e70ba"}, {"position": 0.5, "color": "#14468c"}, {"position": 1.0, "color": "#2f8fd0"}], "finishStyle": "satin", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_shallow_shelf_5.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["sea-surface"] ?? root).add(node_shallow_shelf_5);
  nodes["shallow-shelf"] = node_shallow_shelf_5;
  const mesh_shallow_shelf_5Geometry = endpoint_shallow_shelf_5
    ? new THREE.CylinderGeometry(endpoint_shallow_shelf_5.endRadius, endpoint_shallow_shelf_5.baseRadius, endpoint_shallow_shelf_5.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_shallow_shelf_5) {
    mesh_shallow_shelf_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shallow_shelf_5 = new THREE.Mesh(
    mesh_shallow_shelf_5Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shallow_shelf_5.name = "Shallow shelf band";
  if (endpoint_shallow_shelf_5) {
    mesh_shallow_shelf_5.position.copy(endpoint_shallow_shelf_5.midpoint);
    mesh_shallow_shelf_5.quaternion.copy(endpoint_shallow_shelf_5.quaternion);
  }
  mesh_shallow_shelf_5.castShadow = options.castShadow ?? true;
  mesh_shallow_shelf_5.receiveShadow = options.receiveShadow ?? true;
  mesh_shallow_shelf_5.userData.sculptComponent = {"id": "shallow-shelf", "name": "Shallow shelf band", "level": "meso", "role": "water-band", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A contour band on the water plane.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "sea-surface", "attachment": {"parentId": "sea-surface", "parentSocket": "sea-surface-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 5e-05, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.001, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["sea"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "sea", "colorMaterialRecipe": {"baseColor": "#1e70ba", "dominantAlbedo": "rgba(30, 112, 186, 1.0)", "secondaryAlbedo": "rgba(20, 70, 140, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#1e70ba"}, {"position": 0.5, "color": "#14468c"}, {"position": 1.0, "color": "#2f8fd0"}], "finishStyle": "satin", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_shallow_shelf_5.add(mesh_shallow_shelf_5);
  meshes["shallow-shelf"] = mesh_shallow_shelf_5;
  colliders["shallow-shelf"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_shallow_shelf_5);

  const endpoint_foam_ring_6 = makeAttachmentEndpoint(null);
  const node_foam_ring_6 = new THREE.Group();
  node_foam_ring_6.name = "Shore foam band__pivot";
  node_foam_ring_6.scale.set(1, 1, 1);
  if (endpoint_foam_ring_6) {
    node_foam_ring_6.position.copy(endpoint_foam_ring_6.start);
    node_foam_ring_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foam_ring_6.position.set(0.0, 0.0, 0.0);
    node_foam_ring_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_foam_ring_6.userData.sculptComponent = {"id": "foam-ring", "name": "Shore foam band", "level": "meso", "role": "contour-band", "importance": 0.6, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A contour band hugging every coastline including islets.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "sea-surface", "attachment": {"parentId": "sea-surface", "parentSocket": "sea-surface-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 5e-05, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.001, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["foam"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "islet-collar", "description": "Every rock islet carries its own closed foam collar.", "evidenceRef": "crops/slab-edge.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "foam", "colorMaterialRecipe": {"baseColor": "#dceef5", "dominantAlbedo": "rgba(220, 238, 245, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.4, "gradientStops": [{"position": 0.0, "color": "#dceef5"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#bcdfe9"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_foam_ring_6.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["sea-surface"] ?? root).add(node_foam_ring_6);
  nodes["foam-ring"] = node_foam_ring_6;
  const mesh_foam_ring_6Geometry = endpoint_foam_ring_6
    ? new THREE.CylinderGeometry(endpoint_foam_ring_6.endRadius, endpoint_foam_ring_6.baseRadius, endpoint_foam_ring_6.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_foam_ring_6) {
    mesh_foam_ring_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_foam_ring_6 = new THREE.Mesh(
    mesh_foam_ring_6Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foam_ring_6.name = "Shore foam band";
  if (endpoint_foam_ring_6) {
    mesh_foam_ring_6.position.copy(endpoint_foam_ring_6.midpoint);
    mesh_foam_ring_6.quaternion.copy(endpoint_foam_ring_6.quaternion);
  }
  mesh_foam_ring_6.castShadow = options.castShadow ?? true;
  mesh_foam_ring_6.receiveShadow = options.receiveShadow ?? true;
  mesh_foam_ring_6.userData.sculptComponent = {"id": "foam-ring", "name": "Shore foam band", "level": "meso", "role": "contour-band", "importance": 0.6, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A contour band hugging every coastline including islets.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "sea-surface", "attachment": {"parentId": "sea-surface", "parentSocket": "sea-surface-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 5e-05, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.001, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["foam"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "islet-collar", "description": "Every rock islet carries its own closed foam collar.", "evidenceRef": "crops/slab-edge.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "foam", "colorMaterialRecipe": {"baseColor": "#dceef5", "dominantAlbedo": "rgba(220, 238, 245, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.4, "gradientStops": [{"position": 0.0, "color": "#dceef5"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#bcdfe9"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_foam_ring_6.add(mesh_foam_ring_6);
  meshes["foam-ring"] = mesh_foam_ring_6;
  colliders["foam-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_foam_ring_6);

  const endpoint_landmass_7 = makeAttachmentEndpoint(null);
  const node_landmass_7 = new THREE.Group();
  node_landmass_7.name = "Landmass heightfield__pivot";
  node_landmass_7.scale.set(1, 1, 1);
  if (endpoint_landmass_7) {
    node_landmass_7.position.copy(endpoint_landmass_7.start);
    node_landmass_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_landmass_7.position.set(0.0, 0.0, 0.0);
    node_landmass_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_landmass_7.userData.sculptComponent = {"id": "landmass", "name": "Landmass heightfield", "level": "macro", "role": "terrain", "importance": 0.9, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "The land is a displaced plane driven by the recovered elevation grid: relief on a surface. Modelling it as assembled solids would lose the continuous coastline the identity depends on.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [{"type": "displacement", "source": "layout.json elevation grid", "axis": "y", "amplitude": 1.0, "note": "Plan-view elevation recovered from the reference; see projection-route.md"}], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.09, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["grass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plateau-tiers", "description": "Elevation quantised to discrete tiers so tops stay flat and the gap between tiers becomes a riser.", "evidenceRef": "crops/nw-waterfall.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "grass", "colorMaterialRecipe": {"baseColor": "#60a846", "dominantAlbedo": "rgba(96, 168, 70, 1.0)", "secondaryAlbedo": "rgba(126, 188, 80, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#60a846"}, {"position": 0.5, "color": "#7ebc50"}, {"position": 1.0, "color": "#36763a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_landmass_7.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["root"] ?? root).add(node_landmass_7);
  nodes["landmass"] = node_landmass_7;
  const mesh_landmass_7Geometry = endpoint_landmass_7
    ? new THREE.CylinderGeometry(endpoint_landmass_7.endRadius, endpoint_landmass_7.baseRadius, endpoint_landmass_7.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_landmass_7) {
    mesh_landmass_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_landmass_7 = new THREE.Mesh(
    mesh_landmass_7Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_landmass_7.name = "Landmass heightfield";
  if (endpoint_landmass_7) {
    mesh_landmass_7.position.copy(endpoint_landmass_7.midpoint);
    mesh_landmass_7.quaternion.copy(endpoint_landmass_7.quaternion);
  }
  mesh_landmass_7.castShadow = options.castShadow ?? true;
  mesh_landmass_7.receiveShadow = options.receiveShadow ?? true;
  mesh_landmass_7.userData.sculptComponent = {"id": "landmass", "name": "Landmass heightfield", "level": "macro", "role": "terrain", "importance": 0.9, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "The land is a displaced plane driven by the recovered elevation grid: relief on a surface. Modelling it as assembled solids would lose the continuous coastline the identity depends on.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [{"type": "displacement", "source": "layout.json elevation grid", "axis": "y", "amplitude": 1.0, "note": "Plan-view elevation recovered from the reference; see projection-route.md"}], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.09, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["grass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plateau-tiers", "description": "Elevation quantised to discrete tiers so tops stay flat and the gap between tiers becomes a riser.", "evidenceRef": "crops/nw-waterfall.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "grass", "colorMaterialRecipe": {"baseColor": "#60a846", "dominantAlbedo": "rgba(96, 168, 70, 1.0)", "secondaryAlbedo": "rgba(126, 188, 80, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#60a846"}, {"position": 0.5, "color": "#7ebc50"}, {"position": 1.0, "color": "#36763a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_landmass_7.add(mesh_landmass_7);
  meshes["landmass"] = mesh_landmass_7;
  colliders["landmass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_landmass_7);

  const endpoint_cliff_band_8 = makeAttachmentEndpoint(null);
  const node_cliff_band_8 = new THREE.Group();
  node_cliff_band_8.name = "Cliff risers__pivot";
  node_cliff_band_8.scale.set(1, 1, 1);
  if (endpoint_cliff_band_8) {
    node_cliff_band_8.position.copy(endpoint_cliff_band_8.start);
    node_cliff_band_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cliff_band_8.position.set(0.0, 0.0, 0.0);
    node_cliff_band_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_cliff_band_8.userData.sculptComponent = {"id": "cliff-band", "name": "Cliff risers", "level": "meso", "role": "terrain-riser", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "The near-vertical wall between two plateau tiers - part of the same displaced surface.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.04, 0.0], "embedDepth": 0.0024, "overlap": 0.002, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.04, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vertical-fluting", "description": "Vertical grooves and darker cavity lines run the riser height.", "evidenceRef": "crops/nw-waterfall.png"}, {"id": "hard-grass-lip", "description": "Grass stops dead at the riser lip with no blend.", "evidenceRef": "crops/nw-waterfall.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_cliff_band_8.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["landmass"] ?? root).add(node_cliff_band_8);
  nodes["cliff-band"] = node_cliff_band_8;
  const mesh_cliff_band_8Geometry = endpoint_cliff_band_8
    ? new THREE.CylinderGeometry(endpoint_cliff_band_8.endRadius, endpoint_cliff_band_8.baseRadius, endpoint_cliff_band_8.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_cliff_band_8) {
    mesh_cliff_band_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cliff_band_8 = new THREE.Mesh(
    mesh_cliff_band_8Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cliff_band_8.name = "Cliff risers";
  if (endpoint_cliff_band_8) {
    mesh_cliff_band_8.position.copy(endpoint_cliff_band_8.midpoint);
    mesh_cliff_band_8.quaternion.copy(endpoint_cliff_band_8.quaternion);
  }
  mesh_cliff_band_8.castShadow = options.castShadow ?? true;
  mesh_cliff_band_8.receiveShadow = options.receiveShadow ?? true;
  mesh_cliff_band_8.userData.sculptComponent = {"id": "cliff-band", "name": "Cliff risers", "level": "meso", "role": "terrain-riser", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "The near-vertical wall between two plateau tiers - part of the same displaced surface.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.04, 0.0], "embedDepth": 0.0024, "overlap": 0.002, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.04, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vertical-fluting", "description": "Vertical grooves and darker cavity lines run the riser height.", "evidenceRef": "crops/nw-waterfall.png"}, {"id": "hard-grass-lip", "description": "Grass stops dead at the riser lip with no blend.", "evidenceRef": "crops/nw-waterfall.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_cliff_band_8.add(mesh_cliff_band_8);
  meshes["cliff-band"] = mesh_cliff_band_8;
  colliders["cliff-band"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cliff_band_8);

  const endpoint_beach_band_9 = makeAttachmentEndpoint(null);
  const node_beach_band_9 = new THREE.Group();
  node_beach_band_9.name = "Beach band__pivot";
  node_beach_band_9.scale.set(1, 1, 1);
  if (endpoint_beach_band_9) {
    node_beach_band_9.position.copy(endpoint_beach_band_9.start);
    node_beach_band_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beach_band_9.position.set(0.0, 0.0, 0.0);
    node_beach_band_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_beach_band_9.userData.sculptComponent = {"id": "beach-band", "name": "Beach band", "level": "meso", "role": "terrain-band", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A material band on the terrain surface where the coast is low.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.002, 0.0], "embedDepth": 0.00012, "overlap": 0.0001, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.002, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["beach-sand"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "beach-sand", "colorMaterialRecipe": {"baseColor": "#e2d09e", "dominantAlbedo": "rgba(226, 208, 158, 1.0)", "secondaryAlbedo": "rgba(240, 228, 192, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#e2d09e"}, {"position": 0.5, "color": "#f0e4c0"}, {"position": 1.0, "color": "#c9b47e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_beach_band_9.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["landmass"] ?? root).add(node_beach_band_9);
  nodes["beach-band"] = node_beach_band_9;
  const mesh_beach_band_9Geometry = endpoint_beach_band_9
    ? new THREE.CylinderGeometry(endpoint_beach_band_9.endRadius, endpoint_beach_band_9.baseRadius, endpoint_beach_band_9.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_beach_band_9) {
    mesh_beach_band_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_beach_band_9 = new THREE.Mesh(
    mesh_beach_band_9Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beach_band_9.name = "Beach band";
  if (endpoint_beach_band_9) {
    mesh_beach_band_9.position.copy(endpoint_beach_band_9.midpoint);
    mesh_beach_band_9.quaternion.copy(endpoint_beach_band_9.quaternion);
  }
  mesh_beach_band_9.castShadow = options.castShadow ?? true;
  mesh_beach_band_9.receiveShadow = options.receiveShadow ?? true;
  mesh_beach_band_9.userData.sculptComponent = {"id": "beach-band", "name": "Beach band", "level": "meso", "role": "terrain-band", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "A material band on the terrain surface where the coast is low.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.002, 0.0], "embedDepth": 0.00012, "overlap": 0.0001, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.002, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["beach-sand"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "beach-sand", "colorMaterialRecipe": {"baseColor": "#e2d09e", "dominantAlbedo": "rgba(226, 208, 158, 1.0)", "secondaryAlbedo": "rgba(240, 228, 192, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#e2d09e"}, {"position": 0.5, "color": "#f0e4c0"}, {"position": 1.0, "color": "#c9b47e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_beach_band_9.add(mesh_beach_band_9);
  meshes["beach-band"] = mesh_beach_band_9;
  colliders["beach-band"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_beach_band_9);

  const endpoint_farmland_10 = makeAttachmentEndpoint(null);
  const node_farmland_10 = new THREE.Group();
  node_farmland_10.name = "Farm parcels__pivot";
  node_farmland_10.scale.set(1, 1, 1);
  if (endpoint_farmland_10) {
    node_farmland_10.position.copy(endpoint_farmland_10.start);
    node_farmland_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_farmland_10.position.set(0.0, 0.0, 0.0);
    node_farmland_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_farmland_10.userData.sculptComponent = {"id": "farmland", "name": "Farm parcels", "level": "meso", "role": "terrain-band", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Rectilinear colour parcels lying on flat plateau tops.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.002, 0.0], "embedDepth": 0.00012, "overlap": 0.0001, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.4, "height": 0.002, "depth": 0.4, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["field-crop"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "parcel-grid", "description": "Axis-aligned parcels in alternating crop colours, only on flat tops.", "evidenceRef": "crops/center-castle.png"}, {"id": "dirt-paths", "description": "Narrow tan paths wind between hamlets, distinct from the straight parcel edges.", "evidenceRef": "crops/nw-waterfall.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "field-crop", "colorMaterialRecipe": {"baseColor": "#96ba5c", "dominantAlbedo": "rgba(150, 186, 92, 1.0)", "secondaryAlbedo": "rgba(200, 196, 113, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#96ba5c"}, {"position": 0.5, "color": "#c8c471"}, {"position": 1.0, "color": "#6f9a45"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_farmland_10.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["landmass"] ?? root).add(node_farmland_10);
  nodes["farmland"] = node_farmland_10;
  const mesh_farmland_10Geometry = endpoint_farmland_10
    ? new THREE.CylinderGeometry(endpoint_farmland_10.endRadius, endpoint_farmland_10.baseRadius, endpoint_farmland_10.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_farmland_10) {
    mesh_farmland_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_farmland_10 = new THREE.Mesh(
    mesh_farmland_10Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_farmland_10.name = "Farm parcels";
  if (endpoint_farmland_10) {
    mesh_farmland_10.position.copy(endpoint_farmland_10.midpoint);
    mesh_farmland_10.quaternion.copy(endpoint_farmland_10.quaternion);
  }
  mesh_farmland_10.castShadow = options.castShadow ?? true;
  mesh_farmland_10.receiveShadow = options.receiveShadow ?? true;
  mesh_farmland_10.userData.sculptComponent = {"id": "farmland", "name": "Farm parcels", "level": "meso", "role": "terrain-band", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Rectilinear colour parcels lying on flat plateau tops.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.002, 0.0], "embedDepth": 0.00012, "overlap": 0.0001, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.4, "height": 0.002, "depth": 0.4, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["field-crop"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "parcel-grid", "description": "Axis-aligned parcels in alternating crop colours, only on flat tops.", "evidenceRef": "crops/center-castle.png"}, {"id": "dirt-paths", "description": "Narrow tan paths wind between hamlets, distinct from the straight parcel edges.", "evidenceRef": "crops/nw-waterfall.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "field-crop", "colorMaterialRecipe": {"baseColor": "#96ba5c", "dominantAlbedo": "rgba(150, 186, 92, 1.0)", "secondaryAlbedo": "rgba(200, 196, 113, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#96ba5c"}, {"position": 0.5, "color": "#c8c471"}, {"position": 1.0, "color": "#6f9a45"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_farmland_10.add(mesh_farmland_10);
  meshes["farmland"] = mesh_farmland_10;
  colliders["farmland"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_farmland_10);

  const endpoint_mountain_massif_11 = makeAttachmentEndpoint(null);
  const node_mountain_massif_11 = new THREE.Group();
  node_mountain_massif_11.name = "Mountain massif__pivot";
  node_mountain_massif_11.scale.set(1, 1, 1);
  if (endpoint_mountain_massif_11) {
    node_mountain_massif_11.position.copy(endpoint_mountain_massif_11.start);
    node_mountain_massif_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mountain_massif_11.position.set(0.0, 0.0, -0.22);
    node_mountain_massif_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_mountain_massif_11.userData.sculptComponent = {"id": "mountain-massif", "name": "Mountain massif", "level": "meso", "role": "landform", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "The dominant peak is the tallest region of the same heightfield, not a separate solid.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.32, "height": 0.09, "depth": 0.32, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, -0.22], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["mountain-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "snow-tongues", "description": "Snow caps the summit and runs down the gullies.", "evidenceRef": "crops/mountain.png"}, {"id": "faceted-ridges", "description": "Ridgelines read as angular facets, not smooth cones.", "evidenceRef": "crops/mountain.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "mountain-rock", "colorMaterialRecipe": {"baseColor": "#587ab0", "dominantAlbedo": "rgba(88, 122, 176, 1.0)", "secondaryAlbedo": "rgba(128, 152, 200, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#587ab0"}, {"position": 0.5, "color": "#8098c8"}, {"position": 1.0, "color": "#3d5a8c"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_mountain_massif_11.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["landmass"] ?? root).add(node_mountain_massif_11);
  nodes["mountain-massif"] = node_mountain_massif_11;
  const mesh_mountain_massif_11Geometry = endpoint_mountain_massif_11
    ? new THREE.CylinderGeometry(endpoint_mountain_massif_11.endRadius, endpoint_mountain_massif_11.baseRadius, endpoint_mountain_massif_11.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_mountain_massif_11) {
    mesh_mountain_massif_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_mountain_massif_11 = new THREE.Mesh(
    mesh_mountain_massif_11Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mountain_massif_11.name = "Mountain massif";
  if (endpoint_mountain_massif_11) {
    mesh_mountain_massif_11.position.copy(endpoint_mountain_massif_11.midpoint);
    mesh_mountain_massif_11.quaternion.copy(endpoint_mountain_massif_11.quaternion);
  }
  mesh_mountain_massif_11.castShadow = options.castShadow ?? true;
  mesh_mountain_massif_11.receiveShadow = options.receiveShadow ?? true;
  mesh_mountain_massif_11.userData.sculptComponent = {"id": "mountain-massif", "name": "Mountain massif", "level": "meso", "role": "landform", "importance": 0.6, "confidence": 0.85, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "The dominant peak is the tallest region of the same heightfield, not a separate solid.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.32, "height": 0.09, "depth": 0.32, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, -0.22], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["mountain-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "snow-tongues", "description": "Snow caps the summit and runs down the gullies.", "evidenceRef": "crops/mountain.png"}, {"id": "faceted-ridges", "description": "Ridgelines read as angular facets, not smooth cones.", "evidenceRef": "crops/mountain.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "mountain-rock", "colorMaterialRecipe": {"baseColor": "#587ab0", "dominantAlbedo": "rgba(88, 122, 176, 1.0)", "secondaryAlbedo": "rgba(128, 152, 200, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#587ab0"}, {"position": 0.5, "color": "#8098c8"}, {"position": 1.0, "color": "#3d5a8c"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_mountain_massif_11.add(mesh_mountain_massif_11);
  meshes["mountain-massif"] = mesh_mountain_massif_11;
  colliders["mountain-massif"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mountain_massif_11);

  const endpoint_ne_mesa_12 = makeAttachmentEndpoint(null);
  const node_ne_mesa_12 = new THREE.Group();
  node_ne_mesa_12.name = "Ochre mesa__pivot";
  node_ne_mesa_12.scale.set(1, 1, 1);
  if (endpoint_ne_mesa_12) {
    node_ne_mesa_12.position.copy(endpoint_ne_mesa_12.start);
    node_ne_mesa_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ne_mesa_12.position.set(0.3, 0.0, -0.2);
    node_ne_mesa_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_ne_mesa_12.userData.sculptComponent = {"id": "ne-mesa", "name": "Ochre mesa", "level": "meso", "role": "landform", "importance": 0.6, "confidence": 0.8, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "An arid terraced highland - the same surface with a different biome and step profile.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.3, "height": 0.05, "depth": 0.26, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, 0, -0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["mesa-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "horizontal-terraces", "description": "Stepped terraces with horizontal bedding lines.", "evidenceRef": "crops/mesa.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "mesa-stone", "colorMaterialRecipe": {"baseColor": "#cea86a", "dominantAlbedo": "rgba(206, 168, 106, 1.0)", "secondaryAlbedo": "rgba(224, 192, 136, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#cea86a"}, {"position": 0.5, "color": "#e0c088"}, {"position": 1.0, "color": "#a8814e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_ne_mesa_12.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["landmass"] ?? root).add(node_ne_mesa_12);
  nodes["ne-mesa"] = node_ne_mesa_12;
  const mesh_ne_mesa_12Geometry = endpoint_ne_mesa_12
    ? new THREE.CylinderGeometry(endpoint_ne_mesa_12.endRadius, endpoint_ne_mesa_12.baseRadius, endpoint_ne_mesa_12.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_ne_mesa_12) {
    mesh_ne_mesa_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ne_mesa_12 = new THREE.Mesh(
    mesh_ne_mesa_12Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ne_mesa_12.name = "Ochre mesa";
  if (endpoint_ne_mesa_12) {
    mesh_ne_mesa_12.position.copy(endpoint_ne_mesa_12.midpoint);
    mesh_ne_mesa_12.quaternion.copy(endpoint_ne_mesa_12.quaternion);
  }
  mesh_ne_mesa_12.castShadow = options.castShadow ?? true;
  mesh_ne_mesa_12.receiveShadow = options.receiveShadow ?? true;
  mesh_ne_mesa_12.userData.sculptComponent = {"id": "ne-mesa", "name": "Ochre mesa", "level": "meso", "role": "landform", "importance": 0.6, "confidence": 0.8, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "An arid terraced highland - the same surface with a different biome and step profile.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.3, "height": 0.05, "depth": 0.26, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, 0, -0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["mesa-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "horizontal-terraces", "description": "Stepped terraces with horizontal bedding lines.", "evidenceRef": "crops/mesa.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "mesa-stone", "colorMaterialRecipe": {"baseColor": "#cea86a", "dominantAlbedo": "rgba(206, 168, 106, 1.0)", "secondaryAlbedo": "rgba(224, 192, 136, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#cea86a"}, {"position": 0.5, "color": "#e0c088"}, {"position": 1.0, "color": "#a8814e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_ne_mesa_12.add(mesh_ne_mesa_12);
  meshes["ne-mesa"] = mesh_ne_mesa_12;
  colliders["ne-mesa"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_ne_mesa_12);

  const attachment_rock_islet_13 = {"parentId": "root", "parentSocket": "root-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.03, 0.0], "embedDepth": 0.0066, "overlap": 0.0015, "gapTolerance": 0.002, "confidence": 0.85};
  const endpoint_rock_islet_13 = makeAttachmentEndpoint(attachment_rock_islet_13);
  const node_rock_islet_13 = new THREE.Group();
  node_rock_islet_13.name = "Rock islet__pivot";
  node_rock_islet_13.scale.set(1, 1, 1);
  if (endpoint_rock_islet_13) {
    node_rock_islet_13.position.copy(endpoint_rock_islet_13.start);
    node_rock_islet_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rock_islet_13.position.set(0.0, 0.0, 0.0);
    node_rock_islet_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_rock_islet_13.userData.sculptComponent = {"id": "rock-islet", "name": "Rock islet", "level": "meso", "role": "landform", "importance": 0.6, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "A free-standing stack in open water; a tapered solid, separate from the heightfield.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.03, 0.0], "embedDepth": 0.0066, "overlap": 0.0015, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_rock_islet_13.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["root"] ?? root).add(node_rock_islet_13);
  nodes["rock-islet"] = node_rock_islet_13;
  const mesh_rock_islet_13Geometry = endpoint_rock_islet_13
    ? new THREE.CylinderGeometry(endpoint_rock_islet_13.endRadius, endpoint_rock_islet_13.baseRadius, endpoint_rock_islet_13.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_rock_islet_13) {
    mesh_rock_islet_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rock_islet_13 = new THREE.Mesh(
    mesh_rock_islet_13Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rock_islet_13.name = "Rock islet";
  if (endpoint_rock_islet_13) {
    mesh_rock_islet_13.position.copy(endpoint_rock_islet_13.midpoint);
    mesh_rock_islet_13.quaternion.copy(endpoint_rock_islet_13.quaternion);
  }
  mesh_rock_islet_13.castShadow = options.castShadow ?? true;
  mesh_rock_islet_13.receiveShadow = options.receiveShadow ?? true;
  mesh_rock_islet_13.userData.sculptComponent = {"id": "rock-islet", "name": "Rock islet", "level": "meso", "role": "landform", "importance": 0.6, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "A free-standing stack in open water; a tapered solid, separate from the heightfield.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.03, 0.0], "embedDepth": 0.0066, "overlap": 0.0015, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_rock_islet_13.add(mesh_rock_islet_13);
  meshes["rock-islet"] = mesh_rock_islet_13;
  colliders["rock-islet"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_rock_islet_13);

  const endpoint_structures_14 = makeAttachmentEndpoint(null);
  const node_structures_14 = new THREE.Group();
  node_structures_14.name = "Built environment__pivot";
  node_structures_14.scale.set(1, 1, 1);
  if (endpoint_structures_14) {
    node_structures_14.position.copy(endpoint_structures_14.start);
    node_structures_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_structures_14.position.set(0.0, 0.0, 0.0);
    node_structures_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_structures_14.userData.sculptComponent = {"id": "structures", "name": "Built environment", "level": "macro", "role": "assembly", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Grouping node for every constructed object so the diorama can be explored part by part.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.06, 0.0], "embedDepth": 0.0036, "overlap": 0.003, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.06, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_structures_14.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["root"] ?? root).add(node_structures_14);
  nodes["structures"] = node_structures_14;
  const mesh_structures_14Geometry = endpoint_structures_14
    ? new THREE.CylinderGeometry(endpoint_structures_14.endRadius, endpoint_structures_14.baseRadius, endpoint_structures_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_structures_14) {
    mesh_structures_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_structures_14 = new THREE.Mesh(
    mesh_structures_14Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_structures_14.name = "Built environment";
  if (endpoint_structures_14) {
    mesh_structures_14.position.copy(endpoint_structures_14.midpoint);
    mesh_structures_14.quaternion.copy(endpoint_structures_14.quaternion);
  }
  mesh_structures_14.castShadow = options.castShadow ?? true;
  mesh_structures_14.receiveShadow = options.receiveShadow ?? true;
  mesh_structures_14.userData.sculptComponent = {"id": "structures", "name": "Built environment", "level": "macro", "role": "assembly", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Grouping node for every constructed object so the diorama can be explored part by part.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.06, 0.0], "embedDepth": 0.0036, "overlap": 0.003, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 1, "height": 0.06, "depth": 1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_structures_14.add(mesh_structures_14);
  meshes["structures"] = mesh_structures_14;
  colliders["structures"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_structures_14);

  const attachment_castle_15 = {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.85};
  const endpoint_castle_15 = makeAttachmentEndpoint(attachment_castle_15);
  const node_castle_15 = new THREE.Group();
  node_castle_15.name = "Castle__pivot";
  node_castle_15.scale.set(1, 1, 1);
  if (endpoint_castle_15) {
    node_castle_15.position.copy(endpoint_castle_15.start);
    node_castle_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_castle_15.position.set(0.02, 0.0, 0.02);
    node_castle_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_castle_15.userData.sculptComponent = {"id": "castle", "name": "Castle", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Cylindrical towers with conical caps on a walled base - stacked solids of revolution.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.05, "height": 0.05, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.02, 0, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_castle_15.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_castle_15);
  nodes["castle"] = node_castle_15;
  const mesh_castle_15Geometry = endpoint_castle_15
    ? new THREE.CylinderGeometry(endpoint_castle_15.endRadius, endpoint_castle_15.baseRadius, endpoint_castle_15.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_castle_15) {
    mesh_castle_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_castle_15 = new THREE.Mesh(
    mesh_castle_15Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_castle_15.name = "Castle";
  if (endpoint_castle_15) {
    mesh_castle_15.position.copy(endpoint_castle_15.midpoint);
    mesh_castle_15.quaternion.copy(endpoint_castle_15.quaternion);
  }
  mesh_castle_15.castShadow = options.castShadow ?? true;
  mesh_castle_15.receiveShadow = options.receiveShadow ?? true;
  mesh_castle_15.userData.sculptComponent = {"id": "castle", "name": "Castle", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Cylindrical towers with conical caps on a walled base - stacked solids of revolution.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.05, "height": 0.05, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.02, 0, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_castle_15.add(mesh_castle_15);
  meshes["castle"] = mesh_castle_15;
  colliders["castle"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_castle_15);

  const attachment_lighthouse_16 = {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.9};
  const endpoint_lighthouse_16 = makeAttachmentEndpoint(attachment_lighthouse_16);
  const node_lighthouse_16 = new THREE.Group();
  node_lighthouse_16.name = "Lighthouse__pivot";
  node_lighthouse_16.scale.set(1, 1, 1);
  if (endpoint_lighthouse_16) {
    node_lighthouse_16.position.copy(endpoint_lighthouse_16.start);
    node_lighthouse_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lighthouse_16.position.set(-0.05, 0.0, 0.2);
    node_lighthouse_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_lighthouse_16.userData.sculptComponent = {"id": "lighthouse", "name": "Lighthouse", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tapered cylinder with a gallery band and a conical cap.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.02, "height": 0.05, "depth": 0.02, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.05, 0, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "gallery-band", "description": "Dark band below the lantern.", "evidenceRef": "crops/lighthouse-pier.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_lighthouse_16.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_lighthouse_16);
  nodes["lighthouse"] = node_lighthouse_16;
  const mesh_lighthouse_16Geometry = endpoint_lighthouse_16
    ? new THREE.CylinderGeometry(endpoint_lighthouse_16.endRadius, endpoint_lighthouse_16.baseRadius, endpoint_lighthouse_16.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_lighthouse_16) {
    mesh_lighthouse_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lighthouse_16 = new THREE.Mesh(
    mesh_lighthouse_16Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lighthouse_16.name = "Lighthouse";
  if (endpoint_lighthouse_16) {
    mesh_lighthouse_16.position.copy(endpoint_lighthouse_16.midpoint);
    mesh_lighthouse_16.quaternion.copy(endpoint_lighthouse_16.quaternion);
  }
  mesh_lighthouse_16.castShadow = options.castShadow ?? true;
  mesh_lighthouse_16.receiveShadow = options.receiveShadow ?? true;
  mesh_lighthouse_16.userData.sculptComponent = {"id": "lighthouse", "name": "Lighthouse", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tapered cylinder with a gallery band and a conical cap.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.02, "height": 0.05, "depth": 0.02, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.05, 0, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "gallery-band", "description": "Dark band below the lantern.", "evidenceRef": "crops/lighthouse-pier.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_lighthouse_16.add(mesh_lighthouse_16);
  meshes["lighthouse"] = mesh_lighthouse_16;
  colliders["lighthouse"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_lighthouse_16);

  const endpoint_windmill_17 = makeAttachmentEndpoint(null);
  const node_windmill_17 = new THREE.Group();
  node_windmill_17.name = "Windmill__pivot";
  node_windmill_17.scale.set(1, 1, 1);
  if (endpoint_windmill_17) {
    node_windmill_17.position.copy(endpoint_windmill_17.start);
    node_windmill_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_windmill_17.position.set(0.28, 0.0, 0.06);
    node_windmill_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_windmill_17.userData.sculptComponent = {"id": "windmill", "name": "Windmill", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.9, "primitive": "tapered-sweep", "topologyClass": "assembled-solid", "topologyRationale": "A tapering tower - a swept profile, not a straight cylinder.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.06, 0.0], "embedDepth": 0.0036, "overlap": 0.003, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.03, "height": 0.06, "depth": 0.03, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.28, 0, 0.06], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_windmill_17.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_windmill_17);
  nodes["windmill"] = node_windmill_17;
  const mesh_windmill_17Geometry = endpoint_windmill_17
    ? new THREE.CylinderGeometry(endpoint_windmill_17.endRadius, endpoint_windmill_17.baseRadius, endpoint_windmill_17.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.5, 0.0], "rx": 0.06, "rz": 0.04, "twist": 0.0}, {"position": [0.0, -0.1, 0.0], "rx": 0.048, "rz": 0.03, "twist": 0.0}, {"position": [0.0, 0.25, 0.0], "rx": 0.024, "rz": 0.014, "twist": 0.0}, {"position": [0.0, 0.5, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 10, "capEnds": true});
  if (!endpoint_windmill_17) {
    mesh_windmill_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_windmill_17 = new THREE.Mesh(
    mesh_windmill_17Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_windmill_17.name = "Windmill";
  if (endpoint_windmill_17) {
    mesh_windmill_17.position.copy(endpoint_windmill_17.midpoint);
    mesh_windmill_17.quaternion.copy(endpoint_windmill_17.quaternion);
  }
  mesh_windmill_17.castShadow = options.castShadow ?? true;
  mesh_windmill_17.receiveShadow = options.receiveShadow ?? true;
  mesh_windmill_17.userData.sculptComponent = {"id": "windmill", "name": "Windmill", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.9, "primitive": "tapered-sweep", "topologyClass": "assembled-solid", "topologyRationale": "A tapering tower - a swept profile, not a straight cylinder.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.06, 0.0], "embedDepth": 0.0036, "overlap": 0.003, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.03, "height": 0.06, "depth": 0.03, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.28, 0, 0.06], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_windmill_17.add(mesh_windmill_17);
  meshes["windmill"] = mesh_windmill_17;
  colliders["windmill"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_windmill_17);

  const endpoint_arch_bridge_18 = makeAttachmentEndpoint(null);
  const node_arch_bridge_18 = new THREE.Group();
  node_arch_bridge_18.name = "Multi-arch bridge__pivot";
  node_arch_bridge_18.scale.set(1, 1, 1);
  if (endpoint_arch_bridge_18) {
    node_arch_bridge_18.position.copy(endpoint_arch_bridge_18.start);
    node_arch_bridge_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arch_bridge_18.position.set(-0.02, 0.0, -0.08);
    node_arch_bridge_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_arch_bridge_18.userData.sculptComponent = {"id": "arch-bridge", "name": "Multi-arch bridge", "level": "meso", "role": "structure", "importance": 0.6, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A repeated arch profile extruded across the span on piers.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.03, 0.0], "embedDepth": 0.0066, "overlap": 0.0015, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.18, "height": 0.03, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.02, 0, -0.08], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_arch_bridge_18.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_arch_bridge_18);
  nodes["arch-bridge"] = node_arch_bridge_18;
  const mesh_arch_bridge_18Geometry = endpoint_arch_bridge_18
    ? new THREE.CylinderGeometry(endpoint_arch_bridge_18.endRadius, endpoint_arch_bridge_18.baseRadius, endpoint_arch_bridge_18.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_arch_bridge_18) {
    mesh_arch_bridge_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_arch_bridge_18 = new THREE.Mesh(
    mesh_arch_bridge_18Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arch_bridge_18.name = "Multi-arch bridge";
  if (endpoint_arch_bridge_18) {
    mesh_arch_bridge_18.position.copy(endpoint_arch_bridge_18.midpoint);
    mesh_arch_bridge_18.quaternion.copy(endpoint_arch_bridge_18.quaternion);
  }
  mesh_arch_bridge_18.castShadow = options.castShadow ?? true;
  mesh_arch_bridge_18.receiveShadow = options.receiveShadow ?? true;
  mesh_arch_bridge_18.userData.sculptComponent = {"id": "arch-bridge", "name": "Multi-arch bridge", "level": "meso", "role": "structure", "importance": 0.6, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A repeated arch profile extruded across the span on piers.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.03, 0.0], "embedDepth": 0.0066, "overlap": 0.0015, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.18, "height": 0.03, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.02, 0, -0.08], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_arch_bridge_18.add(mesh_arch_bridge_18);
  meshes["arch-bridge"] = mesh_arch_bridge_18;
  colliders["arch-bridge"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_arch_bridge_18);

  const endpoint_stone_ring_19 = makeAttachmentEndpoint(null);
  const node_stone_ring_19 = new THREE.Group();
  node_stone_ring_19.name = "Stone ring monument__pivot";
  node_stone_ring_19.scale.set(1, 1, 1);
  if (endpoint_stone_ring_19) {
    node_stone_ring_19.position.copy(endpoint_stone_ring_19.start);
    node_stone_ring_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stone_ring_19.position.set(-0.2, 0.0, -0.16);
    node_stone_ring_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_stone_ring_19.userData.sculptComponent = {"id": "stone-ring", "name": "Stone ring monument", "level": "meso", "role": "monument", "importance": 0.6, "confidence": 0.75, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "An upright annulus - a torus is the primitive it actually is.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.11, 0.0], "embedDepth": 0.0066, "overlap": 0.0055000000000000005, "gapTolerance": 0.002, "confidence": 0.75}, "dimensions": {"width": 0.11, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.2, 0, -0.16], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_stone_ring_19.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_stone_ring_19);
  nodes["stone-ring"] = node_stone_ring_19;
  const mesh_stone_ring_19Geometry = endpoint_stone_ring_19
    ? new THREE.CylinderGeometry(endpoint_stone_ring_19.endRadius, endpoint_stone_ring_19.baseRadius, endpoint_stone_ring_19.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.08, 24, 96);
  if (!endpoint_stone_ring_19) {
    mesh_stone_ring_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stone_ring_19 = new THREE.Mesh(
    mesh_stone_ring_19Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stone_ring_19.name = "Stone ring monument";
  if (endpoint_stone_ring_19) {
    mesh_stone_ring_19.position.copy(endpoint_stone_ring_19.midpoint);
    mesh_stone_ring_19.quaternion.copy(endpoint_stone_ring_19.quaternion);
  }
  mesh_stone_ring_19.castShadow = options.castShadow ?? true;
  mesh_stone_ring_19.receiveShadow = options.receiveShadow ?? true;
  mesh_stone_ring_19.userData.sculptComponent = {"id": "stone-ring", "name": "Stone ring monument", "level": "meso", "role": "monument", "importance": 0.6, "confidence": 0.75, "primitive": "torus", "topologyClass": "assembled-solid", "topologyRationale": "An upright annulus - a torus is the primitive it actually is.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.11, 0.0], "embedDepth": 0.0066, "overlap": 0.0055000000000000005, "gapTolerance": 0.002, "confidence": 0.75}, "dimensions": {"width": 0.11, "height": 0.11, "depth": 0.02, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.2, 0, -0.16], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_stone_ring_19.add(mesh_stone_ring_19);
  meshes["stone-ring"] = mesh_stone_ring_19;
  colliders["stone-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_stone_ring_19);

  const attachment_watchtower_20 = {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.04, 0.0], "embedDepth": 0.0024, "overlap": 0.002, "gapTolerance": 0.002, "confidence": 0.8};
  const endpoint_watchtower_20 = makeAttachmentEndpoint(attachment_watchtower_20);
  const node_watchtower_20 = new THREE.Group();
  node_watchtower_20.name = "Mesa watchtower__pivot";
  node_watchtower_20.scale.set(1, 1, 1);
  if (endpoint_watchtower_20) {
    node_watchtower_20.position.copy(endpoint_watchtower_20.start);
    node_watchtower_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_watchtower_20.position.set(0.3, 0.0, -0.24);
    node_watchtower_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_watchtower_20.userData.sculptComponent = {"id": "watchtower", "name": "Mesa watchtower", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A plain stone cylinder on the mesa top.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.04, 0.0], "embedDepth": 0.0024, "overlap": 0.002, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.015, "height": 0.04, "depth": 0.015, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, 0, -0.24], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["mesa-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "mesa-stone", "colorMaterialRecipe": {"baseColor": "#cea86a", "dominantAlbedo": "rgba(206, 168, 106, 1.0)", "secondaryAlbedo": "rgba(224, 192, 136, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#cea86a"}, {"position": 0.5, "color": "#e0c088"}, {"position": 1.0, "color": "#a8814e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_watchtower_20.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_watchtower_20);
  nodes["watchtower"] = node_watchtower_20;
  const mesh_watchtower_20Geometry = endpoint_watchtower_20
    ? new THREE.CylinderGeometry(endpoint_watchtower_20.endRadius, endpoint_watchtower_20.baseRadius, endpoint_watchtower_20.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_watchtower_20) {
    mesh_watchtower_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_watchtower_20 = new THREE.Mesh(
    mesh_watchtower_20Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_watchtower_20.name = "Mesa watchtower";
  if (endpoint_watchtower_20) {
    mesh_watchtower_20.position.copy(endpoint_watchtower_20.midpoint);
    mesh_watchtower_20.quaternion.copy(endpoint_watchtower_20.quaternion);
  }
  mesh_watchtower_20.castShadow = options.castShadow ?? true;
  mesh_watchtower_20.receiveShadow = options.receiveShadow ?? true;
  mesh_watchtower_20.userData.sculptComponent = {"id": "watchtower", "name": "Mesa watchtower", "level": "meso", "role": "building", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A plain stone cylinder on the mesa top.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.04, 0.0], "embedDepth": 0.0024, "overlap": 0.002, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.015, "height": 0.04, "depth": 0.015, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, 0, -0.24], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["mesa-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "mesa-stone", "colorMaterialRecipe": {"baseColor": "#cea86a", "dominantAlbedo": "rgba(206, 168, 106, 1.0)", "secondaryAlbedo": "rgba(224, 192, 136, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#cea86a"}, {"position": 0.5, "color": "#e0c088"}, {"position": 1.0, "color": "#a8814e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_watchtower_20.add(mesh_watchtower_20);
  meshes["watchtower"] = mesh_watchtower_20;
  colliders["watchtower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_watchtower_20);

  const endpoint_waterfall_21 = makeAttachmentEndpoint(null);
  const node_waterfall_21 = new THREE.Group();
  node_waterfall_21.name = "Waterfall__pivot";
  node_waterfall_21.scale.set(1, 1, 1);
  if (endpoint_waterfall_21) {
    node_waterfall_21.position.copy(endpoint_waterfall_21.start);
    node_waterfall_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_waterfall_21.position.set(-0.3, 0.0, 0.02);
    node_waterfall_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_waterfall_21.userData.sculptComponent = {"id": "waterfall", "name": "Waterfall", "level": "meso", "role": "effect", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A thin curtain of falling water. Built as a thin solid rather than a zero-thickness shell because it needs to read from both sides and carry a spray disc at its base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.07, 0.0], "embedDepth": 0.004200000000000001, "overlap": 0.0105, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.02, "height": 0.07, "depth": 0.006, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.3, 0, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["waterfall"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "waterfall", "colorMaterialRecipe": {"baseColor": "#e8f4fa", "dominantAlbedo": "rgba(232, 244, 250, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#e8f4fa"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#bcdcea"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_waterfall_21.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_waterfall_21);
  nodes["waterfall"] = node_waterfall_21;
  const mesh_waterfall_21Geometry = endpoint_waterfall_21
    ? new THREE.CylinderGeometry(endpoint_waterfall_21.endRadius, endpoint_waterfall_21.baseRadius, endpoint_waterfall_21.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_waterfall_21) {
    mesh_waterfall_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_waterfall_21 = new THREE.Mesh(
    mesh_waterfall_21Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_waterfall_21.name = "Waterfall";
  if (endpoint_waterfall_21) {
    mesh_waterfall_21.position.copy(endpoint_waterfall_21.midpoint);
    mesh_waterfall_21.quaternion.copy(endpoint_waterfall_21.quaternion);
  }
  mesh_waterfall_21.castShadow = options.castShadow ?? true;
  mesh_waterfall_21.receiveShadow = options.receiveShadow ?? true;
  mesh_waterfall_21.userData.sculptComponent = {"id": "waterfall", "name": "Waterfall", "level": "meso", "role": "effect", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A thin curtain of falling water. Built as a thin solid rather than a zero-thickness shell because it needs to read from both sides and carry a spray disc at its base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.07, 0.0], "embedDepth": 0.004200000000000001, "overlap": 0.0105, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.02, "height": 0.07, "depth": 0.006, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.3, 0, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["waterfall"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "waterfall", "colorMaterialRecipe": {"baseColor": "#e8f4fa", "dominantAlbedo": "rgba(232, 244, 250, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.5, "gradientStops": [{"position": 0.0, "color": "#e8f4fa"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#bcdcea"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_waterfall_21.add(mesh_waterfall_21);
  meshes["waterfall"] = mesh_waterfall_21;
  colliders["waterfall"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_waterfall_21);

  const endpoint_pier_22 = makeAttachmentEndpoint(null);
  const node_pier_22 = new THREE.Group();
  node_pier_22.name = "Timber pier__pivot";
  node_pier_22.scale.set(1, 1, 1);
  if (endpoint_pier_22) {
    node_pier_22.position.copy(endpoint_pier_22.start);
    node_pier_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pier_22.position.set(0.16, 0.0, 0.1);
    node_pier_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_pier_22.userData.sculptComponent = {"id": "pier", "name": "Timber pier", "level": "meso", "role": "structure", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A plank deck on posts.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0006, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.05, "height": 0.01, "depth": 0.02, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.16, 0, 0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "timber", "colorMaterialRecipe": {"baseColor": "#8a6440", "dominantAlbedo": "rgba(138, 100, 64, 1.0)", "secondaryAlbedo": "rgba(160, 120, 80, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "gradientStops": [{"position": 0.0, "color": "#8a6440"}, {"position": 0.5, "color": "#a07850"}, {"position": 1.0, "color": "#6a4a30"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_pier_22.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_pier_22);
  nodes["pier"] = node_pier_22;
  const mesh_pier_22Geometry = endpoint_pier_22
    ? new THREE.CylinderGeometry(endpoint_pier_22.endRadius, endpoint_pier_22.baseRadius, endpoint_pier_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_pier_22) {
    mesh_pier_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pier_22 = new THREE.Mesh(
    mesh_pier_22Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pier_22.name = "Timber pier";
  if (endpoint_pier_22) {
    mesh_pier_22.position.copy(endpoint_pier_22.midpoint);
    mesh_pier_22.quaternion.copy(endpoint_pier_22.quaternion);
  }
  mesh_pier_22.castShadow = options.castShadow ?? true;
  mesh_pier_22.receiveShadow = options.receiveShadow ?? true;
  mesh_pier_22.userData.sculptComponent = {"id": "pier", "name": "Timber pier", "level": "meso", "role": "structure", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A plank deck on posts.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0006, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.05, "height": 0.01, "depth": 0.02, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.16, 0, 0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "timber", "colorMaterialRecipe": {"baseColor": "#8a6440", "dominantAlbedo": "rgba(138, 100, 64, 1.0)", "secondaryAlbedo": "rgba(160, 120, 80, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "gradientStops": [{"position": 0.0, "color": "#8a6440"}, {"position": 0.5, "color": "#a07850"}, {"position": 1.0, "color": "#6a4a30"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_pier_22.add(mesh_pier_22);
  meshes["pier"] = mesh_pier_22;
  colliders["pier"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_pier_22);

  const endpoint_house_unit_23 = makeAttachmentEndpoint(null);
  const node_house_unit_23 = new THREE.Group();
  node_house_unit_23.name = "House__pivot";
  node_house_unit_23.scale.set(1, 1, 1);
  if (endpoint_house_unit_23) {
    node_house_unit_23.position.copy(endpoint_house_unit_23.start);
    node_house_unit_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_house_unit_23.position.set(0.0, 0.0, 0.0);
    node_house_unit_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_house_unit_23.userData.sculptComponent = {"id": "house-unit", "name": "House", "level": "micro", "role": "building-unit", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A rendered wall block; the smallest repeated building mass.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0006, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.012, "height": 0.01, "depth": 0.011, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_house_unit_23.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["structures"] ?? root).add(node_house_unit_23);
  nodes["house-unit"] = node_house_unit_23;
  const mesh_house_unit_23Geometry = endpoint_house_unit_23
    ? new THREE.CylinderGeometry(endpoint_house_unit_23.endRadius, endpoint_house_unit_23.baseRadius, endpoint_house_unit_23.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_house_unit_23) {
    mesh_house_unit_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_house_unit_23 = new THREE.Mesh(
    mesh_house_unit_23Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_house_unit_23.name = "House";
  if (endpoint_house_unit_23) {
    mesh_house_unit_23.position.copy(endpoint_house_unit_23.midpoint);
    mesh_house_unit_23.quaternion.copy(endpoint_house_unit_23.quaternion);
  }
  mesh_house_unit_23.castShadow = options.castShadow ?? true;
  mesh_house_unit_23.receiveShadow = options.receiveShadow ?? true;
  mesh_house_unit_23.userData.sculptComponent = {"id": "house-unit", "name": "House", "level": "micro", "role": "building-unit", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A rendered wall block; the smallest repeated building mass.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "structures", "attachment": {"parentId": "structures", "parentSocket": "structures-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0006, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.012, "height": 0.01, "depth": 0.011, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["wall-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "wall-plaster", "colorMaterialRecipe": {"baseColor": "#f0e8dc", "dominantAlbedo": "rgba(240, 232, 220, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.7, "gradientStops": [{"position": 0.0, "color": "#f0e8dc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#d6caba"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_house_unit_23.add(mesh_house_unit_23);
  meshes["house-unit"] = mesh_house_unit_23;
  colliders["house-unit"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_house_unit_23);

  const endpoint_house_roof_24 = makeAttachmentEndpoint(null);
  const node_house_roof_24 = new THREE.Group();
  node_house_roof_24.name = "Gable roof__pivot";
  node_house_roof_24.scale.set(1, 1, 1);
  if (endpoint_house_roof_24) {
    node_house_roof_24.position.copy(endpoint_house_roof_24.start);
    node_house_roof_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_house_roof_24.position.set(0.0, 0.0, 0.0);
    node_house_roof_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_house_roof_24.userData.sculptComponent = {"id": "house-roof", "name": "Gable roof", "level": "micro", "role": "building-unit", "importance": 0.6, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A triangular profile extruded along the ridge - a gable, not a cone.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-unit", "attachment": {"parentId": "house-unit", "parentSocket": "house-unit-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.007, 0.0], "embedDepth": 0.00042, "overlap": 0.00035000000000000005, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.014, "height": 0.007, "depth": 0.013, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["roof-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "roof-tile", "colorMaterialRecipe": {"baseColor": "#c2452c", "dominantAlbedo": "rgba(194, 69, 44, 1.0)", "secondaryAlbedo": "rgba(217, 96, 63, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#c2452c"}, {"position": 0.5, "color": "#d9603f"}, {"position": 1.0, "color": "#9a3320"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_house_roof_24.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["house-unit"] ?? root).add(node_house_roof_24);
  nodes["house-roof"] = node_house_roof_24;
  const mesh_house_roof_24Geometry = endpoint_house_roof_24
    ? new THREE.CylinderGeometry(endpoint_house_roof_24.endRadius, endpoint_house_roof_24.baseRadius, endpoint_house_roof_24.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_house_roof_24) {
    mesh_house_roof_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_house_roof_24 = new THREE.Mesh(
    mesh_house_roof_24Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_house_roof_24.name = "Gable roof";
  if (endpoint_house_roof_24) {
    mesh_house_roof_24.position.copy(endpoint_house_roof_24.midpoint);
    mesh_house_roof_24.quaternion.copy(endpoint_house_roof_24.quaternion);
  }
  mesh_house_roof_24.castShadow = options.castShadow ?? true;
  mesh_house_roof_24.receiveShadow = options.receiveShadow ?? true;
  mesh_house_roof_24.userData.sculptComponent = {"id": "house-roof", "name": "Gable roof", "level": "micro", "role": "building-unit", "importance": 0.6, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A triangular profile extruded along the ridge - a gable, not a cone.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-unit", "attachment": {"parentId": "house-unit", "parentSocket": "house-unit-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.007, 0.0], "embedDepth": 0.00042, "overlap": 0.00035000000000000005, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.014, "height": 0.007, "depth": 0.013, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["roof-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "roof-tile", "colorMaterialRecipe": {"baseColor": "#c2452c", "dominantAlbedo": "rgba(194, 69, 44, 1.0)", "secondaryAlbedo": "rgba(217, 96, 63, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#c2452c"}, {"position": 0.5, "color": "#d9603f"}, {"position": 1.0, "color": "#9a3320"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_house_roof_24.add(mesh_house_roof_24);
  meshes["house-roof"] = mesh_house_roof_24;
  colliders["house-roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_house_roof_24);

  const attachment_conifer_unit_25 = {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.018, 0.0], "embedDepth": 0.0010799999999999998, "overlap": 0.0009, "gapTolerance": 0.002, "confidence": 0.9};
  const endpoint_conifer_unit_25 = makeAttachmentEndpoint(attachment_conifer_unit_25);
  const node_conifer_unit_25 = new THREE.Group();
  node_conifer_unit_25.name = "Conifer__pivot";
  node_conifer_unit_25.scale.set(1, 1, 1);
  if (endpoint_conifer_unit_25) {
    node_conifer_unit_25.position.copy(endpoint_conifer_unit_25.start);
    node_conifer_unit_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_conifer_unit_25.position.set(0.0, 0.0, 0.0);
    node_conifer_unit_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_conifer_unit_25.userData.sculptComponent = {"id": "conifer-unit", "name": "Conifer", "level": "micro", "role": "vegetation", "importance": 0.6, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "A tapering canopy on a short trunk; a cone is the correct read at this scale.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.018, 0.0], "embedDepth": 0.0010799999999999998, "overlap": 0.0009, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.008, "height": 0.018, "depth": 0.008, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["conifer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "conifer", "colorMaterialRecipe": {"baseColor": "#2e6b40", "dominantAlbedo": "rgba(46, 107, 64, 1.0)", "secondaryAlbedo": "rgba(63, 136, 80, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#2e6b40"}, {"position": 0.5, "color": "#3f8850"}, {"position": 1.0, "color": "#1e4d2e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_conifer_unit_25.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["landmass"] ?? root).add(node_conifer_unit_25);
  nodes["conifer-unit"] = node_conifer_unit_25;
  const mesh_conifer_unit_25Geometry = endpoint_conifer_unit_25
    ? new THREE.CylinderGeometry(endpoint_conifer_unit_25.endRadius, endpoint_conifer_unit_25.baseRadius, endpoint_conifer_unit_25.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_conifer_unit_25) {
    mesh_conifer_unit_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_conifer_unit_25 = new THREE.Mesh(
    mesh_conifer_unit_25Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_conifer_unit_25.name = "Conifer";
  if (endpoint_conifer_unit_25) {
    mesh_conifer_unit_25.position.copy(endpoint_conifer_unit_25.midpoint);
    mesh_conifer_unit_25.quaternion.copy(endpoint_conifer_unit_25.quaternion);
  }
  mesh_conifer_unit_25.castShadow = options.castShadow ?? true;
  mesh_conifer_unit_25.receiveShadow = options.receiveShadow ?? true;
  mesh_conifer_unit_25.userData.sculptComponent = {"id": "conifer-unit", "name": "Conifer", "level": "micro", "role": "vegetation", "importance": 0.6, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "A tapering canopy on a short trunk; a cone is the correct read at this scale.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "landmass", "attachment": {"parentId": "landmass", "parentSocket": "landmass-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.018, 0.0], "embedDepth": 0.0010799999999999998, "overlap": 0.0009, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.008, "height": 0.018, "depth": 0.008, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["conifer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "conifer", "colorMaterialRecipe": {"baseColor": "#2e6b40", "dominantAlbedo": "rgba(46, 107, 64, 1.0)", "secondaryAlbedo": "rgba(63, 136, 80, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#2e6b40"}, {"position": 0.5, "color": "#3f8850"}, {"position": 1.0, "color": "#1e4d2e"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_conifer_unit_25.add(mesh_conifer_unit_25);
  meshes["conifer-unit"] = mesh_conifer_unit_25;
  colliders["conifer-unit"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_conifer_unit_25);

  const attachment_tower_cap_26 = {"parentId": "castle", "parentSocket": "castle-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.014, 0.0], "embedDepth": 0.00084, "overlap": 0.0007000000000000001, "gapTolerance": 0.002, "confidence": 0.9};
  const endpoint_tower_cap_26 = makeAttachmentEndpoint(attachment_tower_cap_26);
  const node_tower_cap_26 = new THREE.Group();
  node_tower_cap_26.name = "Conical tower cap__pivot";
  node_tower_cap_26.scale.set(1, 1, 1);
  if (endpoint_tower_cap_26) {
    node_tower_cap_26.position.copy(endpoint_tower_cap_26.start);
    node_tower_cap_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tower_cap_26.position.set(0.0, 0.0, 0.0);
    node_tower_cap_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_tower_cap_26.userData.sculptComponent = {"id": "tower-cap", "name": "Conical tower cap", "level": "micro", "role": "building-unit", "importance": 0.6, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "The red cone capping every tower - the accent that identifies castle and lighthouse.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "castle", "attachment": {"parentId": "castle", "parentSocket": "castle-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.014, 0.0], "embedDepth": 0.00084, "overlap": 0.0007000000000000001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.014, "height": 0.014, "depth": 0.014, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["roof-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "roof-tile", "colorMaterialRecipe": {"baseColor": "#c2452c", "dominantAlbedo": "rgba(194, 69, 44, 1.0)", "secondaryAlbedo": "rgba(217, 96, 63, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#c2452c"}, {"position": 0.5, "color": "#d9603f"}, {"position": 1.0, "color": "#9a3320"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_tower_cap_26.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["castle"] ?? root).add(node_tower_cap_26);
  nodes["tower-cap"] = node_tower_cap_26;
  const mesh_tower_cap_26Geometry = endpoint_tower_cap_26
    ? new THREE.CylinderGeometry(endpoint_tower_cap_26.endRadius, endpoint_tower_cap_26.baseRadius, endpoint_tower_cap_26.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_tower_cap_26) {
    mesh_tower_cap_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_tower_cap_26 = new THREE.Mesh(
    mesh_tower_cap_26Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tower_cap_26.name = "Conical tower cap";
  if (endpoint_tower_cap_26) {
    mesh_tower_cap_26.position.copy(endpoint_tower_cap_26.midpoint);
    mesh_tower_cap_26.quaternion.copy(endpoint_tower_cap_26.quaternion);
  }
  mesh_tower_cap_26.castShadow = options.castShadow ?? true;
  mesh_tower_cap_26.receiveShadow = options.receiveShadow ?? true;
  mesh_tower_cap_26.userData.sculptComponent = {"id": "tower-cap", "name": "Conical tower cap", "level": "micro", "role": "building-unit", "importance": 0.6, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "The red cone capping every tower - the accent that identifies castle and lighthouse.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "castle", "attachment": {"parentId": "castle", "parentSocket": "castle-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.014, 0.0], "embedDepth": 0.00084, "overlap": 0.0007000000000000001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.014, "height": 0.014, "depth": 0.014, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["roof-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "roof-tile", "colorMaterialRecipe": {"baseColor": "#c2452c", "dominantAlbedo": "rgba(194, 69, 44, 1.0)", "secondaryAlbedo": "rgba(217, 96, 63, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#c2452c"}, {"position": 0.5, "color": "#d9603f"}, {"position": 1.0, "color": "#9a3320"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_tower_cap_26.add(mesh_tower_cap_26);
  meshes["tower-cap"] = mesh_tower_cap_26;
  colliders["tower-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_tower_cap_26);

  const endpoint_windmill_sail_27 = makeAttachmentEndpoint(null);
  const node_windmill_sail_27 = new THREE.Group();
  node_windmill_sail_27.name = "Windmill sail__pivot";
  node_windmill_sail_27.scale.set(1, 1, 1);
  if (endpoint_windmill_sail_27) {
    node_windmill_sail_27.position.copy(endpoint_windmill_sail_27.start);
    node_windmill_sail_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_windmill_sail_27.position.set(0.0, 0.0, 0.0);
    node_windmill_sail_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_windmill_sail_27.userData.sculptComponent = {"id": "windmill-sail", "name": "Windmill sail", "level": "micro", "role": "mechanism", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A flat lattice arm; four arms at right angles on a hub.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "windmill", "attachment": {"parentId": "windmill", "parentSocket": "windmill-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.006, 0.0], "embedDepth": 0.00035999999999999997, "overlap": 0.00030000000000000003, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.03, "height": 0.006, "depth": 0.002, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "timber", "colorMaterialRecipe": {"baseColor": "#8a6440", "dominantAlbedo": "rgba(138, 100, 64, 1.0)", "secondaryAlbedo": "rgba(160, 120, 80, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "gradientStops": [{"position": 0.0, "color": "#8a6440"}, {"position": 0.5, "color": "#a07850"}, {"position": 1.0, "color": "#6a4a30"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_windmill_sail_27.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["windmill"] ?? root).add(node_windmill_sail_27);
  nodes["windmill-sail"] = node_windmill_sail_27;
  const mesh_windmill_sail_27Geometry = endpoint_windmill_sail_27
    ? new THREE.CylinderGeometry(endpoint_windmill_sail_27.endRadius, endpoint_windmill_sail_27.baseRadius, endpoint_windmill_sail_27.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_windmill_sail_27) {
    mesh_windmill_sail_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_windmill_sail_27 = new THREE.Mesh(
    mesh_windmill_sail_27Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_windmill_sail_27.name = "Windmill sail";
  if (endpoint_windmill_sail_27) {
    mesh_windmill_sail_27.position.copy(endpoint_windmill_sail_27.midpoint);
    mesh_windmill_sail_27.quaternion.copy(endpoint_windmill_sail_27.quaternion);
  }
  mesh_windmill_sail_27.castShadow = options.castShadow ?? true;
  mesh_windmill_sail_27.receiveShadow = options.receiveShadow ?? true;
  mesh_windmill_sail_27.userData.sculptComponent = {"id": "windmill-sail", "name": "Windmill sail", "level": "micro", "role": "mechanism", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A flat lattice arm; four arms at right angles on a hub.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "windmill", "attachment": {"parentId": "windmill", "parentSocket": "windmill-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.006, 0.0], "embedDepth": 0.00035999999999999997, "overlap": 0.00030000000000000003, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.03, "height": 0.006, "depth": 0.002, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "timber", "colorMaterialRecipe": {"baseColor": "#8a6440", "dominantAlbedo": "rgba(138, 100, 64, 1.0)", "secondaryAlbedo": "rgba(160, 120, 80, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "gradientStops": [{"position": 0.0, "color": "#8a6440"}, {"position": 0.5, "color": "#a07850"}, {"position": 1.0, "color": "#6a4a30"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_windmill_sail_27.add(mesh_windmill_sail_27);
  meshes["windmill-sail"] = mesh_windmill_sail_27;
  colliders["windmill-sail"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_windmill_sail_27);

  const endpoint_bridge_arch_28 = makeAttachmentEndpoint(null);
  const node_bridge_arch_28 = new THREE.Group();
  node_bridge_arch_28.name = "Bridge arch__pivot";
  node_bridge_arch_28.scale.set(1, 1, 1);
  if (endpoint_bridge_arch_28) {
    node_bridge_arch_28.position.copy(endpoint_bridge_arch_28.start);
    node_bridge_arch_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bridge_arch_28.position.set(0.0, 0.0, 0.0);
    node_bridge_arch_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_bridge_arch_28.userData.sculptComponent = {"id": "bridge-arch", "name": "Bridge arch", "level": "micro", "role": "structure-unit", "importance": 0.6, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "One round arch and its pier, repeated across the span.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "arch-bridge", "attachment": {"parentId": "arch-bridge", "parentSocket": "arch-bridge-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.02, 0.0], "embedDepth": 0.0012, "overlap": 0.001, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.02, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_bridge_arch_28.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["arch-bridge"] ?? root).add(node_bridge_arch_28);
  nodes["bridge-arch"] = node_bridge_arch_28;
  const mesh_bridge_arch_28Geometry = endpoint_bridge_arch_28
    ? new THREE.CylinderGeometry(endpoint_bridge_arch_28.endRadius, endpoint_bridge_arch_28.baseRadius, endpoint_bridge_arch_28.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_bridge_arch_28) {
    mesh_bridge_arch_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_bridge_arch_28 = new THREE.Mesh(
    mesh_bridge_arch_28Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bridge_arch_28.name = "Bridge arch";
  if (endpoint_bridge_arch_28) {
    mesh_bridge_arch_28.position.copy(endpoint_bridge_arch_28.midpoint);
    mesh_bridge_arch_28.quaternion.copy(endpoint_bridge_arch_28.quaternion);
  }
  mesh_bridge_arch_28.castShadow = options.castShadow ?? true;
  mesh_bridge_arch_28.receiveShadow = options.receiveShadow ?? true;
  mesh_bridge_arch_28.userData.sculptComponent = {"id": "bridge-arch", "name": "Bridge arch", "level": "micro", "role": "structure-unit", "importance": 0.6, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "One round arch and its pier, repeated across the span.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "arch-bridge", "attachment": {"parentId": "arch-bridge", "parentSocket": "arch-bridge-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.02, 0.0], "embedDepth": 0.0012, "overlap": 0.001, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.02, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cliff-rock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cliff-rock", "colorMaterialRecipe": {"baseColor": "#7e808c", "dominantAlbedo": "rgba(126, 128, 140, 1.0)", "secondaryAlbedo": "rgba(154, 154, 166, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#7e808c"}, {"position": 0.5, "color": "#9a9aa6"}, {"position": 1.0, "color": "#54566a"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_bridge_arch_28.add(mesh_bridge_arch_28);
  meshes["bridge-arch"] = mesh_bridge_arch_28;
  colliders["bridge-arch"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_bridge_arch_28);

  const endpoint_cloud_layer_29 = makeAttachmentEndpoint(null);
  const node_cloud_layer_29 = new THREE.Group();
  node_cloud_layer_29.name = "Cloud layer__pivot";
  node_cloud_layer_29.scale.set(1, 1, 1);
  if (endpoint_cloud_layer_29) {
    node_cloud_layer_29.position.copy(endpoint_cloud_layer_29.start);
    node_cloud_layer_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cloud_layer_29.position.set(0.0, 0.03, 0.0);
    node_cloud_layer_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_cloud_layer_29.userData.sculptComponent = {"id": "cloud-layer", "name": "Cloud layer", "level": "macro", "role": "atmosphere", "importance": 0.9, "confidence": 0.85, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Masses of ellipsoid puffs. They sit INSIDE the diorama at and below plateau height, which is an identity feature, not a distant skybox.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.06, 0.0], "embedDepth": 0.0036, "overlap": 0.009, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.06, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cloud-mass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "island-level-altitude", "description": "Cloud bases sit at or below plateau height, over the sea and against the mountain flanks.", "evidenceRef": "crops/mountain.png"}, {"id": "cirrus-streak", "description": "Thin horizontal streaks cross the summit.", "evidenceRef": "crops/mountain.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cloud-mass", "colorMaterialRecipe": {"baseColor": "#f8fafc", "dominantAlbedo": "rgba(248, 250, 252, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.35, "gradientStops": [{"position": 0.0, "color": "#f8fafc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#dde6f0"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_cloud_layer_29.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["root"] ?? root).add(node_cloud_layer_29);
  nodes["cloud-layer"] = node_cloud_layer_29;
  const mesh_cloud_layer_29Geometry = endpoint_cloud_layer_29
    ? new THREE.CylinderGeometry(endpoint_cloud_layer_29.endRadius, endpoint_cloud_layer_29.baseRadius, endpoint_cloud_layer_29.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_cloud_layer_29) {
    mesh_cloud_layer_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cloud_layer_29 = new THREE.Mesh(
    mesh_cloud_layer_29Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cloud_layer_29.name = "Cloud layer";
  if (endpoint_cloud_layer_29) {
    mesh_cloud_layer_29.position.copy(endpoint_cloud_layer_29.midpoint);
    mesh_cloud_layer_29.quaternion.copy(endpoint_cloud_layer_29.quaternion);
  }
  mesh_cloud_layer_29.castShadow = options.castShadow ?? true;
  mesh_cloud_layer_29.receiveShadow = options.receiveShadow ?? true;
  mesh_cloud_layer_29.userData.sculptComponent = {"id": "cloud-layer", "name": "Cloud layer", "level": "macro", "role": "atmosphere", "importance": 0.9, "confidence": 0.85, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Masses of ellipsoid puffs. They sit INSIDE the diorama at and below plateau height, which is an identity feature, not a distant skybox.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.06, 0.0], "embedDepth": 0.0036, "overlap": 0.009, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 1, "height": 0.06, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cloud-mass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "island-level-altitude", "description": "Cloud bases sit at or below plateau height, over the sea and against the mountain flanks.", "evidenceRef": "crops/mountain.png"}, {"id": "cirrus-streak", "description": "Thin horizontal streaks cross the summit.", "evidenceRef": "crops/mountain.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cloud-mass", "colorMaterialRecipe": {"baseColor": "#f8fafc", "dominantAlbedo": "rgba(248, 250, 252, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.35, "gradientStops": [{"position": 0.0, "color": "#f8fafc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#dde6f0"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_cloud_layer_29.add(mesh_cloud_layer_29);
  meshes["cloud-layer"] = mesh_cloud_layer_29;
  colliders["cloud-layer"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cloud_layer_29);

  const endpoint_cloud_puff_30 = makeAttachmentEndpoint(null);
  const node_cloud_puff_30 = new THREE.Group();
  node_cloud_puff_30.name = "Cloud puff__pivot";
  node_cloud_puff_30.scale.set(1, 1, 1);
  if (endpoint_cloud_puff_30) {
    node_cloud_puff_30.position.copy(endpoint_cloud_puff_30.start);
    node_cloud_puff_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cloud_puff_30.position.set(0.0, 0.0, 0.0);
    node_cloud_puff_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_cloud_puff_30.userData.sculptComponent = {"id": "cloud-puff", "name": "Cloud puff", "level": "micro", "role": "volume-unit", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "A squashed ellipsoid; several make one billowed mass with a flat base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cloud-layer", "attachment": {"parentId": "cloud-layer", "parentSocket": "cloud-layer-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.03, 0.0], "embedDepth": 0.0018, "overlap": 0.0015, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.06, "height": 0.03, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cloud-mass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cloud-mass", "colorMaterialRecipe": {"baseColor": "#f8fafc", "dominantAlbedo": "rgba(248, 250, 252, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.35, "gradientStops": [{"position": 0.0, "color": "#f8fafc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#dde6f0"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_cloud_puff_30.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}};
  (nodes["cloud-layer"] ?? root).add(node_cloud_puff_30);
  nodes["cloud-puff"] = node_cloud_puff_30;
  const mesh_cloud_puff_30Geometry = endpoint_cloud_puff_30
    ? new THREE.CylinderGeometry(endpoint_cloud_puff_30.endRadius, endpoint_cloud_puff_30.baseRadius, endpoint_cloud_puff_30.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_cloud_puff_30) {
    mesh_cloud_puff_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cloud_puff_30 = new THREE.Mesh(
    mesh_cloud_puff_30Geometry,
    materialMap["cliff-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cloud_puff_30.name = "Cloud puff";
  if (endpoint_cloud_puff_30) {
    mesh_cloud_puff_30.position.copy(endpoint_cloud_puff_30.midpoint);
    mesh_cloud_puff_30.quaternion.copy(endpoint_cloud_puff_30.quaternion);
  }
  mesh_cloud_puff_30.castShadow = options.castShadow ?? true;
  mesh_cloud_puff_30.receiveShadow = options.receiveShadow ?? true;
  mesh_cloud_puff_30.userData.sculptComponent = {"id": "cloud-puff", "name": "Cloud puff", "level": "micro", "role": "volume-unit", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "A squashed ellipsoid; several make one billowed mass with a flat base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "cloud-layer", "attachment": {"parentId": "cloud-layer", "parentSocket": "cloud-layer-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.03, 0.0], "embedDepth": 0.0018, "overlap": 0.0015, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.06, "height": 0.03, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cliff-rock"}}, "material": "cliff-rock", "materialLayers": ["cloud-mass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "cloud-mass", "colorMaterialRecipe": {"baseColor": "#f8fafc", "dominantAlbedo": "rgba(248, 250, 252, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.35, "gradientStops": [{"position": 0.0, "color": "#f8fafc"}, {"position": 0.5, "color": "#ffffff"}, {"position": 1.0, "color": "#dde6f0"}], "finishStyle": "matte", "shadingModel": "painted-albedo-with-soft-lighting", "note": "Not a toon ramp: the stops are painted albedo, quantisation is forbidden."}};
  node_cloud_puff_30.add(mesh_cloud_puff_30);
  meshes["cloud-puff"] = mesh_cloud_puff_30;
  colliders["cloud-puff"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cloud_puff_30);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"lights": [{"id": "key", "type": "directional", "intensity": 1.15, "color": "#FFF6E2", "position": [0.55, 0.78, 0.4], "castsShadow": true, "role": "Sun, high and slightly behind the viewer, matching the reference shadow direction."}, {"id": "fill", "type": "hemisphere", "intensity": 0.85, "color": "#BFE0FF", "groundColor": "#4E7A5A", "position": [0, 1, 0], "castsShadow": false, "role": "Sky dome fill; keeps shadowed faces coloured rather than black."}, {"id": "bounce", "type": "directional", "intensity": 0.32, "color": "#7FB4E8", "position": [-0.6, -0.25, -0.5], "castsShadow": false, "role": "Cool upward bounce off the sea, which is what lifts the underside of the slab."}, {"id": "ambient", "type": "ambient", "intensity": 0.42, "color": "#DCEBFF", "position": [0, 0, 0], "castsShadow": false, "role": "Broad base so no surface reads as unlit.", "toneMapping": "ACESFilmic", "exposure": 1.0}, {"id": "contact-shadow-policy", "type": "shadow-policy", "intensity": 0.0, "color": "#000000", "position": [0, 0, 0], "castsShadow": true, "role": "Contact shadow and ground shadow are required: every prop must darken the terrain beneath it, and ambient occlusion deepens the cliff bases and harbour inlets. Without contact shadow a house reads as a decal painted on the hillside rather than an object standing on it. Soft PCF, 2048 map, radius 2.5 - hard-edged shadows would fight the painted finish."}], "environment": {"type": "gradient-sky", "top": "#8FC4EE", "bottom": "#F2F7FB", "intensity": 0.6}, "toneMapping": "ACESFilmic", "exposure": 1.0, "shadowBehavior": {"contactShadow": true, "groundShadow": true, "shadowCatcher": "sea-surface and landmass both receive", "type": "PCFSoft", "mapSize": 2048, "bias": -0.0005, "radius": 2.5, "note": "Soft and broad. Hard-edged shadows would fight the painted finish, and an un-shadowed prop reads as a decal on the terrain rather than an object on it."}, "forbidden": ["toon gradient map", "outline pass", "posterisation", "rim light"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createIsometricDioramaIslandLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Isometric Diorama Island look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "intensity": 1.15, "color": "#FFF6E2", "position": [0.55, 0.78, 0.4], "castsShadow": true, "role": "Sun, high and slightly behind the viewer, matching the reference shadow direction."}, {"id": "fill", "type": "hemisphere", "intensity": 0.85, "color": "#BFE0FF", "groundColor": "#4E7A5A", "position": [0, 1, 0], "castsShadow": false, "role": "Sky dome fill; keeps shadowed faces coloured rather than black."}, {"id": "bounce", "type": "directional", "intensity": 0.32, "color": "#7FB4E8", "position": [-0.6, -0.25, -0.5], "castsShadow": false, "role": "Cool upward bounce off the sea, which is what lifts the underside of the slab."}, {"id": "ambient", "type": "ambient", "intensity": 0.42, "color": "#DCEBFF", "position": [0, 0, 0], "castsShadow": false, "role": "Broad base so no surface reads as unlit.", "toneMapping": "ACESFilmic", "exposure": 1.0}, {"id": "contact-shadow-policy", "type": "shadow-policy", "intensity": 0.0, "color": "#000000", "position": [0, 0, 0], "castsShadow": true, "role": "Contact shadow and ground shadow are required: every prop must darken the terrain beneath it, and ambient occlusion deepens the cliff bases and harbour inlets. Without contact shadow a house reads as a decal painted on the hillside rather than an object standing on it. Soft PCF, 2048 map, radius 2.5 - hard-edged shadows would fight the painted finish."}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"lights": [{"id": "key", "type": "directional", "intensity": 1.15, "color": "#FFF6E2", "position": [0.55, 0.78, 0.4], "castsShadow": true, "role": "Sun, high and slightly behind the viewer, matching the reference shadow direction."}, {"id": "fill", "type": "hemisphere", "intensity": 0.85, "color": "#BFE0FF", "groundColor": "#4E7A5A", "position": [0, 1, 0], "castsShadow": false, "role": "Sky dome fill; keeps shadowed faces coloured rather than black."}, {"id": "bounce", "type": "directional", "intensity": 0.32, "color": "#7FB4E8", "position": [-0.6, -0.25, -0.5], "castsShadow": false, "role": "Cool upward bounce off the sea, which is what lifts the underside of the slab."}, {"id": "ambient", "type": "ambient", "intensity": 0.42, "color": "#DCEBFF", "position": [0, 0, 0], "castsShadow": false, "role": "Broad base so no surface reads as unlit.", "toneMapping": "ACESFilmic", "exposure": 1.0}, {"id": "contact-shadow-policy", "type": "shadow-policy", "intensity": 0.0, "color": "#000000", "position": [0, 0, 0], "castsShadow": true, "role": "Contact shadow and ground shadow are required: every prop must darken the terrain beneath it, and ambient occlusion deepens the cliff bases and harbour inlets. Without contact shadow a house reads as a decal painted on the hillside rather than an object standing on it. Soft PCF, 2048 map, radius 2.5 - hard-edged shadows would fight the painted finish."}], "environment": {"type": "gradient-sky", "top": "#8FC4EE", "bottom": "#F2F7FB", "intensity": 0.6}, "toneMapping": "ACESFilmic", "exposure": 1.0, "shadowBehavior": {"contactShadow": true, "groundShadow": true, "shadowCatcher": "sea-surface and landmass both receive", "type": "PCFSoft", "mapSize": 2048, "bias": -0.0005, "radius": 2.5, "note": "Soft and broad. Hard-edged shadows would fight the painted finish, and an un-shadowed prop reads as a decal on the terrain rather than an object on it."}, "forbidden": ["toon gradient map", "outline pass", "posterisation", "rim light"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createIsometricDioramaIslandEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameIsometricDioramaIslandCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createIsometricDioramaIslandPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureIsometricDioramaIslandRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createIsometricDioramaIslandInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
