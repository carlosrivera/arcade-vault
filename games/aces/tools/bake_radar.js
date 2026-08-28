// bake_radar.js — precompute the HUD terrain-radar chart from heightAt().
//
// The height field is deterministic, so the whole chart is baked once at build
// time instead of being sampled every frame in the browser. Output:
//   assets/radar_chart.png   phosphor-green elevation chart w/ hillshade
//   src/radarChartMeta.js    world-space placement of that PNG
//
// Usage: node tools/bake_radar.js [centerX] [centerZ]
// Defaults to the spawn basin. Re-run whenever WORLD_OFFSET / HSCALE changes.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { heightAt } from '../src/terrain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- chart config
const CENTER_X = parseFloat(process.argv[2] ?? '48000');
const CENTER_Z = parseFloat(process.argv[3] ?? '-28000');
const SIZE = 2048;          // pixels per side
const MPP = 100;            // metres per pixel -> 205 km of coverage; the HUD
                            // radar shows a 24 km window, so this keeps the
                            // circle at ~240 source pixels (no visible blur)

// Sampling uses the same band-limit the radar's effective resolution implies,
// so the bake only pays for octaves a 250 m grid can carry.
const CELL = MPP;

// ---------------------------------------------------------------- sample grid
console.log(`sampling ${SIZE}x${SIZE} at ${MPP} m/px around (${CENTER_X}, ${CENTER_Z})...`);
const h = new Float32Array(SIZE * SIZE);
let min = Infinity, max = -Infinity;
const x0 = CENTER_X - (SIZE / 2) * MPP;
const z0 = CENTER_Z - (SIZE / 2) * MPP;
for (let py = 0; py < SIZE; py++) {
  if ((py & 255) === 0) console.log(`  row ${py}/${SIZE}`);
  for (let px = 0; px < SIZE; px++) {
    const v = heightAt(x0 + px * MPP, z0 + py * MPP, CELL);
    h[py * SIZE + px] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
}
console.log(`height range ${min.toFixed(0)} .. ${max.toFixed(0)} m`);

// ---------------------------------------------------------------- palette
// HUD is green phosphor, so the chart is too: elevation -> brightness ramp,
// hillshade from grid gradients, darker contour lines every 250 m, coastline
// traced bright. Ocean is one flat fill so it reads instantly from altitude.
const OCEAN = [6, 22, 13];
const rgb = new Uint8Array(SIZE * SIZE * 3);
const CONTOUR = 250;
const LX = 0.6, LZ = 0.8;   // hillshade light direction (matches world sun bias)

const band = (v) => Math.max(0, Math.floor(v / CONTOUR));
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    const i = py * SIZE + px;
    const v = h[i];
    const o = i * 3;
    if (v <= 0) {
      rgb[o] = OCEAN[0]; rgb[o + 1] = OCEAN[1]; rgb[o + 2] = OCEAN[2];
      // coastline: land pixel adjacent to sea gets a bright rim
      const nb = py > 0 ? h[i - SIZE] : v, nbx = px > 0 ? h[i - 1] : v;
      if (nb > 0 || nbx > 0) { rgb[o] = 60; rgb[o + 1] = 190; rgb[o + 2] = 110; }
      continue;
    }
    const t = Math.min(1, v / 3200);
    let b = 46 + 185 * Math.pow(t, 0.7);

    // hillshade from central differences on the baked grid
    const gx = h[i + (px < SIZE - 1 ? 1 : 0)] - h[i - (px > 0 ? 1 : 0)];
    const gz = h[i + (py < SIZE - 1 ? SIZE : 0)] - h[i - (py > 0 ? SIZE : 0)];
    const mag = Math.hypot(gx, gz) + 1e-6;
    const lit = (gx * LX + gz * LZ) / mag;   // -1 .. 1
    b *= 0.78 + 0.35 * lit;

    // contour lines: band index differs from a neighbour -> darken
    const isContour =
      (px < SIZE - 1 && band(h[i + 1]) !== band(v)) ||
      (py < SIZE - 1 && band(h[i + SIZE]) !== band(v));

    if (isContour) b *= 0.45;
    rgb[o] = b * 0.30;
    rgb[o + 1] = b;
    rgb[o + 2] = b * 0.48;
  }
}

// ---------------------------------------------------------------- PNG encode
// Minimal PNG writer: 8-bit RGB, no filtering, zlib IDAT. No deps needed.
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function writePNG(file, w, hpx, rgbData) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hpx, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolor
  const raw = Buffer.alloc(hpx * (1 + w * 3));
  for (let y = 0; y < hpx; y++) {
    raw[y * (1 + w * 3)] = 0;  // filter: none
    Buffer.from(rgbData.buffer, y * w * 3, w * 3).copy(raw, y * (1 + w * 3) + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${(png.length / 1024).toFixed(0)} KB)`);
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
writePNG(path.join(assetsDir, 'radar_chart.png'), SIZE, SIZE, rgb);

// ---------------------------------------------------------------- meta module
const metaSrc = `// GENERATED by tools/bake_radar.js — do not edit by hand.
// World-space placement of assets/radar_chart.png for the HUD terrain radar.
export const RADAR_CHART = {
  file: 'assets/radar_chart.png',
  centerX: ${CENTER_X},
  centerZ: ${CENTER_Z},
  mpp: ${MPP},
  size: ${SIZE},
};
`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'radarChartMeta.js'), metaSrc);
console.log('wrote src/radarChartMeta.js');
