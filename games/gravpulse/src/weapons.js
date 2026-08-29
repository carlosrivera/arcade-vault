import * as THREE from 'three';
import { shipEvents, sparkBurst } from './ships.js';
import { WEAPON_PAD_FRACTIONS } from './track.js';

// Combat layer: weapon pads grant rockets / mines / shields. Rockets home on
// the nearest ship ahead, mines drop behind and arm, shields eat one hit.

const PICKUP_S = 6;
const PICKUP_LAT = 4.5;
const PAD_COOLDOWN = 6;
const PLAYER_FIRE_CD = 0.8;
const AI_FIRE_CD = 3.5;
const SHIELD_TIME = 10;

const WEAPON_PAD_LATS = [-3, 3, -2, 3, -3, 2];

function wrapDs(d, L) {
  if (d > L / 2) d -= L;
  else if (d < -L / 2) d += L;
  return d;
}

function weaponPadTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8,16,10,0.92)';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#59ff7a';
  g.lineWidth = 8;
  g.shadowColor = '#59ff7a';
  g.shadowBlur = 12;
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const x = 64 + Math.cos(a) * 38,
      y = 64 + Math.sin(a) * 38;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
  g.stroke();
  g.fillStyle = '#d2ffe0';
  g.beginPath();
  g.arc(64, 64, 9, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function createPrerenderedLightningTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, 512, 512);

  function drawBranch(x1, y1, x2, y2, displace, depth) {
    if (depth <= 0 || displace < 2) {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      return;
    }
    const midX = (x1 + x2) / 2 + (Math.random() - 0.5) * displace;
    const midY = (y1 + y2) / 2 + (Math.random() - 0.5) * displace;
    drawBranch(x1, y1, midX, midY, displace * 0.55, depth - 1);
    drawBranch(midX, midY, x2, y2, displace * 0.55, depth - 1);

    if (Math.random() < 0.2) {
      const bx = midX + (Math.random() - 0.5) * displace * 2.0;
      const by = midY + (Math.random() - 0.5) * displace * 2.0;
      drawBranch(midX, midY, bx, by, displace * 0.45, depth - 2);
    }
  }

  // Draw 3 distinct, bold, high-voltage lightning strikes (clean & punchy)
  for (let i = 0; i < 3; i++) {
    const sx = Math.random() * 512;
    const sy = Math.random() * 512;
    const ex = (sx + (Math.random() - 0.5) * 450 + 512) % 512;
    const ey = (sy + (Math.random() - 0.5) * 450 + 512) % 512;

    // Outer cyan plasma glow
    g.strokeStyle = '#00f0ff';
    g.lineWidth = 4.5;
    g.shadowColor = '#00e5ff';
    g.shadowBlur = 8;
    drawBranch(sx, sy, ex, ey, 75, 5);

    // Mid violet discharge arc
    g.strokeStyle = '#d54aff';
    g.lineWidth = 2.0;
    g.shadowColor = '#e040fb';
    g.shadowBlur = 4;
    drawBranch(sx, sy, ex, ey, 75, 5);

    // Fine white-hot plasma core
    g.strokeStyle = '#ffffff';
    g.lineWidth = 0.9;
    g.shadowColor = '#ffffff';
    g.shadowBlur = 2;
    drawBranch(sx, sy, ex, ey, 75, 5);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function createShockwaveRingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);

  const grad = g.createRadialGradient(128, 128, 60, 128, 128, 124);
  grad.addColorStop(0, 'rgba(0, 240, 255, 0)');
  grad.addColorStop(0.35, 'rgba(0, 240, 255, 0.45)');
  grad.addColorStop(0.68, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.85, 'rgba(215, 60, 255, 0.9)');
  grad.addColorStop(1, 'rgba(0, 240, 255, 0)');

  g.fillStyle = grad;
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.arc(128, 128, 50, 0, Math.PI * 2, true);
  g.fill();

  return new THREE.CanvasTexture(c);
}

let cachedLightningTex = null;
let cachedShockwaveTex = null;

