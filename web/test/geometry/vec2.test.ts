import { describe, expect, it } from 'vitest';

import { add, cross, dot, length, normalize, rightOf, scale, sub } from '@web/geometry/vec2.js';

describe('vec2', () => {
  it('adds, subtracts and scales', () => {
    expect(add([1, 2], [3, 4])).toEqual([4, 6]);
    expect(sub([3, 4], [1, 2])).toEqual([2, 2]);
    expect(scale([2, 3], 2)).toEqual([4, 6]);
  });

  it('computes length', () => {
    expect(length([3, 4])).toBe(5);
    expect(length([0, 0])).toBe(0);
  });

  it('computes dot and cross', () => {
    expect(dot([1, 0], [0, 1])).toBe(0);
    expect(dot([2, 3], [4, 5])).toBe(23);
    expect(cross([1, 0], [0, 1])).toBe(1);
    expect(cross([0, 1], [1, 0])).toBe(-1);
  });

  it('normalizes to unit length', () => {
    const n = normalize([3, 4]);
    expect(n[0]).toBeCloseTo(0.6, 10);
    expect(n[1]).toBeCloseTo(0.8, 10);
    expect(length(n)).toBeCloseTo(1, 10);
  });

  it('normalizes a zero vector to [0, 0] rather than NaN', () => {
    const n = normalize([0, 0]);
    expect(n).toEqual([0, 0]);
    expect(Number.isNaN(n[0])).toBe(false);
    expect(Number.isNaN(n[1])).toBe(false);
  });

  it('rightOf rotates a heading 90 degrees clockwise (east -> south)', () => {
    // Facing east (1, 0): right of travel is south, i.e. (0, -1) since y = north.
    expect(rightOf([1, 0])).toEqual([0, -1]);
    // Facing north (0, 1): right of travel is east, (1, 0) (modulo a signed zero).
    const r = rightOf([0, 1]);
    expect(r[0]).toBe(1);
    expect(r[1]).toBeCloseTo(0, 10);
  });
});
