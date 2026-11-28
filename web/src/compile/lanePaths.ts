/**
 * Rule 1 (PRD §7.4): build every `LanePath` from the scenario's selected edge
 * options. Ported from the first loop of `tools/reference/make_sample.py`'s
 * compile section (building `paths`, `lanes_by_node_in`, `lanes_by_node_out`).
 */

import type { Scenario } from '@shared/scenario.js';
import { selectedEdgeOption, selectedNodeOption } from '@shared/scenario.js';
import type { LanePath, LaneDir } from '@shared/network.js';

import { laneCenterlines, nodeSetback } from '@web/geometry/laneLayout.js';
import { polylineLength, round2, trimPolyline } from '@web/geometry/polyline.js';

export interface LanePathsResult {
  lanes: LanePath[];
  /** Lane paths leaving a node, keyed by that node's id, in build order. */
  outgoingByNode: Map<string, LanePath[]>;
  /** Lane paths arriving at a node, keyed by that node's id, in build order. */
  incomingByNode: Map<string, LanePath[]>;
}

const DIRS: LaneDir[] = ['f', 'b'];

export function buildLanePaths(scenario: Scenario): LanePathsResult {
  const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
  const lanes: LanePath[] = [];
  const outgoingByNode = new Map<string, LanePath[]>();
  const incomingByNode = new Map<string, LanePath[]>();

  for (const edge of scenario.edges) {
    const option = selectedEdgeOption(edge);
    for (const dir of DIRS) {
      const startId = dir === 'f' ? edge.from : edge.to;
      const endId = dir === 'f' ? edge.to : edge.from;
      const startNode = nodesById.get(startId);
      const endNode = nodesById.get(endId);
      if (!startNode || !endNode) {
        throw new Error(`edge ${edge.id} references a node not in the scenario`);
      }
      const setbackStart = nodeSetback(startNode, selectedNodeOption(startNode));
      const setbackEnd = nodeSetback(endNode, selectedNodeOption(endNode));

      const centerlines = laneCenterlines(edge, option, dir);
      for (const lc of centerlines) {
        if (lc.lane.type !== 'car') continue; // engine only simulates cars
        const trimmed = trimPolyline(lc.centerline, setbackStart, setbackEnd);
        const path: LanePath = {
          id: `L/${edge.id}/${dir}/${lc.laneIndex}`,
          kind: 'lane',
          edge: edge.id,
          dir,
          laneIndex: lc.laneIndex,
          fromNode: startId,
          toNode: endId,
          length: round2(polylineLength(trimmed)),
          speedLimit: edge.speedLimit,
          turns: lc.lane.turns ?? null,
          next: [],
          debugPolyline: trimmed.map(([x, y]) => [round2(x), round2(y)]),
          // Key placed last (matching the reference, which appends `index`
          // after building the whole array) so JSON key order matches the
          // golden file; the real value is assigned later by compileScenario.
          index: 0,
        };
        lanes.push(path);

        const outArr = outgoingByNode.get(startId);
        if (outArr) outArr.push(path);
        else outgoingByNode.set(startId, [path]);

        const inArr = incomingByNode.get(endId);
        if (inArr) inArr.push(path);
        else incomingByNode.set(endId, [path]);
      }
    }
  }

  return { lanes, outgoingByNode, incomingByNode };
}
