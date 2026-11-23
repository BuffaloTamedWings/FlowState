/**
 * Per-edge lane centerlines and node setbacks, ported from
 * `tools/reference/make_sample.py`'s `lane_geometry` and `setback`.
 */

import type { Polyline } from '@shared/common.js';
import type { Edge, EdgeOption, Lane, Node, NodeOption } from '@shared/scenario.js';
import { laneWidth } from '@shared/scenario.js';
import { NODE_SETBACKS } from '@shared/network.js';

import { offsetPolyline } from './polyline.js';

/** One lane's centerline, with its index in that direction (0 = leftmost). */
export interface LaneCenterline {
  laneIndex: number;
  lane: Lane;
  centerline: Polyline;
}

/**
 * Centerlines for every lane of `edge` traveling in direction `dir`, built
 * from `option`. Reference: `lane_geometry`.
 *
 * Includes bike and transit lanes — filtering to car-only lanes is the
 * compile step's job (step 4), not geometry's.
 *
 * Offset rule (PRD §7.1 / CLAUDE.md): lane order is left to right in the
 * direction of travel, 0 = leftmost. If the opposite direction has any lanes
 * (two-way street), this direction's lanes sit entirely right of the edge
 * centerline (lane 0 starts at offset 0). If the opposite direction is empty
 * (one-way street), the lanes are centered on the edge centerline instead.
 */
export function laneCenterlines(edge: Edge, option: EdgeOption, dir: 'f' | 'b'): LaneCenterline[] {
  const lanes = dir === 'f' ? option.forward : option.backward;
  const other = dir === 'f' ? option.backward : option.forward;

  let cl: Polyline = edge.centerline;
  if (dir === 'b') {
    cl = [...cl].reverse();
  }

  // Deliberate divergence from the reference: `lane_geometry` always takes the
  // width from the lane's *type*, ignoring a per-lane `width` override, because
  // no lane in the test grid has one. PRD §7.1 does define the override ("car /
  // transit 3.5 m, bike 1.8 m unless a lane has `width`"), so `laneWidth()`
  // honors it here. The golden file is unaffected — it has no overrides — but
  // imported downtown data may.
  const widths = lanes.map((l) => laneWidth(l));
  const totalWidth = widths.reduce((a, w) => a + w, 0);
  const start = other.length > 0 ? 0 : -totalWidth / 2;

  const result: LaneCenterline[] = [];
  let acc = start;
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    const w = widths[i];
    if (!lane || w === undefined) continue;
    const off = acc + w / 2;
    acc += w;
    result.push({ laneIndex: i, lane, centerline: offsetPolyline(cl, off) });
  }
  return result;
}

/**
 * How far a lane must be trimmed back from `node`, given the node's selected
 * option. Reference: `setback`.
 *
 * Roundabouts don't have a fixed kind-based setback: the ring itself occupies
 * `params.radius` meters, plus a fixed margin (`NODE_SETBACKS.roundaboutMargin`)
 * so the lane end sits clear of the ring rather than right at its edge.
 */
export function nodeSetback(node: Node, selectedOption: NodeOption): number {
  if (selectedOption.control === 'roundabout') {
    const radius = selectedOption.params.radius ?? 0;
    return radius + NODE_SETBACKS.roundaboutMargin;
  }
  return NODE_SETBACKS[node.kind];
}
