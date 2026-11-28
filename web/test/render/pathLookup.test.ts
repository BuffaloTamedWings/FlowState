import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CompiledNetwork } from '@shared/network.js';

import { buildPathLookup, samplePath } from '@web/render/pathLookup.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const network = JSON.parse(readFileSync(resolve(dataDir, 'compiled/test-grid.compiled.json'), 'utf8')) as CompiledNetwork;

describe('buildPathLookup', () => {
  it('gives every one of the 147 test-grid paths a usable table', () => {
    const lookup = buildPathLookup(network);
    expect(lookup.length).toBe(network.paths.length);
    expect(lookup.length).toBe(147);
    for (const table of lookup) {
      expect(table).toBeDefined();
      expect(table.totalLength).toBeGreaterThanOrEqual(0);
    }
  });

  it('a path with no debugPolyline gets a degenerate table instead of throwing', () => {
    const stripped: CompiledNetwork = {
      ...network,
      paths: network.paths.map((p) => {
        const { debugPolyline: _drop, ...rest } = p;
        return rest as typeof p;
      }),
    };
    expect(() => buildPathLookup(stripped)).not.toThrow();
    const lookup = buildPathLookup(stripped);
    const sample = samplePath(lookup, 0, 5);
    expect(sample).toEqual({ x: 0, y: 0, heading: [0, 0] });
  });
});

describe('samplePath', () => {
  const lookup = buildPathLookup(network);

  it('hits the polyline endpoints at s=0 and s=length', () => {
    for (let i = 0; i < network.paths.length; i++) {
      const path = network.paths[i]!;
      const poly = path.debugPolyline;
      if (!poly || poly.length === 0) continue;
      const start = samplePath(lookup, i, 0);
      const end = samplePath(lookup, i, path.length);
      const [sx, sy] = poly[0]!;
      const [ex, ey] = poly[poly.length - 1]!;
      expect(start.x).toBeCloseTo(sx, 1);
      expect(start.y).toBeCloseTo(sy, 1);
      expect(end.x).toBeCloseTo(ex, 1);
      expect(end.y).toBeCloseTo(ey, 1);
    }
  });

  it('clamps out-of-range s', () => {
    const path = network.paths[0]!;
    const atLength = samplePath(lookup, 0, path.length);
    const beyond = samplePath(lookup, 0, path.length + 50);
    const before = samplePath(lookup, 0, -50);
    const atZero = samplePath(lookup, 0, 0);
    expect(beyond).toEqual(atLength);
    expect(before).toEqual(atZero);
  });

  it('an out-of-range pathIndex returns the origin rather than throwing', () => {
    expect(() => samplePath(lookup, 99999, 0)).not.toThrow();
    expect(samplePath(lookup, 99999, 0)).toEqual({ x: 0, y: 0, heading: [0, 0] });
  });
});
