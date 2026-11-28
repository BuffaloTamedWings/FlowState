/**
 * Tests for `validateNetwork`/`assertValid` (step 4). Two kinds of case:
 *
 * - the committed golden compile (`data/compiled/test-grid.compiled.json`)
 *   must validate clean;
 * - for every check in the module's doc comment, a small in-memory mutation
 *   of a deep clone of that golden network must trip exactly that check's
 *   `code` and nothing that isn't plausibly caused by it. `format-mismatch`
 *   is used throughout as a sentinel for "this mutation didn't cascade into
 *   something unrelated" since nothing below ever touches `format`.
 *
 * Also checks that `data/scenarios/hard-case.scenario.json` parses, satisfies
 * the `Scenario` shape, contains the features step 4 calls for, and both
 * compiles and validates clean — it is the stand-in for real OSM data until
 * step 8, so "it doesn't crash and produces no dead lanes" is the whole point
 * of it (there is no golden file to match).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compileScenario } from '@web/compile/index.js';
import type { CompiledNetwork, ConnectorPath, LanePath } from '@shared/network.js';
import { isConnectorPath, isLanePath } from '@shared/network.js';
import {
  BRANCH_SIDES,
  EDGE_OPTION_KINDS,
  LANE_TYPES,
  NODE_CONTROLS,
  NODE_KINDS,
  POINT_TYPES,
  ROAD_CLASSES,
  SCENARIO_FORMAT,
  SCENARIO_VERSION,
  TURNS,
  selectedEdgeOption,
  selectedNodeOption,
  type Scenario,
} from '@shared/scenario.js';

import { assertValid, validateNetwork, type ValidationProblem } from '@web/compile/validate.js';

const dataDir = resolve(import.meta.dirname, '../../../data');

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}

const golden = readJson<CompiledNetwork>('compiled/test-grid.compiled.json');

/** Deep clone so each test mutates its own copy. */
function clone(network: CompiledNetwork): CompiledNetwork {
  return structuredClone(network);
}

function errorCodes(problems: ValidationProblem[]): string[] {
  return problems.filter((p) => p.severity === 'error').map((p) => p.code);
}

/** Every mutation test asserts this is absent — nothing here ever touches `format`. */
function expectIsolated(problems: ValidationProblem[], expectedCode: string): void {
  const codes = errorCodes(problems);
  expect(codes).toContain(expectedCode);
  expect(codes).not.toContain('format-mismatch');
}

function findPath<T extends LanePath | ConnectorPath>(
  network: CompiledNetwork,
  pred: (p: CompiledNetwork['paths'][number]) => boolean,
): T {
  const found = network.paths.find(pred);
  if (!found) throw new Error('fixture path not found');
  return found as T;
}

