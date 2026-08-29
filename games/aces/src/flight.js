// flight.js — rigid-body 6DOF flight model.
//
// Body axes: +X right, +Y up (through canopy), -Z forward (three.js convention).
// State is a position, velocity (world), orientation quaternion, angular
// velocity (body frame). Forces are computed in body frame, torques are
// pilot-commanded angular accelerations damped by dynamic pressure.

import * as THREE from 'three';

// ---------------------------------------------------------------- constants
const GRAVITY = 9.81;
const AIR_DENSITY_SL = 1.225; // kg/m^3 at sea level
const SCALE_HEIGHT = 8500; // m, exponential atmosphere

// F-22-ish numbers (mass in "units" tuned so speeds read like knots*m)
const MASS = 15700; // kg, loaded
const WING_AREA = 78; // m^2
const MAX_THRUST_MIL = 232000; // N (2x F119, military)
const _MAX_THRUST_AB = 312000; // N (afterburner)

// Lift curve: piecewise Cl vs AoA. Stalls hard past ~18 deg.
function liftCoefficient(aoa) {
  const d = THREE.MathUtils.radToDeg(aoa);
  const a = Math.abs(d);
  let cl;
  if (a <= 15) cl = 0.1 * d;
  else if (a <= 30) cl = 0.1 * 15 * Math.sign(d) * (1 - (a - 15) / 20);
  else cl = 0.02 * Math.sign(d);
  return cl;
}

function dragCoefficient(aoa, controls) {
  const _d = Math.abs(THREE.MathUtils.radToDeg(aoa));
  const cd0 = 0.021 + 0.045 * Math.sin(Math.abs(aoa)) ** 3;
  const induced = (liftCoefficient(aoa) * liftCoefficient(aoa)) / (Math.PI * 4.2);
  const brake = controls.airbrake ? 0.09 : 0;
  return cd0 + induced + brake;
}

export class FlightModel {
  constructor() {
    this.position = new THREE.Vector3(0, 2200, 0);
    this.velocity = new THREE.Vector3(0, 0, -160); // m/s forward
    this.quaternion = new THREE.Quaternion();
    // start level, nose toward -Z, slight nose-down variety handled by caller
    this.angularVelocity = new THREE.Vector3(); // body frame rad/s
    this.controls = {
      pitch: 0,
      roll: 0,
      yaw: 0,
      throttle: 0.7,
      afterburner: false,
      airbrake: false,
    };
    this.gLoad = 1;
    this.aoa = 0;
    this.sideslip = 0;
    this.stalled = false;
    this.thrust = 0;
    this.crashed = false;
  }

