// voxel.js — instanced cube rendering for blocky, Minecraft-styled worlds.
//
// A voxel scene is thousands of identical cubes, so the whole trick is drawing
// them in one InstancedMesh: one geometry, one material, one draw call, with
// per-cube position, scale, rotation and colour packed into instance
// attributes. Building them as separate Meshes is what makes voxel scenes
// crawl.

import * as THREE from 'three';
import { PRNG } from '#engine/rng.js';

export const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/**
 * Blocky Minecraft-style face texture: only 8x8 BIG texels, quantized to
 * four flat tone steps plus a darkened border ring — reads as chunky pixel
 * blocks instead of realistic grain, and multiplies with instance colors.
 */
let _grainTexture = null;
export function getGrainTexture() {
  if (_grainTexture) return _grainTexture;

  const size = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = new PRNG('voxel_grain8');

  // Four flat tone steps — hard pixel steps are what sell the MC look.
  // Kept gentle: soft block texture, not high-contrast noise.
  const TONES = [1.0, 0.96, 0.92, 0.86];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const roll = rng.next();
      const tone =
        roll > 0.86 ? TONES[3] : roll > 0.62 ? TONES[2] : roll > 0.3 ? TONES[1] : TONES[0];
      const c = Math.round(tone * 255);
      ctx.fillStyle = `rgb(${c},${c},${c})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // Faint border ring so every cube reads as one unit block
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  ctx.fillRect(0, 0, size, 1);
  ctx.fillRect(0, size - 1, size, 1);
  ctx.fillRect(0, 0, 1, size);
  ctx.fillRect(size - 1, 0, 1, size);
  // Corner pixels slightly darker still (fake per-block AO)
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillRect(size - 1, 0, 1, 1);
  ctx.fillRect(0, size - 1, 1, 1);
  ctx.fillRect(size - 1, size - 1, 1, 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _grainTexture = tex;
  return tex;
}

export const VOXEL_MATERIAL = new THREE.MeshStandardMaterial({
  roughness: 0.85,
  metalness: 0.05,
  flatShading: true,
});

// Textured variant for ENVIRONMENT props (walls, portal, torches, ground).
// Playable board cells stay untextured — they get life from per-subbox
// color variation instead.
let _blockMaterial = null;
export function getBlockMaterial() {
  if (!_blockMaterial) {
    _blockMaterial = VOXEL_MATERIAL.clone();
    _blockMaterial.map = getGrainTexture();
    _blockMaterial.needsUpdate = true;
  }
  return _blockMaterial;
}

/**
 * Builds an optimized Three.js Mesh from a list of voxels: [{ x, y, z, color, scale }]
 */
export function buildVoxelMesh(voxels, voxelSize = 1, material = VOXEL_MATERIAL) {
  if (!voxels || voxels.length === 0) return new THREE.Group();

  const count = voxels.length;
  const instancedMesh = new THREE.InstancedMesh(BOX_GEOMETRY, material, count);
  instancedMesh.castShadow = true;
  instancedMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const v = voxels[i];
    // Per-axis overrides (sx/sy/sz) let glyphs fuse into solid strokes
    dummy.position.set(v.x * voxelSize, v.y * voxelSize, v.z * voxelSize);
    dummy.scale.set(
      (v.sx ?? v.scale ?? 1) * voxelSize,
      (v.sy ?? v.scale ?? 1) * voxelSize,
      (v.sz ?? v.scale ?? 1) * voxelSize,
    );
    dummy.rotation.set(v.rx || 0, v.ry || 0, v.rz || 0);
    dummy.updateMatrix();

    instancedMesh.setMatrixAt(i, dummy.matrix);
    color.setHex(typeof v.color === 'number' ? v.color : 0xdfb470);
    instancedMesh.setColorAt(i, color);
  }

  instancedMesh.instanceMatrix.needsUpdate = true;
  if (instancedMesh.instanceColor) {
    instancedMesh.instanceColor.needsUpdate = true;
  }

  return instancedMesh;
}
