/**
 * S3: traffic demand (PRD §7.5, §8.5). Decides when vehicles appear and what
 * trip each one takes. Entry queues and insertion live in `sim.ts`.
 *
 * - Arrivals: a Poisson process at the preset's spawn rate (total for the map),
 *   drawn from the seeded RNG so a seed always gives the same run.
 * - Trip: pick a trip type by `share`, an origin of the listed types by
 *   `weight`, then a *reachable* destination by `weight`. Garages count by how
 *   many cars are parked (as origins) or free spaces (as destinations).
 * - Trip types that can't be satisfied on this map (no such points, nothing
 *   reachable) are skipped and their share falls to the others.
 * - Parking: a vehicle heading for a garage reserves a space at spawn. If every
 *   garage is full it's sent to a reachable exit instead (`parkingFailed`).
 * - Vehicle type: from the preset's optional `vehicleMix` (default all cars).
 */
import type { CompiledPoint, PointAccess } from '@shared/network.js';
import { spawnRateAt, validateVehicleMix, vehicleMixOf, type Preset, type Trip, type VehicleShare } from '@shared/preset.js';
import type { PointType } from '@shared/scenario.js';
import type { Network } from './network.js';
import { pickWeighted, poisson, type Rng } from './rng.js';
import type { Router } from './routing.js';
import type { VehicleTypeId } from './vehicles.js';

export interface ParkingState {
  readonly capacity: number;
  /** Cars currently parked. */
  parked: number;
  /** Spaces promised to vehicles already on their way. */
  reserved: number;
}

export const freeSpaces = (g: ParkingState): number => Math.max(0, g.capacity - g.parked - g.reserved);

export interface TripPlan {
  origin: CompiledPoint;
  destination: CompiledPoint;
  /** The origin access lane the vehicle will enter on. */
  access: PointAccess;
  route: Int32Array;
  /** Where the trip ends on the last path of the route. */
  endS: number;
  vehicle: VehicleTypeId;
  /** True if this vehicle wanted a garage but every garage was full. */
  parkingFailed: boolean;
}

const EXIT_TYPES: readonly PointType[] = ['edgeSink', 'rampSink'];

export class Demand {
  private readonly byType = new Map<PointType, CompiledPoint[]>();
  private readonly mix: readonly VehicleShare[];

  constructor(
    private readonly net: Network,
    private readonly preset: Preset,
    private readonly rng: Rng,
    private readonly router: Router,
    readonly parking: ReadonlyMap<string, ParkingState>,
    /** Extra seconds to add when choosing an origin lane, e.g. for its entry queue. */
    private readonly lanePenalty: (access: PointAccess) => number = () => 0,
  ) {
    for (const p of net.points.values()) {
      const list = this.byType.get(p.type) ?? [];
      list.push(p);
      this.byType.set(p.type, list);
    }
    const problems = validateVehicleMix(preset.vehicleMix);
    if (problems.length > 0) throw new Error(`Invalid preset ${preset.id}: ${problems.join('; ')}`);
    this.mix = vehicleMixOf(preset);
  }

  /** Vehicles requested during the step [t, t + dt). */
  arrivals(t: number, dt: number): number {
    return poisson(this.rng, (spawnRateAt(this.preset.spawnRate, t) / 60) * dt);
  }

  /** Choose a trip for one new vehicle, or null if no trip type is possible right now. */
  pickTrip(): TripPlan | null {
    const shares = this.preset.trips.map((t) => t.share);
    for (;;) {
      const i = pickWeighted(this.rng, shares);
      if (i < 0) return null;
      const plan = this.tryTrip(this.preset.trips[i]!);
      if (plan) return plan;
      shares[i] = 0; // impossible right now: let the other trip types take its share
    }
  }

  private points(types: readonly PointType[]): CompiledPoint[] {
    return types.flatMap((t) => this.byType.get(t) ?? []);
  }

  private originWeight(p: CompiledPoint): number {
    if (p.type !== 'parking') return p.weight;
    const g = this.parking.get(p.id);
    return g ? p.weight * g.parked : 0;
  }

  private destWeight(p: CompiledPoint): number {
    if (p.type !== 'parking') return p.weight;
    const g = this.parking.get(p.id);
    return g ? p.weight * freeSpaces(g) : 0;
  }

  /** Cheapest origin access lane from which `dest` is reachable, or null. */
  private bestAccess(origin: CompiledPoint, dest: CompiledPoint): PointAccess | null {
    let best: PointAccess | null = null;
    let bestCost = Infinity;
    for (const a of origin.access) {
      const p = this.net.byId.get(a.path)!;
      const c = this.router.costFrom(dest.id, p, a.s);
      if (c === Infinity) continue;
      const total = c + this.lanePenalty(a);
      if (total < bestCost) { best = a; bestCost = total; }
    }
    return best;
  }

  private tryTrip(trip: Trip): TripPlan | null {
    const origins = this.points(trip.from);
    const oWeights = origins.map((p) => this.originWeight(p));
    const wantsParking = trip.to.includes('parking');
    const garagesFull = wantsParking && this.points(['parking']).every((g) => this.destWeight(g) <= 0);

    for (;;) {
      const oi = pickWeighted(this.rng, oWeights);
      if (oi < 0) return null;
      const origin = origins[oi]!;

      let parkingFailed = false;
      let candidates = this.points(trip.to).filter((d) => d.id !== origin.id);
      let weights = candidates.map((d) => this.destWeight(d));
      if (garagesFull && weights.every((w) => w <= 0)) {
        candidates = this.points(EXIT_TYPES).filter((d) => d.id !== origin.id);
        weights = candidates.map((d) => d.weight);
        parkingFailed = true;
      }
      // Only destinations this origin can actually reach.
      const access = candidates.map((d, k) => (weights[k]! > 0 ? this.bestAccess(origin, d) : null));
      weights = weights.map((w, k) => (access[k] ? w : 0));

      const di = pickWeighted(this.rng, weights);
      if (di < 0) { oWeights[oi] = 0; continue; } // nowhere to go from here: try another origin
      const destination = candidates[di]!;
      const a = access[di]!;
      const r = this.router.route(destination.id, this.net.byId.get(a.path)!, a.s);
      if (!r) { oWeights[oi] = 0; continue; }
      return { origin, destination, access: a, route: r.route, endS: r.endS, vehicle: this.pickVehicle(), parkingFailed };
    }
  }

  private pickVehicle(): VehicleTypeId {
    if (this.mix.length === 1) return this.mix[0]!.type;
    const i = pickWeighted(this.rng, this.mix.map((m) => m.share));
    return this.mix[Math.max(0, i)]!.type;
  }
}
