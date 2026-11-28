/**
 * Rules 2-6 (PRD §7.4): build every `ConnectorPath` at each intersection,
 * merge and diverge node. Ported from `tools/reference/make_sample.py`'s
 * `make_conn` and the node loop that follows it.
 */

import type { Node, Scenario, Turn } from '@shared/scenario.js';
import type { ConnectorPath, ConnectorTurn, LanePath } from '@shared/network.js';
import { TURN_SPEED_LIMIT } from '@shared/network.js';

import { connectorCurve } from '@web/geometry/connector.js';
import { headingAtEnd, headingAtStart, polylineLength, round2 } from '@web/geometry/polyline.js';

import { assignTurns, groupApproaches, turnOf } from './movements.js';

export interface ConnectorBuildResult {
  connectors: ConnectorPath[];
  /**
   * Connector ids that are merge/diverge ramp branches (the Python
   * reference's transient `isBranch` field, kept out of the output type).
   */
  branchIds: Set<string>;
}

/** Builds one connector and wires it into `from`'s `next`. Reference: `make_conn`. */
function makeConnector(
  node: string,
  from: LanePath,
  to: LanePath,
  turn: ConnectorTurn,
  isBranch: boolean,
  out: ConnectorPath[],
  branchIds: Set<string>,
): ConnectorPath {
  const fromPts = from.debugPolyline;
  const toPts = to.debugPolyline;
  if (!fromPts || fromPts.length === 0 || !toPts || toPts.length === 0) {
    throw new Error(`connector at ${node}: lane ${from.id} or ${to.id} has no geometry`);
  }
  const p0 = fromPts[fromPts.length - 1];
  const p2 = toPts[0];
  if (!p0 || !p2) {
    throw new Error(`connector at ${node}: lane ${from.id} or ${to.id} has no endpoint`);
  }
  const h0 = headingAtEnd(fromPts);
  const h1 = headingAtStart(toPts);
  const curve = connectorCurve(p0, h0, p2, h1, 16);
  const speedLimit = turn === 'through' ? Math.min(from.speedLimit, to.speedLimit) : TURN_SPEED_LIMIT;
  const id = `C/${node}/${from.id.slice(2)}>${to.id.slice(2)}`;
  const connector: ConnectorPath = {
    id,
    kind: 'connector',
    node,
    from: from.id,
    to: to.id,
    turn,
    length: round2(polylineLength(curve)),
    speedLimit,
    phase: null,
    stop: false,
    yieldTo: [],
    conflicts: [],
    debugPolyline: curve.map(([x, y]) => [round2(x), round2(y)]),
    next: [to.id],
    // Key placed last (matching the reference, which appends `index` after
    // building the whole array) so JSON key order matches the golden file;
    // the real value is assigned later by compileScenario.
    index: 0,
  };
  out.push(connector);
  from.next.push(connector.id);
  if (isBranch) branchIds.add(connector.id);
  return connector;
}

function approachEdge(group: LanePath[]): string | undefined {
  return group[0]?.edge;
}

export function buildConnectors(
  scenario: Scenario,
  incomingByNode: Map<string, LanePath[]>,
  outgoingByNode: Map<string, LanePath[]>,
): ConnectorBuildResult {
  const connectors: ConnectorPath[] = [];
  const branchIds = new Set<string>();

  for (const node of scenario.nodes) {
    if (node.kind === 'boundary' || node.kind === 'rampEnd') continue;

    const ins = groupApproaches(incomingByNode.get(node.id) ?? []);
    const outs = groupApproaches(outgoingByNode.get(node.id) ?? []);

    if (node.kind === 'merge' || node.kind === 'diverge') {
      buildMergeDiverge(node, ins, outs, connectors, branchIds);
      continue;
    }

    buildIntersection(node, ins, outs, connectors, branchIds);
  }

  return { connectors, branchIds };
}

