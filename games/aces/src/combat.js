// combat.js — enemy AI, guided missiles, cannon rounds, explosions.
//
// Missiles use proportional navigation against their target's velocity.
// Enemies fly a simple pursue-orbit policy with terrain avoidance.

import * as THREE from 'three';
import { puffTexture } from './clouds.js';
import { FlightModel } from './flight.js';
import { setHudKills } from './hud.js';
import { buildMissile, makeJetRig } from './jet.js';
import { terrainHeightAt } from './terrain.js';

const GRAV = 9.81;

// ---------------------------------------------------------------- vapor trails
// Wingtip condensation puffs when pulling high G — the classic F-22 vapor look.
export class VaporTrails {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.matBase = new THREE.SpriteMaterial({
      map: puffTexture(true),
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
    });
    this.emitTimer = 0;
    this.sideState = { left: null, right: null };
  }

  update(dt, fm, intensity) {
    // Continuous trail: march sprites along the path between the last
    // emission point and the current tip, so it reads as vapor, not pops.
    const STEP = 0.22; // meters between sprites
    for (const side of [-1, 1]) {
      const key = side > 0 ? 'right' : 'left';
      const tip = fm.position
        .clone()
        .addScaledVector(fm.right, side * 8.2)
        .addScaledVector(fm.up, -2.2)
        .addScaledVector(fm.forward, -1.0);

      const state = this.sideState[key];
      if (intensity <= 0) {
        this.sideState[key] = null;
        continue;
      }
      if (!state) {
        this.sideState[key] = { last: tip };
        continue;
      }

      const from = state.last;
      const seg = tip.clone().sub(from);
      const dist = seg.length();
      if (dist > 400) {
        this.sideState[key] = { last: tip };
        continue;
      } // teleport guard
      const dir = seg.clone().normalize();
      let d = STEP - (state.carry || 0);
      while (d <= dist) {
        const pos = from.clone().addScaledVector(dir, d);
        this.spawn(pos, fm, intensity);
        d += STEP;
      }
      state.carry = (dist + (state.carry || 0)) % STEP;
      state.last = tip;
    }

    for (const s of this.pool) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t > 1.1) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      const k = s.t / 1.1;
      const size = (1.6 + k * 1.6) * 0.4;
      if (s.sizeJitter === undefined) s.sizeJitter = 0.6 + Math.random() * 0.2;
      s.sprite.scale.set(size * s.sizeJitter, size * s.sizeJitter, 1);
      if (s.baseRot === undefined) s.baseRot = Math.random() * Math.PI * 2;
      s.sprite.material.rotation = s.baseRot;
      s.sprite.material.opacity = (1 - k * k) * Math.min(1.2, intensity + 0.35);
    }
  }

  spawn(pos, _fm, _intensity) {
    let s = this.pool.find((p) => !p.active);
    if (!s && this.pool.length < 4000) {
      s = { sprite: new THREE.Sprite(this.matBase.clone()), active: false, t: 0 };
      this.scene.add(s.sprite);
      this.pool.push(s);
    }
    if (s) {
      s.active = true;
      s.t = 0;
      s.sprite.position.copy(pos);
      s.sprite.visible = true;
    }
  }
}

