/**
 * The simulation: one network + one preset + one seed, stepped at SIM_DT.
 * The S7 worker wraps this; the headless harness drives it directly.
 *
 * Each step:
 *  1. New vehicles are requested by the demand model and join their origin's
 *     **entry queue** (a virtual line off the map).
 *  2. Each queue's front vehicle enters if there's a safe gap (PRD §8.5).
 *  3. Every vehicle on the map moves (`stepCars`).
 *  4. Vehicles that reached their destination are removed and their trip recorded;
 *     garage arrivals park.
 *  5. Vehicles that entered a new lane may re-route (PRD §8.3).
 *  6. Stopped time is tracked; a vehicle stopped > GRIDLOCK_SEC is removed.
 * Every second, travel times are sampled; every REFRESH_SEC, routes are recomputed.
 */
import { SIM_DT, type CompletedTrip, type MetricsCounts } from '@shared/messages.js';
import type { CompiledPoint, PointAccess } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';
import { Demand, freeSpaces, type ParkingState, type TripPlan } from './demand.js';
import { idmAccel } from './idm.js';
import type { Network } from './network.js';
import { mulberry32 } from './rng.js';
import { freeFlowTime, REFRESH_SEC, Router, TravelTimes } from './routing.js';
import { chooseAccel, currentPath, lengthOf, Occupancy, paramsOf, stepCars, type Car } from './traffic.js';
import { VEHICLE_PARAMS } from './vehicles.js';

/** A vehicle stopped this long is removed as gridlocked (PRD §8.5). */
export const GRIDLOCK_SEC = 120;
/** Below this speed a vehicle counts as stopped (m/s). */
export const STOPPED_SPEED = 0.1;
/** Seconds of expected wait per vehicle already queued, when choosing an origin lane. */
export const QUEUE_PENALTY_SEC = 2;

interface Waiting {
  plan: TripPlan;
  requestedAt: number;
}

interface EntryQueue {
  readonly key: string;
  readonly path: number;
  readonly s: number;
  readonly waiting: Waiting[];
}

interface TripState {
  plan: TripPlan;
  requestedAt: number;
  enteredAt: number;
  freeFlow: number;
  stopped: number;
  stoppedRun: number;
}

export interface SimCounts extends MetricsCounts {
  /** Vehicles requested by the demand model (including any still waiting). */
  requested: number;
  /** Vehicles that made it onto the map. */
  entered: number;
  /** Vehicles that completed their trip. */
  finished: number;
  /** Requests dropped because no trip type was possible. */
  skipped: number;
}

export class Sim {
  time = 0;
  /** Vehicles on the map, sorted by ID. */
  readonly cars: Car[] = [];
  readonly parking = new Map<string, ParkingState>();
  readonly router: Router;

  private readonly occ: Occupancy;
  private readonly travel: TravelTimes;
  private readonly demand: Demand;
  private readonly queues: EntryQueue[] = [];
  private readonly queueByKey = new Map<string, EntryQueue>();
  private readonly trips = new Map<number, TripState>();
  private completed: CompletedTrip[] = [];
  private nextId = 0;
  private stepCount = 0;
  private readonly counters = { requested: 0, entered: 0, finished: 0, skipped: 0, parkingFailed: 0, gridlockRemovals: 0 };

  constructor(readonly net: Network, readonly preset: Preset, readonly seed: number) {
    const rng = mulberry32(seed);
    this.occ = new Occupancy(net.count);
    this.travel = new TravelTimes(net);
    this.router = new Router(net, this.travel);

    for (const p of net.points.values()) {
      if (p.type === 'parking') {
        const capacity = p.capacity ?? 0;
        this.parking.set(p.id, { capacity, parked: Math.round(capacity * preset.parking.initialOccupancy), reserved: 0 });
      }
    }
    // Entry queues for every access lane of every point that can be an origin, in a fixed order.
    for (const p of net.points.values()) for (const a of p.access) this.queueFor(a);
    this.queues.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    this.demand = new Demand(net, preset, rng, this.router, this.parking,
      (a) => QUEUE_PENALTY_SEC * this.queueFor(a).waiting.length);
  }

