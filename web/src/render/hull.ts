/**
 * Convex hull and node footprints for intersection fill polygons. Pure
 * TypeScript — no Three.js — so it unit-tests in plain Node.
 */

import type { Point2, Polygon } from '@shared/common.js';
import type { CompiledNetwork } from '@shared/network.js';
import { isConnectorPath } from '@shared/network.js';

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * Monotone-chain (Andrew's) convex hull, counter-clockwise, no duplicate
 * closing point. Deterministic: input is sorted by x then y before building
 * the chains, so the same point set always produces the same hull regardless
 * of input order.
 *
 * Fewer than 3 points, or all-collinear input, returns the input's extremes
 * (the two endpoints of the line, or the single/duplicate point) rather than
 * throwing.
 */
export function convexHull(points: Point2[]): Polygon {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));

  if (sorted.length === 1) return [sorted[0] as Point2];

  const lower: Point2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2] as Point2;
      const b = lower[lower.length - 1] as Point2;
      if (cross(a, b, p) <= 0) lower.pop();
      else break;
    }
    lower.push(p);
  }

  const upper: Point2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i] as Point2;
    while (upper.length >= 2) {
      const a = upper[upper.length - 2] as Point2;
      const b = upper[upper.length - 1] as Point2;
      if (cross(a, b, p) <= 0) upper.pop();
      else break;
    }
    upper.push(p);
  }

  // Both chains include both endpoints; drop the last point of each (it's the
  // first point of the other chain) to avoid a duplicate closing point.
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];

  if (hull.length >= 3) return hull;

  // All-collinear (or a single distinct point repeated): fall back to the
  // sorted input's extremes rather than returning a degenerate 1-2 point hull
  // that dropped interior-but-still-extreme points.
  const first = sorted[0] as Point2;
  const last = sorted[sorted.length - 1] as Point2;
  if (first[0] === last[0] && first[1] === last[1]) return [first];
  return [first, last];
}

/**
 * Convex hull of every point of every connector `debugPolyline` at `nodeId`,
 * plus the last point of each incoming lane and the first point of each
 * outgoing lane of those connectors. Returns `[]` if the node has no
 * connectors (does not throw).
 */
export function nodeFootprint(network: CompiledNetwork, nodeId: string): Polygon {
  const pathsById = new Map(network.paths.map((p) => [p.id, p]));
  const points: Point2[] = [];

  for (const path of network.paths) {
    if (!isConnectorPath(path) || path.node !== nodeId) continue;
    if (path.debugPolyline) {
      for (const p of path.debugPolyline) points.push(p);
    }
    const from = pathsById.get(path.from);
    if (from?.debugPolyline && from.debugPolyline.length > 0) {
      points.push(from.debugPolyline[from.debugPolyline.length - 1] as Point2);
    }
    const to = pathsById.get(path.to);
    if (to?.debugPolyline && to.debugPolyline.length > 0) {
      points.push(to.debugPolyline[0] as Point2);
    }
  }

  if (points.length === 0) return [];
  return convexHull(points);
}
