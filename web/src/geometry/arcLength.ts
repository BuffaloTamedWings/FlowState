/**
 * Arc-length lookup table for a polyline, built once per path and queried
 * every frame for every car on it (60fps * however many cars) — so this is
 * written to be fast on lookup, not elegant. No reference equivalent exists
 * in `make_sample.py`; the compile step only needs lengths, the render/sim
 * side needs `(s) -> (x, y, heading)`.
 */

import type { Point2, Polyline } from '@shared/common.js';

import { length, normalize, sub } from './vec2.js';

export interface ArcTable {
  /** The original points, kept so a lookup can interpolate. */
  readonly points: readonly Point2[];
  /** Cumulative distance at each point; `cumulative[0] === 0`. Same length as `points`. */
  readonly cumulative: readonly number[];
  /** Total length of the polyline (`cumulative[cumulative.length - 1]`, or 0 for <2 points). */
  readonly totalLength: number;
}

export interface ArcSample {
  x: number;
  y: number;
  /** Unit heading `[hx, hy]` of the segment the sample falls on. */
  heading: Point2;
}

/** Precomputes cumulative distances along `pts`. */
export function buildArcTable(pts: Polyline): ArcTable {
  const cumulative: number[] = [0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) acc += length(sub(b, a));
    cumulative.push(acc);
  }
  return { points: pts, cumulative, totalLength: acc };
}

/**
 * Position and heading at distance `s` along the table's polyline, clamped to
 * `[0, totalLength]`. Finds the enclosing segment with a binary search over
 * `cumulative` (O(log n)) rather than a linear walk, then does one lerp.
 *
 * A single-point polyline (the degenerate result `trimPolyline` can produce
 * when a cut distance exceeds the whole line) returns that point with a
 * `[0, 0]` heading rather than throwing.
 */
export function sampleArc(table: ArcTable, s: number): ArcSample {
  const { points, cumulative, totalLength } = table;
  if (points.length === 0) return { x: 0, y: 0, heading: [0, 0] };
  if (points.length === 1) {
    const p = points[0];
    return p ? { x: p[0], y: p[1], heading: [0, 0] } : { x: 0, y: 0, heading: [0, 0] };
  }

  const clamped = Math.min(Math.max(s, 0), totalLength);

  // Binary search for the last index whose cumulative distance is <= clamped.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const cmid = cumulative[mid];
    if (cmid !== undefined && cmid <= clamped) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // lo is the segment start index; clamp so lo+1 is always in range.
  const i = Math.min(lo, points.length - 2);
  const a = points[i];
  const b = points[i + 1];
  const segStart = cumulative[i];
  const segEnd = cumulative[i + 1];
  if (!a || !b || segStart === undefined || segEnd === undefined) {
    const fallback = points[points.length - 1];
    return fallback ? { x: fallback[0], y: fallback[1], heading: [0, 0] } : { x: 0, y: 0, heading: [0, 0] };
  }
  const segLen = segEnd - segStart;
  const t = segLen === 0 ? 0 : (clamped - segStart) / segLen;
  const heading = normalize(sub(b, a));
  return {
    x: a[0] + (b[0] - a[0]) * t,
    y: a[1] + (b[1] - a[1]) * t,
    heading,
  };
}
