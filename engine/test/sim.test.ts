import { describe, expect, it } from 'vitest';
import type { CompletedTrip } from '@shared/messages.js';
import type { CompiledPoint } from '@shared/network.js';
import { mulberry32, pickWeighted, poisson } from '../src/rng.js';
import { GRIDLOCK_SEC, Sim } from '../src/sim.js';
import { currentPath, lengthOf } from '../src/traffic.js';
import { conn, grid, lane, network, preset, readGridRaw, readPreset } from './fixtures.js';
import { loadNetwork } from '../src/network.js';

describe('rng', () => {
  it('is repeatable and seed-dependent', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
  });

  it('picks by weight and never picks zero weights', () => {
    const rng = mulberry32(1);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[pickWeighted(rng, [1, 0, 3])]!++;
    expect(counts[1]).toBe(0);
    expect(counts[2]! / counts[0]!).toBeCloseTo(3, 0);
    expect(pickWeighted(rng, [0, 0])).toBe(-1);
  });

  it('draws Poisson counts with the right mean', () => {
    const rng = mulberry32(2);
    let total = 0;
    for (let i = 0; i < 20000; i++) total += poisson(rng, 0.1);
    expect(total / 20000).toBeCloseTo(0.1, 2);
  });
});

/** Run a sim and collect every completed trip plus per-minute garage snapshots. */
function runFor(sim: Sim, minutes: number) {
  const trips: CompletedTrip[] = [];
  const garages: ReturnType<Sim['parkingSnapshot']>[] = [];
  for (let m = 0; m < minutes; m++) {
    sim.run(60);
    trips.push(...sim.takeCompleted());
    garages.push(sim.parkingSnapshot());
  }
  return { trips, garages };
}

