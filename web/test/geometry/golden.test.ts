/**
 * Acceptance test for step 3: rebuilding every car lane's centerline from the
 * scenario with this module's `laneCenterlines` + `nodeSetback` + `trimPolyline`
 * must reproduce the lengths and endpoints already baked into the committed
 * golden compile (`data/compiled/test-grid.compiled.json`), which was produced
 * by `tools/reference/make_sample.py`. This does NOT redo step 4 (turn
 * classification, conflicts, phases) — only the lane geometry it depends on.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CompiledNetwork, LanePath, ConnectorPath } from '@shared/network.js';
import { isConnectorPath, isLanePath } from '@shared/network.js';
import type { Scenario } from '@shared/scenario.js';
import { selectedEdgeOption, selectedNodeOption } from '@shared/scenario.js';

import { connectorCurve } from '@web/geometry/connector.js';
import { laneCenterlines, nodeSetback } from '@web/geometry/laneLayout.js';
import { headingAtEnd, headingAtStart, polylineLength, trimPolyline } from '@web/geometry/polyline.js';

const dataDir = resolve(import.meta.dirname, '../../../data');

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}

const scenario = readJson<Scenario>('scenarios/test-grid.scenario.json');
const network = readJson<CompiledNetwork>('compiled/test-grid.compiled.json');

const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
const edgesById = new Map(scenario.edges.map((e) => [e.id, e]));

const goldenLanes = network.paths.filter(isLanePath);
const goldenConnectors = network.paths.filter(isConnectorPath);

/**
 * The plan's acceptance bar is 0.05 m, but the observed deviation is far
 * smaller and has a known cause: the golden file stores coordinates rounded to
 * 2 dp, so a full-precision rebuild can differ by at most half a hundredth per
 * coordinate (0.005), or 0.005 * sqrt(2) ~= 0.0071 for a 2D point distance.
 * Measured worst cases are 0.0050 m (lane length), 0.0047 m (lane point) and
 * 0.0066 m (connector sample) — i.e. the residual is *entirely* the golden
 * file's rounding quantum and nothing else.
 *
 * So the tolerance is tightened to 0.01 m: still above the rounding floor, but
 * 5x stricter than the plan's bar, which turns this from "roughly agrees" into
 * a regression test that catches any real change in the geometry rules.
 */
const LENGTH_TOL = 0.01;
const POINT_TOL = 0.01;

describe('golden lane geometry (test-grid)', () => {
  it('has the expected 54 car lanes to check', () => {
    expect(goldenLanes).toHaveLength(54);
  });

  it.each(goldenLanes.map((lane) => [lane.id, lane] as const))(
    'reproduces length and endpoints of %s',
    (_id, golden: LanePath) => {
      const edge = edgesById.get(golden.edge);
      expect(edge, `scenario is missing edge ${golden.edge}`).toBeDefined();
      const option = selectedEdgeOption(edge!);

      const lanes = laneCenterlines(edge!, option, golden.dir);
      const lane = lanes.find((l) => l.laneIndex === golden.laneIndex);
      expect(lane, `${golden.id}: no lane at index ${golden.laneIndex}`).toBeDefined();
      // Only car lanes are ever compiled; a mismatch here would mean our
      // laneIndex bookkeeping disagrees with the reference's.
      expect(lane!.lane.type, golden.id).toBe('car');

      const fromNode = nodesById.get(golden.fromNode);
      const toNode = nodesById.get(golden.toNode);
      expect(fromNode, `scenario is missing node ${golden.fromNode}`).toBeDefined();
      expect(toNode, `scenario is missing node ${golden.toNode}`).toBeDefined();

      const setbackStart = nodeSetback(fromNode!, selectedNodeOption(fromNode!));
      const setbackEnd = nodeSetback(toNode!, selectedNodeOption(toNode!));
      const trimmed = trimPolyline(lane!.centerline, setbackStart, setbackEnd);

      const length = polylineLength(trimmed);
      expect(Math.abs(length - golden.length), `${golden.id}: length diff`).toBeLessThanOrEqual(LENGTH_TOL);

      const goldenPts = golden.debugPolyline;
      expect(goldenPts, `${golden.id}: golden has no debugPolyline`).toBeDefined();
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      const goldenFirst = goldenPts![0];
      const goldenLast = goldenPts![goldenPts!.length - 1];
      expect(first, golden.id).toBeDefined();
      expect(last, golden.id).toBeDefined();

      const dFirst = Math.hypot(first![0] - goldenFirst![0], first![1] - goldenFirst![1]);
      const dLast = Math.hypot(last![0] - goldenLast![0], last![1] - goldenLast![1]);
      expect(dFirst, `${golden.id}: first point diff`).toBeLessThanOrEqual(POINT_TOL);
      expect(dLast, `${golden.id}: last point diff`).toBeLessThanOrEqual(POINT_TOL);
    },
  );
});

describe('golden connector geometry (test-grid)', () => {
  const goldenLanesById = new Map(goldenLanes.map((l) => [l.id, l]));

  it('every golden connector starts and ends exactly on its lanes’ endpoints', () => {
    for (const conn of goldenConnectors) {
      const fromLane = goldenLanesById.get(conn.from);
      const toLane = goldenLanesById.get(conn.to);
      expect(fromLane, conn.id).toBeDefined();
      expect(toLane, conn.id).toBeDefined();
      const connPts = conn.debugPolyline;
      expect(connPts, conn.id).toBeDefined();

      const fromEnd = fromLane!.debugPolyline![fromLane!.debugPolyline!.length - 1]!;
      const toStart = toLane!.debugPolyline![0]!;
      expect(connPts![0], conn.id).toEqual(fromEnd);
      expect(connPts![connPts!.length - 1], conn.id).toEqual(toStart);
    }
  });

  it.each(goldenConnectors.map((c) => [c.id, c] as const))(
    'our connectorCurve reproduces the golden curve for %s',
    (_id, conn: ConnectorPath) => {
      const fromLane = goldenLanesById.get(conn.from);
      const toLane = goldenLanesById.get(conn.to);
      expect(fromLane, conn.id).toBeDefined();
      expect(toLane, conn.id).toBeDefined();

      // The reference derives connector headings from the already-rounded
      // lane debugPolylines, not full-precision geometry (see round2's doc
      // comment) — so we must do the same here to match.
      const p0 = fromLane!.debugPolyline![fromLane!.debugPolyline!.length - 1]!;
      const h0 = headingAtEnd(fromLane!.debugPolyline!);
      const p2 = toLane!.debugPolyline![0]!;
      const h1 = headingAtStart(toLane!.debugPolyline!);

      const curve = connectorCurve(p0, h0, p2, h1, 16);
      const golden = conn.debugPolyline!;
      expect(curve, conn.id).toHaveLength(golden.length);
      for (let i = 0; i < curve.length; i++) {
        const got = curve[i]!;
        const want = golden[i]!;
        expect(Math.hypot(got[0] - want[0], got[1] - want[1]), `${conn.id}[${i}]`).toBeLessThanOrEqual(POINT_TOL);
      }
    },
  );
});
