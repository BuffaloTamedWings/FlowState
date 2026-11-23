import { describe, expect, it } from 'vitest';

import { buildArcTable, sampleArc } from '@web/geometry/arcLength.js';

describe('buildArcTable / sampleArc', () => {
  const pts: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const table = buildArcTable(pts);

  it('tracks total length and cumulative distances', () => {
    expect(table.totalLength).toBeCloseTo(20, 10);
    expect(table.cumulative).toEqual([0, 10, 20]);
  });

  it('samples a point on the first segment', () => {
    const s = sampleArc(table, 4);
    expect(s.x).toBeCloseTo(4, 10);
    expect(s.y).toBeCloseTo(0, 10);
    expect(s.heading[0]).toBeCloseTo(1, 10);
    expect(s.heading[1]).toBeCloseTo(0, 10);
  });

  it('samples a point on the second segment', () => {
    const s = sampleArc(table, 15);
    expect(s.x).toBeCloseTo(10, 10);
    expect(s.y).toBeCloseTo(5, 10);
    expect(s.heading[0]).toBeCloseTo(0, 10);
    expect(s.heading[1]).toBeCloseTo(1, 10);
  });

  it('clamps below 0 and above total length', () => {
    expect(sampleArc(table, -5)).toMatchObject({ x: 0, y: 0 });
    const end = sampleArc(table, 1000);
    expect(end.x).toBeCloseTo(10, 10);
    expect(end.y).toBeCloseTo(10, 10);
  });

  it('matches the binary search against a brute-force linear scan at many points', () => {
    for (let s = -2; s <= 22; s += 0.37) {
      const got = sampleArc(table, s);
      // Brute force: walk segments linearly.
      const clamped = Math.min(Math.max(s, 0), table.totalLength);
      let acc = 0;
      let expected = { x: 0, y: 0 };
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc + segLen >= clamped || i === pts.length - 2) {
          const t = segLen === 0 ? 0 : (clamped - acc) / segLen;
          expected = { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
          break;
        }
        acc += segLen;
      }
      expect(got.x).toBeCloseTo(expected.x, 6);
      expect(got.y).toBeCloseTo(expected.y, 6);
    }
  });

  it('handles a single-point polyline without crashing', () => {
    const single = buildArcTable([[5, 5]]);
    expect(single.totalLength).toBe(0);
    const s = sampleArc(single, 10);
    expect(s).toEqual({ x: 5, y: 5, heading: [0, 0] });
  });

  it('handles an empty polyline without crashing', () => {
    const empty = buildArcTable([]);
    expect(empty.totalLength).toBe(0);
    expect(sampleArc(empty, 0)).toEqual({ x: 0, y: 0, heading: [0, 0] });
  });
});
