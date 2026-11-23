import { describe, expect, it } from 'vitest';

import { connectorCurve } from '@web/geometry/connector.js';

describe('connectorCurve', () => {
  it('always starts and ends exactly on its endpoints', () => {
    const cases: Array<[[number, number], [number, number], [number, number], [number, number]]> = [
      [[0, 0], [1, 0], [10, 0], [1, 0]], // straight through
      [[0, 0], [1, 0], [10, 10], [0, 1]], // left turn
      [[0, 0], [1, 0], [10, -10], [0, -1]], // right turn
      [[0, 0], [1, 0], [10, 0], [0, 1]], // parallel-but-perpendicular-exit tangents
    ];
    for (const [p0, h0, p2, h1] of cases) {
      const curve = connectorCurve(p0, h0, p2, h1, 16);
      expect(curve).toHaveLength(17);
      expect(curve[0]?.[0]).toBeCloseTo(p0[0], 10);
      expect(curve[0]?.[1]).toBeCloseTo(p0[1], 10);
      expect(curve[curve.length - 1]?.[0]).toBeCloseTo(p2[0], 10);
      expect(curve[curve.length - 1]?.[1]).toBeCloseTo(p2[1], 10);
    }
  });

  it('falls back to a straight, uniformly-sampled segment when tangents are parallel', () => {
    const p0: [number, number] = [0, 0];
    const p2: [number, number] = [10, 0];
    const h: [number, number] = [1, 0];
    const curve = connectorCurve(p0, h, p2, h, 4);
    // Midpoint control collapses the quadratic Bezier to the straight line,
    // so every sample should land exactly on the segment, evenly spaced.
    for (let k = 0; k <= 4; k++) {
      const pt = curve[k];
      expect(pt).toBeDefined();
      expect(pt?.[0]).toBeCloseTo((10 * k) / 4, 10);
      expect(pt?.[1]).toBeCloseTo(0, 10);
    }
  });

  it('curves through a tangent-intersection control point for a 90-degree turn', () => {
    // Heading east at (0,0), heading north at (10,10): tangent lines intersect
    // at (10,0), which should sit "inside" the curve (not equal to an endpoint).
    const curve = connectorCurve([0, 0], [1, 0], [10, 10], [0, 1], 16);
    const mid = curve[8];
    expect(mid).toBeDefined();
    // Roughly curves toward (10,0) corner rather than the straight midpoint (5,5).
    expect(mid![0]).toBeGreaterThan(5);
    expect(mid![1]).toBeLessThan(5);
  });
});
