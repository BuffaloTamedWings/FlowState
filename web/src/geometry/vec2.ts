/**
 * 2D vector helpers on plain `Point2` tuples (`[x, y]`, x = east, y = north).
 *
 * Deliberately small and free of classes: everything downstream (polylines,
 * lane offsets, Bézier connectors) just needs arithmetic on pairs of numbers,
 * and keeping them as tuples lets this module interoperate with `Point2`
 * straight from `@shared/common.js` without wrapping/unwrapping.
 */

import type { Point2 } from '@shared/common.js';

export function add(a: Point2, b: Point2): Point2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function scale(a: Point2, k: number): Point2 {
  return [a[0] * k, a[1] * k];
}

/** Euclidean length (a.k.a. `Math.hypot(a[0], a[1])`). */
export function length(a: Point2): number {
  return Math.hypot(a[0], a[1]);
}

export function dot(a: Point2, b: Point2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** Z component of the 3D cross product of two 2D vectors. */
export function cross(a: Point2, b: Point2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/**
 * Normalizes to unit length. The reference (`norm` in `make_sample.py`) never
 * has to handle a zero vector because every polyline segment it normalizes is
 * non-degenerate by construction. We can't assume that in general callers, so
 * a zero-length input returns `[0, 0]` rather than dividing and producing
 * `NaN` — a "no direction" vector that is safe to add into an averaged normal
 * (see `offsetPolyline`) without poisoning the sum.
 */
export function normalize(a: Point2): Point2 {
  const l = length(a);
  if (l === 0) return [0, 0];
  return [a[0] / l, a[1] / l];
}

/**
 * The direction 90° clockwise from `d` in this coordinate system (x = east,
 * y = north): `(d.y, -d.x)`. This is "right of travel" for a car heading in
 * direction `d` — positive lane offsets move right of the direction of travel.
 */
export function rightOf(d: Point2): Point2 {
  return [d[1], -d[0]];
}
