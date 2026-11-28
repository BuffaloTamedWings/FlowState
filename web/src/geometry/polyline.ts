/**
 * Polyline operations, ported from `tools/reference/make_sample.py` lines
 * ~320-390 (`poly_len`, `offset_polyline`, `trim`/`cut_start`, `heading_start`,
 * `heading_end`). Faithful port, not an improvement — see module-level notes
 * on each function for the quirks the golden compile depends on.
 */

import type { Point2, Polyline } from '@shared/common.js';

import { add, dot, length, normalize, rightOf, scale, sub } from './vec2.js';

/** Sum of segment lengths. Reference: `poly_len`. */
export function polylineLength(pts: Polyline): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    total += length(sub(b, a));
  }
  return total;
}

/**
 * Offsets every point of `pts` by `offset` meters perpendicular to the line.
 * Reference: `offset_polyline`.
 *
 * For each point, the normal used is the *average* of `rightOf` the incoming
 * segment's direction and `rightOf` the outgoing segment's direction (missing
 * at the two ends), summed and renormalized. This deliberately does NOT divide
 * by `cos(theta/2)` to compensate for the corner angle, so an offset lane
 * pulls slightly inward at a bend instead of mitering out to the "true"
 * perpendicular distance. That's the reference's behavior and the golden
 * compile depends on it — do not "fix" it here.
 */
export function offsetPolyline(pts: Polyline, offset: number): Polyline {
  const out: Point2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    let sum: Point2 = [0, 0];
    if (i > 0) {
      const prev = pts[i - 1];
      if (prev) sum = add(sum, rightOf(normalize(sub(p, prev))));
    }
    if (i < pts.length - 1) {
      const nxt = pts[i + 1];
      if (nxt) sum = add(sum, rightOf(normalize(sub(nxt, p))));
    }
    const n = normalize(sum);
    out.push(add(p, scale(n, offset)));
  }
  return out;
}

/** Cuts `dist` meters off the start of `pts`. Shared by `trimPolyline`. */
function cutStart(pts: Polyline, dist: number): Polyline {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    const seg = length(sub(b, a));
    if (acc + seg >= dist) {
      const t = (dist - acc) / seg;
      const cutPoint = add(a, scale(sub(b, a), t));
      return [cutPoint, ...pts.slice(i + 1)];
    }
    acc += seg;
  }
  // Degenerate case straight from the reference (`ps[-1:]`): the cut distance
  // exceeds the whole polyline, so what's left is a single-point "polyline" —
  // just the last point. Downstream consumers (lengths, headings, arc tables)
  // must tolerate a 1-point polyline rather than assuming >= 2 points.
  const last = pts[pts.length - 1];
  return last ? [last] : [];
}

/**
 * Cuts `fromStart` meters off the front and `fromEnd` meters off the back.
 * Reference: `trim`. Trimming from the end reverses, cuts from the (new)
 * start, and reverses back — exactly mirroring the Python implementation.
 */
export function trimPolyline(pts: Polyline, fromStart: number, fromEnd: number): Polyline {
  let p = fromStart > 0 ? cutStart(pts, fromStart) : pts;
  if (fromEnd > 0) {
    const reversed = [...p].reverse();
    p = cutStart(reversed, fromEnd).reverse();
  }
  return p;
}

/** Normalized direction of the first two points. Reference: `heading_start`. */
export function headingAtStart(pts: Polyline): Point2 {
  const a = pts[0];
  const b = pts[1];
  if (!a || !b) return [0, 0];
  return normalize(sub(b, a));
}

/** Normalized direction of the last two points. Reference: `heading_end`. */
export function headingAtEnd(pts: Polyline): Point2 {
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  if (!a || !b) return [0, 0];
  return normalize(sub(b, a));
}

/**
 * Position and unit tangent at distance `s` along `pts`, clamped to
 * `[0, polylineLength(pts)]`. No reference equivalent — this is what the
 * front end actually needs per-frame; `arcLength.ts` builds a lookup table on
 * top of the same walk for the 60fps hot path.
 */
export function pointAndTangentAt(pts: Polyline, s: number): { point: Point2; tangent: Point2 } {
  if (pts.length === 0) return { point: [0, 0], tangent: [0, 0] };
  if (pts.length === 1) {
    const only = pts[0];
    return { point: only ?? [0, 0], tangent: [0, 0] };
  }
  const clamped = Math.max(0, s);
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    const dir = sub(b, a);
    const seg = length(dir);
    if (seg === 0) continue;
    if (acc + seg >= clamped || i === pts.length - 2) {
      const t = seg === 0 ? 0 : Math.min(1, Math.max(0, (clamped - acc) / seg));
      return { point: add(a, scale(dir, t)), tangent: normalize(dir) };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  return { point: last ?? [0, 0], tangent: [0, 0] };
}

/**
 * Rounds to 2 decimal places using round-half-to-even (banker's rounding), to
 * match Python's `round(v, 2)` — which the reference calls as `r2`. JavaScript's
 * `Math.round` is round-half-up and gives different results on exact ties
 * (e.g. `0.125`), so this can't use it directly.
 *
 * `round2` exists only for serialization: geometry itself (lengths, offsets,
 * trims, Bézier sampling) must run in full precision and only round at the
 * boundary where a value is written out. This matters for step 4: the
 * reference stores each lane's `debugPolyline` already rounded to 2 dp, and
 * then derives connector headings and Bézier control points *from those
 * rounded points* — so in the compile step, rounding happens before connector
 * geometry is built, not after.
 */
export function round2(v: number): number {
  const scaled = v * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9; // guard against binary floating-point noise around .5
  let rounded: number;
  if (Math.abs(diff - 0.5) < EPS) {
    // Exact tie: round to even.
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / 100;
}

/** Nearest point on `pts` to `query`, plus the distance and the arc-length fraction (0-1) along `pts`. */
export interface ClosestPoint {
  point: Point2;
  distance: number;
  /** Arc-length fraction `[0, 1]` along `pts` at the closest point. 0 for a degenerate (0- or 1-point) polyline. */
  t: number;
}

/**
 * Projects `query` onto every segment of `pts` and keeps the closest. Used by
 * `render/ground.ts` to find, for an arbitrary ground point, how far it is
 * from a sunken edge's centerline and how far along that edge it sits (so the
 * trench floor height there can be looked up from the edge's own elevation
 * profile). No reference equivalent -- `make_sample.py` never needs the
 * inverse of `offsetPolyline`/`pointAndTangentAt`.
 */
export function closestPointOnPolyline(pts: Polyline, query: Point2): ClosestPoint {
  if (pts.length === 0) return { point: [0, 0], distance: Infinity, t: 0 };
  if (pts.length === 1) {
    const only = pts[0]!;
    return { point: only, distance: length(sub(query, only)), t: 0 };
  }

  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) total += length(sub(b, a));
    cumulative.push(total);
  }

  let best: ClosestPoint = { point: pts[0]!, distance: Infinity, t: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    const seg = sub(b, a);
    const segLen = length(seg);
    let tt: number;
    let proj: Point2;
    if (segLen === 0) {
      tt = 0;
      proj = a;
    } else {
      const raw = dot(sub(query, a), seg) / (segLen * segLen);
      tt = Math.min(1, Math.max(0, raw));
      proj = add(a, scale(seg, tt));
    }
    const distance = length(sub(query, proj));
    if (distance < best.distance) {
      const segStart = cumulative[i] ?? 0;
      const arc = segStart + tt * segLen;
      best = { point: proj, distance, t: total === 0 ? 0 : arc / total };
    }
  }
  return best;
}
