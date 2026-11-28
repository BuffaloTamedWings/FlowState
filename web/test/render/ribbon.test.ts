import { describe, expect, it } from 'vitest';

import { ribbonBuffers } from '@web/render/ribbon.js';

describe('ribbonBuffers', () => {
  it('emits two vertices per input point and two triangles per segment', () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    const { positions, indices } = ribbonBuffers(points, 4, 0);
    expect(positions.length).toBe(points.length * 2 * 3);
    expect(indices.length).toBe((points.length - 1) * 2 * 3);
  });

  it("a straight east-facing ribbon's corners sit at +/- width/2 north/south", () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
    ];
    const { positions } = ribbonBuffers(points, 4, 0);
    // Vertex 0: left (north) at point 0.
    expect(positions[0]).toBeCloseTo(0, 10);
    expect(positions[1]).toBeCloseTo(2, 10);
    expect(positions[2]).toBeCloseTo(0, 10);
    // Vertex 1: right (south) at point 0.
    expect(positions[3]).toBeCloseTo(0, 10);
    expect(positions[4]).toBeCloseTo(-2, 10);
    expect(positions[5]).toBeCloseTo(0, 10);
    // Vertex 2: left at point 1.
    expect(positions[6]).toBeCloseTo(10, 10);
    expect(positions[7]).toBeCloseTo(2, 10);
    // Vertex 3: right at point 1.
    expect(positions[9]).toBeCloseTo(10, 10);
    expect(positions[10]).toBeCloseTo(-2, 10);
  });

  it('winds triangles so the normal points up (+z) when viewed from above', () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
    ];
    const { positions, indices } = ribbonBuffers(points, 4, 0);
    const vert = (i: number): [number, number, number] => [
      positions[i * 3] ?? 0,
      positions[i * 3 + 1] ?? 0,
      positions[i * 3 + 2] ?? 0,
    ];
    // First triangle.
    const [a, b, c] = [vert(indices[0] ?? 0), vert(indices[1] ?? 0), vert(indices[2] ?? 0)];
    const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    // Cross product ab x ac, z component (normal's z, i.e. "up" in local coords).
    const crossZ = ab[0] * ac[1] - ab[1] * ac[0];
    expect(crossZ).toBeGreaterThan(0);
  });

  it('accepts a per-vertex z array for ramps', () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    const z = [0, 1, 2];
    const { positions } = ribbonBuffers(points, 4, z);
    expect(positions[2]).toBeCloseTo(0, 10);
    expect(positions[5]).toBeCloseTo(0, 10);
    expect(positions[8]).toBeCloseTo(1, 10);
    expect(positions[11]).toBeCloseTo(1, 10);
    expect(positions[14]).toBeCloseTo(2, 10);
    expect(positions[17]).toBeCloseTo(2, 10);
  });

  it('throws on fewer than 2 points', () => {
    expect(() => ribbonBuffers([[0, 0]], 4, 0)).toThrow();
    expect(() => ribbonBuffers([], 4, 0)).toThrow();
  });

  it('throws when the z array length does not match the points length', () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    expect(() => ribbonBuffers(points, 4, [0, 1])).toThrow();
  });
});
