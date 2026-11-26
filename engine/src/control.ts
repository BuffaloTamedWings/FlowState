/**
 * S5: intersection control (PRD §8.4).
 *
 * The whole mechanism is a **gate**: before a vehicle enters a connector, it asks
 * "may I go?". If not, the end of its lane acts as a stopped leader, so IDM
 * brings it to a smooth stop at the line (see `lookAhead` in traffic.ts). The
 * gate is re-asked every step from one snapshot, so runs stay deterministic.
 *
 * Rules, for every control:
 *  - never enter while a crossing or merging connector is occupied by any part
 *    of a vehicle (bodies are tracked to the tail, so trucks clear properly);
 *  - don't block the box: the outgoing lane must have room for the whole vehicle;
 *  - give way where the rules say so: wait for a critical gap to vehicles on, or
 *    about to reach, each connector this one must yield to.
 * Plus, per control:
 *  - signal / signalProtectedLeft: fixed-time plan; green go, yellow go only if
 *    the vehicle can't stop comfortably (or it's a permissive turner waiting at
 *    the line, which may "sneak" through once oncoming traffic stops), red stop;
 *  - `stop: true` (all-way stop, minor approaches of a yield): full stop first;
 *    all-way stops then go first-come-first-served among conflicting approaches;
 *  - merge: ramp connectors yield with a 3 s gap; everything else uses 4 s.
 */
import type { CompiledNode, ConnectorPath } from '@shared/network.js';
import type { Network } from './network.js';
import { chooseAccel, currentPath, lengthOf, paramsOf, type Car, type Occupancy } from './traffic.js';

export const CYCLE_SEC = 60;
export const YELLOW_SEC = 3;
export const ALL_RED_SEC = 1;
/** Critical gap for yields, permissive turns and roundabout entries (s). */
export const CRITICAL_GAP_SEC = 4;
/** Critical gap for ramp merges (s). */
export const MERGE_GAP_SEC = 3;
/** A vehicle counts as stopped at the line below this speed... */
export const STOP_SPEED = 0.1;
/** ...when its front is within its min gap plus this of the line (m). */
export const STOP_LINE_SLACK = 1.5;
/** A full outgoing lane still admits a vehicle if its rear vehicle is moving faster than this (m/s). */
export const MOVING_AWAY_SPEED = 3;
/** A priority vehicle slower than this is judged by whether it could go, not by its ETA (m/s). */
const STOPPED_FOR_YIELD = 0.5;
/** ...and it could go if IDM would accelerate it at least this hard (m/s²). */
const FREE_TO_GO_ACCEL = 0.3;
/** Ignore body slivers shorter than this (floating-point leftovers when a tail just cleared a path) (m). */
const BODY_EPS = 1e-6;
/** Vehicles further than this from a connector aren't tracked as approaching it (m). */
const APPROACH_RANGE = 120;

// ---------------------------------------------------------------------------
// Signal timing
// ---------------------------------------------------------------------------

export interface PhaseWindow {
  id: string;
  /** Seconds into the cycle. Green is [greenStart, greenEnd), yellow until yellowEnd, all-red until redEnd. */
  greenStart: number;
  greenEnd: number;
  yellowEnd: number;
  redEnd: number;
}

export type SignalState = 'green' | 'yellow' | 'red';

/**
 * Fixed-time plan: phases in array order, each green → 3 s yellow → 1 s all-red,
 * with the green time shared in proportion to each phase's distinct incoming
 * car lanes. A single-phase signal is green all the time.
 */
export function signalPlan(node: CompiledNode, connectors: ReadonlyMap<string, ConnectorPath>): PhaseWindow[] {
  const phases = node.phases ?? [];
  if (phases.length <= 1) {
    return phases.map((p) => ({ id: p.id, greenStart: 0, greenEnd: CYCLE_SEC, yellowEnd: CYCLE_SEC, redEnd: CYCLE_SEC }));
  }
  const lanes = phases.map((p) => new Set(p.paths.map((c) => connectors.get(c)?.from)).size || 1);
  const totalLanes = lanes.reduce((a, b) => a + b, 0);
  const greenTotal = CYCLE_SEC - phases.length * (YELLOW_SEC + ALL_RED_SEC);
  const out: PhaseWindow[] = [];
  let t = 0;
  phases.forEach((p, i) => {
    const green = (greenTotal * lanes[i]!) / totalLanes;
    const w = { id: p.id, greenStart: t, greenEnd: t + green, yellowEnd: t + green + YELLOW_SEC, redEnd: t + green + YELLOW_SEC + ALL_RED_SEC };
    out.push(w);
    t = w.redEnd;
  });
  return out;
}

