/**
 * Orchestrates the compile step: scenario -> compiled network. Ported from
 * `tools/reference/make_sample.py`'s "5. Compile the current layout" section.
 *
 * Determinism: every grouping here is an array or a `Map` built by iterating
 * the scenario in its own order (never a plain object keyed by id), so the
 * same scenario always produces byte-identical JSON.
 */

import type { CompiledNetwork, CompiledPath, ConnectorPath } from '@shared/network.js';
import { NETWORK_FORMAT, NETWORK_VERSION } from '@shared/network.js';
import type { Scenario } from '@shared/scenario.js';
import { selectedEdgeOption, selectedNodeOption } from '@shared/scenario.js';

import { buildLanePaths } from './lanePaths.js';
import { buildConnectors } from './connectors.js';
import { assignConflicts } from './conflicts.js';
import { buildNodes } from './control.js';
import { buildPoints } from './points.js';

/** Groups connectors by node, preserving creation order (both within and across nodes). */
function groupConnectorsByNode(connectors: ConnectorPath[]): Map<string, ConnectorPath[]> {
  const byNode = new Map<string, ConnectorPath[]>();
  for (const c of connectors) {
    const arr = byNode.get(c.node);
    if (arr) arr.push(c);
    else byNode.set(c.node, [c]);
  }
  return byNode;
}

export function compileScenario(scenario: Scenario): CompiledNetwork {
  const { lanes, incomingByNode, outgoingByNode } = buildLanePaths(scenario);
  const lanesById = new Map(lanes.map((l) => [l.id, l]));

  const { connectors, branchIds } = buildConnectors(scenario, incomingByNode, outgoingByNode);

  const connectorsByNode = groupConnectorsByNode(connectors);
  assignConflicts(connectorsByNode);

  const compiledNodes = buildNodes(scenario, connectorsByNode, lanesById, branchIds);

  const allPaths: CompiledPath[] = [...lanes, ...connectors];
  for (let i = 0; i < allPaths.length; i++) {
    const p = allPaths[i];
    if (p) p.index = i;
  }

  const points = buildPoints(scenario, lanes, incomingByNode, outgoingByNode);

  const edgesLayout: Record<string, string> = {};
  for (const edge of scenario.edges) {
    edgesLayout[edge.id] = selectedEdgeOption(edge).id;
  }
  const nodesLayout: Record<string, string> = {};
  for (const node of scenario.nodes) {
    nodesLayout[node.id] = selectedNodeOption(node).id;
  }

  return {
    format: NETWORK_FORMAT,
    version: NETWORK_VERSION,
    scenario: scenario.meta.id,
    layout: { edges: edgesLayout, nodes: nodesLayout },
    units: scenario.meta.units,
    paths: allPaths,
    nodes: compiledNodes,
    points,
  };
}
