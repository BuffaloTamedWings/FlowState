import { describe, expect, it } from 'vitest';
import { vehicleCodeOf, withVehicleCode, TICK_FLAG_BRAKING, TICK_FLAG_STOPPED } from '@shared/messages.js';
import { VEHICLE_TYPES, vehicleTypeByCode } from '@shared/vehicles.js';
import type { CompiledPoint } from '@shared/network.js';
import { Sim } from '../src/sim.js';
import { currentPath, lengthOf, lookAhead, Occupancy, type Car } from '../src/traffic.js';
import { VEHICLE_PARAMS, vehicleCode } from '../src/vehicles.js';
import { conn, grid, lane, network, preset, readPreset } from './fixtures.js';

describe('engine vehicle types follow the shared contract', () => {
  it('uses exactly the shared lengths, so gaps match what the front end draws', () => {
    for (const t of VEHICLE_TYPES) expect(VEHICLE_PARAMS[t.id].carLength).toBe(t.length);
  });

  it('round-trips each type code through the tick flags without touching other bits', () => {
    for (const t of VEHICLE_TYPES) {
      const flags = withVehicleCode(TICK_FLAG_BRAKING | TICK_FLAG_STOPPED, vehicleCode(t.id));
      expect(vehicleTypeByCode(vehicleCodeOf(flags)).id).toBe(t.id);
      expect(flags & (TICK_FLAG_BRAKING | TICK_FLAG_STOPPED)).toBe(TICK_FLAG_BRAKING | TICK_FLAG_STOPPED);
    }
  });

  it('rejects a preset with an invalid vehicle mix', () => {
    const bad = preset({ vehicleMix: [{ type: 'car', share: 0.5 }, { type: 'truck', share: 0.2 }] });
    expect(() => new Sim(grid(), bad, 1)).toThrow(/shares sum to 0.7/);
  });
});

describe('long vehicles in traffic', () => {
  // One road with no merges: A (100 m) → C (20 m turn) → B (100 m), plus a garage
  // exit 50 m into B, so we can check every gap exactly along the chain.
  const points: CompiledPoint[] = [
    { id: 'spawn', type: 'edgeSpawn', weight: 1, access: [{ path: 'A', s: 0 }] },
    { id: 'garage', type: 'parking', weight: 1, capacity: 1000, access: [{ path: 'B', s: 50 }] },
    { id: 'sink', type: 'edgeSink', weight: 1, access: [{ path: 'B', s: 100 }] },
  ];
  const net = network([lane('A', 100, 15, ['C']), conn('C', 'A', 'B', 20, 6.7), lane('B', 100, 15, [])], points);
  const offset = [0, 100, 120]; // start of each path along the chain
  const mixed = preset({
    spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 30]] },
    trips: [{ share: 0.6, from: ['edgeSpawn'], to: ['edgeSink'] }, { share: 0.4, from: ['parking'], to: ['edgeSink'] }],
    parking: { initialOccupancy: 1 },
    vehicleMix: [{ type: 'car', share: 0.5 }, { type: 'truck', share: 0.3 }, { type: 'semi', share: 0.2 }],
  });

  it('a follower sees a semi across a path boundary using the semi\'s 18 m length', () => {
    // Semi front 3 m into the turn: 15 m of it is still on lane A.
    const semi: Car = { id: 1, route: Int32Array.from([0, 1, 2]), leg: 1, s: 3, v: 2, params: VEHICLE_PARAMS.semi, type: 'semi' };
    const me: Car = { id: 2, route: Int32Array.from([0, 1, 2]), leg: 0, s: 70, v: 5 };
    const occ = new Occupancy(net.count);
    occ.rebuild([semi, me]);
    expect(lookAhead(me, net, occ).leader?.gap).toBeCloseTo(100 - 70 + 3 - 18, 9); // 15 m, not 28.5
  });

  it('keeps a positive bumper-to-bumper gap everywhere with cars, trucks and semis mixed', () => {
    const sim = new Sim(net, mixed, 4);
    const seen = { car: 0, truck: 0, semi: 0 };
    let minGap = Infinity;
    for (let step = 0; step < 12000; step++) {
      sim.step();
      const along = sim.cars
        .map((c) => ({ c, x: offset[currentPath(c)]! + c.s }))
        .sort((a, b) => b.x - a.x);
      for (let k = 1; k < along.length; k++) {
        minGap = Math.min(minGap, along[k - 1]!.x - lengthOf(along[k - 1]!.c) - along[k]!.x);
      }
    }
    // Count types among everything that entered.
    const sim2 = new Sim(net, mixed, 4);
    const ids = new Set<number>();
    for (let step = 0; step < 12000; step++) {
      sim2.step();
      for (const c of sim2.cars) if (!ids.has(c.id)) { ids.add(c.id); seen[c.type ?? 'car']++; }
    }
    expect(minGap).toBeGreaterThan(0);
    const total = seen.car + seen.truck + seen.semi;
    expect(total).toBeGreaterThan(300);
    expect(seen.truck / total).toBeGreaterThan(0.22);
    expect(seen.truck / total).toBeLessThan(0.38);
    expect(seen.semi / total).toBeGreaterThan(0.13);
    expect(seen.semi / total).toBeLessThan(0.27);
  });
});

describe('vehicle mix on the test grid', () => {
  it('runs the morning preset with the PRD example mix (90% cars, 8% trucks, 2% semis)', () => {
    const withMix = { ...readPreset('morning'), vehicleMix: [
      { type: 'car' as const, share: 0.9 }, { type: 'truck' as const, share: 0.08 }, { type: 'semi' as const, share: 0.02 },
    ] };
    const sim = new Sim(grid(), withMix, 20261201);
    const types = { car: 0, truck: 0, semi: 0 };
    const ids = new Set<number>();
    for (let m = 0; m < 30; m++) {
      sim.run(60);
      for (const c of sim.cars) if (!ids.has(c.id)) { ids.add(c.id); types[c.type ?? 'car']++; }
    }
    const c = sim.counts();
    // Same preset with all cars, for comparison: trucks and semis take more room and
    // start slower, so a little less gets through, but not dramatically less.
    const allCars = new Sim(grid(), readPreset('morning'), 20261201);
    allCars.run(1800);
    expect(c.finished).toBeGreaterThan(0.85 * allCars.counts().finished);
    // Morning is over capacity on the signalized test grid (see control.test.ts), so a
    // few vehicles can queue past the gridlock limit; no deadlock (the drain tests).
    expect(c.gridlockRemovals).toBeLessThanOrEqual(5);
    expect(types.truck).toBeGreaterThan(0);
    expect(types.semi).toBeGreaterThan(0);
    expect(types.car / ids.size).toBeGreaterThan(0.85);
  });
});
