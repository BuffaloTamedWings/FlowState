/**
 * Per-path stats for the `stats` message (PRD §7.6): 4 floats per path, in
 * `index` order, laid out by the `STATS_*` offsets in `shared/messages.ts`.
 *
 *  - speed ratio: mean speed of vehicles whose front is on the path ÷ its limit.
 *    An empty path reports 1 (free flow), so the heatmap shows it green.
 *  - occupancy: share of the path covered by vehicle bodies, 0–1.
 *  - queue length: the standing queue at the end of the path (m): from the end
 *    back to the tail of the last vehicle in an unbroken line of stopped vehicles
 *    starting at the front. 0 if the front vehicle is moving or far from the end.
 *  - flow: vehicles that left the path, per minute, over the stats interval.
 */
import { STATS_FLOW, STATS_OCCUPANCY, STATS_QUEUE_LENGTH, STATS_SPEED_RATIO, STATS_STRIDE } from '@shared/messages.js';
import type { Network } from './network.js';
import { currentPath, lengthOf, paramsOf, type Car } from './traffic.js';

/** Below this speed a vehicle counts as standing in a queue (m/s). */
export const QUEUE_SPEED = 1;
/** The queue's front vehicle must be within this of the path end (m), on top of its min gap. */
const QUEUE_FRONT_SLACK = 5;
/** Consecutive queued vehicles may be at most this much further apart than their min gap (m). */
const QUEUE_SPACING_SLACK = 4;

export function computeStats(net: Network, cars: readonly Car[], exits: Uint32Array, intervalSec: number): Float32Array<ArrayBuffer> {
  const n = net.count;
  const buf = new Float32Array(n * STATS_STRIDE);
  const speedSum = new Float64Array(n);
  const fronts: Car[][] = Array.from({ length: n }, () => []);
  const covered = new Float64Array(n);

  for (const c of cars) {
    const p = currentPath(c);
    speedSum[p]! += c.v;
    fronts[p]!.push(c);
    // Body coverage, front path back along the route.
    let hi = c.s;
    let remaining = lengthOf(c);
    for (let leg = c.leg; leg >= 0 && remaining > 1e-6; leg--) {
      const path = c.route[leg]!;
      if (leg < c.leg) hi = net.length[path]!;
      const lo = Math.max(0, hi - remaining);
      covered[path]! += hi - lo;
      remaining -= hi - lo;
    }
  }

  for (let p = 0; p < n; p++) {
    const o = p * STATS_STRIDE;
    const here = fronts[p]!;
    const len = net.length[p]!;
    buf[o + STATS_SPEED_RATIO] = here.length > 0 ? speedSum[p]! / here.length / net.speedLimit[p]! : 1;
    buf[o + STATS_OCCUPANCY] = Math.min(1, covered[p]! / len);
    buf[o + STATS_QUEUE_LENGTH] = queueLength(here, len);
    buf[o + STATS_FLOW] = intervalSec > 0 ? (exits[p]! * 60) / intervalSec : 0;
  }
  return buf;
}

/** Standing queue at the end of a path (m), from the vehicles whose front is on it. */
export function queueLength(onPath: readonly Car[], pathLength: number): number {
  if (onPath.length === 0) return 0;
  const sorted = [...onPath].sort((a, b) => b.s - a.s);
  const front = sorted[0]!;
  if (front.v >= QUEUE_SPEED || pathLength - front.s > paramsOf(front).minGap + QUEUE_FRONT_SLACK) return 0;
  let tail = front.s - lengthOf(front);
  for (let k = 1; k < sorted.length; k++) {
    const c = sorted[k]!;
    if (c.v >= QUEUE_SPEED || tail - c.s > paramsOf(c).minGap + QUEUE_SPACING_SLACK) break;
    tail = c.s - lengthOf(c);
  }
  return Math.min(pathLength, pathLength - Math.max(0, tail));
}
