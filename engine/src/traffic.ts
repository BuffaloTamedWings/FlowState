/**
 * S2: cars driving along routes on a loaded network.
 *
 * A car is just `(route, leg, s, v)`: which path it's on (`route[leg]`), how far
 * along it is, and how fast it's going. No coordinates — the front end owns geometry.
 *
 * Each step, every car looks ahead along its own route for (a) the nearest car in
 * front, which may be on a later path, and (b) any slower speed limit coming up,
 * so it brakes for a turn before it gets there. IDM picks the acceleration from
 * (a), capped by (b).
 *
 * Not here yet: stop lines and intersection control (S5). Cars on two different
 * connectors that cross or merge don't see each other until S5 adds conflicts.
 */
import { SIM_DT } from '@shared/messages.js';
import { DEFAULT_IDM, idmAccel, integrate, type IdmParams } from './idm.js';
import type { Network } from './network.js';

export interface Car {
  /** Unique within a run. Cars are processed in ID order for determinism. */
  readonly id: number;
  /** Path indices from origin to destination. */
  readonly route: Int32Array;
  /** Position in `route`; the current path is `route[leg]`. */
  leg: number;
  /** Meters along the current path. */
  s: number;
  /** m/s. */
  v: number;
}

export interface Leader {
  /** Bumper-to-bumper distance (m). */
  gap: number;
  /** Leader speed (m/s). */
  speed: number;
}

export interface LookAhead {
  leader: Leader | null;
  /** Desired speed: the current path's limit. */
  v0: number;
  /**
   * Upper bound on acceleration (m/s², usually negative) so the car reaches every
   * slower path ahead at no more than that path's limit. +Infinity if no slowdown is needed.
   */
  maxAccel: number;
}

/** Default distance a car scans ahead for leaders and speed drops (m). */
export const LOOKAHEAD_M = 150;

export const currentPath = (car: Car): number => car.route[car.leg]!;

/** Cars on each path, front first (largest `s`). Rebuilt each step in a fixed order. */
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
 * Scan forward along the car's route: find its leader and its desired speed.
 *
 * Leader: the car directly ahead on the same path, else the rearmost car on the
 * first later path in the route that has one. Null if nothing within `lookahead`
 * or the route ends first (the end of the route is the destination).
 *
 * Speed drops: for each later path at distance d whose limit is below the car's
 * speed, constant braking of (v² − limit²) / 2d gets it there at the limit. The
 * strongest of those is the cap. Braking starts gently as soon as the slower path
 * comes within the lookahead, the way a driver eases off before a turn.
 */
export function lookAhead(
  car: Car,
  net: Network,
  occ: Occupancy,
  p: Readonly<IdmParams> = DEFAULT_IDM,
  lookahead: number = LOOKAHEAD_M,
): LookAhead {
  const path = currentPath(car);
  const v0 = net.speedLimit[path]!;
  let maxAccel = Infinity;
  let leader: Leader | null = null;

  const here = occ.on(path);
  const k = here.indexOf(car);
  if (k > 0) {
    const lead = here[k - 1]!;
    leader = { gap: lead.s - car.s - p.carLength, speed: lead.v };
  }

  let dist = net.length[path]! - car.s; // distance to the start of the next path
  for (let leg = car.leg + 1; leg < car.route.length && dist <= lookahead; leg++) {
    const next = car.route[leg]!;
    const limit = net.speedLimit[next]!;
    if (car.v > limit) maxAccel = Math.min(maxAccel, -(car.v * car.v - limit * limit) / (2 * Math.max(dist, 0.1)));

    if (leader === null) {
      const there = occ.on(next);
      const rear = there[there.length - 1];
      if (rear !== undefined && rear !== car) leader = { gap: dist + rear.s - p.carLength, speed: rear.v };
    }
    dist += net.length[next]!;
  }

  return { leader, v0, maxAccel };
}

export interface StepResult {
  /** IDs of cars that reached the end of their route this step, in ID order. */
  finished: number[];
}

/**
 * Advance every car by one step. Two phases, like the ring road: all cars decide
 * from the same snapshot, then all move. `cars` must be sorted by ID; finished
 * cars are removed from it in place.
 */
export function stepCars(
  net: Network,
  cars: Car[],
  occ: Occupancy,
  p: Readonly<IdmParams> = DEFAULT_IDM,
  dt: number = SIM_DT,
): StepResult {
  occ.rebuild(cars);

  const accel = new Float64Array(cars.length);
  cars.forEach((car, i) => {
    const { leader, v0, maxAccel } = lookAhead(car, net, occ, p);
    const a = leader
      ? idmAccel(car.v, v0, leader.gap, leader.speed, p)
      : idmAccel(car.v, v0, Infinity, 0, p);
    accel[i] = Math.min(a, maxAccel);
  });

  const finished: number[] = [];
  cars.forEach((car, i) => {
    const { v, ds } = integrate(car.v, accel[i]!, dt);
    car.v = v;
    car.s += ds;
    // Carry overshoot onto the next path; a fast car may cross a short connector in one step.
    while (car.s >= net.length[currentPath(car)]! && car.leg < car.route.length - 1) {
      car.s -= net.length[currentPath(car)]!;
      car.leg++;
    }
    if (car.leg === car.route.length - 1 && car.s >= net.length[currentPath(car)]!) finished.push(car.id);
  });

  if (finished.length > 0) {
    const done = new Set(finished);
    let w = 0;
    for (const car of cars) if (!done.has(car.id)) cars[w++] = car;
    cars.length = w;
  }
  return { finished };
}
