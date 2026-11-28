/**
 * Resolves each scenario `Point`'s access to compiled lane paths. Ported from
 * `tools/reference/make_sample.py`'s `access_for`.
 */

import type { Point, Scenario } from '@shared/scenario.js';
import type { CompiledPoint, LanePath, PointAccess } from '@shared/network.js';

import { round2 } from '@web/geometry/polyline.js';

function accessFor(
  point: Point,
  lanes: LanePath[],
  incomingByNode: Map<string, LanePath[]>,
  outgoingByNode: Map<string, LanePath[]>,
): PointAccess[] {
  const acc: PointAccess[] = [];
  if (point.node !== undefined) {
    const node = point.node;
    if (point.type === 'edgeSpawn' || point.type === 'rampSpawn') {
      for (const p of outgoingByNode.get(node) ?? []) {
        acc.push({ path: p.id, s: 0 });
      }
    } else {
      for (const p of incomingByNode.get(node) ?? []) {
        acc.push({ path: p.id, s: p.length });
      }
    }
  } else if (point.at !== undefined) {
    const { edge, t } = point.at;
    for (const dir of ['f', 'b'] as const) {
      const ls = lanes.filter((p) => p.edge === edge && p.dir === dir);
      if (ls.length === 0) continue;
      // Rightmost car lane of this direction.
      let rightmost = ls[0];
      for (const l of ls) {
        if (rightmost === undefined || l.laneIndex > rightmost.laneIndex) rightmost = l;
      }
      if (!rightmost) continue;
      const s = dir === 'f' ? t : 1 - t;
      acc.push({ path: rightmost.id, s: round2(s * rightmost.length) });
    }
  }
  return acc;
}

export function buildPoints(
  scenario: Scenario,
  lanes: LanePath[],
  incomingByNode: Map<string, LanePath[]>,
  outgoingByNode: Map<string, LanePath[]>,
): CompiledPoint[] {
  const compiled: CompiledPoint[] = [];
  for (const point of scenario.points) {
    const access = accessFor(point, lanes, incomingByNode, outgoingByNode);
    const cp: CompiledPoint = {
      id: point.id,
      type: point.type,
      weight: point.weight ?? 1,
      access,
    };
    if (point.type === 'parking' && point.capacity !== undefined) {
      cp.capacity = point.capacity;
    }
    compiled.push(cp);
  }
  return compiled;
}
