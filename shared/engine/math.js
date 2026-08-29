// math.js — frame-rate independent helpers used by every game loop.

/**
 * Exponential smoothing toward a target, stable across frame times.
 *
 * The naive `x += (target - x) * k` overshoots when a frame runs long, because
 * k is a fraction of an unknown interval. Scaling by dt and clamping to 1 keeps
 * a slow frame from stepping past the target.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} rate   approach speed; higher converges faster
 * @param {number} dt     seconds since the previous frame
 */
export function damp(current, target, rate, dt) {
  return current + (target - current) * Math.min(1, dt * rate);
}

/** Clamp to [min, max]. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Clamp to [0, 1]. */
export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Linear interpolation; t is not clamped. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Map value from [inMin, inMax] onto [outMin, outMax], clamped at both ends. */
export function remap(value, inMin, inMax, outMin, outMax) {
  const t = clamp01((value - inMin) / (inMax - inMin));
  return outMin + (outMax - outMin) * t;
}
