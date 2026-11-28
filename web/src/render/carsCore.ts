/**
 * The pure, GPU-free half of `cars.ts`: instance-slot bookkeeping and the
 * x/y interpolation rule. Factored out so both can be unit tested without a
 * `WebGLRenderer` (`web/test/render/cars.test.ts`).
 */
import type { TickCar } from '@shared/messages.js';

import type { ArcSample, ArcTable } from '@web/geometry/index.js';

import { samplePath } from './pathLookup.js';

/**
 * Maps `vehicleId -> instance slot`, released and reused as cars leave and
 * join. Correct whether or not the engine recycles `vehicleId`s (open
 * question for Sashank — noted in `cars.ts`): a released slot only comes
 * back into use once a *new* `allocate` call needs it, never by assumption.
 */
export class SlotAllocator {
  private idToSlot = new Map<number, number>();
  private freeSlots: number[] = [];
  capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    for (let i = capacity - 1; i >= 0; i--) this.freeSlots.push(i);
  }

  /** Current id -> slot assignments. */
  get slots(): ReadonlyMap<number, number> {
    return this.idToSlot;
  }

  /** Returns this id's slot, allocating (and growing capacity if needed) on first use. */
  allocate(id: number): number {
    const existing = this.idToSlot.get(id);
    if (existing !== undefined) return existing;
    if (this.freeSlots.length === 0) this.grow();
    const slot = this.freeSlots.pop();
    if (slot === undefined) throw new Error('SlotAllocator: grow() did not free a slot');
    this.idToSlot.set(id, slot);
    return slot;
  }

  /**
   * Releases every id not in `presentIds`. Returns the freed slot indices so
   * the caller can blank them (e.g. zero-scale their instance matrix).
   */
  release(presentIds: ReadonlySet<number>): number[] {
    const freed: number[] = [];
    for (const [id, slot] of this.idToSlot) {
      if (!presentIds.has(id)) {
        freed.push(slot);
        this.idToSlot.delete(id);
        this.freeSlots.push(slot);
      }
    }
    return freed;
  }

  /** Doubles capacity and makes the new slots available. Caller must grow the backing mesh to match. */
  private grow(): void {
    const oldCapacity = this.capacity;
    this.capacity = oldCapacity * 2;
    for (let i = this.capacity - 1; i >= oldCapacity; i--) this.freeSlots.push(i);
  }
}

/**
 * Further than this between two consecutive ticks (0.1 sim seconds apart,
 * whatever the playback speed) is not motion — no vehicle covers 50 m in
 * 0.1 s — so it is treated as a teleport and drawn without interpolation.
 */
export const MAX_INTERP_DISTANCE_M = 50;

export interface CarPose {
  x: number;
  y: number;
  heading: ArcSample['heading'];
}

/**
 * Position/heading for one car at interpolation fraction `alpha` between the
 * previous and current tick. Interpolates in x/y, never in `s` — a car can
 * switch paths between ticks (a connector ending and the next lane
 * beginning), and interpolating `s` across that boundary would make it jump
 * through geometry that doesn't connect in a straight line.
 *
 * A changed `pathIndex` is explicitly NOT a reason to stop interpolating.
 * Consecutive paths are geometrically continuous by construction — a
 * connector curve starts at the last point of the lane it leaves and ends at
 * the first point of the lane it enters (`compile/connectors.ts`) — so
 * lerping in world x/y across a path boundary is exactly as smooth as within
 * one path. Snapping instead would put a visible hitch on every car at every
 * intersection, which is the artifact this whole rule exists to avoid.
 *
 * A car with no previous sample (just spawned) is drawn at its newest
 * position outright. So is one that moved further than `MAX_INTERP_DISTANCE_M`
 * between two ticks: that is not driving, it is a teleport (a `reset`, a
 * gridlock removal, or a recycled `vehicleId` landing on a live slot), and
 * sliding a car across the map to meet it would look far worse than a jump.
 */
export function interpolateCarPose(lookup: ArcTable[], prev: TickCar | undefined, curr: TickCar, alpha: number): CarPose {
  const currSample = samplePath(lookup, curr.pathIndex, curr.s);
  if (!prev) {
    return { x: currSample.x, y: currSample.y, heading: currSample.heading };
  }
  const prevSample = samplePath(lookup, prev.pathIndex, prev.s);
  if (Math.hypot(currSample.x - prevSample.x, currSample.y - prevSample.y) > MAX_INTERP_DISTANCE_M) {
    return { x: currSample.x, y: currSample.y, heading: currSample.heading };
  }
  const t = Math.min(Math.max(alpha, 0), 1);
  return {
    x: prevSample.x + (currSample.x - prevSample.x) * t,
    y: prevSample.y + (currSample.y - prevSample.y) * t,
    heading: currSample.heading,
  };
}
