/**
 * Golden test for step 4: compiling `data/scenarios/test-grid.scenario.json`
 * with `web/src/compile` must reproduce `data/compiled/test-grid.compiled.json`
 * (produced by `tools/reference/make_sample.py`) — same path ids and order,
 * same `next`/conflicts/yields/phases, lengths within tolerance.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CompiledNetwork, CompiledPath, ConnectorPath, LanePath } from '@shared/network.js';
import { isConnectorPath, isLanePath } from '@shared/network.js';
import type { Scenario } from '@shared/scenario.js';

import { compileScenario } from '@web/compile/index.js';

const dataDir = resolve(import.meta.dirname, '../../../data');

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}

const scenario = readJson<Scenario>('scenarios/test-grid.scenario.json');
const golden = readJson<CompiledNetwork>('compiled/test-grid.compiled.json');

const got = compileScenario(scenario);

// See web/test/geometry/golden.test.ts: the golden file stores coordinates
// rounded to 2 dp, so a full-precision rebuild can differ by up to the
// rounding quantum (~0.0071 m for a 2D point, observed worst case ~0.0066 m).
// This tolerance is 5x looser than the plan's 0.05 m bar but still strict
// enough to catch a real regression.
const LENGTH_TOL = 0.01;

function setOf(xs: string[]): Set<string> {
  return new Set(xs);
}

function conflictKey(c: { path: string; type: string }): string {
  return `${c.path}|${c.type}`;
}

describe('golden compile (test-grid)', () => {
  it('has the expected path counts', () => {
    const goldenLanes = golden.paths.filter(isLanePath);
    const goldenConnectors = golden.paths.filter(isConnectorPath);
    const gotLanes = got.paths.filter(isLanePath);
    const gotConnectors = got.paths.filter(isConnectorPath);
    expect(goldenLanes).toHaveLength(54);
    expect(goldenConnectors).toHaveLength(93);
    expect(gotLanes, 'lane count').toHaveLength(54);
    expect(gotConnectors, 'connector count').toHaveLength(93);
    expect(got.paths, 'total path count').toHaveLength(147);
  });

  it('produces the same path ids in the same order (same index)', () => {
    const gotIds = got.paths.map((p) => p.id);
    const goldenIds = golden.paths.map((p) => p.id);
    expect(gotIds).toEqual(goldenIds);
  });

  const goldenById = new Map(golden.paths.map((p) => [p.id, p]));

  it.each(got.paths.map((p) => [p.id, p] as const))('path %s matches the golden path', (id, path: CompiledPath) => {
    const want = goldenById.get(id);
    expect(want, `golden is missing path ${id}`).toBeDefined();
    if (!want) return;

    expect(Math.abs(path.length - want.length), `${id}: length`).toBeLessThanOrEqual(LENGTH_TOL);
    expect(path.speedLimit, `${id}: speedLimit`).toBe(want.speedLimit);
    expect(path.next, `${id}: next`).toEqual(want.next);

    if (isLanePath(path)) {
      expect(isLanePath(want), `${id}: golden path is not a lane`).toBe(true);
      const w = want as LanePath;
      expect(path.edge, `${id}: edge`).toBe(w.edge);
      expect(path.dir, `${id}: dir`).toBe(w.dir);
      expect(path.laneIndex, `${id}: laneIndex`).toBe(w.laneIndex);
      expect(path.fromNode, `${id}: fromNode`).toBe(w.fromNode);
      expect(path.toNode, `${id}: toNode`).toBe(w.toNode);
      expect(path.turns, `${id}: turns`).toEqual(w.turns);
    } else if (isConnectorPath(path)) {
      expect(isConnectorPath(want), `${id}: golden path is not a connector`).toBe(true);
      const w = want as ConnectorPath;
      expect(path.node, `${id}: node`).toBe(w.node);
      expect(path.from, `${id}: from`).toBe(w.from);
      expect(path.to, `${id}: to`).toBe(w.to);
      expect(path.turn, `${id}: turn`).toBe(w.turn);
      expect(path.phase, `${id}: phase`).toBe(w.phase);
      expect(path.stop, `${id}: stop`).toBe(w.stop);

      expect(path.conflicts.length, `${id}: conflicts count`).toBe(w.conflicts.length);
      expect(setOf(path.conflicts.map(conflictKey)), `${id}: conflicts`).toEqual(setOf(w.conflicts.map(conflictKey)));

      expect(setOf(path.yieldTo), `${id}: yieldTo`).toEqual(setOf(w.yieldTo));
    }
  });

  it('produces the same node ids', () => {
    expect(setOf(got.nodes.map((n) => n.id))).toEqual(setOf(golden.nodes.map((n) => n.id)));
  });

  const goldenNodesById = new Map(golden.nodes.map((n) => [n.id, n]));

  it.each(got.nodes.map((n) => [n.id, n] as const))('node %s matches the golden node', (id, node) => {
    const want = goldenNodesById.get(id);
    expect(want, `golden is missing node ${id}`).toBeDefined();
    if (!want) return;

    expect(node.control, `${id}: control`).toBe(want.control);

    const gotPhaseIds = node.phases?.map((p) => p.id) ?? null;
    const wantPhaseIds = want.phases?.map((p) => p.id) ?? null;
    expect(gotPhaseIds, `${id}: phase ids/order`).toEqual(wantPhaseIds);
    if (node.phases && want.phases) {
      for (let i = 0; i < node.phases.length; i++) {
        const gp = node.phases[i];
        const wp = want.phases[i];
        expect(gp, `${id}: phase[${i}]`).toBeDefined();
        expect(wp, `${id}: phase[${i}]`).toBeDefined();
        if (gp && wp) {
          expect(setOf(gp.paths), `${id}: phase ${gp.id} paths`).toEqual(setOf(wp.paths));
        }
      }
    }

    expect(setOf(node.inPaths), `${id}: inPaths`).toEqual(setOf(want.inPaths));
    expect(setOf(node.connectors), `${id}: connectors`).toEqual(setOf(want.connectors));
  });

  it('produces the same points', () => {
    expect(got.points.map((p) => p.id)).toEqual(golden.points.map((p) => p.id));
  });

  const goldenPointsById = new Map(golden.points.map((p) => [p.id, p]));

  it.each(got.points.map((p) => [p.id, p] as const))('point %s matches the golden point', (id, point) => {
    const want = goldenPointsById.get(id);
    expect(want, `golden is missing point ${id}`).toBeDefined();
    if (!want) return;

    expect(point.type, `${id}: type`).toBe(want.type);
    expect(point.weight, `${id}: weight`).toBe(want.weight);
    expect(point.capacity, `${id}: capacity`).toBe(want.capacity);

    expect(point.access.map((a) => a.path), `${id}: access paths`).toEqual(want.access.map((a) => a.path));
    for (let i = 0; i < point.access.length; i++) {
      const g = point.access[i];
      const w = want.access[i];
      expect(g, `${id}: access[${i}]`).toBeDefined();
      expect(w, `${id}: access[${i}]`).toBeDefined();
      if (g && w) {
        expect(Math.abs(g.s - w.s), `${id}: access[${i}].s`).toBeLessThanOrEqual(LENGTH_TOL);
      }
    }
  });

  it('matches top-level metadata', () => {
    expect(got.format).toBe(golden.format);
    expect(got.version).toBe(golden.version);
    expect(got.scenario).toBe(golden.scenario);
    expect(got.units).toEqual(golden.units);
    expect(got.layout).toEqual(golden.layout);
  });
});