export function signalState(plan: readonly PhaseWindow[], phaseId: string | null, time: number): SignalState {
  if (plan.length === 1 && plan[0]!.id === phaseId) return 'green';
  const tc = ((time % CYCLE_SEC) + CYCLE_SEC) % CYCLE_SEC;
  const w = plan.find((p) => p.id === phaseId);
  if (!w) return 'red';
  if (tc >= w.greenStart && tc < w.greenEnd) return 'green';
  if (tc >= w.greenEnd && tc < w.yellowEnd) return 'yellow';
  return 'red';
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * Every path a vehicle's body covers, front path first: from the front bumper
 * back `length` meters along the route it came by. Long vehicles straddle paths.
 */
export function bodyPaths(car: Car, net: Network): number[] {
  const out = [currentPath(car)];
  let remaining = lengthOf(car) - car.s;
  for (let leg = car.leg - 1; leg >= 0 && remaining > BODY_EPS; leg--) {
    const p = car.route[leg]!;
    out.push(p);
    remaining -= net.length[p]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

interface ConnInfo {
  index: number;
  node: string;
  control: string;
  phase: string | null;
  stop: boolean;
  from: number;
  to: number;
  /** Connectors that conflict (cross or merge). */
  conflicts: Int32Array;
  /** Connectors this one must give way to (yieldTo plus deterministic tie-breaks). */
  mustYieldTo: Int32Array;
  gapSec: number;
}

interface Approach {
  car: Car;
  /** Distance from the vehicle's front to the connector's start (m). */
  dist: number;
  /** Seconds until it gets there at its current speed (Infinity if standing still). */
  eta: number;
}

export class Intersections {
  private readonly info: (ConnInfo | null)[];
  private readonly plans = new Map<string, PhaseWindow[]>();
  private time = 0;
  private occ: Occupancy | null = null;
  /** Number of vehicle bodies on each path. */
  private readonly bodies: Int32Array;
  /** Vehicles heading for each connector next, nearest first. */
  private readonly approach: Approach[][];
  /** Body length on connectors that feed each lane (m): space already claimed on it. */
  private readonly claimed: Float64Array;
  /** car id → { connector, time it stopped at the line } for `stop: true` approaches. */
  private stopped = new Map<number, { conn: number; at: number }>();

  constructor(private readonly net: Network) {
    const connById = new Map<string, ConnectorPath>();
    for (const p of net.paths) if (p.kind === 'connector') connById.set(p.id, p);
    const controlOf = new Map<string, string>([...net.nodes.values()].map((n) => [n.id, n.control]));
    for (const n of net.nodes.values()) if (n.phases) this.plans.set(n.id, signalPlan(n, connById));

    const idx = (id: string) => net.byId.get(id)!;
    this.info = net.paths.map((p) => {
      if (p.kind !== 'connector') return null;
      const control = controlOf.get(p.node) ?? 'none';
      const conflicts = p.conflicts.map((c) => idx(c.path));
      const yieldTo = new Set(p.yieldTo.map(idx));
      // Conflicts with no yield relation either way would let both go at once.
      // Break the tie deterministically: the higher-index connector gives way.
      // At signals this only applies within the same phase (phases are separated in time),
      // and all-way stops use first-come-first-served instead.
      if (control !== 'allStop') {
        for (const c of p.conflicts) {
          const other = connById.get(c.path)!;
          const relation = p.yieldTo.includes(other.id) || other.yieldTo.includes(p.id);
          const samePhaseOrUnsignalled = (control !== 'signal' && control !== 'signalProtectedLeft') || other.phase === p.phase;
          if (!relation && samePhaseOrUnsignalled && other.index < p.index) yieldTo.add(other.index);
        }
      }
      return {
        index: p.index, node: p.node, control, phase: p.phase, stop: p.stop,
        from: idx(p.from), to: idx(p.to),
        conflicts: Int32Array.from(conflicts),
        mustYieldTo: Int32Array.from([...yieldTo].sort((a, b) => a - b)),
        gapSec: control === 'merge' ? MERGE_GAP_SEC : CRITICAL_GAP_SEC,
      };
    });
    this.bodies = new Int32Array(net.count);
    this.claimed = new Float64Array(net.count);
    this.approach = Array.from({ length: net.count }, () => []);
  }

  /** Refresh the snapshot the gate reads. Call once per step, after `occ.rebuild`. */
  update(cars: readonly Car[], occ: Occupancy, time: number): void {
    this.time = time;
    this.occ = occ;
    this.bodies.fill(0);
    this.claimed.fill(0);
    for (const a of this.approach) a.length = 0;
    const stopped = new Map<number, { conn: number; at: number }>();

    for (const car of cars) {
      for (const p of bodyPaths(car, this.net)) {
        this.bodies[p]!++;
        const ci = this.info[p];
        if (ci) this.claimed[ci.to]! += lengthOf(car) + paramsOf(car).minGap;
      }
      // First connector ahead on the route (not the one the vehicle is on).
      let dist = this.net.length[currentPath(car)]! - car.s;
      for (let leg = car.leg + 1; leg < car.route.length && dist <= APPROACH_RANGE; leg++) {
        const p = car.route[leg]!;
        const ci = this.info[p];
        if (ci) {
          this.approach[p]!.push({ car, dist, eta: car.v > 0 ? dist / car.v : Infinity });
          // Register a full stop at the line for stop-controlled approaches.
          if (ci.stop && leg === car.leg + 1) {
            const prev = this.stopped.get(car.id);
            if (prev && prev.conn === p) stopped.set(car.id, prev);
            else if (car.v < STOP_SPEED && dist <= paramsOf(car).minGap + STOP_LINE_SLACK) stopped.set(car.id, { conn: p, at: time });
          }
          break;
        }
        dist += this.net.length[p]!;
      }
    }
    for (const a of this.approach) if (a.length > 1) a.sort((x, y) => x.dist - y.dist || x.car.id - y.car.id);
    this.stopped = stopped;
  }

  /** Has this vehicle made its full stop for `conn`? (For tests and metrics.) */
  hasStopped(carId: number, conn: number): boolean {
    return this.stopped.get(carId)?.conn === conn;
  }

  /** Signal state of a connector right now, or null if it isn't signalled. */
  signalStateOf(conn: number): SignalState | null {
    const ci = this.info[conn];
    if (!ci || (ci.control !== 'signal' && ci.control !== 'signalProtectedLeft')) return null;
    return signalState(this.plans.get(ci.node) ?? [], ci.phase, this.time);
  }

  isOccupied(path: number): boolean {
    return this.bodies[path]! > 0;
  }

  /** May `car`, whose front is `dist` meters from the line, enter connector `conn` now? */
  gate = (car: Car, conn: number, dist: number): boolean => this.check(car, conn, dist, true);

  /**
   * The gate's rules. With `yields` false the give-way and first-come-first-served
   * checks are skipped: used to ask whether a vehicle we'd defer to could actually
   * go, without recursing.
   */
  private check(car: Car, conn: number, dist: number, yields: boolean): boolean {
    const ci = this.info[conn];
    if (!ci) return true;
    const p = paramsOf(car);

    // Signals.
    const light = this.signalStateOf(conn);
    if (light === 'red') return false;
    // A permissive turner already waiting at the line may "sneak" on yellow, once
    // oncoming traffic is stopping; otherwise yellow means go only if you can't stop.
    const atLine = dist <= p.minGap + STOP_LINE_SLACK;
    const sneak = light === 'yellow' && ci.mustYieldTo.length > 0 && atLine;
    if (light === 'yellow' && !sneak && (car.v * car.v) / (2 * p.comfortDecel) <= dist) return false;

    // Stop signs: full stop first.
    if (ci.stop && !this.hasStopped(car.id, conn)) return false;

    // Nothing in the way inside the intersection.
    for (const x of ci.conflicts) if (this.bodies[x]! > 0) return false;

    // All-way stop: first come, first served among conflicting approaches. Only
    // defer to an earlier arrival that can actually go; one stuck behind a full
    // lane would otherwise hold the whole intersection forever.
    if (yields && ci.control === 'allStop') {
      const mine = this.stopped.get(car.id)!.at;
      for (const x of ci.conflicts) {
        for (const a of this.approach[x]!) {
          const s = this.stopped.get(a.car.id);
          if (!s || s.conn !== x || !(s.at < mine || (s.at === mine && a.car.id < car.id))) continue;
          if (this.check(a.car, x, a.dist, false)) return false;
        }
      }
    }

    // Give way: critical gap to traffic on, or about to reach, each priority connector.
    if (yields) {
      for (const y of ci.mustYieldTo) {
        if (this.bodies[y]! > 0) return false;
        for (const a of this.approach[y]!) {
          if (a.car === car) continue;
          if (sneak) {
            // On yellow only oncoming vehicles too close to stop are still coming.
            const committed = (a.car.v * a.car.v) / (2 * paramsOf(a.car).comfortDecel) > a.dist;
            if (committed && a.eta < ci.gapSec) return false;
          } else if (this.arrivesWithin(a, y, ci.gapSec)) {
            return false;
          }
        }
      }
    }

    // Don't block the box.
    return this.hasRoom(car, ci);
  }

  /**
   * Will this priority vehicle reach its connector within `gap` seconds? A moving
   * one: at its current speed. A stopped or crawling one only counts if it's free
   * to go (its own gate is open and nothing ahead holds it back); then assume it
   * pulls away from rest at full acceleration. Otherwise yielding to it would wait
   * forever, e.g. oncoming traffic stuck behind a full lane.
   */
  private arrivesWithin(a: Approach, conn: number, gap: number): boolean {
    if (a.car.v >= STOPPED_FOR_YIELD) return a.eta < gap;
    if (!this.check(a.car, conn, a.dist, false)) return false;
    if (!this.occ || chooseAccel(a.car, this.net, this.occ) < FREE_TO_GO_ACCEL) return false;
    return Math.sqrt((2 * a.dist) / paramsOf(a.car).maxAccel) < gap;
  }

  private hasRoom(car: Car, ci: ConnInfo): boolean {
    const occ = this.occ;
    if (!occ) return true;
    const out = occ.on(ci.to);
    const rear = out[out.length - 1];
    let room = this.net.length[ci.to]!;
    if (rear) {
      if (rear.v > MOVING_AWAY_SPEED) return true;
      room = rear.s - lengthOf(rear);
    }
    room -= this.claimed[ci.to]!;
    return room >= lengthOf(car) + paramsOf(car).minGap;
  }
}
