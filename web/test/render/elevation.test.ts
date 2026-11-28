import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Edge, Scenario } from '@shared/scenario.js';

import { elevationSampler, polylineElevations } from '@web/render/elevation.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const scenario = JSON.parse(
  readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8'),
) as Scenario;

function edge(id: string): Edge {
  const e = scenario.edges.find((x) => x.id === id);
  if (!e) throw new Error(`fixture is missing edge ${id}`);
  return e;
}

describe('elevationSampler', () => {
  it('returns a constant 0 for an edge with null elevation', () => {
    const flat = scenario.edges.find((e) => e.elevation === null);
    if (!flat) throw new Error('expected at least one flat edge in the fixture');
    const sample = elevationSampler(flat);
    expect(sample(0)).toBe(0);
    expect(sample(0.5)).toBe(0);
    expect(sample(1)).toBe(0);
  });

  it('monotonically interpolates eROff between its endpoint elevations', () => {
    const e = edge('eROff');
    expect(e.elevation).toEqual([-7.0, -3.5, 0.0]);
    const sample = elevationSampler(e);
    expect(sample(0)).toBeCloseTo(-7.0, 6);
    expect(sample(1)).toBeCloseTo(0.0, 6);
    const mid = sample(0.5);
    expect(mid).toBeGreaterThan(-7.0);
    expect(mid).toBeLessThan(0.0);
    // Monotonic: sampling more finely never decreases.
    let prev = sample(0);
    for (let t = 0.05; t <= 1; t += 0.05) {
      const v = sample(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('monotonically interpolates eROn between its endpoint elevations', () => {
    const e = edge('eROn');
    expect(e.elevation).toEqual([0.0, -3.5, -7.0]);
    const sample = elevationSampler(e);
    expect(sample(0)).toBeCloseTo(0.0, 6);
    expect(sample(1)).toBeCloseTo(-7.0, 6);
    let prev = sample(0);
    for (let t = 0.05; t <= 1; t += 0.05) {
      const v = sample(t);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});

describe('polylineElevations', () => {
  it('returns all zeros for a flat sampler', () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [25, 0],
    ];
    const zs = polylineElevations(pts, () => 0);
    expect(zs).toEqual([0, 0, 0]);
  });

  it('one z per vertex, sampled at cumulative arc-length fraction', () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    // Halfway along the polyline should sample t = 0.5.
    const zs = polylineElevations(pts, (t) => t);
    expect(zs).toHaveLength(3);
    expect(zs[0]).toBeCloseTo(0, 10);
    expect(zs[1]).toBeCloseTo(0.5, 10);
    expect(zs[2]).toBeCloseTo(1, 10);
  });

  it('handles a single-point polyline by sampling t=0', () => {
    expect(polylineElevations([[1, 1]], (t) => t + 5)).toEqual([5]);
  });
});
