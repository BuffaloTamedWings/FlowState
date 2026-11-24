/**
 * S4: routing over the path graph (lanes + connectors), PRD §8.3.
 *
 * The PRD suggests A*, but A* needs a distance-to-goal estimate and the engine
 * has no coordinates by design. Instead we run Dijkstra *backward from each
 * destination*: for every path, the expected time from the start of that path to
 * the destination ("cost to go"). There are only a few dozen destinations, so
 * every table is rebuilt cheaply every `REFRESH_SEC`.
 *
 * One table answers every routing question:
 * - route at spawn: from the start lane, keep taking the next path with the
 *   lowest cost to go (this also picks the right lane for upcoming turns);
 * - re-routing: compare the rest of the current route with the table;
 * - reachability: an infinite cost means "can't get there from here".
 *
 * Cost of a path = length / expected speed, where expected speed is a smoothed
 * recent mean of vehicles on it (the speed limit when empty), floored so a
 * standing queue looks slow rather than impossible. A backed-up lane therefore
 * looks slower, and new vehicles choose the lane next to it.
 */
import type { CompiledPoint } from '@shared/network.js';
import type { Network } from './network.js';
import { currentPath, type Car, type Occupancy } from './traffic.js';

/** How often travel times are folded into the routing tables (sim seconds). PRD §8.3. */
export const REFRESH_SEC = 30;
/** Re-route when another route is this much better than the rest of the current one. PRD §8.3. */
export const REROUTE_GAIN = 0.15;
/** Smoothing window for expected speed (sim seconds). */
export const SMOOTHING_SEC = 30;
/** Expected speed never drops below this (m/s), so queues cost a lot but not infinity. */
export const MIN_EXPECTED_SPEED = 1;

/** Per-path expected speed, smoothed from what vehicles are actually doing. */
export class TravelTimes {
  /** m/s, by path index. */
  readonly expectedSpeed: Float64Array;

  constructor(private readonly net: Network) {
    this.expectedSpeed = Float64Array.from(net.speedLimit);
  }

  /**
   * Fold in one sample (call once per sim second). Empty paths drift back toward
   * their speed limit; occupied ones toward the mean speed of their vehicles.
   */
  sample(occ: Occupancy, dtSec: number): void {
    const alpha = Math.min(1, dtSec / SMOOTHING_SEC);
    for (let p = 0; p < this.net.count; p++) {
      const here = occ.on(p);
      let target = this.net.speedLimit[p]!;
      if (here.length > 0) {
        let sum = 0;
        for (const c of here) sum += c.v;
        target = sum / here.length;
      }
      const v = this.expectedSpeed[p]! + alpha * (target - this.expectedSpeed[p]!);
      this.expectedSpeed[p] = Math.max(MIN_EXPECTED_SPEED, v);
    }
  }

  /** Seconds to traverse path `p` end to end. */
  cost(p: number): number {
    return this.net.length[p]! / this.expectedSpeed[p]!;
  }

  /** Seconds to drive the first `s` meters of path `p`. */
  partial(p: number, s: number): number {
    return s / this.expectedSpeed[p]!;
  }
}

/** Expected seconds from the *start* of each path to the destination; Infinity if unreachable. */
export type CostToGo = Float64Array;

/** Small binary min-heap of path indices keyed by cost. */
class Heap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];
  get size(): number { return this.items.length; }
  push(item: number, key: number): void {
    const { items, keys } = this;
    let i = items.length;
    items.push(item); keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! < key || (keys[parent] === key && items[parent]! <= item)) break;
      items[i] = items[parent]!; keys[i] = keys[parent]!;
      i = parent;
    }
    items[i] = item; keys[i] = key;
  }
  pop(): { item: number; key: number } {
    const { items, keys } = this;
    const top = { item: items[0]!, key: keys[0]! };
    const lastItem = items.pop()!; const lastKey = keys.pop()!;
    if (items.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1;
        let m = -1;
        if (l < items.length) m = l;
        if (r < items.length && (keys[r]! < keys[l]! || (keys[r] === keys[l] && items[r]! < items[l]!))) m = r;
        if (m < 0 || keys[m]! > lastKey || (keys[m] === lastKey && items[m]! >= lastItem)) break;
        items[i] = items[m]!; keys[i] = keys[m]!;
        i = m;
      }
      items[i] = lastItem; keys[i] = lastKey;
    }
    return top;
  }
}

