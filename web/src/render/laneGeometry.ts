/**
 * Drawable centerlines and boundary lines for *every* lane of a scenario
 * (car, bike, transit) — the compiled network only has car lanes. Mirrors
 * the trimming in `web/src/compile/lanePaths.ts` exactly, so a car lane's
 * `DrawableLane.centerline` lines up with its compiled `LanePath.debugPolyline`
 * vertex-for-vertex. Pure TypeScript — no Three.js.
 */

import type { Polyline } from '@shared/common.js';
import type { Edge, Lane, Scenario } from '@shared/scenario.js';
import { selectedEdgeOption, selectedNodeOption } from '@shared/scenario.js';

import { laneCenterlines, nodeSetback } from '@web/geometry/laneLayout.js';
import { offsetPolyline, trimPolyline } from '@web/geometry/polyline.js';
import { laneWidth } from '@shared/scenario.js';

import { elevationSampler, polylineElevations } from './elevation.js';

export interface DrawableLane {
  edge: string;
  dir: 'f' | 'b';
  laneIndex: number;
  type: Lane['type'];
  width: number;
  centerline: Polyline;
  z: number[];
  /** `L/{edge}/{dir}/{laneIndex}` — matches `LanePath.id` for car lanes. */
  id: string;
}

export interface LaneBoundary {
  points: Polyline;
  z: number[];
  kind: 'edge' | 'divider' | 'centerline';
}

const DIRS: Array<'f' | 'b'> = ['f', 'b'];

/**
 * Builds a `t -> z` sampler for lane direction `dir`. `elevationSampler`'s `t`
 * runs `edge.from -> edge.to` (matching `edge.elevation`'s index order); a
 * `dir === 'b'` lane centerline runs the opposite way, so its own fraction
 * `t` along itself corresponds to `1 - t` in the edge's frame.
 */
function dirSampler(edge: Edge, dir: 'f' | 'b'): (t: number) => number {
  const base = elevationSampler(edge);
  return dir === 'f' ? base : (t: number) => base(1 - t);
}

export function drawableLanes(scenario: Scenario): DrawableLane[] {
  const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
  const out: DrawableLane[] = [];

  for (const edge of scenario.edges) {
    const option = selectedEdgeOption(edge);
    const sampler = (dir: 'f' | 'b') => dirSampler(edge, dir);

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
      const samp = sampler(dir);
      for (const lc of centerlines) {
        const trimmed = trimPolyline(lc.centerline, setbackStart, setbackEnd);
        out.push({
          edge: edge.id,
          dir,
          laneIndex: lc.laneIndex,
          type: lc.lane.type,
          width: laneWidth(lc.lane),
          centerline: trimmed,
          z: polylineElevations(trimmed, samp),
          id: `L/${edge.id}/${dir}/${lc.laneIndex}`,
        });
      }
    }
  }

  return out;
}

export function laneBoundaries(scenario: Scenario): LaneBoundary[] {
  const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
  const out: LaneBoundary[] = [];

  for (const edge of scenario.edges) {
    const option = selectedEdgeOption(edge);

    for (const dir of DIRS) {
      const lanes = dir === 'f' ? option.forward : option.backward;
      if (lanes.length === 0) continue;

      const other = dir === 'f' ? option.backward : option.forward;
      const startId = dir === 'f' ? edge.from : edge.to;
      const endId = dir === 'f' ? edge.to : edge.from;
      const startNode = nodesById.get(startId);
      const endNode = nodesById.get(endId);
      if (!startNode || !endNode) {
        throw new Error(`edge ${edge.id} references a node not in the scenario`);
      }
      const setbackStart = nodeSetback(startNode, selectedNodeOption(startNode));
      const setbackEnd = nodeSetback(endNode, selectedNodeOption(endNode));

      let cl: Polyline = edge.centerline;
      if (dir === 'b') cl = [...cl].reverse();

      const widths = lanes.map((l) => laneWidth(l));
      const totalWidth = widths.reduce((a, w) => a + w, 0);
      const start = other.length > 0 ? 0 : -totalWidth / 2;

      const samp = dirSampler(edge, dir);

      let acc = start;
      const offsets = [acc];
      for (const w of widths) {
        acc += w;
        offsets.push(acc);
      }

      for (let i = 0; i < offsets.length; i++) {
        const off = offsets[i];
        if (off === undefined) continue;
        // On a two-way street the innermost boundary (offset 0) *is* the edge
        // centerline, and both directions produce it. Skip it here so it is
        // emitted exactly once, below, as the gold `centerline` — otherwise
        // three coincident lines z-fight and the two white ones usually win.
        if (other.length > 0 && i === 0) continue;
        const boundary = offsetPolyline(cl, off);
        const trimmed = trimPolyline(boundary, setbackStart, setbackEnd);
        const kind: LaneBoundary['kind'] = i === 0 || i === offsets.length - 1 ? 'edge' : 'divider';
        out.push({ points: trimmed, z: polylineElevations(trimmed, samp), kind });
      }
    }

    // When both directions have lanes, the edge centerline itself is a
    // dividing line (double yellow) between them.
    if (option.forward.length > 0 && option.backward.length > 0) {
      const startNode = nodesById.get(edge.from);
      const endNode = nodesById.get(edge.to);
      if (!startNode || !endNode) {
        throw new Error(`edge ${edge.id} references a node not in the scenario`);
      }
      const setbackStart = nodeSetback(startNode, selectedNodeOption(startNode));
      const setbackEnd = nodeSetback(endNode, selectedNodeOption(endNode));
      const trimmed = trimPolyline(edge.centerline, setbackStart, setbackEnd);
      const samp = dirSampler(edge, 'f');
      out.push({ points: trimmed, z: polylineElevations(trimmed, samp), kind: 'centerline' });
    }
  }

  return out;
}