describe('validateNetwork: golden file', () => {
  it('has zero error-severity problems on the committed golden compile', () => {
    const problems = validateNetwork(golden);
    const errors = problems.filter((p) => p.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  it('assertValid does not throw on the golden compile', () => {
    expect(() => assertValid(golden)).not.toThrow();
  });
});

describe('validateNetwork: index integrity', () => {
  it('flags path-index-mismatch when a path is moved out of position', () => {
    const net = clone(golden);
    const p = net.paths[5];
    if (!p) throw new Error('fixture missing path 5');
    p.index = 999;
    expectIsolated(validateNetwork(net), 'path-index-mismatch');
  });

  it('flags duplicate-path-id when two paths share an id', () => {
    const net = clone(golden);
    const a = net.paths[0];
    const b = net.paths[1];
    if (!a || !b) throw new Error('fixture missing paths');
    b.id = a.id;
    expectIsolated(validateNetwork(net), 'duplicate-path-id');
  });
});

describe('validateNetwork: reference integrity', () => {
  it('flags dangling-next when a lane points at a nonexistent path', () => {
    const net = clone(golden);
    const lane = findPath<LanePath>(net, isLanePath);
    lane.next = ['NOPE'];
    expectIsolated(validateNetwork(net), 'dangling-next');
  });

  it('flags connector-next-invalid when next does not equal [to]', () => {
    const net = clone(golden);
    const conn = findPath<ConnectorPath>(net, isConnectorPath);
    conn.next = [conn.to, conn.to];
    expectIsolated(validateNetwork(net), 'connector-next-invalid');
  });

  it('flags connector-endpoint-not-lane when to names a connector', () => {
    const net = clone(golden);
    const connectors = net.paths.filter(isConnectorPath);
    const a = connectors[0];
    const b = connectors[1];
    if (!a || !b) throw new Error('fixture missing connectors');
    a.to = b.id;
    a.next = [b.id];
    expectIsolated(validateNetwork(net), 'connector-endpoint-not-lane');
  });

  it('flags dangling-conflict when a conflict names a nonexistent path', () => {
    const net = clone(golden);
    const conn = findPath<ConnectorPath>(net, isConnectorPath);
    conn.conflicts = [{ path: 'NOPE', type: 'cross' }];
    expectIsolated(validateNetwork(net), 'dangling-conflict');
  });

  it('flags dangling-yield-to when yieldTo names a nonexistent path', () => {
    const net = clone(golden);
    const conn = findPath<ConnectorPath>(net, isConnectorPath);
    conn.yieldTo = ['NOPE'];
    expectIsolated(validateNetwork(net), 'dangling-yield-to');
  });

  it('flags dangling-node-inpath when a node lists a nonexistent inPath', () => {
    const net = clone(golden);
    const node = net.nodes[0];
    if (!node) throw new Error('fixture missing nodes');
    node.inPaths = ['NOPE', ...node.inPaths];
    expectIsolated(validateNetwork(net), 'dangling-node-inpath');
  });

  it('flags dangling-node-connector when a node lists a nonexistent connector', () => {
    const net = clone(golden);
    const node = net.nodes[0];
    if (!node) throw new Error('fixture missing nodes');
    node.connectors = ['NOPE', ...node.connectors];
    expectIsolated(validateNetwork(net), 'dangling-node-connector');
  });

  it('flags dangling-phase-path when a phase lists a nonexistent path', () => {
    const net = clone(golden);
    const signalNode = net.nodes.find((n) => n.phases && n.phases.length > 0);
    const phase = signalNode?.phases?.[0];
    if (!signalNode || !phase) throw new Error('fixture missing a signal node with phases');
    phase.paths = ['NOPE', ...phase.paths];
    expectIsolated(validateNetwork(net), 'dangling-phase-path');
  });

  it('flags dangling-point-access when a point access names a nonexistent path', () => {
    const net = clone(golden);
    const point = net.points[0];
    const access = point?.access[0];
    if (!point || !access) throw new Error('fixture missing a point with access');
    access.path = 'NOPE';
    expectIsolated(validateNetwork(net), 'dangling-point-access');
  });
});

describe('validateNetwork: dead-end and unreachable lanes', () => {
  it('flags dead-end-lane when a lane into a compiled node loses its outgoing connectors', () => {
    const net = clone(golden);
    const lane = findPath<LanePath>(net, (p) => isLanePath(p) && p.id === 'L/eF5/f/0');
    expect(lane.next.length).toBeGreaterThan(0);
    lane.next = [];
    expectIsolated(validateNetwork(net), 'dead-end-lane');
  });

  it('flags unreachable-lane when nothing leads into a lane from a compiled node', () => {
    const net = clone(golden);
    const connectors = net.paths.filter(isConnectorPath);
    const toCounts = new Map<string, number>();
    for (const c of connectors) toCounts.set(c.to, (toCounts.get(c.to) ?? 0) + 1);
    // A connector whose target lane has exactly one connector leading into it:
    // redirecting this one orphans that lane entirely.
    const victim = connectors.find((c) => toCounts.get(c.to) === 1);
    const other = connectors.find((c) => c.id !== victim?.id && c.to !== victim?.to);
    if (!victim || !other) throw new Error('fixture missing connectors to redirect');
    const orphanedLane = victim.to;
    // Keep `next` consistent with `to` (rule 2) so this doesn't also trip that check.
    victim.to = other.to;
    victim.next = [other.to];
    expectIsolated(validateNetwork(net), 'unreachable-lane');
    expect(orphanedLane).not.toBe(other.to);
  });
});

describe('validateNetwork: spawn reachability', () => {
  it('flags spawn-unreachable when a spawn point only reaches an isolated lane', () => {
    const net = clone(golden);
    const spawn = net.points.find((p) => p.type === 'edgeSpawn' || p.type === 'rampSpawn');
    if (!spawn) throw new Error('fixture missing a spawn point');

    // An island lane: fromNode/toNode name no compiled node, so checks 3/4
    // don't fire on it, and nothing else references it, so it's a dead end
    // for BFS purposes without being a structural dangling reference.
    const islandLane: LanePath = {
      id: 'L/island/f/0',
      kind: 'lane',
      edge: 'island',
      dir: 'f',
      laneIndex: 0,
      fromNode: 'nowhere-from',
      toNode: 'nowhere-to',
      length: 10,
      speedLimit: 10,
      turns: null,
      next: [],
      index: net.paths.length,
    };
    net.paths.push(islandLane);
    spawn.access = [{ path: islandLane.id, s: 0 }];

    expectIsolated(validateNetwork(net), 'spawn-unreachable');
  });
});

describe('validateNetwork: control consistency', () => {
  it('flags phases-presence-mismatch when a signal node loses its phases', () => {
    const net = clone(golden);
    const signalNode = net.nodes.find((n) => n.control === 'signal' && n.phases);
    if (!signalNode) throw new Error('fixture missing a signal node');
    signalNode.phases = null;
    expectIsolated(validateNetwork(net), 'phases-presence-mismatch');
  });

  it('flags connector-phase-unknown when a signal connector names a nonexistent phase', () => {
    const net = clone(golden);
    const signalNode = net.nodes.find((n) => n.control === 'signal' && n.phases && n.phases.length > 0);
    const connId = signalNode?.connectors[0];
    const conn = connId ? net.paths.find((p) => p.id === connId) : undefined;
    if (!conn || !isConnectorPath(conn)) throw new Error('fixture missing a signal connector');
    conn.phase = 'NOT-A-PHASE';
    expectIsolated(validateNetwork(net), 'connector-phase-unknown');
  });

  it('flags connector-phase-should-be-null at an unsignalized node', () => {
    const net = clone(golden);
    const allStopNode = net.nodes.find((n) => n.control === 'allStop');
    const connId = allStopNode?.connectors[0];
    const conn = connId ? net.paths.find((p) => p.id === connId) : undefined;
    if (!conn || !isConnectorPath(conn)) throw new Error('fixture missing an allStop connector');
    conn.phase = 'NS';
    expectIsolated(validateNetwork(net), 'connector-phase-should-be-null');
  });

  it('flags connector-stop-mismatch when an allStop connector is not stopped', () => {
    const net = clone(golden);
    const allStopNode = net.nodes.find((n) => n.control === 'allStop');
    const connId = allStopNode?.connectors[0];
    const conn = connId ? net.paths.find((p) => p.id === connId) : undefined;
    if (!conn || !isConnectorPath(conn)) throw new Error('fixture missing an allStop connector');
    expect(conn.stop).toBe(true);
    conn.stop = false;
    expectIsolated(validateNetwork(net), 'connector-stop-mismatch');
  });

  it('flags connector-stop-mismatch when a signal connector stops', () => {
    const net = clone(golden);
    const signalNode = net.nodes.find((n) => n.control === 'signal');
    const connId = signalNode?.connectors[0];
    const conn = connId ? net.paths.find((p) => p.id === connId) : undefined;
    if (!conn || !isConnectorPath(conn)) throw new Error('fixture missing a signal connector');
    expect(conn.stop).toBe(false);
    conn.stop = true;
    expectIsolated(validateNetwork(net), 'connector-stop-mismatch');
  });

  it('flags lane-stop-inconsistent when connectors off one lane disagree', () => {
    const net = clone(golden);
    const connectors = net.paths.filter(isConnectorPath);
    const fromCounts = new Map<string, ConnectorPath[]>();
    for (const c of connectors) {
      const list = fromCounts.get(c.from) ?? [];
      list.push(c);
      fromCounts.set(c.from, list);
    }
    const pair = [...fromCounts.values()].find((list) => list.length > 1);
    const a = pair?.[0];
    if (!a) throw new Error('fixture missing a lane with multiple connectors');
    a.stop = !a.stop;
    expectIsolated(validateNetwork(net), 'lane-stop-inconsistent');
  });
});

describe('validateNetwork: sanity', () => {
  it('flags format-mismatch', () => {
    const net = clone(golden);
    (net as { format: string }).format = 'bogus-format';
    const codes = errorCodes(validateNetwork(net));
    expect(codes).toContain('format-mismatch');
  });

  it('flags version-mismatch', () => {
    const net = clone(golden);
    net.version = 999;
    expectIsolated(validateNetwork(net), 'version-mismatch');
  });

  it('flags invalid-length', () => {
    const net = clone(golden);
    const p = net.paths[0];
    if (!p) throw new Error('fixture missing paths');
    p.length = -1;
    expectIsolated(validateNetwork(net), 'invalid-length');
  });

  it('flags invalid-speed-limit', () => {
    const net = clone(golden);
    const p = net.paths[0];
    if (!p) throw new Error('fixture missing paths');
    p.speedLimit = 0;
    expectIsolated(validateNetwork(net), 'invalid-speed-limit');
  });

  it('flags access-s-out-of-range', () => {
    const net = clone(golden);
    const point = net.points[0];
    const access = point?.access[0];
    if (!point || !access) throw new Error('fixture missing a point with access');
    access.s = -5;
    expectIsolated(validateNetwork(net), 'access-s-out-of-range');
  });
});

// ---------------------------------------------------------------------------
// hard-case.scenario.json: shape + the features step 4 asks for
// ---------------------------------------------------------------------------

const hardCase = readJson<Scenario>('scenarios/hard-case.scenario.json');

describe('hard-case fixture', () => {
  it('has the expected format/version and enum values', () => {
    expect(hardCase.format).toBe(SCENARIO_FORMAT);
    expect(hardCase.version).toBe(SCENARIO_VERSION);
    for (const node of hardCase.nodes) {
      expect(NODE_KINDS).toContain(node.kind);
      for (const opt of node.options) expect(NODE_CONTROLS).toContain(opt.control);
      expect(node.options.some((o) => o.id === node.selected)).toBe(true);
      expect(node.options[0]?.id).toBe('current');
    }
    for (const edge of hardCase.edges) {
      expect(ROAD_CLASSES).toContain(edge.roadClass);
      expect(edge.options[0]?.id).toBe('current');
      expect(edge.options.some((o) => o.id === edge.selected)).toBe(true);
      for (const opt of edge.options) {
        expect(EDGE_OPTION_KINDS).toContain(opt.kind);
        for (const lane of [...opt.forward, ...opt.backward]) {
          expect(LANE_TYPES).toContain(lane.type);
          for (const t of lane.turns ?? []) expect(TURNS).toContain(t);
        }
      }
    }
    for (const point of hardCase.points) expect(POINT_TYPES).toContain(point.type);
    for (const node of hardCase.nodes) {
      if (node.branch) expect(BRANCH_SIDES).toContain(node.branch.side);
    }
  });

  it('has a 5-way intersection', () => {
    const edgeCounts = new Map<string, number>();
    for (const edge of hardCase.edges) {
      edgeCounts.set(edge.from, (edgeCounts.get(edge.from) ?? 0) + 1);
      edgeCounts.set(edge.to, (edgeCounts.get(edge.to) ?? 0) + 1);
    }
    const fiveWay = hardCase.nodes.find((n) => edgeCounts.get(n.id) === 5);
    expect(fiveWay, 'no node with 5 incident edges').toBeDefined();
    const incident = hardCase.edges.filter((e) => e.from === fiveWay!.id || e.to === fiveWay!.id);
    expect(new Set(incident.map((e) => e.id)).size).toBe(5);
  });

  it('offers a roundabout with a radius, but does not select it', () => {
    // Rule 10 (the ring) is deferred to step 11 and compiling a selected
    // roundabout throws on purpose, so the fixture has to leave it unselected
    // to stay compilable. `web/test/compile/options.test.ts` covers what
    // happens when it *is* selected.
    const node = hardCase.nodes.find((n) =>
      n.options.some((o) => o.control === 'roundabout'),
    );
    expect(node, 'no node offers a roundabout').toBeDefined();
    const option = node?.options.find((o) => o.control === 'roundabout');
    expect(option?.params.radius ?? 0).toBeGreaterThan(0);
    expect(node ? selectedNodeOption(node).control : null).not.toBe('roundabout');
  });

  it('selects a signalProtectedLeft node', () => {
    const node = hardCase.nodes.find((n) => selectedNodeOption(n).control === 'signalProtectedLeft');
    expect(node, 'no node selects signalProtectedLeft').toBeDefined();
  });

  it("selects a yield node whose majorEdges is a non-empty strict subset of its incoming edges", () => {
    const node = hardCase.nodes.find((n) => selectedNodeOption(n).control === 'yield');
    expect(node, 'no node selects yield').toBeDefined();
    const majorEdges = selectedNodeOption(node!).params.majorEdges ?? [];
    const incoming = hardCase.edges.filter((e) => e.from === node!.id || e.to === node!.id).map((e) => e.id);
    expect(majorEdges.length).toBeGreaterThan(0);
    expect(majorEdges.length).toBeLessThan(incoming.length);
    for (const id of majorEdges) expect(incoming).toContain(id);
  });

  it('has an edge with elevation matching its centerline length', () => {
    const withElevation = hardCase.edges.filter((e) => e.elevation !== null);
    expect(withElevation.length).toBeGreaterThan(0);
    for (const edge of withElevation) expect(edge.elevation).toHaveLength(edge.centerline.length);
  });

  it('has a per-lane width override', () => {
    const hasOverride = hardCase.edges.some((e) =>
      e.options.some((o) => [...o.forward, ...o.backward].some((l) => l.width !== undefined)),
    );
    expect(hasOverride).toBe(true);
  });

  it('has a multi-vertex curved centerline, including a tight bend', () => {
    const curved = hardCase.edges.filter((e) => e.centerline.length >= 4);
    expect(curved.length).toBeGreaterThanOrEqual(2);

    // A "tight bend" edge should contain a turn far sharper than the test
    // grid's gentle ramps: find the smallest turn angle among interior
    // vertices of any curved edge and require it to be well under 90 degrees.
    let sharpestDeg = 180;
    for (const edge of curved) {
      for (let i = 1; i < edge.centerline.length - 1; i++) {
        const a = edge.centerline[i - 1]!;
        const b = edge.centerline[i]!;
        const c = edge.centerline[i + 1]!;
        const v1x = b[0] - a[0];
        const v1y = b[1] - a[1];
        const v2x = c[0] - b[0];
        const v2y = c[1] - b[1];
        const dot = v1x * v2x + v1y * v2y;
        const mag1 = Math.hypot(v1x, v1y);
        const mag2 = Math.hypot(v2x, v2y);
        if (mag1 === 0 || mag2 === 0) continue;
        const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
        const deg = (Math.acos(cos) * 180) / Math.PI;
        sharpestDeg = Math.min(sharpestDeg, deg);
      }
    }
    expect(sharpestDeg).toBeLessThan(80);
  });

  it('has a one-way edge, a pinned-turn lane, a node restriction, and a merge/diverge pair', () => {
    expect(hardCase.edges.some((e) => selectedEdgeOption(e).backward.length === 0)).toBe(true);
    expect(
      hardCase.edges.some((e) => selectedEdgeOption(e).forward.some((l) => l.turns && l.turns.length > 0)),
    ).toBe(true);
    expect(hardCase.nodes.some((n) => n.restrictions.length > 0)).toBe(true);
    const merge = hardCase.nodes.find((n) => n.kind === 'merge');
    const diverge = hardCase.nodes.find((n) => n.kind === 'diverge');
    expect(merge?.branch).not.toBeNull();
    expect(diverge?.branch).not.toBeNull();
  });

  it('has edgeSpawn, edgeSink, parking (with capacity), and lunchZone points', () => {
    const types = new Set(hardCase.points.map((p) => p.type));
    expect(types.has('edgeSpawn')).toBe(true);
    expect(types.has('edgeSink')).toBe(true);
    expect(types.has('lunchZone')).toBe(true);
    const parking = hardCase.points.filter((p) => p.type === 'parking');
    expect(parking.length).toBeGreaterThan(0);
    expect(parking.every((p) => typeof p.capacity === 'number' && p.capacity > 0)).toBe(true);
  });

  it('has geometrically plausible edges: no zero-length, endpoints match node positions', () => {
    const nodesById = new Map(hardCase.nodes.map((n) => [n.id, n]));
    for (const edge of hardCase.edges) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      expect(from, `${edge.id}: missing from-node`).toBeDefined();
      expect(to, `${edge.id}: missing to-node`).toBeDefined();
      const first = edge.centerline[0]!;
      const last = edge.centerline[edge.centerline.length - 1]!;
      expect(first).toEqual([from!.x, from!.y]);
      expect(last).toEqual([to!.x, to!.y]);

      let length = 0;
      for (let i = 0; i < edge.centerline.length - 1; i++) {
        const a = edge.centerline[i]!;
        const b = edge.centerline[i + 1]!;
        length += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      expect(length).toBeGreaterThan(0);
    }
  });
});

describe('the hard-case fixture compiles and validates', () => {
  // Step 4's "done when". There is no golden file for this scenario — the
  // point is that the nastiness the test grid lacks (a 5-way node, curved
  // multi-vertex centerlines, ramps with elevation, a per-lane width
  // override, yield and protected-left controls, a turn restriction) neither
  // crashes the compile nor produces a structurally broken network.
  const network = compileScenario(hardCase);

  it('produces lanes, connectors, nodes and points', () => {
    expect(network.paths.filter(isLanePath).length).toBeGreaterThan(0);
    expect(network.paths.filter(isConnectorPath).length).toBeGreaterThan(0);
    expect(network.nodes.length).toBeGreaterThan(0);
    expect(network.points.length).toBeGreaterThan(0);
  });

  it('has no validation errors', () => {
    const problems = validateNetwork(network);
    const errors = problems.filter((p) => p.severity === 'error');
    expect(
      errors.map((p) => `${p.code}: ${p.message}`),
      'hard-case fixture should compile to a clean network',
    ).toEqual([]);
  });

  it('compiles the 5-way intersection into all three turn kinds', () => {
    const incident = new Map<string, number>();
    for (const e of hardCase.edges) {
      incident.set(e.from, (incident.get(e.from) ?? 0) + 1);
      incident.set(e.to, (incident.get(e.to) ?? 0) + 1);
    }
    const fiveWay = [...incident.entries()].find(([, n]) => n >= 5)?.[0];
    expect(fiveWay, 'fixture should have a node with 5+ incident edges').toBeDefined();
    const turns = new Set(
      network.paths.filter(isConnectorPath).filter((c) => c.node === fiveWay).map((c) => c.turn),
    );
    expect([...turns].sort()).toEqual(['left', 'right', 'through']);
  });

  it('keeps the interior vertices of curved centerlines', () => {
    // The test grid is 23/25 straight two-point edges, so this is the case it
    // cannot cover: a trimmed lane on a curved edge must keep its bend.
    const curved = network.paths
      .filter(isLanePath)
      .filter((l) => (l.debugPolyline?.length ?? 0) > 2);
    expect(curved.length).toBeGreaterThan(0);
  });

  it('drops the movement named by the node restriction', () => {
    const lanesById = new Map(network.paths.filter(isLanePath).map((l) => [l.id, l]));
    for (const node of hardCase.nodes) {
      for (const r of node.restrictions) {
        const offending = network.paths
          .filter(isConnectorPath)
          .filter(
            (c) =>
              c.node === node.id &&
              lanesById.get(c.from)?.edge === r.fromEdge &&
              lanesById.get(c.to)?.edge === r.toEdge,
          );
        expect(offending.map((c) => c.id), `${r.fromEdge} -> ${r.toEdge} is restricted`).toEqual([]);
      }
    }
  });

  it('gives the protected-left node all four phases, with lefts alone in theirs', () => {
    const node = network.nodes.find((n) => n.control === 'signalProtectedLeft');
    expect(node, 'fixture should select a signalProtectedLeft node').toBeDefined();
    expect(node?.phases?.map((p) => p.id)).toEqual(['NS-left', 'NS', 'EW-left', 'EW']);
    for (const c of network.paths.filter(isConnectorPath).filter((c) => c.node === node?.id)) {
      expect(c.phase?.endsWith('-left') ?? false, `${c.id} turns ${c.turn}`).toBe(c.turn === 'left');
      expect(c.yieldTo, `${c.id} is protected`).toEqual([]);
    }
  });

  it('is deterministic — compiling twice gives identical JSON', () => {
    expect(JSON.stringify(compileScenario(hardCase))).toBe(JSON.stringify(network));
  });
});

describe('point-no-access', () => {
  it('flags a spawn or sink that resolved to no access lane', () => {
    // Latent in the downtown import (step 8): a one-way boundary edge gives a
    // point anchored to the wrong end no lane to sit on.
    for (const type of ['edgeSpawn', 'edgeSink'] as const) {
      const network = structuredClone(golden);
      const point = network.points.find((p) => p.type === type);
      expect(point, `golden should contain an ${type}`).toBeDefined();
      if (point) point.access = [];
      const codes = validateNetwork(network).map((p) => p.code);
      expect(codes).toContain('point-no-access');
      expect(codes).not.toContain('format-mismatch');
    }
  });

  it('does not fire on either committed scenario', () => {
    for (const network of [golden, compileScenario(hardCase)]) {
      expect(validateNetwork(network).map((p) => p.code)).not.toContain('point-no-access');
    }
  });
});
