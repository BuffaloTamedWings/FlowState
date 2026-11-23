/**
 * Intelligent Driver Model (IDM) car following. PRD §8.2.
 *
 * Pure functions only: no state, no randomness, so the engine stays deterministic.
 * Units: meters, seconds, m/s.
 */

import { SIM_DT } from '@shared/messages.js';

export interface IdmParams {
  /** Desired time headway T (s). */
  timeHeadway: number;
  /** Max acceleration a (m/s²). */
  maxAccel: number;
  /** Comfortable braking b (m/s², positive). */
  comfortDecel: number;
  /** Minimum bumper-to-bumper gap s₀ (m). */
  minGap: number;
  /** Acceleration exponent δ. */
  delta: number;
  /** Vehicle length (m). */
  carLength: number;
}

export const DEFAULT_IDM: Readonly<IdmParams> = Object.freeze({
  timeHeadway: 1.5,
  maxAccel: 1.0,
  comfortDecel: 2.0,
  minGap: 2.0,
  delta: 4,
  carLength: 4.5,
});

/**
 * IDM acceleration.
 *
 * @param v       own speed (m/s)
 * @param v0      desired speed (m/s), normally the path speed limit
 * @param gap     bumper-to-bumper distance to the leader (m); `Infinity` for a free road.
 *                A stop line is a leader with speed 0 at the line.
 * @param vLead   leader speed (m/s); ignored when gap is Infinity
 */
export function idmAccel(
  v: number,
  v0: number,
  gap: number,
  vLead: number,
  p: Readonly<IdmParams> = DEFAULT_IDM,
): number {
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), p.delta);
  if (!Number.isFinite(gap)) return p.maxAccel * free;

  const dv = v - vLead; // closing speed (positive = approaching)
  const sStar =
    p.minGap + Math.max(0, v * p.timeHeadway + (v * dv) / (2 * Math.sqrt(p.maxAccel * p.comfortDecel)));
  const s = Math.max(gap, 0.01); // avoid divide-by-zero; a tiny gap gives huge braking
  return p.maxAccel * (free - (sStar / s) ** 2);
}

/**
 * Steady-state speed for a given gap: the speed where IDM acceleration is 0 behind a leader
 * going the same speed. Found by bisection (acceleration falls as speed rises).
 */
export function equilibriumSpeed(gap: number, v0: number, p: Readonly<IdmParams> = DEFAULT_IDM): number {
  if (gap <= p.minGap) return 0;
  let lo = 0;
  let hi = v0;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (idmAccel(mid, v0, gap, mid, p) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Advance one car by dt with a ballistic update, never letting speed go negative.
 * Returns the new speed and the distance travelled during the step.
 */
export function integrate(v: number, accel: number, dt: number = SIM_DT): { v: number; ds: number } {
  const vNext = v + accel * dt;
  if (vNext >= 0) return { v: vNext, ds: v * dt + 0.5 * accel * dt * dt };
  // Car stops partway through the step: travel only until v reaches 0.
  return { v: 0, ds: accel < 0 ? (v * v) / (-2 * accel) : 0 };
}
