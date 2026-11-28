import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CompiledNetwork } from '@shared/network.js';
import { isLanePath } from '@shared/network.js';
import type { Scenario } from '@shared/scenario.js';

import { compileScenario } from '@web/compile/index.js';
import { drawableLanes, laneBoundaries } from '@web/render/laneGeometry.js';

const dataDir = resolve(import.meta.dirname, '../../../data');

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}

const scenario = readJson<Scenario>('scenarios/test-grid.scenario.json');
const golden = readJson<CompiledNetwork>('compiled/test-grid.compiled.json');

describe('drawableLanes', () => {
  const drawable = drawableLanes(scenario);
  const byId = new Map(drawable.map((d) => [d.id, d]));

  it('has a matching DrawableLane for every compiled car LanePath, vertex-for-vertex within 0.01 m', () => {
    const carLanes = golden.paths.filter(isLanePath);
    expect(carLanes).toHaveLength(54);

    for (const lane of carLanes) {
      const dl = byId.get(lane.id);
      expect(dl, `missing DrawableLane for ${lane.id}`).toBeDefined();
      expect(dl?.type).toBe('car');
      const compiledPoly = lane.debugPolyline ?? [];
      const drawnPoly = dl?.centerline ?? [];
      expect(drawnPoly.length, `${lane.id} point count`).toBe(compiledPoly.length);
      for (let i = 0; i < compiledPoly.length; i++) {
        const cp = compiledPoly[i];
        const dp = drawnPoly[i];
        expect(cp).toBeDefined();
        expect(dp).toBeDefined();
        if (!cp || !dp) continue;
        expect(Math.abs(dp[0] - cp[0])).toBeLessThanOrEqual(0.01);
        expect(Math.abs(dp[1] - cp[1])).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it('the test grid selects no bike or transit lanes on any edge (no compiled car-lane counterpart exists for them)', () => {
    const nonCar = drawable.filter((d) => d.type !== 'car');
    expect(nonCar).toHaveLength(0);
  });

  it('bike/transit lanes appear in drawableLanes but have no compiled LanePath, once an edge selects a bikeLane option', () => {
    const edgeId = 'eF0';
    const clone: Scenario = JSON.parse(JSON.stringify(scenario)) as Scenario;
    const edge = clone.edges.find((e) => e.id === edgeId);
    if (!edge) throw new Error(`fixture is missing edge ${edgeId}`);
    const bikeOption = edge.options.find((o) => o.kind === 'bikeLane');
    if (!bikeOption) throw new Error(`edge ${edgeId} has no bikeLane option in the fixture`);
    edge.selected = bikeOption.id;

    const drawnWithBike = drawableLanes(clone);
    const bikeLanes = drawnWithBike.filter((d) => d.edge === edgeId && d.type === 'bike');
    expect(bikeLanes.length).toBeGreaterThan(0);

    const compiledWithBike = compileScenario(clone);
    const compiledIds = new Set(compiledWithBike.paths.filter(isLanePath).map((p) => p.id));
    for (const bl of bikeLanes) {
      expect(compiledIds.has(bl.id)).toBe(false);
    }
  });
});

describe('laneBoundaries', () => {
  const boundaries = laneBoundaries(scenario);

  it('every boundary polyline has at least 2 points', () => {
    expect(boundaries.length).toBeGreaterThan(0);
    for (const b of boundaries) {
      expect(b.points.length).toBeGreaterThanOrEqual(2);
      expect(b.z.length).toBe(b.points.length);
    }
  });

  it('total boundary count matches lane-boundary-offset counts per edge+direction, plus one centerline where both directions have lanes', () => {
    let expectedTotal = 0;
    for (const edge of scenario.edges) {
      const option = edge.options.find((o) => o.id === edge.selected);
      if (!option) continue;
      const twoWay = option.forward.length > 0 && option.backward.length > 0;
      // One boundary per lane plus an outer edge line, except on a two-way
      // street where the innermost boundary is dropped in favour of the single
      // shared centerline (laneGeometry.ts skips it to avoid coincident lines).
      if (option.forward.length > 0) expectedTotal += option.forward.length + (twoWay ? 0 : 1);
      if (option.backward.length > 0) expectedTotal += option.backward.length + (twoWay ? 0 : 1);
      if (twoWay) expectedTotal += 1;
    }
    expect(boundaries.length).toBe(expectedTotal);
  });
});