  get forward() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
  }
  get up() {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
  }
  get right() {
    return new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion);
  }
  get speed() {
    return this.velocity.length();
  }
  get altitude() {
    return this.position.y;
  }
  get mach() {
    return this.speed / 300;
  } // rough, altitude-agnostic

  headingDeg() {
    const f = this.forward;
    let h = THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z));
    if (h < 0) h += 360;
    return h;
  }

  pitchDeg() {
    const f = this.forward;
    return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)));
  }

  rollDeg() {
    // bank of the right wing relative to horizon
    const r = this.right;
    return THREE.MathUtils.radToDeg(Math.atan2(-r.y, Math.hypot(r.x, r.z)));
  }

  reset(pos, headingDeg) {
    this.position.copy(pos);
    this.quaternion.setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-headingDeg), 0));
    this.velocity.copy(this.forward).multiplyScalar(170);
    this.angularVelocity.set(0, 0, 0);
    this.crashed = false;
    this.gLoad = 1;
  }

  update(dt, groundHeightFn) {
    const c = this.controls;
    const speed = this.speed;

    // ---------------------------------------------------- atmosphere
    const density = AIR_DENSITY_SL * Math.exp(-Math.max(0, this.altitude) / SCALE_HEIGHT);
    const q = 0.5 * density * speed * speed; // dynamic pressure
    const qRef = 0.5 * AIR_DENSITY_SL * 150 * 150; // "normal" q for damping norms

    // ---------------------------------------------------- orientation axes
    const fwd = this.forward;
    const up = this.up;
    const right = this.right;

    // AoA: angle between velocity and body forward in the body XZ... in pitch plane
    let aoa = 0,
      beta = 0;
    if (speed > 1) {
      const vBody = this.velocity.clone().applyQuaternion(this.quaternion.clone().invert());
      aoa = Math.atan2(-vBody.y, -vBody.z);
      beta = Math.atan2(vBody.x, -vBody.z);
    }
    this.aoa = aoa;
    this.sideslip = beta;
    this.stalled = Math.abs(THREE.MathUtils.radToDeg(aoa)) > 22 && speed < 130;

    // ---------------------------------------------------- aerodynamic forces
    const cl = liftCoefficient(aoa);
    const cd = dragCoefficient(aoa, c);
    const liftDir = new THREE.Vector3().crossVectors(right, this.velocity).normalize();
    if (liftDir.lengthSq() < 1e-6) liftDir.copy(up);
    const liftMag = cl * q * WING_AREA;
    const dragMag = cd * q * WING_AREA;
    const sideMag = -beta * 1.8 * q * WING_AREA * 0.3; // fuselage side force

    const force = new THREE.Vector3();
    force.addScaledVector(liftDir, liftMag);
    force.addScaledVector(this.velocity.clone().normalize(), -dragMag);
    force.addScaledVector(right, sideMag);

    // ---------------------------------------------------- thrust
    const abBoost = c.afterburner ? 1.34 : 1;
    this.thrust = c.throttle * MAX_THRUST_MIL * abBoost;
    force.addScaledVector(fwd, this.thrust);

    // ---------------------------------------------------- gravity
    force.y -= MASS * GRAVITY;

    // G-load: apparent gravity along body up axis
    const accelWorld = force.clone().divideScalar(MASS);
    this.gLoad = (accelWorld.dot(up) + GRAVITY * up.dot(new THREE.Vector3(0, 1, 0))) / GRAVITY;
    this.gLoad = THREE.MathUtils.clamp(this.gLoad, -5, 12);

    // ---------------------------------------------------- angular dynamics
    // Control authority scales with dynamic pressure — no control at stall,
    // weak controls when slow, full authority at combat speeds.
    const authority = THREE.MathUtils.clamp(q / qRef, this.stalled ? 0.06 : 0.14, 1);
    const pitchRateMax = 1.05; // rad/s at full authority (~ 8 G at combat speed)
    const rollRateMax = 2.8;
    const yawRateMax = 0.35;

    // Body-frame angular rates. With forward = -Z, up = +Y, right = +X:
    // +X rate pitches nose up, -Y rate yaws nose right, -Z rate rolls right.
    const targetRates = new THREE.Vector3(
      c.pitch * pitchRateMax,
      -c.yaw * yawRateMax,
      -c.roll * rollRateMax,
    );
    // Weathervaning stability: aerodynamic torque pushes nose toward velocity vector.
    const stabGain = 0.9 * authority;
    targetRates.x += -aoa * 2.2 * stabGain * (this.stalled ? 0.3 : 1);
    targetRates.y += -beta * 3.0 * stabGain;

    // Fly-by-wire augmentation (keyboard-friendly): with the roll stick free,
    // roll wings-level; with the pitch stick free, hold vertical speed ~0.
    if (!this.stalled) {
      if (Math.abs(c.roll) < 0.05) {
        // Fade the leveler out as pitch input grows, so pulling into a
        // banked turn doesn't fight the augmentation.
        const leveler = 1 - Math.min(1, Math.abs(c.pitch) * 1.4);
        targetRates.z +=
          THREE.MathUtils.clamp(THREE.MathUtils.degToRad(this.rollDeg()) * 1.3, -1.0, 1.0) *
          authority *
          leveler;
      }
      if (Math.abs(c.pitch) < 0.05) {
        targetRates.x += THREE.MathUtils.clamp(-this.velocity.y * 0.004, -0.15, 0.15) * authority;
      }
    }

    // G-limiter: bleed off pitch rate command beyond ~9 G / -3 G
    if (Math.abs(targetRates.x) > 0.01) {
      const over =
        this.gLoad > 8.5
          ? (this.gLoad - 8.5) / 1.2
          : this.gLoad < -2.5
            ? (this.gLoad + 2.5) / 1.2
            : 0;
      if (over !== 0) {
        const damp = THREE.MathUtils.clamp(1 - Math.abs(over), 0.02, 1);
        targetRates.x *= damp;
      }
    }

    // Rate controller: angular velocity chases target rates with a time constant
    const rateLerp = 1 - Math.exp(-dt * 6.5);
    this.angularVelocity.lerp(targetRates.multiplyScalar(authority), rateLerp);

    // ---------------------------------------------------- integrate
    this.velocity.addScaledVector(accelWorld, dt);
    this.position.addScaledVector(this.velocity, dt);

    // Quaternion integration from body angular velocity:
    // q̇ = ½ q ⊗ ω_body, so q_new = q + dt·q̇ (right-multiply keeps rates body-frame)
    const w = this.angularVelocity;
    const dq = this.quaternion
      .clone()
      .multiply(new THREE.Quaternion(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0));
    this.quaternion
      .set(
        this.quaternion.x + dq.x,
        this.quaternion.y + dq.y,
        this.quaternion.z + dq.z,
        this.quaternion.w + dq.w,
      )
      .normalize();

    // ---------------------------------------------------- ground collision
    const gh = groundHeightFn ? groundHeightFn(this.position.x, this.position.z) : 0;
    if (this.position.y < gh + 4) {
      this.position.y = gh + 4;
      this.crashed = true;
    }
    if (this.position.y > 14000) {
      this.position.y = 14000;
      this.velocity.y = Math.min(this.velocity.y, 0);
    }
  }
}
