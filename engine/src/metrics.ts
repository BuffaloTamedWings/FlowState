/**
 * S8: what the engine measures for scoring (PRD §9.1), beyond trips and counts.
 *
 * **Control delay per intersection** (the Highway Capacity Manual measure behind
 * level of service): for each vehicle that passes through a node,
 *
 *     delay = (time from entering the approach lane to leaving the connector)
 *           − (free-flow time over the same distance: lane ÷ lane limit + connector ÷ connector limit)
 *
 * The approach starts where the vehicle joined the lane (its start, or mid-lane
 * for garage exits). Vehicles that leave mid-lane, or are removed as gridlocked,
 * are not counted. Braking for a slow turn counts as a little delay even with no
 * control, as in field measurements of control delay.
 *
 * **Max queue per path:** the largest standing queue (same definition as the
 * `stats` message) sampled once per sim-second.
 *
 * Both are **running totals since load** (average over every vehicle served so
 * far, max so far). Level of service is an average over a period, and 5-second
 * windows are shorter than one signal cycle. A restart from empty resets them.
 */
import type { NodeMetrics, PathMetrics } from '@shared/messages.js';
import type { Network } from './network.js';
import { queueLength } from './stats.js';
import { currentPath, type Car, type Occupancy } from './traffic.js';

export type Los = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** Upper bounds (s/veh) for A–E; above the last is F. PRD §9.2 (HCM). */
const SIGNAL_LOS = [10, 20, 35, 55, 80];
const STOP_LOS = [10, 15, 25, 35, 50];

/**
 * HCM level of service for an average control delay. Signals use the signalized
 * table; every other control (stops, yields, merges, roundabouts) the
 * unsignalized one.
 */
export function levelOfService(delaySec: number, control: string): Los {
  const bounds = control === 'signal' || control === 'signalProtectedLeft' ? SIGNAL_LOS : STOP_LOS;
  const grades: Los[] = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < bounds.length; i++) if (delaySec <= bounds[i]!) return grades[i]!;
  return 'F';
}

interface Approach {
  /** Lane the vehicle is approaching on. */
  lane: number;
  /** Sim time it joined that lane, and where along it. */
  t: number;
  s: number;
}

interface Crossing {
  node: string;
  start: number;
  freeFlow: number;
}

export class MetricsTracker {
  private readonly approach = new Map<number, Approach>();
  private readonly crossing = new Map<number, Crossing>();
  private readonly delaySum = new Map<string, number>();
  private readonly served = new Map<string, number>();
  private readonly maxQueue: Float64Array;

  constructor(private readonly net: Network) {
    this.maxQueue = new Float64Array(net.count);
    for (const id of net.nodes.keys()) {
      this.delaySum.set(id, 0);
      this.served.set(id, 0);
    }
  }

  /** A vehicle just appeared on the map. */
  entered(car: Car, time: number): void {
    const p = currentPath(car);
    if (this.net.isLane[p] === 1) this.approach.set(car.id, { lane: p, t: time, s: car.s });
  }

  /**
   * A vehicle moved on from route leg `prevLeg` during the step that ended at
   * `time`. Call before any re-route, so `car.route` is still the route it drove.
   */
  moved(car: Car, prevLeg: number, time: number): void {
    const net = this.net;
    // Every path it passed this step, in case it crossed a short connector in one step.
    const passed: number[] = [];
    for (let leg = prevLeg; leg <= car.leg; leg++) passed.push(car.route[leg]!);

    for (let i = 1; i < passed.length; i++) {
      const from = passed[i - 1]!;
      const to = passed[i]!;
      if (net.isLane[from] === 1 && net.isLane[to] === 0) {
        // Lane → connector: the vehicle is crossing the node.
        const a = this.approach.get(car.id);
        const conn = net.paths[to]!;
        if (a && a.lane === from && conn.kind === 'connector') {
          const freeFlow = (net.length[from]! - a.s) / net.speedLimit[from]! + net.length[to]! / net.speedLimit[to]!;
          this.crossing.set(car.id, { node: conn.node, start: a.t, freeFlow });
        }
        this.approach.delete(car.id);
      } else if (net.isLane[from] === 0 && net.isLane[to] === 1) {
        // Connector → lane: through the node. Record its delay, start the next approach.
        const c = this.crossing.get(car.id);
        if (c && this.served.has(c.node)) {
          this.delaySum.set(c.node, this.delaySum.get(c.node)! + Math.max(0, time - c.start - c.freeFlow));
          this.served.set(c.node, this.served.get(c.node)! + 1);
        }
        this.crossing.delete(car.id);
        this.approach.set(car.id, { lane: to, t: time, s: i === passed.length - 1 ? car.s : 0 });
      }
    }
  }

  /** A vehicle left the map (arrived or removed). */
  left(carId: number): void {
    this.approach.delete(carId);
    this.crossing.delete(carId);
  }

  /** Fold in the current standing queues (call once per sim-second). */
  sampleQueues(occ: Occupancy): void {
    for (let p = 0; p < this.net.count; p++) {
      const q = queueLength(occ.on(p), this.net.length[p]!);
      if (q > this.maxQueue[p]!) this.maxQueue[p] = q;
    }
  }

  /** Per-node metrics keyed by node ID: average control delay and vehicles served, since load. */
  nodes(): Record<string, NodeMetrics> {
    const out: Record<string, NodeMetrics> = {};
    for (const [id, n] of this.served) out[id] = { avgControlDelaySec: n > 0 ? this.delaySum.get(id)! / n : 0, carsServed: n };
    return out;
  }

  /** Per-path metrics keyed by path ID: max standing queue since load. */
  paths(): Record<string, PathMetrics> {
    const out: Record<string, PathMetrics> = {};
    this.net.paths.forEach((p, i) => { out[p.id] = { maxQueueLengthM: this.maxQueue[i]! }; });
    return out;
  }
}
