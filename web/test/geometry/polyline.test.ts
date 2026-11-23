import { describe, expect, it } from 'vitest';

import {
  headingAtEnd,
  headingAtStart,
  offsetPolyline,
  pointAndTangentAt,
  polylineLength,
  round2,
  trimPolyline,
} from '@web/geometry/polyline.js';

describe('polylineLength', () => {
  it('sums segment lengths', () => {
    expect(polylineLength([[0, 0], [3, 4]])).toBe(5);
    expect(polylineLength([[0, 0], [3, 4], [3, 0]])).toBe(5 + 4);
  });

  it('is 0 for a single point', () => {
    expect(polylineLength([[1, 1]])).toBe(0);
  });
});

describe('offsetPolyline', () => {
  it('offsets a straight east-facing line to the right (south) by the given amount', () => {
    const out = offsetPolyline(
      [
        [0, 0],
        [10, 0],
      ],
      2,
    );
    expect(out[0]?.[0]).toBeCloseTo(0, 10);
    expect(out[0]?.[1]).toBeCloseTo(-2, 10);
    expect(out[1]?.[0]).toBeCloseTo(10, 10);
    expect(out[1]?.[1]).toBeCloseTo(-2, 10);
  });

  it('averages the normals at an interior corner rather than mitering', () => {
    // An L-shaped path: east then north. At the corner, the offset normal is
    // the normalized sum of rightOf(east) = (0,-1) and rightOf(north) = (1,0),
    // i.e. normalize((1,-1)), NOT the full-miter perpendicular distance.
    const out = offsetPolyline(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      2,
    );
    const corner = out[1];
    expect(corner).toBeDefined();
    const expectedDir = 1 / Math.sqrt(2);
    expect(corner?.[0]).toBeCloseTo(10 + 2 * expectedDir, 10);
    expect(corner?.[1]).toBeCloseTo(0 - 2 * expectedDir, 10);
  });
});

describe('trimPolyline', () => {
  const line: [number, number][] = [
    [0, 0],
    [10, 0],
    [20, 0],
  ];

  it('cuts from the start', () => {
    const out = trimPolyline(line, 5, 0);
    expect(out[0]).toEqual([5, 0]);
    expect(out[out.length - 1]).toEqual([20, 0]);
  });

  it('cuts from the end', () => {
    const out = trimPolyline(line, 0, 5);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([15, 0]);
  });

  it('cuts from both ends', () => {
    const out = trimPolyline(line, 5, 5);
    expect(out[0]).toEqual([5, 0]);
    expect(out[out.length - 1]).toEqual([15, 0]);
  });

  it('collapses to the single last point when the cut exceeds the whole length', () => {
    const out = trimPolyline(line, 100, 0);
    expect(out).toEqual([[20, 0]]);
  });
});

describe('headingAtStart / headingAtEnd', () => {
  it('reports the direction of the first and last segments', () => {
    const line: [number, number][] = [
      [0, 0],
      [0, 10],
      [10, 10],
    ];
    expect(headingAtStart(line)[0]).toBeCloseTo(0, 10);
    expect(headingAtStart(line)[1]).toBeCloseTo(1, 10);
    expect(headingAtEnd(line)[0]).toBeCloseTo(1, 10);
    expect(headingAtEnd(line)[1]).toBeCloseTo(0, 10);
  });
});

describe('pointAndTangentAt', () => {
  const line: [number, number][] = [
    [0, 0],
    [10, 0],
  ];

  it('interpolates partway along', () => {
    const { point, tangent } = pointAndTangentAt(line, 4);
    expect(point[0]).toBeCloseTo(4, 10);
    expect(point[1]).toBeCloseTo(0, 10);
    expect(tangent[0]).toBeCloseTo(1, 10);
  });

  it('clamps below 0 and above the total length', () => {
    expect(pointAndTangentAt(line, -5).point).toEqual([0, 0]);
    expect(pointAndTangentAt(line, 50).point).toEqual([10, 0]);
  });
});

describe('round2 (round-half-to-even, matching Python round(v, 2))', () => {
  it('rounds a clear case normally', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.236)).toBe(1.24);
  });

  it('rounds an exact tie to the nearest even hundredth', () => {
    // 0.125 is exactly representable in binary (1/8): the tie rounds down to
    // the even neighbor 0.12, matching Python's round(0.125, 2) == 0.12.
    expect(round2(0.125)).toBe(0.12);
  });

  it('rounds a near-tie the same way Python does', () => {
    // 0.135 ties at the hundredths place (13.5); the even neighbor is 14, so
    // this rounds up, matching Python's round(0.135, 2) == 0.14.
    expect(round2(0.135)).toBe(0.14);
  });
});
