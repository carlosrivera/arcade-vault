import fs from 'fs';
import { heightAt } from './games/aces/src/terrain.js';

const width = 1024;
const height = 1024;
const scale = 50; 
const offsetX = parseFloat(process.argv[2]) || 0;
const offsetZ = parseFloat(process.argv[3]) || 0;
const outName = process.argv[4] || 'heightmap.pgm';

let min = Infinity;
let max = -Infinity;
const heights = new Float32Array(width * height);

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const worldX = offsetX + (x - width/2) * scale;
    const worldZ = offsetZ + (y - height/2) * scale;
    const h = heightAt(worldX, worldZ);
    heights[y * width + x] = h;
    if (h < min) min = h;
    if (h > max) max = h;
  }
}

const header = Buffer.from(`P5\n${width} ${height}\n255\n`);
const pixels = new Uint8Array(width * height);
for (let i = 0; i < pixels.length; i++) {
  const normalized = Math.max(0, Math.min(1, (heights[i] - min) / (max - min)));
  pixels[i] = Math.floor(normalized * 255);
}

const out = Buffer.concat([header, pixels]);
fs.writeFileSync(outName, out);
console.log(`Generated ${outName} at (${offsetX}, ${offsetZ}) - Min: ${min}, Max: ${max}`);
