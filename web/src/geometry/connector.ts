/**
 * Connector (turn) curves through a node, ported from `tools/reference/
 * make_sample.py`'s `bezier`.
 */

import type { Point2, Polyline } from '@shared/common.js';

import { add, cross, dot, length, scale, sub } from './vec2.js';

/**
 * Quadratic Bézier from `p0` (with unit tangent `h0`) to `p2` (with unit
 * tangent `h1`), sampled at `segments + 1` points including both endpoints.
 * Reference: `bezier`.
 *
 * The control point is where the two tangent lines intersect. With
 * `cr = cross(h0, h1)`:
 *   - if `|cr| > 1e-3` (the tangents aren't parallel), solve for `t` such that
 *     `c = p0 + h0 * t` lies on the line through `p2` in direction `h1`, via
 *     `t = cross(p2 - p0, h1) / cr`.
 *   - that candidate `c` is accepted only if `t > 0` (the intersection is
 *     ahead of `p0`, not behind it), `c !== p2` (otherwise the curve
 *     degenerates to a point), and `dot(p2 - c, h1) > 0` (the intersection is
 *     behind `p2` along its own tangent, i.e. the curve still approaches `p2`
 *     moving forward in direction `h1`).
 *   - otherwise (parallel tangents, or the candidate fails those checks) fall
 *     back to the midpoint `(p0 + p2) / 2`.
 *
 * A midpoint control point makes the quadratic Bézier reduce exactly to the
 * straight segment `p0 -> p2`, uniformly sampled by `t` — this is the
 * intended "straight fallback" for e.g. a direct through movement, not a bug.
 */
export function connectorCurve(p0: Point2, h0: Point2, p2: Point2, h1: Point2, segments = 16): Polyline {
  const cr = cross(h0, h1);
  let ctrl: Point2 | null = null;
  if (Math.abs(cr) > 1e-3) {
    const w = sub(p2, p0);
    const t = cross(w, h1) / cr;
    const c = add(p0, scale(h0, t));
    if (t > 0 && length(sub(c, p2)) > 0 && dot(sub(p2, c), h1) > 0) {
      ctrl = c;
    }
  }
  const control = ctrl ?? scale(add(p0, p2), 0.5);

  const pts: Polyline = [];
  for (let k = 0; k <= segments; k++) {
    const t = k / segments;
    const a = scale(p0, (1 - t) ** 2);
    const b = scale(control, 2 * (1 - t) * t);
    const c = scale(p2, t * t);
    pts.push(add(add(a, b), c));
  }
  return pts;
}
