/**
 * Per-lane elevation sampling. Pure TypeScript — no Three.js.
 */

import type { Polyline } from '@shared/common.js';
import type { Edge } from '@shared/scenario.js';

import { length, sub } from '@web/geometry/vec2.js';

/**
 * Builds a function `t -> z` for `t` in `[0, 1]` along `edge`, linearly
 * interpolating `edge.elevation` by *index fraction* (not by re-projecting
 * arc-length onto the original centerline). That's an approximation: it is
 * exact when `elevation` has one entry per centerline vertex and the vertices
 * are evenly spaced (true for the test grid's two straight ramps), and good
 * enough for gentle curves, but it will drift from true arc-length fraction
 * on a centerline with unevenly spaced vertices. Returns a constant 0 when
 * `elevation` is null.
 */
export function elevationSampler(edge: Edge): (t: number) => number {
  const elevation = edge.elevation;
  if (!elevation || elevation.length === 0) {
    return () => 0;
  }
  if (elevation.length === 1) {
    const only = elevation[0] ?? 0;
    return () => only;
  }
  const n = elevation.length;
  return (t: number) => {
    const clamped = Math.min(1, Math.max(0, t));
    const idx = clamped * (n - 1);
    const i0 = Math.min(n - 2, Math.floor(idx));
    const i1 = i0 + 1;
    const frac = idx - i0;
    const z0 = elevation[i0] ?? 0;
    const z1 = elevation[i1] ?? 0;
    return z0 + (z1 - z0) * frac;
  };
}

/**
 * One z per vertex of `pts`, sampling `sample` at each vertex's cumulative
 * arc-length fraction along `pts` itself (0 at the first point, 1 at the
 * last). A single-point polyline samples at `t = 0`.
 */
export function polylineElevations(pts: Polyline, sample: (t: number) => number): number[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [sample(0)];

  const cumulative: number[] = [0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) acc += length(sub(b, a));
    cumulative.push(acc);
  }
  const total = acc;
  return cumulative.map((c) => sample(total === 0 ? 0 : c / total));
}
