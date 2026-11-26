/**
 * S2/S3: vehicles driving along routes on a loaded network.
 *
 * A vehicle is just `(route, leg, s, v)`: which path it's on (`route[leg]`), how
 * far along it is, and how fast it's going. `s` is the **front bumper**; the body
 * extends `params.carLength` behind it, possibly back onto the previous path.
 * No coordinates — the front end owns geometry.
 *
 * Each step, every vehicle looks ahead along its own route for (a) the nearest
 * vehicle in front, which may be on a later path, and (b) any slower speed limit
 * coming up, so it brakes for a turn before it gets there. IDM picks the
 * acceleration from (a), capped by (b). Each vehicle uses its own IdmParams, and
 * gaps are measured to the leader's rear bumper using the *leader's* length.
 *
 * Not here yet: stop lines and intersection control (S5). Vehicles on two
 * different connectors that cross or merge don't see each other until S5.
 */
import { SIM_DT } from '@shared/messages.js';
import { DEFAULT_IDM, idmAccel, integrate, type IdmParams } from './idm.js';
import type { Network } from './network.js';
import type { VehicleTypeId } from './vehicles.js';

export interface Car {
  /** Unique within a run. Vehicles are processed in ID order for determinism. */
  readonly id: number;
  /** Path indices from origin to destination. Replaced when the vehicle re-routes. */
  route: Int32Array;
  /** Position in `route`; the current path is `route[leg]`. */
  leg: number;
  /** Meters along the current path (front bumper). */
  s: number;
  /** m/s. */
  v: number;
  /** Driving parameters and length. Default: a car. */
  params?: Readonly<IdmParams>;
  /** Vehicle type, for the tick flags. Default: car. */
  type?: VehicleTypeId;
  /**
   * Where the trip ends on the last path of the route (m). Default: the end of
   * that path (a sink). Garages and lunch zones end mid-lane.
   */
  endS?: number;
}

export interface Leader {
  /** Bumper-to-bumper distance (m): to the leader's rear, using its length. */
  gap: number;
  /** Leader speed (m/s). */
  speed: number;
}

export interface LookAhead {
  leader: Leader | null;
  /** Desired speed: the current path's limit. */
  v0: number;
  /**
   * Upper bound on acceleration (m/s², usually negative) so the vehicle reaches
   * every slower path ahead at no more than that path's limit. +Infinity if no
   * slowdown is needed.
   */
  maxAccel: number;
}

/** Default distance a vehicle scans ahead for leaders and speed drops (m). */
export const LOOKAHEAD_M = 150;

export const currentPath = (car: Car): number => car.route[car.leg]!;
export const paramsOf = (car: Car): Readonly<IdmParams> => car.params ?? DEFAULT_IDM;
export const lengthOf = (car: Car): number => paramsOf(car).carLength;
export const endSOf = (car: Car, net: Network): number =>
  car.endS ?? net.length[car.route[car.route.length - 1]!]!;

/** Vehicles on each path, front first (largest `s`). Rebuilt each step in a fixed order. */
export class Occupancy {
  private readonly lists: Car[][];

  constructor(pathCount: number) {
    this.lists = Array.from({ length: pathCount }, () => []);
  }

  rebuild(cars: readonly Car[]): void {
    for (const l of this.lists) l.length = 0;
    for (const c of cars) this.lists[currentPath(c)]!.push(c);
    for (const l of this.lists) if (l.length > 1) l.sort((a, b) => b.s - a.s || a.id - b.id);
  }

  on(path: number): readonly Car[] {
    return this.lists[path]!;
  }
}

/**
 * Scan forward along the vehicle's route: find its leader and speed cap.
 *
 * Leader: the vehicle directly ahead on the same path, else the rearmost vehicle
 * on the first later path in the route that has one. Null if nothing within
 * `lookahead` or the route ends first (the end of the route is the destination).
 *
 * Speed drops: for each later path at distance d whose limit is below the
 * vehicle's speed, constant braking of (v² − limit²) / 2d gets it there at the
 * limit. The strongest of those is the cap. Braking starts gently as soon as the
 * slower path comes within the lookahead, the way a driver eases off before a turn.
 */