// ---------------------------------------------------------------- exhaust
// Engine exhaust particles: mil power = faint hot shimmer + thin smoke,
// afterburner = fire stream. Emitted from both nozzles, rate follows throttle.
export class ExhaustFX {
  constructor(scene) {
    this.scene = scene;
    this.flamePool = [];
    this.smokePool = [];
    const flameTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      grad.addColorStop(0, 'rgba(255,240,200,1)');
      grad.addColorStop(0.35, 'rgba(255,150,40,0.9)');
      grad.addColorStop(1, 'rgba(255,60,10,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    this.flameMat = new THREE.SpriteMaterial({
      map: flameTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.smokeMat = new THREE.SpriteMaterial({
      map: puffTexture(),
      color: 0x999999,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
  }

  spawn(pool, mat, pos, vel, life, size0, size1, opacity, additive, shrinkRate = 1.0) {
    let p = pool.find((q) => !q.active);
    if (!p && pool.length < (additive ? 1200 : 400)) {
      p = { sprite: new THREE.Sprite(mat.clone()), active: false, t: 0 };
      this.scene.add(p.sprite);
      pool.push(p);
    }
    if (p) {
      p.active = true;
      p.t = 0;
      p.life = life;
      p.size0 = size0;
      p.size1 = size1;
      p.opacity = opacity;
      p.shrinkRate = shrinkRate;
      p.sprite.position.copy(pos);
      p.vel = vel.clone();
      p.sprite.visible = true;
    }
  }

  update(dt, fm, flames) {
    const c = fm.controls;
    const back = fm.forward.clone().multiplyScalar(-1);
    const ab = c.afterburner;
    const throttle = Math.max(c.throttle, ab ? 1 : 0);

    // emission accumulators per nozzle
    for (let i = 0; i < flames.length; i++) {
      const nozzle = new THREE.Vector3();
      flames[i].getWorldPosition(nozzle);
      const key = i === 0 ? 'R' : 'L';
      const acc = `n${key}`;
      if (!this[acc]) this[acc] = { accF: 0, accS: 0 };
      const st = this[acc];

      if (ab) {
        // Faint smoke trail hanging in atmosphere under AB
        const smokeRate = 35;
        st.accS += smokeRate * dt;
        while (st.accS >= 1) {
          st.accS -= 1;
          const vel = back.clone().multiplyScalar(8 + Math.random() * 4);
          this.spawn(this.smokePool, this.smokeMat, nozzle, vel, 0.45, 0.45, 1.6, 0.15, false);
        }
      } else {
        // Smoke trail under power (clean jet exhaust, no fire)
        const smokeRate = 18 * throttle;
        st.accS += smokeRate * dt;
        while (st.accS >= 1) {
          st.accS -= 1;
          const vel = back.clone().multiplyScalar(8 + Math.random() * 6);
          vel.addScaledVector(fm.right, (Math.random() - 0.5) * 2);
          vel.addScaledVector(fm.up, (Math.random() - 0.5) * 2);
          this.spawn(this.smokePool, this.smokeMat, nozzle, vel, 0.45, 0.5, 1.8, 0.16, false);
        }
      }
    }

    const step = (pool) => {
      for (const p of pool) {
        if (!p.active) continue;
        p.t += dt;
        if (p.t >= p.life) {
          p.active = false;
          p.sprite.visible = false;
          continue;
        }
        const k = p.t / p.life;
        p.sprite.position.addScaledVector(p.vel, dt);
        const kSize = p.shrinkRate ? Math.min(1, k * p.shrinkRate) : k;
        const size = p.size0 + (p.size1 - p.size0) * kSize;
        p.sprite.scale.set(size, size, 1);
        p.sprite.material.opacity = p.opacity * (1 - k);
      }
    };
    step(this.flamePool);
    step(this.smokePool);
  }
}

// ---------------------------------------------------------------- explosion
const explosionPool = [];
const explosionTex = (() => {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  function hash(x, y) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >>> 13)) >>> 0;
    return ((Math.imul(h, 1274126177) ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vn(x, y) {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    const xf = x - xi,
      yf = y - yi;
    const u = xf * xf * (3 - 2 * xf),
      v = yf * yf * (3 - 2 * yf);
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(hash(xi, yi), hash(xi + 1, yi), u), l(hash(xi, yi + 1), hash(xi + 1, yi + 1), u), v);
  }
  const img = g.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / size,
        v = py / size;
      const dx = u - 0.5,
        dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 center .. 1 edge
      let n = 0,
        amp = 0.5,
        f = 6;
      for (let o = 0; o < 4; o++) {
        n += amp * vn(u * f, v * f);
        amp *= 0.55;
        f *= 2.3;
      }
      // ragged edge: noise pushes the fireball boundary in/out
      const rr = r + (n - 0.5) * 0.55;
      let cr, cg, cb, a;
      if (rr < 0.25) {
        cr = 255;
        cg = 245;
        cb = 210;
        a = 1;
      } // white-hot core
      else if (rr < 0.55) {
        cr = 255;
        cg = 175 - n * 40;
        cb = 60;
        a = 1;
      } // orange
      else if (rr < 0.8) {
        cr = 200 - n * 60;
        cg = 70;
        cb = 25;
        a = 0.85;
      } // dark red/soot
      else {
        a = Math.max(0, 1 - (rr - 0.8) * 5);
        cr = 90;
        cg = 40;
        cb = 30;
      }
      const i = (py * size + px) * 4;
      img.data[i] = cr;
      img.data[i + 1] = cg;
      img.data[i + 2] = cb;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
})();

export function explode(scene, position, scale = 1, callbacks) {
  let ex = explosionPool.find((e) => !e.active);
  if (!ex) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: explosionTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    scene.add(sprite);
    ex = { sprite, active: false, t: 0, dur: 0, scale: 1 };
    explosionPool.push(ex);
  }
  ex.active = true;
  ex.t = 0;
  ex.dur = 0.9 + Math.random() * 0.3;
  ex.scale = scale;
  ex.sprite.position.copy(position);
  ex.sprite.visible = true;
  if (callbacks?.onExplode) callbacks.onExplode(position, scale);
  return ex;
}

export function updateExplosions(dt) {
  for (const ex of explosionPool) {
    if (!ex.active) continue;
    ex.t += dt;
    const k = ex.t / ex.dur;
    if (k >= 1) {
      ex.active = false;
      ex.sprite.visible = false;
      continue;
    }
    const s = ex.scale * (24 + k * 90);
    ex.sprite.scale.set(s, s, 1);
    ex.sprite.material.opacity = 1 - k * k;
  }
}

// ---------------------------------------------------------------- bullets
export class Cannon {
  constructor(scene) {
    this.scene = scene;
    this.rounds = []; // { pos, vel, life, player }
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffdd66 });
    this.tracerGeo = new THREE.BoxGeometry(0.35, 0.35, 9);
    this.meshes = [];
  }

  fire(origin, direction, speedBase, isPlayer) {
    const spread = isPlayer ? 0.0009 : 0.004;
    const dir = direction
      .clone()
      .add(
        new THREE.Vector3(
          (Math.random() - 0.5) * spread,
          (Math.random() - 0.5) * spread,
          (Math.random() - 0.5) * spread,
        ),
      )
      .normalize();
    const speed = speedBase + 1000;
    const vel = dir.multiplyScalar(speed);
    this.rounds.push({
      pos: origin.clone(),
      vel,
      life: 2.4,
      player: isPlayer,
    });
  }

  update(dt) {
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      r.life -= dt;
      r.vel.y -= GRAV * 0.35 * dt;
      r.pos.addScaledVector(r.vel, dt);
      if (r.life <= 0 || r.pos.y < terrainHeightAt(r.pos.x, r.pos.z)) {
        this.rounds.splice(i, 1);
      }
    }
    // sync instance meshes (simple pooled meshes)
    while (this.meshes.length < this.rounds.length) {
      const m = new THREE.Mesh(this.tracerGeo, this.tracerMat);
      this.scene.add(m);
      this.meshes.push(m);
    }
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (i < this.rounds.length) {
        const r = this.rounds[i];
        m.visible = true;
        m.position.copy(r.pos);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), r.vel.clone().normalize());
      } else {
        m.visible = false;
      }
    }
  }
}