  private queueFor(a: PointAccess): EntryQueue {
    const key = `${a.path}@${a.s}`;
    let q = this.queueByKey.get(key);
    if (!q) {
      q = { key, path: this.net.byId.get(a.path)!, s: a.s, waiting: [] };
      this.queueByKey.set(key, q);
      this.queues.push(q);
    }
    return q;
  }

  /** Advance the simulation by one SIM_DT step. */
  step(): void {
    const dt = SIM_DT;
    this.request(dt);
    this.occ.rebuild(this.cars);
    for (const q of this.queues) this.tryEnter(q);

    const { finished, enteredLane } = stepCars(this.net, this.cars, this.occ, dt);
    for (const id of finished) this.finish(id);
    for (const id of enteredLane) this.maybeReroute(id);
    this.trackStopped(dt);

    this.stepCount++;
    this.time = this.stepCount * dt;
    if (this.stepCount % Math.round(1 / dt) === 0) {
      this.occ.rebuild(this.cars);
      this.travel.sample(this.occ, 1);
    }
    if (this.stepCount % Math.round(REFRESH_SEC / dt) === 0) this.router.refresh();
  }

  /** Step until `seconds` more sim time has passed. */
  run(seconds: number): void {
    const steps = Math.round(seconds / SIM_DT);
    for (let i = 0; i < steps; i++) this.step();
  }

  private request(dt: number): void {
    const n = this.demand.arrivals(this.time, dt);
    for (let k = 0; k < n; k++) {
      this.counters.requested++;
      const plan = this.demand.pickTrip();
      if (!plan) { this.counters.skipped++; continue; }
      if (plan.parkingFailed) this.counters.parkingFailed++;
      if (plan.origin.type === 'parking') this.parking.get(plan.origin.id)!.parked--;
      if (plan.destination.type === 'parking') this.parking.get(plan.destination.id)!.reserved++;
      this.queueFor(plan.access).waiting.push({ plan, requestedAt: this.time });
    }
  }

  /** Let the front vehicle of a queue onto the map if it fits safely. */
  private tryEnter(q: EntryQueue): void {
    const head = q.waiting[0];
    if (!head) return;
    const params = VEHICLE_PARAMS[head.plan.vehicle];
    const limit = this.net.speedLimit[q.path]!;
    const midLane = q.s > 0;

    // Probe vehicle at the insertion point. Lane-start spawns enter moving; garages from rest.
    const probe: Car = { id: -1, route: head.plan.route, leg: 0, s: q.s, v: midLane ? 0 : limit, params, endS: head.plan.endS };
    const ahead = this.nearestAhead(q.path, q.s);
    if (ahead) {
      const gap = ahead.s - lengthOf(ahead) - q.s;
      if (gap < params.minGap) return;
      if (!midLane) probe.v = Math.min(limit, ahead.v);
    }
    if (chooseAccel(probe, this.net, this.occ) < -params.comfortDecel) return;

    // Anyone behind must be able to brake comfortably for the newcomer.
    for (const f of this.followersBehind(q.path, q.s, params.carLength)) {
      if (f.gap < paramsOf(f.car).minGap) return;
      const a = idmAccel(f.car.v, this.net.speedLimit[currentPath(f.car)]!, f.gap, probe.v, paramsOf(f.car));
      if (a < -paramsOf(f.car).comfortDecel) return;
    }

    q.waiting.shift();
    const car: Car = { id: this.nextId++, route: head.plan.route, leg: 0, s: q.s, v: probe.v, params, type: head.plan.vehicle, endS: head.plan.endS };
    this.cars.push(car); // IDs increase, so `cars` stays sorted by ID
    this.trips.set(car.id, {
      plan: head.plan,
      requestedAt: head.requestedAt,
      enteredAt: this.time,
      freeFlow: freeFlowTime(this.net, head.plan.route, q.s, head.plan.endS),
      stopped: 0,
      stoppedRun: 0,
    });
    this.counters.entered++;
    this.occ.rebuild(this.cars);
  }