/** Dijkstra backward from a destination's access lanes over `net.prev`. */
export function costToGo(net: Network, tt: TravelTimes, dest: CompiledPoint): CostToGo {
  const ctg = new Float64Array(net.count).fill(Infinity);
  const heap = new Heap();
  for (const a of dest.access) {
    const p = net.byId.get(a.path)!;
    const c = tt.partial(p, a.s);
    if (c < ctg[p]!) { ctg[p] = c; heap.push(p, c); }
  }
  while (heap.size > 0) {
    const { item: p, key } = heap.pop();
    if (key > ctg[p]!) continue; // stale entry
    for (const q of net.prev[p]!) {
      const c = tt.cost(q) + key;
      if (c < ctg[q]!) { ctg[q] = c; heap.push(q, c); }
    }
  }
  return ctg;
}

/** One cost-to-go table per destination point, rebuilt together. */
export class Router {
  private tables = new Map<string, CostToGo>();
  /** destination point id → (path index → access s on that path). */
  private readonly accessAt = new Map<string, Map<number, number>>();

  constructor(private readonly net: Network, readonly travel: TravelTimes) {
    for (const pt of net.points.values()) {
      const m = new Map<number, number>();
      for (const a of pt.access) m.set(net.byId.get(a.path)!, a.s);
      this.accessAt.set(pt.id, m);
    }
    this.refresh();
  }

  /** Rebuild every table from the current expected speeds. */
  refresh(): void {
    const next = new Map<string, CostToGo>();
    for (const pt of this.net.points.values()) next.set(pt.id, costToGo(this.net, this.travel, pt));
    this.tables = next;
  }

  table(destId: string): CostToGo {
    const t = this.tables.get(destId);
    if (!t) throw new Error(`unknown destination point ${destId}`);
    return t;
  }

  /** Expected seconds from position `s` on path `p` to the destination. */
  costFrom(destId: string, p: number, s: number): number {
    const here = this.accessAt.get(destId)?.get(p);
    if (here !== undefined && here >= s) return this.travel.partial(p, here - s);
    const ctg = this.table(destId);
    let best = Infinity;
    for (const j of this.net.next[p]!) best = Math.min(best, ctg[j]!);
    return best === Infinity ? Infinity : this.travel.partial(p, this.net.length[p]! - s) + best;
  }

  /**
   * Greedy route from position `s` on path `start` to `destId`, following the
   * table. Returns the path list and where the trip ends on the last path, or
   * null if the destination can't be reached from here.
   */
  route(destId: string, start: number, s: number): { route: Int32Array; endS: number } | null {
    const access = this.accessAt.get(destId);
    if (!access) throw new Error(`unknown destination point ${destId}`);
    const ctg = this.table(destId);
    const out = [start];
    const startHere = access.get(start);
    if (startHere !== undefined && startHere >= s) return { route: Int32Array.from(out), endS: startHere };

    let cur = start;
    for (let guard = 0; guard < this.net.count; guard++) {
      let best = -1;
      let bestCost = Infinity;
      for (const j of this.net.next[cur]!) {
        const c = ctg[j]!;
        if (c < bestCost || (c === bestCost && j < best)) { best = j; bestCost = c; }
      }
      if (best < 0) return null;
      out.push(best);
      cur = best;
      const end = access.get(cur);
      if (end !== undefined) return { route: Int32Array.from(out), endS: end };
    }
    return null; // a cycle in the table would be a bug; treat as unreachable
  }

  /** Expected seconds to finish the vehicle's current route from where it is now. */
  remainingCost(car: Car, endS: number): number {
    const last = car.route.length - 1;
    if (car.leg === last) return this.travel.partial(currentPath(car), Math.max(0, endS - car.s));
    let t = this.travel.partial(currentPath(car), this.net.length[currentPath(car)]! - car.s);
    for (let leg = car.leg + 1; leg < last; leg++) t += this.travel.cost(car.route[leg]!);
    return t + this.travel.partial(car.route[last]!, endS);
  }

  /**
   * Re-route check (PRD §8.3), called when a vehicle enters a new lane: if the
   * best route from here beats the rest of the current one by more than
   * REROUTE_GAIN, return the new route; otherwise null.
   */
  reroute(car: Car, destId: string, endS: number): { route: Int32Array; endS: number } | null {
    const p = currentPath(car);
    const best = this.costFrom(destId, p, car.s);
    if (!(best < (1 - REROUTE_GAIN) * this.remainingCost(car, endS))) return null;
    return this.route(destId, p, car.s);
  }
}

/** Route length divided by speed limits: the trip with no other traffic (for metrics). */
export function freeFlowTime(net: Network, route: Int32Array, startS: number, endS: number): number {
  if (route.length === 1) return Math.max(0, endS - startS) / net.speedLimit[route[0]!]!;
  let t = (net.length[route[0]!]! - startS) / net.speedLimit[route[0]!]!;
  for (let i = 1; i < route.length - 1; i++) t += net.length[route[i]!]! / net.speedLimit[route[i]!]!;
  const last = route[route.length - 1]!;
  return t + endS / net.speedLimit[last]!;
}