// ---------------------------------------------------------------- missiles
const smokePool = [];
export class Missiles {
  constructor(scene) {
    this.scene = scene;
    this.list = []; // { obj, pos, vel, target, life, friendly, trail[] }
    this.smokeMat = new THREE.SpriteMaterial({
      map: puffTexture(),
      color: 0xdddddd,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
  }

  launch(from, dir, speed, target, friendly) {
    const obj = buildMissile();
    obj.position.copy(from);
    this.scene.add(obj);
    const m = {
      obj,
      pos: from.clone(),
      vel: dir.clone().normalize().multiplyScalar(speed),
      target,
      life: 9,
      friendly,
      trail: [],
      armed: false,
    };
    this.list.push(m);
    return m;
  }

  update(dt, callbacks) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const m = this.list[i];
      m.life -= dt;
      m.armed = m.armed || m.life < 8.85;

      // guidance: proportional navigation
      const tgtPos = m.target ? m.target.position || m.target.fm.position : null;
      const tgtVel = m.target ? m.target.velocity || m.target.fm.velocity : null;
      if (tgtPos && m.target.alive !== false) {
        const relPos = tgtPos.clone().sub(m.pos);
        const relVel = tgtVel.clone().sub(m.vel);
        const _closing = relVel.length();
        // True proportional navigation: the command is N * Vc * omega, where
        // Vc is closing speed. Scaling by closing speed is what makes the
        // missile tighten as it converges — with a fixed gain it flies the
        // same lazy arc whether the target is running away or coming head-on,
        // which reads as a firework rather than a weapon.
        const omega = new THREE.Vector3()
          .crossVectors(relPos, relVel)
          .divideScalar(Math.max(relPos.lengthSq(), 1));
        // Closing speed is the component of relative velocity along the
        // line of sight; negative when the gap is shrinking.
        const los = relPos.clone().normalize();
        const closingSpeed = -relVel.dot(los);
        // Clamped low so a target that briefly out-runs the missile does not
        // invert the command, and high so a head-on merge stays controllable.
        const Vc = THREE.MathUtils.clamp(closingSpeed, 60, 1400);
        const N = 3.2; // navigation constant
        const aCmd = new THREE.Vector3()
          .crossVectors(omega, relVel)
          .multiplyScalar(-N * (Vc / 400));
        aCmd.y -= GRAV * 0.6; // gravity compensation
        // clamp turn
        const maxA = 320;
        if (aCmd.length() > maxA) aCmd.setLength(maxA);
        m.vel.addScaledVector(aCmd, dt);
      }
      // thrust phase then drag-limited
      const speed = m.vel.length();
      const targetSpeed = m.life > 8.2 ? 900 : Math.max(320, speed - 40 * dt);
      if (speed < targetSpeed) m.vel.setLength(targetSpeed);

      // continuous smoke trail for the entire flight; emits scale with
      // elapsed time so the trail stays contiguous at any framerate
      m.smokeT = (m.smokeT || 0) - dt;
      while (m.smokeT <= 0) {
        m.smokeT += 0.025;
        let sp = smokePool.find((q) => !q.active);
        if (!sp && smokePool.length < 900) {
          sp = { sprite: new THREE.Sprite(this.smokeMat.clone()), active: false, t: 0 };
          sp.sprite.material.map = this.smokeMat.map;
          this.scene.add(sp.sprite);
          smokePool.push(sp);
        }
        if (sp) {
          sp.active = true;
          sp.t = 0;
          // back-project along the velocity so puffs trace the path, not clump
          sp.sprite.position
            .copy(m.pos)
            .addScaledVector(m.vel, (m.smokeT / dt) * -0.025 * (Math.random() * 0.4));
          sp.sprite.visible = true;
        }
      }

      m.pos.addScaledVector(m.vel, dt);
      m.obj.position.copy(m.pos);
      m.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), m.vel.clone().normalize());