function createLightningShieldMaterial() {
  if (!cachedLightningTex) cachedLightningTex = createPrerenderedLightningTexture();

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      tLightning: { value: cachedLightningTex },
      uColorCore: { value: new THREE.Color('#ffffff') },
      uColorArcA: { value: new THREE.Color('#00f0ff') },
      uColorArcB: { value: new THREE.Color('#d04aff') },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPos;
      varying vec3 vViewDir;
      varying vec2 vUv;
      uniform float uTime;

      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vPos = position;

        // Propagating spherical shockwave pulse displacement
        float shockWave = sin(position.z * 5.5 - uTime * 14.0) * 0.08;
        float jitter = sin(position.x * 28.0 + uTime * 45.0) * cos(position.y * 28.0 + uTime * 50.0) * 0.04;
        vec3 displaced = position + normal * (shockWave + jitter);

        vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vPos;
      varying vec3 vViewDir;
      varying vec2 vUv;
      uniform float uTime;
      uniform sampler2D tLightning;
      uniform vec3 uColorCore;
      uniform vec3 uColorArcA;
      uniform vec3 uColorArcB;

      void main() {
        // Broad scrolling lightning rays (few, distinct, cinematic arcs)
        vec2 uv1 = vUv * 1.0 + vec2(uTime * 0.26, uTime * 0.14);
        vec2 uv2 = vUv * 1.25 + vec2(-uTime * 0.30, uTime * 0.20);
        
        vec4 lightMap1 = texture2D(tLightning, uv1);
        vec4 lightMap2 = texture2D(tLightning, uv2);
        vec3 lightningMix = lightMap1.rgb + lightMap2.rgb * 0.7;

        // High-frequency propagating shockwave ring pulse
        float shockPulse = pow(sin(vPos.z * 4.5 - uTime * 12.0) * 0.5 + 0.5, 4.0) * 1.0;

        // Fresnel edge glow
        float fresnel = pow(1.0 - max(0.0, dot(vNormal, vViewDir)), 2.4);

        // Electric color composite (kept under bloom threshold — no supernova)
        vec3 col = lightningMix * 1.2;
        col += uColorArcA * (fresnel * 0.9 + shockPulse * 0.45);
        col += uColorArcB * (fresnel * 0.45 + shockPulse * 0.25);
        col += uColorCore * (shockPulse * 0.35 + lightMap1.r * 1.1);

        float alpha = clamp(lightningMix.r * 1.4 + fresnel * 1.0 + shockPulse * 0.7, 0.0, 1.0);

        gl_FragColor = vec4(col * 0.8, alpha * 0.8);
      }
    `,
  });
}

export class WeaponSystem {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.now = 0;
    this.rockets = [];
    this.mines = [];
    this.flashes = [];

    // pickup pads
    const tex = weaponPadTexture();
    const glow = glowTexture();
    const geom = new THREE.PlaneGeometry(4.2, 4.2);
    const haloGeom = new THREE.PlaneGeometry(9, 13);
    const fractions = track.weaponFractions || WEAPON_PAD_FRACTIONS;
    this.pads = fractions.map((f, i) => {
      const s = f * track.length;
      const lat = WEAPON_PAD_LATS[i % WEAPON_PAD_LATS.length];
      const fr = track.frameAt(s, {
        pos: new THREE.Vector3(),
        tan: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        bank: 0,
      });
      const q = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(fr.right, fr.tan, fr.up),
      );
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      mesh.quaternion.copy(q);
      mesh.position.copy(fr.pos).addScaledVector(fr.right, lat).addScaledVector(fr.up, 0.14);
      scene.add(mesh);
      const halo = new THREE.Mesh(
        haloGeom,
        new THREE.MeshBasicMaterial({
          map: glow,
          color: '#59ff7a',
          transparent: true,
          opacity: 0.3,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      halo.quaternion.copy(q);
      halo.position.copy(fr.pos).addScaledVector(fr.right, lat).addScaledVector(fr.up, 0.07);
      scene.add(halo);
      return { s, lat, mesh, halo, phase: Math.random() * 6.28 };
    });

    // shared rocket/mine resources
    this.rocketGeo = new THREE.ConeGeometry(0.35, 1.7, 6);
    this.rocketGeo.rotateX(Math.PI / 2); // point +Z
    this.rocketMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.2, 0.25) });
    this.flameGeo = new THREE.ConeGeometry(0.3, 1.5, 6);
    this.flameGeo.rotateX(-Math.PI / 2); // tip -Z
    this.flameMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.6, 0.7, 0.2),
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mineGeo = new THREE.OctahedronGeometry(0.62);
    this.mineMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.0, 0.5, 0.2),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.flashGeo = new THREE.SphereGeometry(1, 12, 8);
    this.flashMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.0, 0.9, 0.35),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.shieldGeo = new THREE.SphereGeometry(2.5, 20, 14);
    this._frames = new Map(); // per-ship scratch frame
  }

  _frame(r) {
    let f = this._frames.get(r);
    if (!f) {
      f = {
        pos: new THREE.Vector3(),
        tan: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        bank: 0,
      };
      this._frames.set(r, f);
    }
    return f;
  }

  _orient(mesh, fr) {
    const x = new THREE.Vector3().copy(fr.up).cross(fr.tan).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, fr.up, fr.tan));
  }

  grant(r) {
    const roll = Math.random();
    if (roll < 0.4) {
      r.weapon = 'rocket';
    } else if (roll < 0.7) {
      r.weapon = 'mine';
    } else {
      r.weapon = null;
      r.shieldTime = SHIELD_TIME;
      this._shieldMesh(r).visible = true;
      shipEventsSafe('weaponPickup', r, 'shield');
      return;
    }
    shipEventsSafe('weaponPickup', r, r.weapon);
  }

  _shieldMesh(r) {
    if (!r._shieldMesh) {
      const shieldGroup = new THREE.Group();
      shieldGroup.visible = false;

      // Single Clean High-Voltage Lightning & Shockwave Energy Bubble
      const mat = createLightningShieldMaterial();
      const geo = new THREE.SphereGeometry(2.5, 32, 24);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(1.24, 0.88, 1.64);
      mesh.position.set(0, 0.12, 0);
      shieldGroup.add(mesh);

      // Equatorial Expanding Plasma Shockwave Pulse Disc
      if (!cachedShockwaveTex) cachedShockwaveTex = createShockwaveRingTexture();
      const ringGeo = new THREE.PlaneGeometry(6.8, 6.8);
      const ringMat = new THREE.MeshBasicMaterial({
        map: cachedShockwaveTex,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const waveRing = new THREE.Mesh(ringGeo, ringMat);
      waveRing.rotation.x = -Math.PI / 2;
      waveRing.position.set(0, 0.12, 0);
      shieldGroup.add(waveRing);

      r.mesh.add(shieldGroup);
      r._shieldMesh = shieldGroup;
      r._shieldMat = mat;
      r._shieldSphere = mesh;
      r._shieldWaveRing = waveRing;
    }
    return r._shieldMesh;
  }

  // returns true if something was used
  fire(r, racers, cd = PLAYER_FIRE_CD) {
    if (!r.weapon || r.fireCd > 0) return false;
    const kind = r.weapon;
    r.fireCd = cd;

    if (kind === 'rocket') {
      const target = this._nearestAhead(r, racers, 400);
      const grp = new THREE.Group();
      grp.add(new THREE.Mesh(this.rocketGeo, this.rocketMat));
      const flame = new THREE.Mesh(this.flameGeo, this.flameMat);
      flame.position.z = -1.5;
      grp.add(flame);
      this.scene.add(grp);
      this.rockets.push({
        s: r.s + 3,
        lat: r.lat,
        speed: Math.max(r.speed + 80, 260),
        target,
        owner: r,
        mesh: grp,
        life: 6,
      });
    } else if (kind === 'mine') {
      const mesh = new THREE.Mesh(this.mineGeo, this.mineMat);
      const fr = this.track.frameAt(
        (r.s - 5 + this.track.length) % this.track.length,
        this._frame(r),
      );
      this._orient(mesh, fr);
      mesh.position.copy(fr.pos).addScaledVector(fr.right, r.lat).addScaledVector(fr.up, 0.55);
      this.scene.add(mesh);
      this.mines.push({
        s: (r.s - 5 + this.track.length) % this.track.length,
        lat: r.lat,
        mesh,
        owner: r,
        armAt: this.now + 1.0,
        until: this.now + 25,
      });
    } else {
      return false;
    }
    r.weapon = null;
    shipEventsSafe('weaponFire', r, kind);
    return true;
  }

  _nearestAhead(r, racers, maxGap) {
    let best = null,
      bestGap = maxGap;
    for (const o of racers) {
      if (o === r) continue;
      const gap = o.covered - r.covered;
      if (gap > 5 && gap < bestGap) {
        best = o;
        bestGap = gap;
      }
    }
    return best;
  }

  _aiUse(r, racers) {
    if (r.weapon === 'rocket') {
      if (this._nearestAhead(r, racers, 350)) this.fire(r, racers, AI_FIRE_CD);
    } else if (r.weapon === 'mine') {
      const prey = racers.some(
        (o) => o !== r && r.covered - o.covered > 40 && r.covered - o.covered < 220,
      );
      if (prey) this.fire(r, racers, AI_FIRE_CD);
    }
  }

  _explode(pos) {
    const mesh = new THREE.Mesh(this.flashGeo, this.flashMat.clone());
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.flashes.push({ mesh, t: 0.35, big: 1 });
    sparkBurst(pos, 12, '#ffb066'); // debris spray
  }

  // small white impact spark (ship bumps)
  spark(pos, scale = 1) {
    const mesh = new THREE.Mesh(this.flashGeo, this.flashMat.clone());
    mesh.material.color.setRGB(1.7, 1.7, 1.8);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.flashes.push({ mesh, t: 0.18, big: scale });
  }

  _applyRocketHit(r) {
    if (r.shieldTime > 0) {
      r.shieldTime = 0;
      shipEventsSafe('shieldPing', r);
      return;
    }
    r.speed *= 0.5;
    r.latVel += (Math.random() < 0.5 ? -1 : 1) * 9;
    r.obstCd = Math.max(r.obstCd, 0.8); // camera jolt + brief invulnerability
    shipEventsSafe('explosion', r);
  }

  clear() {
    for (const rk of this.rockets) this.scene.remove(rk.mesh);
    for (const mn of this.mines) this.scene.remove(mn.mesh);
    for (const f of this.flashes) this.scene.remove(f.mesh);
    this.rockets.length = 0;
    this.mines.length = 0;
    this.flashes.length = 0;
  }

  dispose() {
    this.clear();
    for (const p of this.pads) {
      if (p.mesh) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
      }
      if (p.halo) {
        this.scene.remove(p.halo);
        p.halo.geometry.dispose();
        p.halo.material.dispose();
      }
    }
    this.pads.length = 0;
  }

  update(dt, racers, racing) {
    this.now += dt;
    const trk = this.track;

    for (const p of this.pads) {
      p.mesh.material.opacity = racing ? 0.7 + 0.3 * Math.sin(this.now * 6 + p.phase) : 0.45;
      p.halo.material.opacity = racing ? 0.3 + 0.15 * Math.sin(this.now * 6 + p.phase) : 0.15;
    }

    if (racing) {
      for (const r of racers) {
        r.weaponPadCd = Math.max(0, r.weaponPadCd - dt);
        r.fireCd = Math.max(0, r.fireCd - dt);
        r.shieldTime = Math.max(0, r.shieldTime - dt);
        const sm = this._shieldMesh(r);
        sm.visible = r.shieldTime > 0;
        if (r.shieldTime > 0) {
          if (r._shieldMat) r._shieldMat.uniforms.uTime.value += dt;
          if (r._shieldSphere) {
            r._shieldSphere.rotation.y += dt * 0.75;
            r._shieldSphere.rotation.z += dt * 0.35;
          }
          if (r._shieldWaveRing) {
            const wavePhase = (this.now * 3.6) % 1.0;
            const waveScale = 1.0 + wavePhase * 1.8;
            r._shieldWaveRing.scale.set(waveScale, waveScale, 1.0);
            r._shieldWaveRing.material.opacity = (1.0 - wavePhase) * 0.9;
          }
        }

        if (!r.finished && r.weaponPadCd <= 0 && !r.weapon) {
          for (const p of this.pads) {
            if (
              Math.abs(wrapDs(r.s - p.s, trk.length)) < PICKUP_S &&
              Math.abs(r.lat - p.lat) < PICKUP_LAT
            ) {
              r.weaponPadCd = PAD_COOLDOWN;
              this.grant(r);
              break;
            }
          }
        }
        if (!r.isPlayer && r.weapon && r.fireCd <= 0) this._aiUse(r, racers);
      }
    }

    // rockets
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rk = this.rockets[i];
      rk.life -= dt;
      if (rk.life <= 0) {
        this.scene.remove(rk.mesh);
        this.rockets.splice(i, 1);
        continue;
      }
      rk.speed = Math.min(520, rk.speed + 60 * dt);
      rk.s += rk.speed * dt;
      if (rk.target) rk.lat += THREE.MathUtils.clamp(rk.target.lat - rk.lat, -3.2 * dt, 3.2 * dt);
      let hit = null;
      for (const r of racers) {
        if (r === rk.owner) continue;
        if (Math.abs(wrapDs(r.s - rk.s, trk.length)) < 3.5 && Math.abs(r.lat - rk.lat) < 2.2) {
          hit = r;
          break;
        }
      }
      const fr = this._frame(rk);
      trk.frameAt(rk.s, fr);
      this._orient(rk.mesh, fr);
      rk.mesh.position.copy(fr.pos).addScaledVector(fr.right, rk.lat).addScaledVector(fr.up, 1.15);
      if (hit) {
        this._explode(rk.mesh.position);
        this._applyRocketHit(hit);
        this.scene.remove(rk.mesh);
        this.rockets.splice(i, 1);
      }
    }

    // mines
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const mn = this.mines[i];
      if (this.now > mn.until) {
        this.scene.remove(mn.mesh);
        this.mines.splice(i, 1);
        continue;
      }
      mn.mesh.rotation.y += dt * 2.2;
      mn.mesh.scale.setScalar(mn.armAt < this.now ? 1 + 0.15 * Math.sin(this.now * 8) : 0.7);
      if (this.now < mn.armAt) continue;
      let boom = null;
      for (const r of racers) {
        if (r === mn.owner && this.now < mn.armAt + 1.5) continue;
        if (Math.abs(wrapDs(r.s - mn.s, trk.length)) < 2.8 && Math.abs(r.lat - mn.lat) < 2.4) {
          boom = r;
          break;
        }
      }
      if (boom) {
        this._explode(mn.mesh.position);
        if (boom.shieldTime > 0) {
          boom.shieldTime = 0;
          shipEventsSafe('shieldPing', boom);
        } else {
          boom.speed *= 0.6;
          boom.latVel += (Math.random() < 0.5 ? -1 : 1) * 10;
          boom.obstCd = Math.max(boom.obstCd, 0.7);
        }
        shipEventsSafe('explosion', boom);
        this.scene.remove(mn.mesh);
        this.mines.splice(i, 1);
      }
    }

    // explosion flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t -= dt;
      if (f.t <= 0) {
        this.scene.remove(f.mesh);
        this.flashes.splice(i, 1);
        continue;
      }
      const k = 1 - f.t / 0.35;
      f.mesh.scale.setScalar((1 + k * 6) * (f.big || 1));
      f.mesh.material.opacity = 0.9 * (1 - k);
    }
  }
}

// ships.js owns the shipEvents object (no cycle: ships never imports weapons).
function shipEventsSafe(name, ...args) {
  try {
    shipEvents[name]?.(...args);
  } catch (_e) {
    /* never break the race loop over audio */
  }
}