function buildMergeDiverge(
  node: Node,
  ins: Map<string, LanePath[]>,
  outs: Map<string, LanePath[]>,
  connectors: ConnectorPath[],
  branchIds: Set<string>,
): void {
  const branch = node.branch;
  if (!branch) throw new Error(`node ${node.id} is ${node.kind} but has no branch`);
  const branchEdge = branch.edge;

  const mainIn = [...ins.values()].filter((g) => approachEdge(g) !== branchEdge);
  const mainOut = [...outs.values()].filter((g) => approachEdge(g) !== branchEdge);

  for (const li of mainIn) {
    for (const lo of mainOut) {
      for (let i = 0; i < li.length; i++) {
        const a = li[i];
        const b = lo[Math.min(i, lo.length - 1)];
        if (!a || !b) continue;
        makeConnector(node.id, a, b, 'through', false, connectors, branchIds);
      }
    }
  }

  const sideLeft = branch.side === 'left';
  if (node.kind === 'merge') {
    for (const li of ins.values()) {
      if (approachEdge(li) !== branchEdge) continue;
      for (const lo of mainOut) {
        const targets = sideLeft ? lo : [...lo].reverse();
        // Ramp traffic may merge into any main lane (it picks the one its route needs).
        for (const a of li) {
          for (const tgt of targets) {
            makeConnector(node.id, a, tgt, 'through', true, connectors, branchIds);
          }
        }
      }
    }
  } else {
    for (const lo of outs.values()) {
      if (approachEdge(lo) !== branchEdge) continue;
      const first = lo[0];
      if (!first) continue;
      for (const li of mainIn) {
        const src = sideLeft ? li[0] : li[li.length - 1];
        if (!src) continue;
        makeConnector(node.id, src, first, 'through', true, connectors, branchIds);
      }
    }
  }
}

function buildIntersection(
  node: Node,
  ins: Map<string, LanePath[]>,
  outs: Map<string, LanePath[]>,
  connectors: ConnectorPath[],
  branchIds: Set<string>,
): void {
  const banned = new Set(node.restrictions.map((r) => `${r.fromEdge}>${r.toEdge}`));

  for (const li of ins.values()) {
    const ke = approachEdge(li);
    const liFirst = li[0];
    if (ke === undefined || !liFirst) continue;

    const moves: Array<{ turn: Turn; lo: LanePath[] }> = [];
    for (const lo of outs.values()) {
      const oe = approachEdge(lo);
      const loFirst = lo[0];
      if (oe === undefined || !loFirst) continue;
      if (oe === ke || banned.has(`${ke}>${oe}`)) continue;
      const t = turnOf(headingAtEnd(liFirst.debugPolyline ?? []), headingAtStart(loFirst.debugPolyline ?? []));
      if (t !== 'uturn') moves.push({ turn: t, lo });
    }

    const available = new Set(moves.map((m) => m.turn));
    const allowed = assignTurns(li, available);

    for (const { turn, lo } of moves) {
      let srcs = li.filter((p) => allowed.get(p.id)?.has(turn));
      if (srcs.length === 0) continue;
      const outsOrd = turn === 'right' ? [...lo].reverse() : [...lo];
      if (turn === 'right') srcs = [...srcs].reverse();

      if (srcs.length === 1) {
        const only = srcs[0];
        if (only) {
          // One lane makes this movement: it may enter ANY outgoing lane
          // (this is where a car "picks its lane" for its next turn).
          for (const b of outsOrd) {
            makeConnector(node.id, only, b, turn, false, connectors, branchIds);
          }
        }
      } else {
        for (let j = 0; j < srcs.length; j++) {
          const a = srcs[j];
          const b = outsOrd[Math.min(j, outsOrd.length - 1)];
          if (!a || !b) continue;
          makeConnector(node.id, a, b, turn, false, connectors, branchIds);
        }
        const last = srcs[srcs.length - 1];
        if (last) {
          // Extra outgoing lanes beyond srcs.length are fed by the outermost source lane.
          for (let k = srcs.length; k < outsOrd.length; k++) {
            const b = outsOrd[k];
            if (!b) continue;
            makeConnector(node.id, last, b, turn, false, connectors, branchIds);
          }
        }
      }
    }
  }
}