describe('demand on the test grid', () => {
  it('requests vehicles at the preset rate', () => {
    // Morning's curve integrates to 1237.5 vehicles over 30 min.
    const sim = new Sim(grid(), readPreset('morning'), 20261201);
    sim.run(1800);
    expect(sim.counts().requested).toBeGreaterThan(1237.5 * 0.9);
    expect(sim.counts().requested).toBeLessThan(1237.5 * 1.1);
  });

  it('sends about 80% of morning trips to parking while garages have room', () => {
    const sim = new Sim(grid(), readPreset('morning'), 5);
    const { trips } = runFor(sim, 10);
    const toParking = trips.filter((t) => t.destination.startsWith('park-')).length;
    expect(sim.counts().parkingFailed).toBe(0);
    expect(toParking / trips.length).toBeGreaterThan(0.72);
    expect(toParking / trips.length).toBeLessThan(0.88);
  });

  it('keeps garage counts within capacity, filling in the morning', () => {
    const { garages } = runFor(new Sim(grid(), readPreset('morning'), 3), 30);
    for (const snap of garages) {
      for (const g of Object.values(snap)) {
        expect(g.parked).toBeGreaterThanOrEqual(0);
        expect(g.parked + g.reserved).toBeLessThanOrEqual(g.capacity);
      }
    }
    const total = (s: (typeof garages)[number]) => Object.values(s).reduce((a, g) => a + g.parked, 0);
    expect(total(garages.at(-1)!)).toBeGreaterThan(total(garages[0]!));
  });

  it('empties garages at night', () => {
    const { garages, trips } = runFor(new Sim(grid(), readPreset('night'), 3), 20);
    const total = (s: (typeof garages)[number]) => Object.values(s).reduce((a, g) => a + g.parked, 0);
    expect(total(garages.at(-1)!)).toBeLessThan(total(garages[0]!));
    expect(trips.some((t) => t.origin.startsWith('park-'))).toBe(true);
  });

  it('sends cars to an exit and counts parkingFailed when every garage is full', () => {
    const full = { ...readPreset('morning'), parking: { initialOccupancy: 1 } };
    const sim = new Sim(grid(), full, 9);
    const { trips } = runFor(sim, 5);
    expect(sim.counts().parkingFailed).toBeGreaterThan(0);
    expect(trips.every((t) => !t.destination.startsWith('park-'))).toBe(true);
  });

  it('runs the afternoon preset on a map with no lunch zones', () => {
    const raw = readGridRaw();
    raw.points = raw.points.filter((p) => p.type !== 'lunchZone');
    const sim = new Sim(loadNetwork(raw), readPreset('afternoon'), 4);
    const { trips } = runFor(sim, 5);
    expect(trips.length).toBeGreaterThan(0);
    expect(trips.every((t) => !t.destination.startsWith('lunch-'))).toBe(true);
  });

  it('records sensible trips', () => {
    const { trips } = runFor(new Sim(grid(), readPreset('morning'), 11), 5);
    for (const t of trips) {
      expect(t.freeFlowTimeSec).toBeGreaterThan(0);
      // A trip can't beat free flow by more than one step (despawn happens mid-step).
      expect(t.tripTimeSec).toBeGreaterThanOrEqual(t.freeFlowTimeSec - 0.2);
      expect(t.entryQueueTimeSec).toBeGreaterThanOrEqual(0);
      expect(t.stoppedTimeSec).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic for a seed and varies across seeds', () => {
    const snap = (seed: number) => {
      const sim = new Sim(grid(), readPreset('morning'), seed);
      sim.run(300);
      return JSON.stringify({ counts: sim.counts(), cars: sim.cars.map((c) => [c.id, currentPath(c), c.s, c.v]) });
    };
    expect(snap(7)).toBe(snap(7));
    expect(snap(8)).not.toBe(snap(7));
  });
});

describe('entering the map safely', () => {
  // Through traffic on A → C → B passes a garage exit 50 m into B.
  const points: CompiledPoint[] = [
    { id: 'spawn', type: 'edgeSpawn', weight: 1, access: [{ path: 'A', s: 0 }] },
    { id: 'garage', type: 'parking', weight: 1, capacity: 1000, access: [{ path: 'B', s: 50 }] },
    { id: 'sink', type: 'edgeSink', weight: 1, access: [{ path: 'B', s: 100 }] },
  ];
  const net = network([lane('A', 100, 15, ['C']), conn('C', 'A', 'B', 20, 15), lane('B', 100, 15, [])], points);
  const busy = preset({
    spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 40]] },
    trips: [{ share: 0.5, from: ['edgeSpawn'], to: ['edgeSink'] }, { share: 0.5, from: ['parking'], to: ['edgeSink'] }],
    parking: { initialOccupancy: 1 },
  });

  it('never inserts a vehicle into an unsafe gap, at a lane start or mid-lane', () => {
    const sim = new Sim(net, busy, 3);
    let minGap = Infinity;
    for (let step = 0; step < 6000; step++) {
      sim.step();
      for (let p = 0; p < net.count; p++) {
        const here = sim.cars.filter((c) => currentPath(c) === p).sort((a, b) => b.s - a.s);
        for (let k = 1; k < here.length; k++) minGap = Math.min(minGap, here[k - 1]!.s - lengthOf(here[k - 1]!) - here[k]!.s);
      }
    }
    expect(sim.counts().entered).toBeGreaterThan(100);
    expect(minGap).toBeGreaterThan(0);
  });

  it('makes vehicles wait in the entry queue when the road is full, and counts that wait', () => {
    const jammed = preset({ spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 200]] } });
    const sim = new Sim(net, jammed, 1);
    const { trips } = runFor(sim, 3);
    expect(sim.counts().carsWaitingToEnter).toBeGreaterThan(0);
    expect(Math.max(...trips.map((t) => t.entryQueueTimeSec))).toBeGreaterThan(1);
  });
});

describe('gridlock safety', () => {
  it(`removes a vehicle stopped for more than ${GRIDLOCK_SEC} s`, () => {
    // A crawl-speed lane: every vehicle counts as stopped the whole time.
    const net = network([lane('A', 100, 0.05, [])], [
      { id: 'spawn', type: 'edgeSpawn', weight: 1, access: [{ path: 'A', s: 0 }] },
      { id: 'sink', type: 'edgeSink', weight: 1, access: [{ path: 'A', s: 100 }] },
    ]);
    const sim = new Sim(net, preset({ spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 2]] } }), 1);
    sim.run(GRIDLOCK_SEC - 5);
    expect(sim.counts().gridlockRemovals).toBe(0);
    sim.run(60);
    expect(sim.counts().gridlockRemovals).toBeGreaterThan(0);
  });
});