      // hit detection
      let hit = false;
      if (tgtPos && m.armed) {
        const d = m.pos.distanceTo(tgtPos);
        if (d < 55) hit = true;
      }
      const ground = m.pos.y < terrainHeightAt(m.pos.x, m.pos.z);
      if (hit || ground || m.life <= 0 || speed < 100) {
        if (hit && callbacks?.onHit) callbacks.onHit(m);
        this.scene.remove(m.obj);
        this.list.splice(i, 1);
      }
    }

    // smoke decay
    for (const s of smokePool) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t > 3.2) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      const k = s.t / 3.2;
      const sz = 5 + k * 26;
      s.sprite.scale.set(sz, sz, 1);
      s.sprite.material.opacity = 0.48 * (1 - k);
    }
  }
}

// ---------------------------------------------------------------- enemies
export class Enemy {
  constructor(scene, spawnPos, headingDeg, difficulty = 1) {
    this.scene = scene;
    this.mesh = makeJetRig({ player: false });
    this.mesh.userData.hostile = true;
    scene.add(this.mesh);
    this.fm = new FlightModel();
    this.fm.reset(spawnPos, headingDeg);
    this.alive = true;
    this.difficulty = difficulty;
    this.fireCooldown = 4 + Math.random() * 4;
    this.evadeTimer = 0;
    this.orbitDir = Math.random() > 0.5 ? 1 : -1;
    this.hull = 60;
  }

