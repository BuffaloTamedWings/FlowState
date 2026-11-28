/**
 * Rule 7 (PRD §7.4): which connectors at a node conflict with each other.
 * Ported from `tools/reference/make_sample.py`'s `seg_cross` and the
 * conflicts loop (lines ~579-613).
 */

import type { Point2, Polyline } from '@shared/common.js';
import type { ConnectorPath } from '@shared/network.js';

/** Signed area helper, reference: `o` inside `seg_cross`. */
function orient(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * True when open segments `p1-p2` and `p3-p4` properly cross. Strict `< 0` on
 * both orientation products, so merely touching (collinear or endpoint
 * contact) does not count. Reference: `seg_cross`.
 */
export function segmentsCross(p1: Point2, p2: Point2, p3: Point2, p4: Point2): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True when any segment of `a` crosses any segment of `b`. Reference: `crosses`. */
export function connectorsCross(a: Polyline, b: Polyline): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    const p1 = a[i];
    const p2 = a[i + 1];
    if (!p1 || !p2) continue;
    for (let j = 0; j < b.length - 1; j++) {
      const p3 = b[j];
      const p4 = b[j + 1];
      if (!p3 || !p4) continue;
      if (segmentsCross(p1, p2, p3, p4)) return true;
    }
  }
  return false;
}

/**
 * For each node's connectors (in creation order), compares every pair
 * `(i, j > i)`: same `from` lane is never a conflict (those cars are already
 * queued behind each other); same `to` lane is a `merge`; otherwise a `cross`
 * if the curves intersect. Appends to both connectors' `conflicts` in that
 * order. Mutates the connectors in `connectorsByNode`.
 */
export function assignConflicts(connectorsByNode: Map<string, ConnectorPath[]>): void {
  for (const cs of connectorsByNode.values()) {
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i];
      if (!a) continue;
      for (let j = i + 1; j < cs.length; j++) {
        const b = cs[j];
        if (!b) continue;
        if (a.from === b.from) continue;
        let type: 'merge' | 'cross' | null = null;
        if (a.to === b.to) {
          type = 'merge';
        } else if (connectorsCross(a.debugPolyline ?? [], b.debugPolyline ?? [])) {
          type = 'cross';
        }
        if (type) {
          a.conflicts.push({ path: b.id, type });
          b.conflicts.push({ path: a.id, type });
        }
      }
    }
  }
}
