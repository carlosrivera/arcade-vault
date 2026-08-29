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

// Generated from ObjectSculptSpec target: EXIS 07 Strike Craft
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createEXIS07StrikeCraftModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "EXIS 07 Strike Craft";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "projection": "perspective", "fovDegrees": 28.0, "aspect": 1.33, "orientation": {"azimuthDegrees": 38.0, "elevationDegrees": 22.0, "rollDegrees": 0.0}, "positionHint": [1.6, 0.75, 2.0], "note": "Matched to the three-quarter view: a long lens (~28 deg) with mild convergence, looking down about 22 degrees from ahead and to port."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["hull"] = createSculptMaterial(
    "hull",
    {"id": "hull", "name": "Hull satin charcoal", "type": "standard", "shaderModel": "MeshStandardMaterial / faceted PBR", "baseColor": "#2F3D4D", "color": "#2F3D4D", "albedo": {"dominant": "#2F3D4D", "secondary": ["#3A485C", "#16222D"], "samplingNotes": "Measured from the sunlit upper hull. Flat-shaded satin finish. The reference reads its form entirely through facet orientation, so normals must stay per-face; smoothing them destroys the design language. No wear, grime or texture appears anywhere on this craft."}, "colorVariation": {"palette": ["#2F3D4D", "#3A485C", "#16222D"], "pattern": "faceted", "amplitude": 0.3, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.3, "detail": "Overall hull satin charcoal mass and the value step between facets."}, {"id": "meso", "frequency": 3.5, "amplitude": 0.15, "detail": "faceted variation across the panel."}, {"id": "micro", "frequency": 20.0, "amplitude": 0.03, "detail": "Deliberately near-flat: the reference has no visible microstructure, so inventing grain here would contradict the source."}], "roughness": {"base": 0.42, "value": 0.42, "map": "material-evidence/pbr-00-hull/hull_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries variation; the scalar is the authored mean."}, "metalness": 0.15, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "facet-value-step", "description": "Adjacent facets separate by value alone; the step across a crease is the primary read of the form.", "channel": "albedo"}, {"id": "crease-specular", "description": "A satin specular tracks each crease line as the view moves, brightest where a facet turns toward the key.", "channel": "roughness"}, {"id": "recess-occlusion", "description": "Panel recesses, channel grooves and nozzle sockets darken from ambient occlusion; without it they read as painted lines.", "channel": "ao"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Measured from the sunlit upper hull. Flat-shaded satin finish. The reference reads its form entirely through facet orientation, so normals must stay per-face; smoothing them destroys the design language. No wear, grime or texture appears anywhere on this craft.", "transmission": {"base": 0.0, "variation": 0.0}, "opacity": {"base": 1.0}, "ior": {"base": 1.5, "variation": 0.0}, "normalMap": "material-evidence/pbr-00-hull/hull_normal.png", "aoMap": "material-evidence/pbr-00-hull/hull_ao.png", "referencePbr": {"usable": true, "confidence": 0.751, "verdict": "pass", "measuredAlbedo": "#2D3C4D", "palette": ["#2F3D4D", "#2C3A49", "#3A485C", "#1C2C3C", "#303F50"], "cropPath": "/Users/carlos/code/wipeout/models/exis-07/material-evidence/00-hull.png", "assignedProfile": "coating.painted-metal", "sampledRegion": "hull", "source": "reference-pixel-extraction", "patternSource": "geometry", "estimatedFidelity": 0.751, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-00-hull/hull_albedo.png", "url": "material-evidence/pbr-00-hull/hull_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-00-hull/hull_roughness.png", "url": "material-evidence/pbr-00-hull/hull_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-00-hull/hull_height.png", "url": "material-evidence/pbr-00-hull/hull_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-00-hull/hull_normal.png", "url": "material-evidence/pbr-00-hull/hull_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-00-hull/hull_ao.png", "url": "material-evidence/pbr-00-hull/hull_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}},
    options
  );
  materialMap["hull-dark"] = createSculptMaterial(
    "hull-dark",
    {"id": "hull-dark", "name": "Hull shadow panel", "type": "standard", "shaderModel": "MeshStandardMaterial / faceted PBR", "baseColor": "#16222D", "color": "#16222D", "albedo": {"dominant": "#16222D", "secondary": ["#1F2C39", "#101A23"], "samplingNotes": "Measured from the shadowed lower flank. A second darker hull tone is authored rather than left to lighting alone, because the reference darkens certain panels (undersides, recess walls) beyond what facet angle explains. Flat-shaded satin finish. The reference reads its form entirely through facet orientation, so normals must stay per-face; smoothing them destroys the design language. No wear, grime or texture appears anywhere on this craft."}, "colorVariation": {"palette": ["#16222D", "#1F2C39", "#101A23"], "pattern": "faceted", "amplitude": 0.22, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.22, "detail": "Overall hull shadow panel mass and the value step between facets."}, {"id": "meso", "frequency": 3.5, "amplitude": 0.11, "detail": "faceted variation across the panel."}, {"id": "micro", "frequency": 20.0, "amplitude": 0.022, "detail": "Deliberately near-flat: the reference has no visible microstructure, so inventing grain here would contradict the source."}], "roughness": {"base": 0.46, "value": 0.46, "map": "material-evidence/pbr-01-hull-shade/hull-shade_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries variation; the scalar is the authored mean."}, "metalness": 0.15, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "panel-darkening", "description": "Certain panels - undersides, recess walls, feather plates - sit darker than facet angle alone explains.", "channel": "albedo"}, {"id": "cavity-ao", "description": "Deep occlusion inside the nozzle housings and between stacked feather plates.", "channel": "ao"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Measured from the shadowed lower flank. A second darker hull tone is authored rather than left to lighting alone, because the reference darkens certain panels (undersides, recess walls) beyond what facet angle explains. Flat-shaded satin finish. The reference reads its form entirely through facet orientation, so normals must stay per-face; smoothing them destroys the design language. No wear, grime or texture appears anywhere on this craft.", "transmission": {"base": 0.0, "variation": 0.0}, "opacity": {"base": 1.0}, "ior": {"base": 1.5, "variation": 0.0}, "normalMap": "material-evidence/pbr-01-hull-shade/hull-shade_normal.png", "aoMap": "material-evidence/pbr-01-hull-shade/hull-shade_ao.png", "referencePbr": {"usable": true, "confidence": 0.751, "verdict": "pass", "measuredAlbedo": "#17222E", "palette": ["#16222D", "#14202B", "#17232E", "#232E3C", "#131D28"], "cropPath": "/Users/carlos/code/wipeout/models/exis-07/material-evidence/01-hull-shade.png", "assignedProfile": "coating.painted-metal", "sampledRegion": "hull-shade", "source": "reference-pixel-extraction", "patternSource": "geometry", "estimatedFidelity": 0.751, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-01-hull-shade/hull-shade_albedo.png", "url": "material-evidence/pbr-01-hull-shade/hull-shade_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-01-hull-shade/hull-shade_roughness.png", "url": "material-evidence/pbr-01-hull-shade/hull-shade_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-01-hull-shade/hull-shade_height.png", "url": "material-evidence/pbr-01-hull-shade/hull-shade_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-01-hull-shade/hull-shade_normal.png", "url": "material-evidence/pbr-01-hull-shade/hull-shade_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-01-hull-shade/hull-shade_ao.png", "url": "material-evidence/pbr-01-hull-shade/hull-shade_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}},
    options
  );
  materialMap["canopy"] = createSculptMaterial(
    "canopy",
    {"id": "canopy", "name": "Canopy tint", "type": "standard", "shaderModel": "MeshStandardMaterial / faceted PBR", "baseColor": "#2A3645", "color": "#2A3645", "albedo": {"dominant": "#2A3645", "secondary": ["#3A4A63", "#1B2430"], "samplingNotes": "Dark blue tinted glass, faceted like the hull. Rendered OPAQUE: no interior is visible in any of the four views, so transmission would invent a cockpit the reference does not show. Low roughness gives the hard specular the reference has."}, "colorVariation": {"palette": ["#2A3645", "#3A4A63", "#1B2430"], "pattern": "faceted", "amplitude": 0.25, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.25, "detail": "Overall canopy tint mass and the value step between facets."}, {"id": "meso", "frequency": 3.5, "amplitude": 0.125, "detail": "faceted variation across the panel."}, {"id": "micro", "frequency": 20.0, "amplitude": 0.025, "detail": "Deliberately near-flat: the reference has no visible microstructure, so inventing grain here would contradict the source."}], "roughness": {"base": 0.15, "value": 0.15, "map": "material-evidence/pbr-02-canopy/canopy_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries variation; the scalar is the authored mean."}, "metalness": 0.3, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "tint-depth", "description": "The glazing darkens toward its centre where the tint is seen through more depth.", "channel": "albedo"}, {"id": "hard-specular", "description": "A tight, hard-edged specular that does not blur across facets, which is what separates glazing from painted hull.", "channel": "roughness"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Dark blue tinted glass, faceted like the hull. Rendered OPAQUE: no interior is visible in any of the four views, so transmission would invent a cockpit the reference does not show. Low roughness gives the hard specular the reference has.", "transmission": {"base": 0.0, "variation": 0.0}, "opacity": {"base": 1.0}, "ior": {"base": 1.5, "variation": 0.0}, "normalMap": "material-evidence/pbr-02-canopy/canopy_normal.png", "aoMap": "material-evidence/pbr-02-canopy/canopy_ao.png", "referencePbr": {"usable": true, "confidence": 0.751, "verdict": "pass", "measuredAlbedo": "#1C305C", "palette": ["#1F3361", "#1F325F", "#12254D", "#203462", "#203360"], "cropPath": "/Users/carlos/code/wipeout/models/exis-07/material-evidence/02-canopy.png", "assignedProfile": "glass.frosted", "sampledRegion": "canopy", "source": "reference-pixel-extraction", "patternSource": "geometry", "estimatedFidelity": 0.751, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-02-canopy/canopy_albedo.png", "url": "material-evidence/pbr-02-canopy/canopy_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-02-canopy/canopy_roughness.png", "url": "material-evidence/pbr-02-canopy/canopy_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-02-canopy/canopy_height.png", "url": "material-evidence/pbr-02-canopy/canopy_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-02-canopy/canopy_normal.png", "url": "material-evidence/pbr-02-canopy/canopy_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-02-canopy/canopy_ao.png", "url": "material-evidence/pbr-02-canopy/canopy_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "clearcoat": {"base": 0.65}, "clearcoatRoughness": {"base": 0.06}},
    options
  );
  materialMap["emissive"] = createSculptMaterial(
    "emissive",
    {"id": "emissive", "name": "Cyan channel light", "type": "standard", "shaderModel": "MeshStandardMaterial / faceted PBR", "baseColor": "#25b9f5", "color": "#25b9f5", "albedo": {"dominant": "#25b9f5", "secondary": ["#25b9f5", "#1f7ac0"], "samplingNotes": "Emissive, not lit: it reads at full brightness on faces turned away from the key, so it must emit rather than reflect. Blows to near-white at the strip core, measured #9AFBFC, falling to #1f7ac0 at the channel edge."}, "colorVariation": {"palette": ["#9AFBFC", "#25b9f5", "#1f7ac0"], "pattern": "gradient", "amplitude": 0.5, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.5, "detail": "Overall cyan channel light mass and the value step between facets."}, {"id": "meso", "frequency": 3.5, "amplitude": 0.25, "detail": "gradient variation across the panel."}, {"id": "micro", "frequency": 20.0, "amplitude": 0.05, "detail": "Deliberately near-flat: the reference has no visible microstructure, so inventing grain here would contradict the source."}], "roughness": {"base": 0.3, "value": 0.3, "map": "material-evidence/pbr-03-emissive/emissive_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries variation; the scalar is the authored mean."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "core-to-edge", "description": "Each run blows to near-white at its core and falls to #1f7ac0 at the channel edge - a gradient across the strip width, not a flat fill.", "channel": "emissive"}, {"id": "channel-shadow", "description": "The channel walls either side of a strip stay dark, which is what makes the light read as inset.", "channel": "ao"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Emissive, not lit: it reads at full brightness on faces turned away from the key, so it must emit rather than reflect. Blows to near-white at the strip core, measured #9AFBFC, falling to #1f7ac0 at the channel edge.", "transmission": {"base": 0.0, "variation": 0.0}, "opacity": {"base": 1.0}, "ior": {"base": 1.5, "variation": 0.0}, "normalMap": "material-evidence/pbr-03-emissive/emissive_normal.png", "aoMap": "material-evidence/pbr-03-emissive/emissive_ao.png", "referencePbr": {"usable": true, "confidence": 0.829, "verdict": "pass", "measuredAlbedo": "#569DBB", "palette": ["#25416D", "#9AFBFC", "#AAFCFC", "#4FE1FB", "#0555B4"], "cropPath": "/Users/carlos/code/wipeout/models/exis-07/material-evidence/03-emissive.png", "assignedProfile": "plastic.glossy", "sampledRegion": "emissive", "source": "reference-pixel-extraction", "patternSource": "geometry", "estimatedFidelity": 0.829, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-03-emissive/emissive_albedo.png", "url": "material-evidence/pbr-03-emissive/emissive_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-03-emissive/emissive_roughness.png", "url": "material-evidence/pbr-03-emissive/emissive_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-03-emissive/emissive_height.png", "url": "material-evidence/pbr-03-emissive/emissive_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-03-emissive/emissive_normal.png", "url": "material-evidence/pbr-03-emissive/emissive_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-03-emissive/emissive_ao.png", "url": "material-evidence/pbr-03-emissive/emissive_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "emissive": "#37c8ff", "emissiveIntensity": 2.6},
    options
  );
  materialMap["nozzle-glow"] = createSculptMaterial(
    "nozzle-glow",
    {"id": "nozzle-glow", "name": "Engine core glow", "type": "standard", "shaderModel": "MeshStandardMaterial / faceted PBR", "baseColor": "#8ef6ff", "color": "#8ef6ff", "albedo": {"dominant": "#8ef6ff", "secondary": ["#37c8ff", "#0C4493"], "samplingNotes": "The grille bars inside each nozzle recess. Brighter than the hull strips - it is the hottest thing on the craft - and banded horizontally."}, "colorVariation": {"palette": ["#90FBFC", "#37c8ff", "#0C4493"], "pattern": "banded", "amplitude": 0.55, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.55, "detail": "Overall engine core glow mass and the value step between facets."}, {"id": "meso", "frequency": 3.5, "amplitude": 0.275, "detail": "banded variation across the panel."}, {"id": "micro", "frequency": 20.0, "amplitude": 0.055, "detail": "Deliberately near-flat: the reference has no visible microstructure, so inventing grain here would contradict the source."}], "roughness": {"base": 0.25, "value": 0.25, "map": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries variation; the scalar is the authored mean."}, "metalness": 0.0, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "bar-banding", "description": "Discrete horizontal bars with dark gaps between them, not a continuous glowing plate.", "channel": "emissive"}, {"id": "recess-falloff", "description": "The glow dims toward the recess walls where the housing occludes it.", "channel": "ao"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "The grille bars inside each nozzle recess. Brighter than the hull strips - it is the hottest thing on the craft - and banded horizontally.", "transmission": {"base": 0.0, "variation": 0.0}, "opacity": {"base": 1.0}, "ior": {"base": 1.5, "variation": 0.0}, "normalMap": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_normal.png", "aoMap": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_ao.png", "referencePbr": {"usable": true, "confidence": 0.829, "verdict": "pass", "measuredAlbedo": "#57A8CC", "palette": ["#90FBFC", "#0C4493", "#4F6992", "#158DE6", "#5EE5FC"], "cropPath": "/Users/carlos/code/wipeout/models/exis-07/material-evidence/06-nozzle-glow.png", "assignedProfile": "plastic.glossy", "sampledRegion": "nozzle-glow", "source": "reference-pixel-extraction", "patternSource": "geometry", "estimatedFidelity": 0.829, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_albedo.png", "url": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_roughness.png", "url": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_height.png", "url": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_normal.png", "url": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_ao.png", "url": "material-evidence/pbr-06-nozzle-glow/nozzle-glow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "emissive": "#7fe9ff", "emissiveIntensity": 3.4},
    options
  );
  materialMap["vent-orange"] = createSculptMaterial(
    "vent-orange",
    {"id": "vent-orange", "name": "Intake vent", "type": "standard", "shaderModel": "MeshStandardMaterial / faceted PBR", "baseColor": "#EC761A", "color": "#EC761A", "albedo": {"dominant": "#EC761A", "secondary": ["#F58A2E", "#B85510"], "samplingNotes": "Matte orange. NOT emissive: it takes shading like the hull in every view, which is the only thing separating it from a second accent light."}, "colorVariation": {"palette": ["#EC761A", "#F58A2E", "#B85510"], "pattern": "flat", "amplitude": 0.15, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.15, "detail": "Overall intake vent mass and the value step between facets."}, {"id": "meso", "frequency": 3.5, "amplitude": 0.075, "detail": "flat variation across the panel."}, {"id": "micro", "frequency": 20.0, "amplitude": 0.015, "detail": "Deliberately near-flat: the reference has no visible microstructure, so inventing grain here would contradict the source."}], "roughness": {"base": 0.6, "value": 0.6, "map": "material-evidence/pbr-04-vent-orange/vent-orange_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries variation; the scalar is the authored mean."}, "metalness": 0.2, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "shaded-not-emissive", "description": "Takes the full lighting solution like the hull. This is the one override that exists to record a NEGATIVE: the vent must never gain an emissive channel.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Matte orange. NOT emissive: it takes shading like the hull in every view, which is the only thing separating it from a second accent light.", "transmission": {"base": 0.0, "variation": 0.0}, "opacity": {"base": 1.0}, "ior": {"base": 1.5, "variation": 0.0}, "normalMap": "material-evidence/pbr-04-vent-orange/vent-orange_normal.png", "aoMap": "material-evidence/pbr-04-vent-orange/vent-orange_ao.png", "referencePbr": {"usable": true, "confidence": 0.758, "verdict": "pass", "measuredAlbedo": "#DD6C16", "palette": ["#EC761A", "#E97115", "#EE7B1E", "#5C2104", "#A95213"], "cropPath": "/Users/carlos/code/wipeout/models/exis-07/material-evidence/04-vent-orange.png", "assignedProfile": "coating.painted-metal", "sampledRegion": "vent-orange", "source": "reference-pixel-extraction", "patternSource": "geometry", "estimatedFidelity": 0.758, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-04-vent-orange/vent-orange_albedo.png", "url": "material-evidence/pbr-04-vent-orange/vent-orange_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-04-vent-orange/vent-orange_roughness.png", "url": "material-evidence/pbr-04-vent-orange/vent-orange_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-04-vent-orange/vent-orange_height.png", "url": "material-evidence/pbr-04-vent-orange/vent-orange_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-04-vent-orange/vent-orange_normal.png", "url": "material-evidence/pbr-04-vent-orange/vent-orange_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-04-vent-orange/vent-orange_ao.png", "url": "material-evidence/pbr-04-vent-orange/vent-orange_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}},
    options
  );
  materialMap["decal"] = createSculptMaterial(
    "decal",
    {"id": "decal", "name": "Hull decals", "type": "standard", "shaderModel": "MeshStandardMaterial / faceted PBR", "baseColor": "#F2F5F8", "color": "#F2F5F8", "albedo": {"dominant": "#F2F5F8", "secondary": ["#FFFFFF", "#C9D2DA"], "samplingNotes": "White marks drawn to a canvas at build time: arrow-in-triangle logo, \"07\" on nose and mid-hull, \"EXIS\" wordmark. Generated rather than cropped - see projection-route.md."}, "colorVariation": {"palette": ["#F2F5F8", "#FFFFFF", "#C9D2DA"], "pattern": "glyph", "amplitude": 0.1, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.1, "detail": "Overall hull decals mass and the value step between facets."}, {"id": "meso", "frequency": 3.5, "amplitude": 0.05, "detail": "glyph variation across the panel."}, {"id": "micro", "frequency": 20.0, "amplitude": 0.01, "detail": "Deliberately near-flat: the reference has no visible microstructure, so inventing grain here would contradict the source."}], "roughness": {"base": 0.55, "value": 0.55, "map": "material-evidence/pbr-05-decal/decal_roughness.png", "source": "reference-pixel-extraction", "note": "Extracted map carries variation; the scalar is the authored mean."}, "metalness": 0.05, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "glyph-edges", "description": "Hard-edged white glyphs following the hull surface, slightly off-white (#F2F5F8 measured) rather than pure white.", "channel": "albedo"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "White marks drawn to a canvas at build time: arrow-in-triangle logo, \"07\" on nose and mid-hull, \"EXIS\" wordmark. Generated rather than cropped - see projection-route.md.", "transmission": {"base": 0.0, "variation": 0.0}, "opacity": {"base": 1.0}, "ior": {"base": 1.5, "variation": 0.0}, "normalMap": "material-evidence/pbr-05-decal/decal_normal.png", "aoMap": "material-evidence/pbr-05-decal/decal_ao.png", "referencePbr": {"usable": true, "confidence": 0.716, "verdict": "pass", "measuredAlbedo": "#F9F9F9", "palette": ["#FEFDFE", "#FAFAFA", "#FFFFFF", "#F1F1F1", "#A8AAAB"], "cropPath": "/Users/carlos/code/wipeout/models/exis-07/material-evidence/05-decal.png", "assignedProfile": "plastic.matte", "sampledRegion": "decal", "source": "reference-pixel-extraction", "patternSource": "generated-canvas", "estimatedFidelity": 0.716, "targetThreshold": 0.7, "maps": {"albedo": {"path": "material-evidence/pbr-05-decal/decal_albedo.png", "url": "material-evidence/pbr-05-decal/decal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "material-evidence/pbr-05-decal/decal_roughness.png", "url": "material-evidence/pbr-05-decal/decal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "material-evidence/pbr-05-decal/decal_height.png", "url": "material-evidence/pbr-05-decal/decal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "material-evidence/pbr-05-decal/decal_normal.png", "url": "material-evidence/pbr-05-decal/decal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "material-evidence/pbr-05-decal/decal_ao.png", "url": "material-evidence/pbr-05-decal/decal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "EXIS 07 Strike Craft__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "EXIS 07 Strike Craft", "level": "macro", "role": "assembly-root", "importance": 0.9, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The craft is a polyhedron; the root is its bounding assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.62, "height": 0.26, "depth": 1.0, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "EXIS 07 Strike Craft";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "EXIS 07 Strike Craft", "level": "macro", "role": "assembly-root", "importance": 0.9, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The craft is a polyhedron; the root is its bounding assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.62, "height": 0.26, "depth": 1.0, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_hull_1 = makeAttachmentEndpoint(null);
  const node_hull_1 = new THREE.Group();
  node_hull_1.name = "Faceted hull__pivot";
  node_hull_1.scale.set(1, 1, 1);
  if (endpoint_hull_1) {
    node_hull_1.position.copy(endpoint_hull_1.start);
    node_hull_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hull_1.position.set(0.0, 0.0, 0.0);
    node_hull_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_hull_1.userData.sculptComponent = {"id": "hull", "name": "Faceted hull", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "An authored polyhedron built from explicit vertices. Not a lathe or sweep: every surface is a flat facet, so vertex authoring reproduces it exactly instead of approximating it.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.2, 0.0], "embedDepth": 0.012, "overlap": 0.010000000000000002, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 0.62, "height": 0.2, "depth": 1.0, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hull-faceting", "description": "Flat facets meeting at hard creases over the whole surface; no smooth transitions.", "evidenceRef": "crops/threequarter.png"}, {"id": "chine-rail", "description": "A chine edge runs the full length at mid-height, separating upper and lower hull.", "evidenceRef": "crops/side.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_hull_1.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["root"] ?? root).add(node_hull_1);
  nodes["hull"] = node_hull_1;
  const mesh_hull_1Geometry = endpoint_hull_1
    ? new THREE.CylinderGeometry(endpoint_hull_1.endRadius, endpoint_hull_1.baseRadius, endpoint_hull_1.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_hull_1) {
    mesh_hull_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hull_1 = new THREE.Mesh(
    mesh_hull_1Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hull_1.name = "Faceted hull";
  if (endpoint_hull_1) {
    mesh_hull_1.position.copy(endpoint_hull_1.midpoint);
    mesh_hull_1.quaternion.copy(endpoint_hull_1.quaternion);
  }
  mesh_hull_1.castShadow = options.castShadow ?? true;
  mesh_hull_1.receiveShadow = options.receiveShadow ?? true;
  mesh_hull_1.userData.sculptComponent = {"id": "hull", "name": "Faceted hull", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "An authored polyhedron built from explicit vertices. Not a lathe or sweep: every surface is a flat facet, so vertex authoring reproduces it exactly instead of approximating it.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "flush", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.2, 0.0], "embedDepth": 0.012, "overlap": 0.010000000000000002, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 0.62, "height": 0.2, "depth": 1.0, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hull-faceting", "description": "Flat facets meeting at hard creases over the whole surface; no smooth transitions.", "evidenceRef": "crops/threequarter.png"}, {"id": "chine-rail", "description": "A chine edge runs the full length at mid-height, separating upper and lower hull.", "evidenceRef": "crops/side.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_hull_1.add(mesh_hull_1);
  meshes["hull"] = mesh_hull_1;
  colliders["hull"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_hull_1);

  const endpoint_nose_wedge_2 = makeAttachmentEndpoint(null);
  const node_nose_wedge_2 = new THREE.Group();
  node_nose_wedge_2.name = "Nose wedge__pivot";
  node_nose_wedge_2.scale.set(1, 1, 1);
  if (endpoint_nose_wedge_2) {
    node_nose_wedge_2.position.copy(endpoint_nose_wedge_2.start);
    node_nose_wedge_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_wedge_2.position.set(0.0, 0.0, 0.42);
    node_nose_wedge_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_wedge_2.userData.sculptComponent = {"id": "nose-wedge", "name": "Nose wedge", "level": "meso", "role": "body-section", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A sharp tapering wedge; flat facets converging to a point.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.18, "height": 0.09, "depth": 0.3, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0.42], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_nose_wedge_2.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_nose_wedge_2);
  nodes["nose-wedge"] = node_nose_wedge_2;
  const mesh_nose_wedge_2Geometry = endpoint_nose_wedge_2
    ? new THREE.CylinderGeometry(endpoint_nose_wedge_2.endRadius, endpoint_nose_wedge_2.baseRadius, endpoint_nose_wedge_2.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_nose_wedge_2) {
    mesh_nose_wedge_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nose_wedge_2 = new THREE.Mesh(
    mesh_nose_wedge_2Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_wedge_2.name = "Nose wedge";
  if (endpoint_nose_wedge_2) {
    mesh_nose_wedge_2.position.copy(endpoint_nose_wedge_2.midpoint);
    mesh_nose_wedge_2.quaternion.copy(endpoint_nose_wedge_2.quaternion);
  }
  mesh_nose_wedge_2.castShadow = options.castShadow ?? true;
  mesh_nose_wedge_2.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_wedge_2.userData.sculptComponent = {"id": "nose-wedge", "name": "Nose wedge", "level": "meso", "role": "body-section", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A sharp tapering wedge; flat facets converging to a point.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.18, "height": 0.09, "depth": 0.3, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0.42], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_nose_wedge_2.add(mesh_nose_wedge_2);
  meshes["nose-wedge"] = mesh_nose_wedge_2;
  colliders["nose-wedge"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nose_wedge_2);

  const endpoint_canopy_3 = makeAttachmentEndpoint(null);
  const node_canopy_3 = new THREE.Group();
  node_canopy_3.name = "Canopy__pivot";
  node_canopy_3.scale.set(1, 1, 1);
  if (endpoint_canopy_3) {
    node_canopy_3.position.copy(endpoint_canopy_3.start);
    node_canopy_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_canopy_3.position.set(0.0, 0.1, 0.16);
    node_canopy_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_canopy_3.userData.sculptComponent = {"id": "canopy", "name": "Canopy", "level": "meso", "role": "glazing", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A faceted glazing panel set into the spine; a low polyhedron, not a swept bubble.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.011000000000000001, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.15, "height": 0.05, "depth": 0.3, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.1, 0.16], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["canopy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "canopy-glass", "description": "Elongated hexagonal plan, faceted, dark blue tint reading opaque with a hard specular.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "canopy", "colorMaterialRecipe": {"baseColor": "#2A3645", "dominantAlbedo": "rgba(42, 54, 69, 1.0)", "secondaryAlbedo": "rgba(58, 74, 99, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#2A3645"}, {"position": 0.5, "color": "#3A4A63"}, {"position": 1.0, "color": "#1B2430"}], "finishStyle": "gloss", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_canopy_3.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_canopy_3);
  nodes["canopy"] = node_canopy_3;
  const mesh_canopy_3Geometry = endpoint_canopy_3
    ? new THREE.CylinderGeometry(endpoint_canopy_3.endRadius, endpoint_canopy_3.baseRadius, endpoint_canopy_3.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_canopy_3) {
    mesh_canopy_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_canopy_3 = new THREE.Mesh(
    mesh_canopy_3Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_canopy_3.name = "Canopy";
  if (endpoint_canopy_3) {
    mesh_canopy_3.position.copy(endpoint_canopy_3.midpoint);
    mesh_canopy_3.quaternion.copy(endpoint_canopy_3.quaternion);
  }
  mesh_canopy_3.castShadow = options.castShadow ?? true;
  mesh_canopy_3.receiveShadow = options.receiveShadow ?? true;
  mesh_canopy_3.userData.sculptComponent = {"id": "canopy", "name": "Canopy", "level": "meso", "role": "glazing", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A faceted glazing panel set into the spine; a low polyhedron, not a swept bubble.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.011000000000000001, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.15, "height": 0.05, "depth": 0.3, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.1, 0.16], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["canopy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "canopy-glass", "description": "Elongated hexagonal plan, faceted, dark blue tint reading opaque with a hard specular.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "canopy", "colorMaterialRecipe": {"baseColor": "#2A3645", "dominantAlbedo": "rgba(42, 54, 69, 1.0)", "secondaryAlbedo": "rgba(58, 74, 99, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.75, "gradientStops": [{"position": 0.0, "color": "#2A3645"}, {"position": 0.5, "color": "#3A4A63"}, {"position": 1.0, "color": "#1B2430"}], "finishStyle": "gloss", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_canopy_3.add(mesh_canopy_3);
  meshes["canopy"] = mesh_canopy_3;
  colliders["canopy"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_canopy_3);

  const endpoint_dorsal_spine_4 = makeAttachmentEndpoint(null);
  const node_dorsal_spine_4 = new THREE.Group();
  node_dorsal_spine_4.name = "Dorsal spine__pivot";
  node_dorsal_spine_4.scale.set(1, 1, 1);
  if (endpoint_dorsal_spine_4) {
    node_dorsal_spine_4.position.copy(endpoint_dorsal_spine_4.start);
    node_dorsal_spine_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dorsal_spine_4.position.set(0.0, 0.09, 0.02);
    node_dorsal_spine_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_dorsal_spine_4.userData.sculptComponent = {"id": "dorsal-spine", "name": "Dorsal spine", "level": "meso", "role": "body-section", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The raised centreline ridge running from behind the nose to the fin roots. It is the section the canopy is recessed into and the fins spring from, so modelling it as part of the hull loses both attachment points.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.16, "height": 0.09, "depth": 0.55, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.09, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "spine-ridge", "description": "Raised ridge carrying the canopy recess forward and the fin roots aft.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_dorsal_spine_4.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_dorsal_spine_4);
  nodes["dorsal-spine"] = node_dorsal_spine_4;
  const mesh_dorsal_spine_4Geometry = endpoint_dorsal_spine_4
    ? new THREE.CylinderGeometry(endpoint_dorsal_spine_4.endRadius, endpoint_dorsal_spine_4.baseRadius, endpoint_dorsal_spine_4.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_dorsal_spine_4) {
    mesh_dorsal_spine_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_dorsal_spine_4 = new THREE.Mesh(
    mesh_dorsal_spine_4Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dorsal_spine_4.name = "Dorsal spine";
  if (endpoint_dorsal_spine_4) {
    mesh_dorsal_spine_4.position.copy(endpoint_dorsal_spine_4.midpoint);
    mesh_dorsal_spine_4.quaternion.copy(endpoint_dorsal_spine_4.quaternion);
  }
  mesh_dorsal_spine_4.castShadow = options.castShadow ?? true;
  mesh_dorsal_spine_4.receiveShadow = options.receiveShadow ?? true;
  mesh_dorsal_spine_4.userData.sculptComponent = {"id": "dorsal-spine", "name": "Dorsal spine", "level": "meso", "role": "body-section", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The raised centreline ridge running from behind the nose to the fin roots. It is the section the canopy is recessed into and the fins spring from, so modelling it as part of the hull loses both attachment points.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.09, 0.0], "embedDepth": 0.005399999999999999, "overlap": 0.0045, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.16, "height": 0.09, "depth": 0.55, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.09, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "spine-ridge", "description": "Raised ridge carrying the canopy recess forward and the fin roots aft.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_dorsal_spine_4.add(mesh_dorsal_spine_4);
  meshes["dorsal-spine"] = mesh_dorsal_spine_4;
  colliders["dorsal-spine"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dorsal_spine_4);

  const endpoint_wing_5 = makeAttachmentEndpoint(null);
  const node_wing_5 = new THREE.Group();
  node_wing_5.name = "Wing panel__pivot";
  node_wing_5.scale.set(1, 1, 1);
  if (endpoint_wing_5) {
    node_wing_5.position.copy(endpoint_wing_5.start);
    node_wing_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wing_5.position.set(0.2, -0.01, -0.05);
    node_wing_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_wing_5.userData.sculptComponent = {"id": "wing", "name": "Wing panel", "level": "macro", "role": "aerofoil", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The wing is the hull flare continued outboard, built as faceted panels; mirrored about the centreline, so the pair is a reflection and not a rotation.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.24, "height": 0.05, "depth": 0.55, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.2, -0.01, -0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "wing-loop", "description": "A large angular emissive loop traces the rear wing panel, following panel breaks with hard corners.", "evidenceRef": "crops/top.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_wing_5.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_wing_5);
  nodes["wing"] = node_wing_5;
  const mesh_wing_5Geometry = endpoint_wing_5
    ? new THREE.CylinderGeometry(endpoint_wing_5.endRadius, endpoint_wing_5.baseRadius, endpoint_wing_5.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_wing_5) {
    mesh_wing_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wing_5 = new THREE.Mesh(
    mesh_wing_5Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wing_5.name = "Wing panel";
  if (endpoint_wing_5) {
    mesh_wing_5.position.copy(endpoint_wing_5.midpoint);
    mesh_wing_5.quaternion.copy(endpoint_wing_5.quaternion);
  }
  mesh_wing_5.castShadow = options.castShadow ?? true;
  mesh_wing_5.receiveShadow = options.receiveShadow ?? true;
  mesh_wing_5.userData.sculptComponent = {"id": "wing", "name": "Wing panel", "level": "macro", "role": "aerofoil", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The wing is the hull flare continued outboard, built as faceted panels; mirrored about the centreline, so the pair is a reflection and not a rotation.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.05, 0.0], "embedDepth": 0.003, "overlap": 0.0025000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.24, "height": 0.05, "depth": 0.55, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.2, -0.01, -0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "wing-loop", "description": "A large angular emissive loop traces the rear wing panel, following panel breaks with hard corners.", "evidenceRef": "crops/top.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_wing_5.add(mesh_wing_5);
  meshes["wing"] = mesh_wing_5;
  colliders["wing"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wing_5);

  const endpoint_wingtip_pod_6 = makeAttachmentEndpoint(null);
  const node_wingtip_pod_6 = new THREE.Group();
  node_wingtip_pod_6.name = "Wingtip pod__pivot";
  node_wingtip_pod_6.scale.set(1, 1, 1);
  if (endpoint_wingtip_pod_6) {
    node_wingtip_pod_6.position.copy(endpoint_wingtip_pod_6.start);
    node_wingtip_pod_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wingtip_pod_6.position.set(0.3, 0.0, -0.1);
    node_wingtip_pod_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_wingtip_pod_6.userData.sculptComponent = {"id": "wingtip-pod", "name": "Wingtip pod", "level": "meso", "role": "housing", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A faceted block terminating the wing and housing an outboard engine.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing", "attachment": {"parentId": "wing", "parentSocket": "wing-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.07, 0.0], "embedDepth": 0.004200000000000001, "overlap": 0.0035000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.09, "height": 0.07, "depth": 0.26, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.3, 0, -0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tip-slot", "description": "A cyan emissive slot on the pod leading face.", "evidenceRef": "crops/top.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_wingtip_pod_6.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["wing"] ?? root).add(node_wingtip_pod_6);
  nodes["wingtip-pod"] = node_wingtip_pod_6;
  const mesh_wingtip_pod_6Geometry = endpoint_wingtip_pod_6
    ? new THREE.CylinderGeometry(endpoint_wingtip_pod_6.endRadius, endpoint_wingtip_pod_6.baseRadius, endpoint_wingtip_pod_6.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_wingtip_pod_6) {
    mesh_wingtip_pod_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wingtip_pod_6 = new THREE.Mesh(
    mesh_wingtip_pod_6Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wingtip_pod_6.name = "Wingtip pod";
  if (endpoint_wingtip_pod_6) {
    mesh_wingtip_pod_6.position.copy(endpoint_wingtip_pod_6.midpoint);
    mesh_wingtip_pod_6.quaternion.copy(endpoint_wingtip_pod_6.quaternion);
  }
  mesh_wingtip_pod_6.castShadow = options.castShadow ?? true;
  mesh_wingtip_pod_6.receiveShadow = options.receiveShadow ?? true;
  mesh_wingtip_pod_6.userData.sculptComponent = {"id": "wingtip-pod", "name": "Wingtip pod", "level": "meso", "role": "housing", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A faceted block terminating the wing and housing an outboard engine.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing", "attachment": {"parentId": "wing", "parentSocket": "wing-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.07, 0.0], "embedDepth": 0.004200000000000001, "overlap": 0.0035000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.09, "height": 0.07, "depth": 0.26, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.3, 0, -0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tip-slot", "description": "A cyan emissive slot on the pod leading face.", "evidenceRef": "crops/top.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_wingtip_pod_6.add(mesh_wingtip_pod_6);
  meshes["wingtip-pod"] = mesh_wingtip_pod_6;
  colliders["wingtip-pod"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wingtip_pod_6);

  const endpoint_dorsal_fin_7 = makeAttachmentEndpoint(null);
  const node_dorsal_fin_7 = new THREE.Group();
  node_dorsal_fin_7.name = "Dorsal fin__pivot";
  node_dorsal_fin_7.scale.set(1, 1, 1);
  if (endpoint_dorsal_fin_7) {
    node_dorsal_fin_7.position.copy(endpoint_dorsal_fin_7.start);
    node_dorsal_fin_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dorsal_fin_7.position.set(0.06, 0.14, -0.3);
    node_dorsal_fin_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_dorsal_fin_7.userData.sculptComponent = {"id": "dorsal-fin", "name": "Dorsal fin", "level": "meso", "role": "stabiliser", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A swept flat plate, one per side, splayed outboard from the rear spine.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.14, 0.0], "embedDepth": 0.008400000000000001, "overlap": 0.007000000000000001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.03, "height": 0.14, "depth": 0.22, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.06, 0.14, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fin-strip", "description": "Emissive strip along the outer face, parallel to the swept leading edge.", "evidenceRef": "crops/side.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_dorsal_fin_7.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_dorsal_fin_7);
  nodes["dorsal-fin"] = node_dorsal_fin_7;
  const mesh_dorsal_fin_7Geometry = endpoint_dorsal_fin_7
    ? new THREE.CylinderGeometry(endpoint_dorsal_fin_7.endRadius, endpoint_dorsal_fin_7.baseRadius, endpoint_dorsal_fin_7.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_dorsal_fin_7) {
    mesh_dorsal_fin_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_dorsal_fin_7 = new THREE.Mesh(
    mesh_dorsal_fin_7Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dorsal_fin_7.name = "Dorsal fin";
  if (endpoint_dorsal_fin_7) {
    mesh_dorsal_fin_7.position.copy(endpoint_dorsal_fin_7.midpoint);
    mesh_dorsal_fin_7.quaternion.copy(endpoint_dorsal_fin_7.quaternion);
  }
  mesh_dorsal_fin_7.castShadow = options.castShadow ?? true;
  mesh_dorsal_fin_7.receiveShadow = options.receiveShadow ?? true;
  mesh_dorsal_fin_7.userData.sculptComponent = {"id": "dorsal-fin", "name": "Dorsal fin", "level": "meso", "role": "stabiliser", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A swept flat plate, one per side, splayed outboard from the rear spine.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.14, 0.0], "embedDepth": 0.008400000000000001, "overlap": 0.007000000000000001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.03, "height": 0.14, "depth": 0.22, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.06, 0.14, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fin-strip", "description": "Emissive strip along the outer face, parallel to the swept leading edge.", "evidenceRef": "crops/side.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull", "colorMaterialRecipe": {"baseColor": "#2F3D4D", "dominantAlbedo": "rgba(47, 61, 77, 1.0)", "secondaryAlbedo": "rgba(58, 72, 92, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#2F3D4D"}, {"position": 0.5, "color": "#3A485C"}, {"position": 1.0, "color": "#16222D"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_dorsal_fin_7.add(mesh_dorsal_fin_7);
  meshes["dorsal-fin"] = mesh_dorsal_fin_7;
  colliders["dorsal-fin"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_dorsal_fin_7);

  const endpoint_feather_plate_8 = makeAttachmentEndpoint(null);
  const node_feather_plate_8 = new THREE.Group();
  node_feather_plate_8.name = "Trailing feather plate__pivot";
  node_feather_plate_8.scale.set(1, 1, 1);
  if (endpoint_feather_plate_8) {
    node_feather_plate_8.position.copy(endpoint_feather_plate_8.start);
    node_feather_plate_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_feather_plate_8.position.set(0.16, 0.02, -0.4);
    node_feather_plate_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_feather_plate_8.userData.sculptComponent = {"id": "feather-plate", "name": "Trailing feather plate", "level": "meso", "role": "fairing", "importance": 0.6, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Layered swept plates fanning aft from the wing trailing edge, each overlapping the one below - a stack of thin polyhedra, not one slab.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing", "attachment": {"parentId": "wing", "parentSocket": "wing-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.02, 0.0], "embedDepth": 0.0012, "overlap": 0.003, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.16, "height": 0.02, "depth": 0.2, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.16, 0.02, -0.4], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "feather-plates", "description": "Four plates per side, each stepped up and aft of the one below.", "evidenceRef": "crops/side.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_feather_plate_8.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["wing"] ?? root).add(node_feather_plate_8);
  nodes["feather-plate"] = node_feather_plate_8;
  const mesh_feather_plate_8Geometry = endpoint_feather_plate_8
    ? new THREE.CylinderGeometry(endpoint_feather_plate_8.endRadius, endpoint_feather_plate_8.baseRadius, endpoint_feather_plate_8.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_feather_plate_8) {
    mesh_feather_plate_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_feather_plate_8 = new THREE.Mesh(
    mesh_feather_plate_8Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_feather_plate_8.name = "Trailing feather plate";
  if (endpoint_feather_plate_8) {
    mesh_feather_plate_8.position.copy(endpoint_feather_plate_8.midpoint);
    mesh_feather_plate_8.quaternion.copy(endpoint_feather_plate_8.quaternion);
  }
  mesh_feather_plate_8.castShadow = options.castShadow ?? true;
  mesh_feather_plate_8.receiveShadow = options.receiveShadow ?? true;
  mesh_feather_plate_8.userData.sculptComponent = {"id": "feather-plate", "name": "Trailing feather plate", "level": "meso", "role": "fairing", "importance": 0.6, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Layered swept plates fanning aft from the wing trailing edge, each overlapping the one below - a stack of thin polyhedra, not one slab.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing", "attachment": {"parentId": "wing", "parentSocket": "wing-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.02, 0.0], "embedDepth": 0.0012, "overlap": 0.003, "gapTolerance": 0.002, "confidence": 0.85}, "dimensions": {"width": 0.16, "height": 0.02, "depth": 0.2, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.16, 0.02, -0.4], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "feather-plates", "description": "Four plates per side, each stepped up and aft of the one below.", "evidenceRef": "crops/side.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_feather_plate_8.add(mesh_feather_plate_8);
  meshes["feather-plate"] = mesh_feather_plate_8;
  colliders["feather-plate"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_feather_plate_8);

  const endpoint_propulsion_9 = makeAttachmentEndpoint(null);
  const node_propulsion_9 = new THREE.Group();
  node_propulsion_9.name = "Propulsion cluster__pivot";
  node_propulsion_9.scale.set(1, 1, 1);
  if (endpoint_propulsion_9) {
    node_propulsion_9.position.copy(endpoint_propulsion_9.start);
    node_propulsion_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_propulsion_9.position.set(0.0, 0.0, -0.44);
    node_propulsion_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_propulsion_9.userData.sculptComponent = {"id": "propulsion", "name": "Propulsion cluster", "level": "macro", "role": "assembly", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Grouping node for the three engines so the cluster can be inspected as one unit.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.12, 0.0], "embedDepth": 0.0072, "overlap": 0.006, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.5, "height": 0.12, "depth": 0.16, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, -0.44], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_propulsion_9.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["root"] ?? root).add(node_propulsion_9);
  nodes["propulsion"] = node_propulsion_9;
  const mesh_propulsion_9Geometry = endpoint_propulsion_9
    ? new THREE.CylinderGeometry(endpoint_propulsion_9.endRadius, endpoint_propulsion_9.baseRadius, endpoint_propulsion_9.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_propulsion_9) {
    mesh_propulsion_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_propulsion_9 = new THREE.Mesh(
    mesh_propulsion_9Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_propulsion_9.name = "Propulsion cluster";
  if (endpoint_propulsion_9) {
    mesh_propulsion_9.position.copy(endpoint_propulsion_9.midpoint);
    mesh_propulsion_9.quaternion.copy(endpoint_propulsion_9.quaternion);
  }
  mesh_propulsion_9.castShadow = options.castShadow ?? true;
  mesh_propulsion_9.receiveShadow = options.receiveShadow ?? true;
  mesh_propulsion_9.userData.sculptComponent = {"id": "propulsion", "name": "Propulsion cluster", "level": "macro", "role": "assembly", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Grouping node for the three engines so the cluster can be inspected as one unit.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.12, 0.0], "embedDepth": 0.0072, "overlap": 0.006, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.5, "height": 0.12, "depth": 0.16, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, -0.44], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_propulsion_9.add(mesh_propulsion_9);
  meshes["propulsion"] = mesh_propulsion_9;
  colliders["propulsion"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_propulsion_9);

  const endpoint_engine_central_10 = makeAttachmentEndpoint(null);
  const node_engine_central_10 = new THREE.Group();
  node_engine_central_10.name = "Central engine housing__pivot";
  node_engine_central_10.scale.set(1, 1, 1);
  if (endpoint_engine_central_10) {
    node_engine_central_10.position.copy(endpoint_engine_central_10.start);
    node_engine_central_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_engine_central_10.position.set(0.0, 0.01, -0.46);
    node_engine_central_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_engine_central_10.userData.sculptComponent = {"id": "engine-central", "name": "Central engine housing", "level": "meso", "role": "housing", "importance": 0.6, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "An octagonal recessed housing - eight flat walls, which is what the rear view shows; a cylinder would round off the corners the reference keeps sharp.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "propulsion", "attachment": {"parentId": "propulsion", "parentSocket": "propulsion-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.11, 0.0], "embedDepth": 0.0242, "overlap": 0.0055000000000000005, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 0.16, "height": 0.11, "depth": 0.1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0.01, -0.46], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nozzle-recess", "description": "Octagonal recess, walls stepping inward to the grille.", "evidenceRef": "crops/rear.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_engine_central_10.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["propulsion"] ?? root).add(node_engine_central_10);
  nodes["engine-central"] = node_engine_central_10;
  const mesh_engine_central_10Geometry = endpoint_engine_central_10
    ? new THREE.CylinderGeometry(endpoint_engine_central_10.endRadius, endpoint_engine_central_10.baseRadius, endpoint_engine_central_10.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_engine_central_10) {
    mesh_engine_central_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_engine_central_10 = new THREE.Mesh(
    mesh_engine_central_10Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_central_10.name = "Central engine housing";
  if (endpoint_engine_central_10) {
    mesh_engine_central_10.position.copy(endpoint_engine_central_10.midpoint);
    mesh_engine_central_10.quaternion.copy(endpoint_engine_central_10.quaternion);
  }
  mesh_engine_central_10.castShadow = options.castShadow ?? true;
  mesh_engine_central_10.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_central_10.userData.sculptComponent = {"id": "engine-central", "name": "Central engine housing", "level": "meso", "role": "housing", "importance": 0.6, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "An octagonal recessed housing - eight flat walls, which is what the rear view shows; a cylinder would round off the corners the reference keeps sharp.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "propulsion", "attachment": {"parentId": "propulsion", "parentSocket": "propulsion-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.11, 0.0], "embedDepth": 0.0242, "overlap": 0.0055000000000000005, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 0.16, "height": 0.11, "depth": 0.1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0.01, -0.46], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nozzle-recess", "description": "Octagonal recess, walls stepping inward to the grille.", "evidenceRef": "crops/rear.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_engine_central_10.add(mesh_engine_central_10);
  meshes["engine-central"] = mesh_engine_central_10;
  colliders["engine-central"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_engine_central_10);

  const endpoint_engine_outboard_11 = makeAttachmentEndpoint(null);
  const node_engine_outboard_11 = new THREE.Group();
  node_engine_outboard_11.name = "Outboard engine housing__pivot";
  node_engine_outboard_11.scale.set(1, 1, 1);
  if (endpoint_engine_outboard_11) {
    node_engine_outboard_11.position.copy(endpoint_engine_outboard_11.start);
    node_engine_outboard_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_engine_outboard_11.position.set(0.3, -0.01, -0.34);
    node_engine_outboard_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_engine_outboard_11.userData.sculptComponent = {"id": "engine-outboard", "name": "Outboard engine housing", "level": "meso", "role": "housing", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The same octagonal recess at smaller scale, one inside each wingtip pod.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wingtip-pod", "attachment": {"parentId": "wingtip-pod", "parentSocket": "wingtip-pod-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "embedDepth": 0.0176, "overlap": 0.004, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.11, "height": 0.08, "depth": 0.09, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.3, -0.01, -0.34], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_engine_outboard_11.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["wingtip-pod"] ?? root).add(node_engine_outboard_11);
  nodes["engine-outboard"] = node_engine_outboard_11;
  const mesh_engine_outboard_11Geometry = endpoint_engine_outboard_11
    ? new THREE.CylinderGeometry(endpoint_engine_outboard_11.endRadius, endpoint_engine_outboard_11.baseRadius, endpoint_engine_outboard_11.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_engine_outboard_11) {
    mesh_engine_outboard_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_engine_outboard_11 = new THREE.Mesh(
    mesh_engine_outboard_11Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_outboard_11.name = "Outboard engine housing";
  if (endpoint_engine_outboard_11) {
    mesh_engine_outboard_11.position.copy(endpoint_engine_outboard_11.midpoint);
    mesh_engine_outboard_11.quaternion.copy(endpoint_engine_outboard_11.quaternion);
  }
  mesh_engine_outboard_11.castShadow = options.castShadow ?? true;
  mesh_engine_outboard_11.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_outboard_11.userData.sculptComponent = {"id": "engine-outboard", "name": "Outboard engine housing", "level": "meso", "role": "housing", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The same octagonal recess at smaller scale, one inside each wingtip pod.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wingtip-pod", "attachment": {"parentId": "wingtip-pod", "parentSocket": "wingtip-pod-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "embedDepth": 0.0176, "overlap": 0.004, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.11, "height": 0.08, "depth": 0.09, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.3, -0.01, -0.34], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["hull-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "hull-dark", "colorMaterialRecipe": {"baseColor": "#16222D", "dominantAlbedo": "rgba(22, 34, 45, 1.0)", "secondaryAlbedo": "rgba(31, 44, 57, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#16222D"}, {"position": 0.5, "color": "#1F2C39"}, {"position": 1.0, "color": "#101A23"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_engine_outboard_11.add(mesh_engine_outboard_11);
  meshes["engine-outboard"] = mesh_engine_outboard_11;
  colliders["engine-outboard"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_engine_outboard_11);

  const endpoint_nozzle_core_12 = makeAttachmentEndpoint(null);
  const node_nozzle_core_12 = new THREE.Group();
  node_nozzle_core_12.name = "Engine grille__pivot";
  node_nozzle_core_12.scale.set(1, 1, 1);
  if (endpoint_nozzle_core_12) {
    node_nozzle_core_12.position.copy(endpoint_nozzle_core_12.start);
    node_nozzle_core_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nozzle_core_12.position.set(0.0, 0.0, 0.0);
    node_nozzle_core_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_nozzle_core_12.userData.sculptComponent = {"id": "nozzle-core", "name": "Engine grille", "level": "micro", "role": "emitter", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Horizontal emissive bars filling each nozzle recess.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "engine-central", "attachment": {"parentId": "engine-central", "parentSocket": "engine-central-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.07, 0.0], "embedDepth": 0.004200000000000001, "overlap": 0.0035000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.1, "height": 0.07, "depth": 0.01, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["nozzle-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "grille-bars", "description": "Five bars on the central nozzle, four on each outboard.", "evidenceRef": "crops/rear.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "nozzle-glow", "colorMaterialRecipe": {"baseColor": "#90FBFC", "dominantAlbedo": "rgba(144, 251, 252, 1.0)", "secondaryAlbedo": "rgba(55, 200, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#90FBFC"}, {"position": 0.5, "color": "#37c8ff"}, {"position": 1.0, "color": "#0C4493"}], "finishStyle": "emissive", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_nozzle_core_12.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["engine-central"] ?? root).add(node_nozzle_core_12);
  nodes["nozzle-core"] = node_nozzle_core_12;
  const mesh_nozzle_core_12Geometry = endpoint_nozzle_core_12
    ? new THREE.CylinderGeometry(endpoint_nozzle_core_12.endRadius, endpoint_nozzle_core_12.baseRadius, endpoint_nozzle_core_12.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_nozzle_core_12) {
    mesh_nozzle_core_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nozzle_core_12 = new THREE.Mesh(
    mesh_nozzle_core_12Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nozzle_core_12.name = "Engine grille";
  if (endpoint_nozzle_core_12) {
    mesh_nozzle_core_12.position.copy(endpoint_nozzle_core_12.midpoint);
    mesh_nozzle_core_12.quaternion.copy(endpoint_nozzle_core_12.quaternion);
  }
  mesh_nozzle_core_12.castShadow = options.castShadow ?? true;
  mesh_nozzle_core_12.receiveShadow = options.receiveShadow ?? true;
  mesh_nozzle_core_12.userData.sculptComponent = {"id": "nozzle-core", "name": "Engine grille", "level": "micro", "role": "emitter", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Horizontal emissive bars filling each nozzle recess.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "engine-central", "attachment": {"parentId": "engine-central", "parentSocket": "engine-central-surface", "contactType": "butt", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.07, 0.0], "embedDepth": 0.004200000000000001, "overlap": 0.0035000000000000005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.1, "height": 0.07, "depth": 0.01, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["nozzle-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "grille-bars", "description": "Five bars on the central nozzle, four on each outboard.", "evidenceRef": "crops/rear.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "nozzle-glow", "colorMaterialRecipe": {"baseColor": "#90FBFC", "dominantAlbedo": "rgba(144, 251, 252, 1.0)", "secondaryAlbedo": "rgba(55, 200, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#90FBFC"}, {"position": 0.5, "color": "#37c8ff"}, {"position": 1.0, "color": "#0C4493"}], "finishStyle": "emissive", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_nozzle_core_12.add(mesh_nozzle_core_12);
  meshes["nozzle-core"] = mesh_nozzle_core_12;
  colliders["nozzle-core"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nozzle_core_12);

  const endpoint_chine_strip_13 = makeAttachmentEndpoint(null);
  const node_chine_strip_13 = new THREE.Group();
  node_chine_strip_13.name = "Chine light channel__pivot";
  node_chine_strip_13.scale.set(1, 1, 1);
  if (endpoint_chine_strip_13) {
    node_chine_strip_13.position.copy(endpoint_chine_strip_13.start);
    node_chine_strip_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chine_strip_13.position.set(0.0, 0.0, 0.0);
    node_chine_strip_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_chine_strip_13.userData.sculptComponent = {"id": "chine-strip", "name": "Chine light channel", "level": "micro", "role": "emitter", "importance": 0.6, "confidence": 0.95, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "An emissive run INSET into a recessed channel along the chine - relief cut into the hull surface, not a decal lying on it.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0022, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 0.02, "height": 0.01, "depth": 0.8, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["emissive"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "chine-strip", "description": "Unbroken cyan run from nose to tail along the mid-hull chine.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "emissive", "colorMaterialRecipe": {"baseColor": "#9AFBFC", "dominantAlbedo": "rgba(154, 251, 252, 1.0)", "secondaryAlbedo": "rgba(37, 185, 245, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#9AFBFC"}, {"position": 0.5, "color": "#25b9f5"}, {"position": 1.0, "color": "#1f7ac0"}], "finishStyle": "emissive", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_chine_strip_13.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_chine_strip_13);
  nodes["chine-strip"] = node_chine_strip_13;
  const mesh_chine_strip_13Geometry = endpoint_chine_strip_13
    ? new THREE.CylinderGeometry(endpoint_chine_strip_13.endRadius, endpoint_chine_strip_13.baseRadius, endpoint_chine_strip_13.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_chine_strip_13) {
    mesh_chine_strip_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chine_strip_13 = new THREE.Mesh(
    mesh_chine_strip_13Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chine_strip_13.name = "Chine light channel";
  if (endpoint_chine_strip_13) {
    mesh_chine_strip_13.position.copy(endpoint_chine_strip_13.midpoint);
    mesh_chine_strip_13.quaternion.copy(endpoint_chine_strip_13.quaternion);
  }
  mesh_chine_strip_13.castShadow = options.castShadow ?? true;
  mesh_chine_strip_13.receiveShadow = options.receiveShadow ?? true;
  mesh_chine_strip_13.userData.sculptComponent = {"id": "chine-strip", "name": "Chine light channel", "level": "micro", "role": "emitter", "importance": 0.6, "confidence": 0.95, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "An emissive run INSET into a recessed channel along the chine - relief cut into the hull surface, not a decal lying on it.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0022, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.95}, "dimensions": {"width": 0.02, "height": 0.01, "depth": 0.8, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["emissive"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "chine-strip", "description": "Unbroken cyan run from nose to tail along the mid-hull chine.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "emissive", "colorMaterialRecipe": {"baseColor": "#9AFBFC", "dominantAlbedo": "rgba(154, 251, 252, 1.0)", "secondaryAlbedo": "rgba(37, 185, 245, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#9AFBFC"}, {"position": 0.5, "color": "#25b9f5"}, {"position": 1.0, "color": "#1f7ac0"}], "finishStyle": "emissive", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_chine_strip_13.add(mesh_chine_strip_13);
  meshes["chine-strip"] = mesh_chine_strip_13;
  colliders["chine-strip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_chine_strip_13);

  const endpoint_nose_chevron_14 = makeAttachmentEndpoint(null);
  const node_nose_chevron_14 = new THREE.Group();
  node_nose_chevron_14.name = "Nose chevron light__pivot";
  node_nose_chevron_14.scale.set(1, 1, 1);
  if (endpoint_nose_chevron_14) {
    node_nose_chevron_14.position.copy(endpoint_nose_chevron_14.start);
    node_nose_chevron_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_chevron_14.position.set(0.0, 0.0, 0.0);
    node_nose_chevron_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_chevron_14.userData.sculptComponent = {"id": "nose-chevron", "name": "Nose chevron light", "level": "micro", "role": "emitter", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "A V-shaped emissive channel wrapping the underside of the nose.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "nose-wedge", "attachment": {"parentId": "nose-wedge", "parentSocket": "nose-wedge-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0022, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.3, "height": 0.01, "depth": 0.16, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["emissive"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nose-chevron", "description": "V run with the apex pointing forward.", "evidenceRef": "crops/top.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "emissive", "colorMaterialRecipe": {"baseColor": "#9AFBFC", "dominantAlbedo": "rgba(154, 251, 252, 1.0)", "secondaryAlbedo": "rgba(37, 185, 245, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#9AFBFC"}, {"position": 0.5, "color": "#25b9f5"}, {"position": 1.0, "color": "#1f7ac0"}], "finishStyle": "emissive", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_nose_chevron_14.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["nose-wedge"] ?? root).add(node_nose_chevron_14);
  nodes["nose-chevron"] = node_nose_chevron_14;
  const mesh_nose_chevron_14Geometry = endpoint_nose_chevron_14
    ? new THREE.CylinderGeometry(endpoint_nose_chevron_14.endRadius, endpoint_nose_chevron_14.baseRadius, endpoint_nose_chevron_14.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_nose_chevron_14) {
    mesh_nose_chevron_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nose_chevron_14 = new THREE.Mesh(
    mesh_nose_chevron_14Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_chevron_14.name = "Nose chevron light";
  if (endpoint_nose_chevron_14) {
    mesh_nose_chevron_14.position.copy(endpoint_nose_chevron_14.midpoint);
    mesh_nose_chevron_14.quaternion.copy(endpoint_nose_chevron_14.quaternion);
  }
  mesh_nose_chevron_14.castShadow = options.castShadow ?? true;
  mesh_nose_chevron_14.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_chevron_14.userData.sculptComponent = {"id": "nose-chevron", "name": "Nose chevron light", "level": "micro", "role": "emitter", "importance": 0.6, "confidence": 0.9, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "A V-shaped emissive channel wrapping the underside of the nose.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "nose-wedge", "attachment": {"parentId": "nose-wedge", "parentSocket": "nose-wedge-surface", "contactType": "embed", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.01, 0.0], "embedDepth": 0.0022, "overlap": 0.0005, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.3, "height": 0.01, "depth": 0.16, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["emissive"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nose-chevron", "description": "V run with the apex pointing forward.", "evidenceRef": "crops/top.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "emissive", "colorMaterialRecipe": {"baseColor": "#9AFBFC", "dominantAlbedo": "rgba(154, 251, 252, 1.0)", "secondaryAlbedo": "rgba(37, 185, 245, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#9AFBFC"}, {"position": 0.5, "color": "#25b9f5"}, {"position": 1.0, "color": "#1f7ac0"}], "finishStyle": "emissive", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_nose_chevron_14.add(mesh_nose_chevron_14);
  meshes["nose-chevron"] = mesh_nose_chevron_14;
  colliders["nose-chevron"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nose_chevron_14);

  const endpoint_vent_block_15 = makeAttachmentEndpoint(null);
  const node_vent_block_15 = new THREE.Group();
  node_vent_block_15.name = "Intake vent__pivot";
  node_vent_block_15.scale.set(1, 1, 1);
  if (endpoint_vent_block_15) {
    node_vent_block_15.position.copy(endpoint_vent_block_15.start);
    node_vent_block_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_block_15.position.set(0.0, 0.0, 0.0);
    node_vent_block_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_block_15.userData.sculptComponent = {"id": "vent-block", "name": "Intake vent", "level": "micro", "role": "vent", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A matte orange block seated in a recessed socket.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.02, 0.0], "embedDepth": 0.0044, "overlap": 0.001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.035, "height": 0.02, "depth": 0.07, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["vent-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vent-block", "description": "Two on the dorsal spine, one per side aft; shaded, not emissive.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "vent-orange", "colorMaterialRecipe": {"baseColor": "#EC761A", "dominantAlbedo": "rgba(236, 118, 26, 1.0)", "secondaryAlbedo": "rgba(245, 138, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#EC761A"}, {"position": 0.5, "color": "#F58A2E"}, {"position": 1.0, "color": "#B85510"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_vent_block_15.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_vent_block_15);
  nodes["vent-block"] = node_vent_block_15;
  const mesh_vent_block_15Geometry = endpoint_vent_block_15
    ? new THREE.CylinderGeometry(endpoint_vent_block_15.endRadius, endpoint_vent_block_15.baseRadius, endpoint_vent_block_15.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_vent_block_15) {
    mesh_vent_block_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vent_block_15 = new THREE.Mesh(
    mesh_vent_block_15Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_block_15.name = "Intake vent";
  if (endpoint_vent_block_15) {
    mesh_vent_block_15.position.copy(endpoint_vent_block_15.midpoint);
    mesh_vent_block_15.quaternion.copy(endpoint_vent_block_15.quaternion);
  }
  mesh_vent_block_15.castShadow = options.castShadow ?? true;
  mesh_vent_block_15.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_block_15.userData.sculptComponent = {"id": "vent-block", "name": "Intake vent", "level": "micro", "role": "vent", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A matte orange block seated in a recessed socket.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.02, 0.0], "embedDepth": 0.0044, "overlap": 0.001, "gapTolerance": 0.002, "confidence": 0.9}, "dimensions": {"width": 0.035, "height": 0.02, "depth": 0.07, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["vent-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vent-block", "description": "Two on the dorsal spine, one per side aft; shaded, not emissive.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "vent-orange", "colorMaterialRecipe": {"baseColor": "#EC761A", "dominantAlbedo": "rgba(236, 118, 26, 1.0)", "secondaryAlbedo": "rgba(245, 138, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "gradientStops": [{"position": 0.0, "color": "#EC761A"}, {"position": 0.5, "color": "#F58A2E"}, {"position": 1.0, "color": "#B85510"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_vent_block_15.add(mesh_vent_block_15);
  meshes["vent-block"] = mesh_vent_block_15;
  colliders["vent-block"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vent_block_15);

  const endpoint_decal_set_16 = makeAttachmentEndpoint(null);
  const node_decal_set_16 = new THREE.Group();
  node_decal_set_16.name = "Hull decals__pivot";
  node_decal_set_16.scale.set(1, 1, 1);
  if (endpoint_decal_set_16) {
    node_decal_set_16.position.copy(endpoint_decal_set_16.start);
    node_decal_set_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_decal_set_16.position.set(0.0, 0.0, 0.0);
    node_decal_set_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_decal_set_16.userData.sculptComponent = {"id": "decal-set", "name": "Hull decals", "level": "micro", "role": "marking", "importance": 0.6, "confidence": 0.8, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Flat marks on the hull surface, drawn to a canvas at build time.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 0.00015, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.1, "height": 0.001, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["decal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "decal-set", "description": "Arrow logo and \"07\" on the nose, \"EXIS\" and \"07\" on the mid-hull side.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "decal", "colorMaterialRecipe": {"baseColor": "#F2F5F8", "dominantAlbedo": "rgba(242, 245, 248, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#F2F5F8"}, {"position": 0.5, "color": "#FFFFFF"}, {"position": 1.0, "color": "#C9D2DA"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_decal_set_16.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}};
  (nodes["hull"] ?? root).add(node_decal_set_16);
  nodes["decal-set"] = node_decal_set_16;
  const mesh_decal_set_16Geometry = endpoint_decal_set_16
    ? new THREE.CylinderGeometry(endpoint_decal_set_16.endRadius, endpoint_decal_set_16.baseRadius, endpoint_decal_set_16.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_decal_set_16) {
    mesh_decal_set_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_decal_set_16 = new THREE.Mesh(
    mesh_decal_set_16Geometry,
    materialMap["hull"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_decal_set_16.name = "Hull decals";
  if (endpoint_decal_set_16) {
    mesh_decal_set_16.position.copy(endpoint_decal_set_16.midpoint);
    mesh_decal_set_16.quaternion.copy(endpoint_decal_set_16.quaternion);
  }
  mesh_decal_set_16.castShadow = options.castShadow ?? true;
  mesh_decal_set_16.receiveShadow = options.receiveShadow ?? true;
  mesh_decal_set_16.userData.sculptComponent = {"id": "decal-set", "name": "Hull decals", "level": "micro", "role": "marking", "importance": 0.6, "confidence": 0.8, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Flat marks on the hull surface, drawn to a canvas at build time.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hull", "attachment": {"parentId": "hull", "parentSocket": "hull-surface", "contactType": "overlap", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.001, 0.0], "embedDepth": 6e-05, "overlap": 0.00015, "gapTolerance": 0.002, "confidence": 0.8}, "dimensions": {"width": 0.1, "height": 0.001, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hull"}}, "material": "hull", "materialLayers": ["decal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "decal-set", "description": "Arrow logo and \"07\" on the nose, \"EXIS\" and \"07\" on the mid-hull side.", "evidenceRef": "crops/threequarter.png"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialId": "decal", "colorMaterialRecipe": {"baseColor": "#F2F5F8", "dominantAlbedo": "rgba(242, 245, 248, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "gradientStops": [{"position": 0.0, "color": "#F2F5F8"}, {"position": 0.5, "color": "#FFFFFF"}, {"position": 1.0, "color": "#C9D2DA"}], "finishStyle": "satin", "shadingModel": "faceted-pbr-with-flat-normals", "note": "Flat shading throughout: the value read comes from facet orientation."}};
  node_decal_set_16.add(mesh_decal_set_16);
  meshes["decal-set"] = mesh_decal_set_16;
  colliders["decal-set"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_decal_set_16);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"lights": [{"id": "key", "type": "directional", "intensity": 2.4, "color": "#FFFFFF", "position": [0.6, 0.85, 0.7], "castsShadow": true, "role": "Main studio key, high and to port, matching the reference highlight direction.", "toneMapping": "ACESFilmic", "exposure": 1.0}, {"id": "fill", "type": "directional", "intensity": 0.75, "color": "#AFC6E0", "position": [-0.8, 0.2, 0.4], "castsShadow": false, "role": "Cool fill from the shadow side so dark facets stay separable rather than crushing."}, {"id": "rim", "type": "directional", "intensity": 1.1, "color": "#9FD8FF", "position": [-0.3, 0.4, -1.0], "castsShadow": false, "role": "Back rim that catches the trailing edges and fin tips. A rim is correct HERE - this is a studio product render, not the painted diorama where a rim would have read as stylised edge lighting."}, {"id": "ambient", "type": "ambient", "intensity": 0.28, "color": "#C8D6E8", "position": [0, 0, 0], "castsShadow": false, "role": "Low ambient floor. Kept low deliberately: facet separation depends on contrast."}, {"id": "shadow-policy", "type": "shadow-policy", "intensity": 0.0, "color": "#000000", "position": [0, 0, 0], "castsShadow": true, "role": "Contact shadow and ground shadow on, with ambient occlusion in the nozzle recesses and the channel grooves. Without occlusion in those recesses the nozzles read as flat discs rather than sockets, and the emissive channels lose their inset depth."}], "environment": {"type": "studio-neutral", "top": "#F4F7FA", "bottom": "#DCE3EA", "intensity": 0.5}, "toneMapping": "ACESFilmic", "exposure": 1.0, "shadowBehavior": {"contactShadow": true, "groundShadow": true, "type": "PCFSoft", "mapSize": 2048, "bias": -0.0004, "radius": 2.0, "note": "Ambient occlusion in nozzle recesses and light channels is what sells them as cut into the hull rather than painted on it."}, "bloom": {"enabled": true, "strength": 0.55, "radius": 0.4, "threshold": 0.85, "note": "The reference has a visible halo around every emissive run; without bloom the strips read as flat cyan paint."}, "forbidden": ["toon gradient map", "posterisation", "smooth vertex normals on hull materials"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createEXIS07StrikeCraftLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "EXIS 07 Strike Craft look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "intensity": 2.4, "color": "#FFFFFF", "position": [0.6, 0.85, 0.7], "castsShadow": true, "role": "Main studio key, high and to port, matching the reference highlight direction.", "toneMapping": "ACESFilmic", "exposure": 1.0}, {"id": "fill", "type": "directional", "intensity": 0.75, "color": "#AFC6E0", "position": [-0.8, 0.2, 0.4], "castsShadow": false, "role": "Cool fill from the shadow side so dark facets stay separable rather than crushing."}, {"id": "rim", "type": "directional", "intensity": 1.1, "color": "#9FD8FF", "position": [-0.3, 0.4, -1.0], "castsShadow": false, "role": "Back rim that catches the trailing edges and fin tips. A rim is correct HERE - this is a studio product render, not the painted diorama where a rim would have read as stylised edge lighting."}, {"id": "ambient", "type": "ambient", "intensity": 0.28, "color": "#C8D6E8", "position": [0, 0, 0], "castsShadow": false, "role": "Low ambient floor. Kept low deliberately: facet separation depends on contrast."}, {"id": "shadow-policy", "type": "shadow-policy", "intensity": 0.0, "color": "#000000", "position": [0, 0, 0], "castsShadow": true, "role": "Contact shadow and ground shadow on, with ambient occlusion in the nozzle recesses and the channel grooves. Without occlusion in those recesses the nozzles read as flat discs rather than sockets, and the emissive channels lose their inset depth."}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"lights": [{"id": "key", "type": "directional", "intensity": 2.4, "color": "#FFFFFF", "position": [0.6, 0.85, 0.7], "castsShadow": true, "role": "Main studio key, high and to port, matching the reference highlight direction.", "toneMapping": "ACESFilmic", "exposure": 1.0}, {"id": "fill", "type": "directional", "intensity": 0.75, "color": "#AFC6E0", "position": [-0.8, 0.2, 0.4], "castsShadow": false, "role": "Cool fill from the shadow side so dark facets stay separable rather than crushing."}, {"id": "rim", "type": "directional", "intensity": 1.1, "color": "#9FD8FF", "position": [-0.3, 0.4, -1.0], "castsShadow": false, "role": "Back rim that catches the trailing edges and fin tips. A rim is correct HERE - this is a studio product render, not the painted diorama where a rim would have read as stylised edge lighting."}, {"id": "ambient", "type": "ambient", "intensity": 0.28, "color": "#C8D6E8", "position": [0, 0, 0], "castsShadow": false, "role": "Low ambient floor. Kept low deliberately: facet separation depends on contrast."}, {"id": "shadow-policy", "type": "shadow-policy", "intensity": 0.0, "color": "#000000", "position": [0, 0, 0], "castsShadow": true, "role": "Contact shadow and ground shadow on, with ambient occlusion in the nozzle recesses and the channel grooves. Without occlusion in those recesses the nozzles read as flat discs rather than sockets, and the emissive channels lose their inset depth."}], "environment": {"type": "studio-neutral", "top": "#F4F7FA", "bottom": "#DCE3EA", "intensity": 0.5}, "toneMapping": "ACESFilmic", "exposure": 1.0, "shadowBehavior": {"contactShadow": true, "groundShadow": true, "type": "PCFSoft", "mapSize": 2048, "bias": -0.0004, "radius": 2.0, "note": "Ambient occlusion in nozzle recesses and light channels is what sells them as cut into the hull rather than painted on it."}, "bloom": {"enabled": true, "strength": 0.55, "radius": 0.4, "threshold": 0.85, "note": "The reference has a visible halo around every emissive run; without bloom the strips read as flat cyan paint."}, "forbidden": ["toon gradient map", "posterisation", "smooth vertex normals on hull materials"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createEXIS07StrikeCraftEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameEXIS07StrikeCraftCamera(
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
export function createEXIS07StrikeCraftPresentationComposer(
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

export function configureEXIS07StrikeCraftRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createEXIS07StrikeCraftInspectControls(
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