  update(dt, playerFm, missiles, cannon, callbacks) {
    if (!this.alive) return;
    const fm = this.fm;
    const c = fm.controls;

    const toPlayer = playerFm.position.clone().sub(fm.position);
    const dist = toPlayer.length();
    this.distToPlayer = dist; // used to cull/dim enemy afterburner FX

    // ------------------------------------------------ ground avoidance
    const ground = terrainHeightAt(fm.position.x, fm.position.z);
    const agl = fm.position.y - ground;
    if (agl < 550) {
      // pull up hard
      const desired = new THREE.Vector3(0, 1, -0.3).applyQuaternion(fm.quaternion);
      this.steerToward(desired, 1);
      c.throttle = 1;
      c.afterburner = true;
      return this.applyControlsmoothing(dt);
    }

    // ------------------------------------------------ choose behavior
    this.evadeTimer -= dt;
    if (this.evadeTimer <= 0 && Math.random() < 0.0025 * this.difficulty) {
      this.evadeTimer = 2.5;
    }

    if (this.evadeTimer > 0) {
      // barrel-roll break
      c.roll = this.orbitDir;
      c.pitch = 0.55;
      c.yaw = 0;
      c.throttle = 1;
      c.afterburner = true;
    } else if (dist > 2600) {
      // pursue: steer at an intercept point ahead of the player
      const lead = playerFm.position
        .clone()
        .addScaledVector(playerFm.velocity, Math.min(dist / 700, 4));
      this.steerToward(lead.sub(fm.position), 0.9);
      c.throttle = 1;
      c.afterburner = dist > 5000;
    } else {
      // inside the merge: orbit to keep energy, repositioning turns
      const _fwd = fm.forward;
      const side = fm.right.dot(toPlayer.normalize()) > 0 ? 1 : -1;
      const desired = playerFm.position
        .clone()
        .sub(fm.position)
        .normalize()
        .addScaledVector(fm.right, -side * 1.15)
        .normalize();
      this.steerToward(desired, 0.75);
      c.throttle = 0.85;
      c.afterburner = false;
    }

    this.applyControlsmoothing(dt);

    // ------------------------------------------------ fire
    this.fireCooldown -= dt;
    const aimAngle = fm.forward.angleTo(toPlayer.normalize());
    if (this.fireCooldown <= 0 && dist < 4500 && aimAngle < 0.25 && playerFm.alive !== false) {
      this.fireCooldown = (5 + Math.random() * 5) / this.difficulty;
      if (callbacks?.onEnemyFire) {
        callbacks.onEnemyFire(this, playerFm, missiles, cannon);
      }
    }
  }

  steerToward(worldDir, gain) {
    // convert a desired world direction into roll/pitch commands
    const inv = this.fm.quaternion.clone().invert();
    const local = worldDir.clone().normalize().applyQuaternion(inv);
    // local: x right, y up, z back (since forward is -z)
    const c = this.fm.controls;
    const rollErr = Math.atan2(local.x, local.y); // bank toward target
    const yawErr = Math.atan2(local.x, -local.z);

    // Roll to put the target above us, then pull.
    c.roll = THREE.MathUtils.clamp(rollErr * 1.4 * gain, -1, 1);
    c.pitch = THREE.MathUtils.clamp(
      (local.y > 0 ? Math.acos(THREE.MathUtils.clamp(-local.z, -1, 1)) : 0.08) * 1.1 * gain,
      0,
      1,
    );
    // if target is below and we're upright, push over instead
    if (local.y < -0.2 && Math.abs(rollErr) < 0.5) {
      c.pitch = THREE.MathUtils.clamp(
        -Math.acos(THREE.MathUtils.clamp(-local.z, -1, 1)) * 0.7,
        -1,
        0,
      );
      c.roll *= 0.3;
    }
    c.yaw = THREE.MathUtils.clamp(yawErr * 0.4 * gain, -0.5, 0.5);
  }

  applyControlsmoothing(dt) {
    this.fm.update(dt, terrainHeightAt);
    if (this.fm.crashed) this.kill(null);
    this.mesh.position.copy(this.fm.position);
    this.mesh.quaternion.copy(this.fm.quaternion);
    // Enemy afterburner FX are heavily reduced next to the player's: smaller
    // cones, and culled entirely beyond 6 km — a 5 m additive cone should not
    // read as a beacon from across the map.
    const fl = this.mesh.userData.flames || [];
    const far = (this.distToPlayer ?? 0) > 6000;
    for (const f of fl) {
      f.visible = !!this.fm.controls.afterburner && !far;
      if (f.visible && f.userData.material) {
        f.userData.material.uniforms.uTime.value += dt;
        const bs = f.userData.baseScale || { x: 1, y: 1, z: 1 };
        const flutter = 0.95 + Math.sin(this.fm.speed * 0.1) * 0.08;
        const k = 0.45;
        f.scale.set(bs.x * k, bs.y * k, bs.z * k * flutter);
      }
    }
  }

  damage(amount, source) {
    this.hull -= amount;
    if (this.hull <= 0 && this.alive) this.kill(source);
  }

  kill(_source) {
    if (!this.alive) return;
    this.alive = false;
    explode(this.scene, this.fm.position, 1.6);
    this.scene.remove(this.mesh);
    setHudKills(++Enemy.kills);
  }
}
Enemy.kills = 0;
export function resetKills() {
  Enemy.kills = 0;
  setHudKills(0);
}