export function lookAhead(car: Car, net: Network, occ: Occupancy, lookahead: number = LOOKAHEAD_M): LookAhead {
  const path = currentPath(car);
  const v0 = net.speedLimit[path]!;
  let maxAccel = Infinity;
  let leader: Leader | null = null;

  const here = occ.on(path);
  const k = here.indexOf(car);
  if (k > 0) {
    const lead = here[k - 1]!;
    leader = { gap: lead.s - lengthOf(lead) - car.s, speed: lead.v };
  } else if (k < 0) {
    // Not registered on its path (e.g. a vehicle being tested for insertion):
    // the leader is the rearmost vehicle on this path that is ahead of it.
    for (let i = here.length - 1; i >= 0; i--) {
      const c = here[i]!;
      if (c.s > car.s) { leader = { gap: c.s - lengthOf(c) - car.s, speed: c.v }; break; }
    }
  }

  let dist = net.length[path]! - car.s; // distance to the start of the next path
  for (let leg = car.leg + 1; leg < car.route.length && dist <= lookahead; leg++) {
    const next = car.route[leg]!;
    const limit = net.speedLimit[next]!;
    if (car.v > limit) maxAccel = Math.min(maxAccel, -(car.v * car.v - limit * limit) / (2 * Math.max(dist, 0.1)));

    if (leader === null) {
      const there = occ.on(next);
      const rear = there[there.length - 1];
      if (rear !== undefined && rear !== car) leader = { gap: dist + rear.s - lengthOf(rear), speed: rear.v };
    }
    dist += net.length[next]!;
  }

  return { leader, v0, maxAccel };
}

/** Acceleration the vehicle would choose right now (IDM capped for slower paths ahead). */
export function chooseAccel(car: Car, net: Network, occ: Occupancy): number {
  const p = paramsOf(car);
  const { leader, v0, maxAccel } = lookAhead(car, net, occ);
  const a = leader ? idmAccel(car.v, v0, leader.gap, leader.speed, p) : idmAccel(car.v, v0, Infinity, 0, p);
  return Math.min(a, maxAccel);
}

export interface StepResult {
  /** IDs of vehicles that reached the end of their trip this step, in ID order. */
  finished: number[];
  /** IDs of vehicles that moved onto a new lane path this step (re-route opportunities). */
  enteredLane: number[];
}

/**
 * Advance every vehicle by one step. Two phases, like the ring road: all decide
 * from the same snapshot, then all move. `cars` must be sorted by ID; finished
 * vehicles are removed from it in place.
 */
export function stepCars(net: Network, cars: Car[], occ: Occupancy, dt: number = SIM_DT): StepResult {
  occ.rebuild(cars);

  const accel = new Float64Array(cars.length);
  cars.forEach((car, i) => { accel[i] = chooseAccel(car, net, occ); });

  const finished: number[] = [];
  const enteredLane: number[] = [];
  cars.forEach((car, i) => {
    const { v, ds } = integrate(car.v, accel[i]!, dt);
    car.v = v;
    car.s += ds;
    // Carry overshoot onto the next path; a fast vehicle may cross a short connector in one step.
    let movedToLane = false;
    while (car.s >= net.length[currentPath(car)]! && car.leg < car.route.length - 1) {
      car.s -= net.length[currentPath(car)]!;
      car.leg++;
      if (net.isLane[currentPath(car)] === 1) movedToLane = true;
    }
    if (car.leg === car.route.length - 1 && car.s >= endSOf(car, net)) finished.push(car.id);
    else if (movedToLane) enteredLane.push(car.id);
  });

  if (finished.length > 0) {
    const done = new Set(finished);
    let w = 0;
    for (const car of cars) if (!done.has(car.id)) cars[w++] = car;
    cars.length = w;
  }
  return { finished, enteredLane };
}
