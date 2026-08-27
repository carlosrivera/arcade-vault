/**
 * DUNESWEEPER - Excavation FX & Particle Systems
 * Physical sand cube scatter, dust bursts, floating glyphs, and camera shake
 */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { BOX_GEOMETRY } from './voxel_primitives.js';

export class ExcavationFX {
  constructor(scene, rendererRef) {
    this.scene = scene;
    this.rendererRef = rendererRef;

    this.particles = [];
    this.maxParticles = 600;

    // Shared InstancedMesh for micro-sand cubes
    this.particleMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0.05,
      flatShading: true,
    });

    this.instancedMesh = new THREE.InstancedMesh(
      BOX_GEOMETRY,
      this.particleMaterial,
      this.maxParticles,
    );
    this.instancedMesh.castShadow = false;
    this.instancedMesh.receiveShadow = false;
    this.scene.add(this.instancedMesh);

    this.dummy = new THREE.Object3D();
    this.tempColor = new THREE.Color();

    // Screen shake state
    this.shakeIntensity = 0;
    this.shakeDecay = 0.9;
  }

  /**
   * Spawn a burst of scattering sand voxel cubes when a cell is excavated
   */
  burstCellSand(worldX, worldZ, isTrap = false) {
    const count = isTrap ? 32 : 18;
    const vSize = CONFIG.VOXEL_SIZE * 0.45;
    const palettes = CONFIG.PALETTES.sand;

    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) {
        this.particles.shift(); // Recycle oldest
      }

      // Outward spherical explosion velocity with upward bias
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 2.2;
      const vx = Math.cos(angle) * speed * (0.4 + Math.random() * 0.6);
      const vz = Math.sin(angle) * speed * (0.4 + Math.random() * 0.6);
      const vy = 1.6 + Math.random() * 2.8;

      const spawnBaseY = CONFIG.SAND_LAYERS * CONFIG.VOXEL_SIZE;
      const colHex =
        isTrap && Math.random() < 0.4
          ? 0xef4444 // Red spark if trap
          : palettes[Math.floor(Math.random() * palettes.length)];

      this.particles.push({
        x: worldX + (Math.random() - 0.5) * CONFIG.CELL_SIZE * 0.8,
        y: spawnBaseY * (0.5 + Math.random() * 0.6),
        z: worldZ + (Math.random() - 0.5) * CONFIG.CELL_SIZE * 0.8,
        vx,
        vy,
        vz,
        rotX: Math.random() * Math.PI,
        rotY: Math.random() * Math.PI,
        rotZ: Math.random() * Math.PI,
        vRotX: (Math.random() - 0.5) * 8,
        vRotY: (Math.random() - 0.5) * 8,
        vRotZ: (Math.random() - 0.5) * 8,
        scale: vSize * (0.7 + Math.random() * 0.6),
        color: colHex,
        life: 1.0,
        decay: 0.8 + Math.random() * 0.6, // seconds
      });
    }
  }

  /**
   * Spawn victory celebration golden confetti
   */
  burstVictory() {
    const count = 120;
    const goldPalette = [0xf5b700, 0xffe169, 0x10b981, 0x38bdf8, 0xec4899];

    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) {
        this.particles.shift();
      }

      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 3.5;
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      const vy = 3.5 + Math.random() * 4.0;

      this.particles.push({
        x: (Math.random() - 0.5) * 6,
        y: 1.0,
        z: (Math.random() - 0.5) * 6,
        vx,
        vy,
        vz,
        rotX: Math.random() * Math.PI,
        rotY: Math.random() * Math.PI,
        rotZ: Math.random() * Math.PI,
        vRotX: (Math.random() - 0.5) * 10,
        vRotY: (Math.random() - 0.5) * 10,
        vRotZ: (Math.random() - 0.5) * 10,
        scale: CONFIG.VOXEL_SIZE * 0.6,
        color: goldPalette[Math.floor(Math.random() * goldPalette.length)],
        life: 1.0,
        decay: 0.35, // longer celebration
      });
    }
  }

  triggerScreenShake(intensity = 0.35) {
    this.shakeIntensity = intensity;
  }

  update(dt) {
    // Screen shake update
    if (this.shakeIntensity > 0.005) {
      const sx = (Math.random() - 0.5) * this.shakeIntensity;
      const sz = (Math.random() - 0.5) * this.shakeIntensity;
      if (this.rendererRef?.dioramaGroup) {
        this.rendererRef.dioramaGroup.position.set(sx, 0, sz);
      }
      this.shakeIntensity *= this.shakeDecay;
    } else if (this.rendererRef?.dioramaGroup) {
      this.rendererRef.dioramaGroup.position.set(0, 0, 0);
      this.shakeIntensity = 0;
    }

    // Update sand particles
    const gravity = -9.8;
    const floorLevel = 0.02;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= p.decay * dt;

      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      p.vy += gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // Bounce on floor
      if (p.y <= floorLevel) {
        p.y = floorLevel;
        p.vy = -p.vy * 0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }

      p.rotX += p.vRotX * dt;
      p.rotY += p.vRotY * dt;
      p.rotZ += p.vRotZ * dt;
    }

    // Sync to instanced mesh
    const activeCount = this.particles.length;
    for (let i = 0; i < this.maxParticles; i++) {
      if (i < activeCount) {
        const p = this.particles[i];
        const currentScale = p.scale * Math.min(1, p.life * 2);

        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.rotation.set(p.rotX, p.rotY, p.rotZ);
        this.dummy.scale.set(currentScale, currentScale, currentScale);
        this.dummy.updateMatrix();

        this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
        this.tempColor.setHex(p.color);
        this.instancedMesh.setColorAt(i, this.tempColor);
      } else {
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
      }
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
  }

  destroy() {
    this.scene.remove(this.instancedMesh);
    this.particleMaterial.dispose();
  }
}