  /** Rearmost vehicle on `path` whose front is ahead of `s`. */
  private nearestAhead(path: number, s: number): Car | null {
    const here = this.occ.on(path);
    for (let i = here.length - 1; i >= 0; i--) if (here[i]!.s > s) return here[i]!;
    return null;
  }

  /** The nearest vehicle behind `s` on `path`, or else the front vehicle on each path feeding it. */
  private followersBehind(path: number, s: number, len: number): { car: Car; gap: number }[] {
    for (const c of this.occ.on(path)) if (c.s <= s) return [{ car: c, gap: s - len - c.s }];
    const out: { car: Car; gap: number }[] = [];
    for (const p of this.net.prev[path]!) {
      const c = this.occ.on(p)[0];
      if (c) out.push({ car: c, gap: this.net.length[p]! - c.s + s - len });
    }
    return out;
  }

  private finish(id: number): void {
    const t = this.trips.get(id);
    if (!t) return;
    this.trips.delete(id);
    this.counters.finished++;
    const dest = t.plan.destination;
    if (dest.type === 'parking') {
      const g = this.parking.get(dest.id)!;
      g.reserved = Math.max(0, g.reserved - 1);
      g.parked = Math.min(g.capacity, g.parked + 1);
    }
    this.completed.push({
      tripTimeSec: this.time - t.requestedAt,
      freeFlowTimeSec: t.freeFlow,
      stoppedTimeSec: t.stopped,
      entryQueueTimeSec: t.enteredAt - t.requestedAt,
      origin: t.plan.origin.id,
      destination: dest.id,
    });
  }

  private maybeReroute(id: number): void {
    const t = this.trips.get(id);
    const car = this.cars.find((c) => c.id === id);
    if (!t || !car) return;
    const r = this.router.reroute(car, t.plan.destination.id, car.endS ?? 0);
    if (!r) return;
    car.route = r.route;
    car.leg = 0;
    car.endS = r.endS;
  }

  private trackStopped(dt: number): void {
    let removed = false;
    for (const car of this.cars) {
      const t = this.trips.get(car.id)!;
      if (car.v < STOPPED_SPEED) {
        t.stopped += dt;
        t.stoppedRun += dt;
        if (t.stoppedRun > GRIDLOCK_SEC) removed = true;
      } else {
        t.stoppedRun = 0;
      }
    }
    if (!removed) return;
    let w = 0;
    for (const car of this.cars) {
      const t = this.trips.get(car.id)!;
      if (t.stoppedRun > GRIDLOCK_SEC) {
        this.counters.gridlockRemovals++;
        this.trips.delete(car.id);
        const dest = t.plan.destination;
        if (dest.type === 'parking') {
          const g = this.parking.get(dest.id)!;
          g.reserved = Math.max(0, g.reserved - 1);
        }
      } else {
        this.cars[w++] = car;
      }
    }
    this.cars.length = w;
  }

  /** Trips completed since the last call. */
  takeCompleted(): CompletedTrip[] {
    const out = this.completed;
    this.completed = [];
    return out;
  }

  get waitingCount(): number {
    let n = 0;
    for (const q of this.queues) n += q.waiting.length;
    return n;
  }

  counts(): SimCounts {
    return { ...this.counters, carsActive: this.cars.length, carsWaitingToEnter: this.waitingCount };
  }

  /** Parked cars and free spaces per garage. */
  parkingSnapshot(): Record<string, { capacity: number; parked: number; reserved: number; free: number }> {
    const out: Record<string, { capacity: number; parked: number; reserved: number; free: number }> = {};
    for (const [id, g] of this.parking) out[id] = { ...g, free: freeSpaces(g) };
    return out;
  }

  /** Point lookup for logs and tests. */
  point(id: string): CompiledPoint | undefined {
    return this.net.points.get(id);
  }
}
