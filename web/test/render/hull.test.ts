import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Point2 } from '@shared/common.js';
import type { CompiledNetwork } from '@shared/network.js';
import { isConnectorPath } from '@shared/network.js';

import { convexHull, nodeFootprint } from '@web/render/hull.js';

describe('convexHull', () => {
  it('drops an interior point from a square', () => {
    const square: Point2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5], // interior
    ];
    const hull = convexHull(square);
    expect(hull).toHaveLength(4);
    for (const p of hull) {
      expect(p).not.toEqual([5, 5]);
    }
  });

  it('is counter-clockwise with no duplicate closing point', () => {
    const square: Point2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const hull = convexHull(square);
    expect(hull[0]).not.toEqual(hull[hull.length - 1]);
    // Shoelace sum should be positive for CCW.
    let sum = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i] as Point2;
      const b = hull[(i + 1) % hull.length] as Point2;
      sum += a[0] * b[1] - b[0] * a[1];
    }
    expect(sum).toBeGreaterThan(0);
  });

  it('handles collinear input by returning the extremes', () => {
    const line: Point2[] = [
      [0, 0],
      [5, 0],
      [10, 0],
      [2, 0],
    ];
    const hull = convexHull(line);
    expect(hull.length).toBeLessThanOrEqual(2);
    expect(hull).toContainEqual([0, 0]);
    expect(hull).toContainEqual([10, 0]);
  });

  it('does not throw on fewer than 3 points', () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([[1, 1]])).toEqual([[1, 1]]);
    expect(convexHull([[1, 1], [2, 2]])).toHaveLength(2);
  });

  it('is deterministic regardless of input order', () => {
    const points: Point2[] = [
      [3, 1],
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
      [1, 9],
    ];
    const shuffled = [...points].reverse();
    const a = convexHull(points);
    const b = convexHull(shuffled);
    expect(b).toEqual(a);
  });
});

describe('nodeFootprint', () => {
  const dataDir = resolve(import.meta.dirname, '../../../data');
  const network = JSON.parse(
    readFileSync(resolve(dataDir, 'compiled/test-grid.compiled.json'), 'utf8'),
  ) as CompiledNetwork;

  it('returns [] for a node with no connectors', () => {
    expect(nodeFootprint(network, 'does-not-exist')).toEqual([]);
  });

  it("contains every connector point of a real intersection node ('n11')", () => {
    const polygon = nodeFootprint(network, 'n11');
    expect(polygon.length).toBeGreaterThanOrEqual(3);

    const connectorsAt = network.paths.filter(isConnectorPath).filter((c) => c.node === 'n11');
    expect(connectorsAt.length).toBeGreaterThan(0);

    // A convex hull must contain every source point (hull membership check
    // via the sign of the cross product against every hull edge).
    function isInsideOrOnHull(p: Point2): boolean {
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i] as Point2;
        const b = polygon[(i + 1) % polygon.length] as Point2;
        const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        if (cross < -1e-6) return false;
      }
      return true;
    }

    for (const c of connectorsAt) {
      for (const p of c.debugPolyline ?? []) {
        expect(isInsideOrOnHull(p)).toBe(true);
      }
    }
  });
});
