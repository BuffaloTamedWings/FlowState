import { describe, expect, it } from 'vitest';
import type { CompiledNode, ConnectorPath } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';
import { ALL_RED_SEC, bodyPaths, CRITICAL_GAP_SEC, CYCLE_SEC, signalPlan, signalState, YELLOW_SEC } from '../src/control.js';
import type { Network } from '../src/network.js';
import { Sim } from '../src/sim.js';
import { currentPath, lengthOf, type Car } from '../src/traffic.js';
import { VEHICLE_PARAMS } from '../src/vehicles.js';
import { grid, preset, readPreset, yieldJunction } from './fixtures.js';

const connectorsOf = (net: Network) =>
  new Map(net.paths.filter((p): p is ConnectorPath => p.kind === 'connector').map((p) => [p.id, p]));

const MIX = [{ type: 'car' as const, share: 0.9 }, { type: 'truck' as const, share: 0.08 }, { type: 'semi' as const, share: 0.02 }];

describe('signal timing', () => {
  const net = grid();
  const conns = connectorsOf(net);

  it('splits green in proportion to incoming lanes, with yellow and all-red, in a 60 s cycle', () => {
    const plan = signalPlan(net.nodes.get('n21')!, conns); // NS 4 lanes, EW 2 lanes
    const green = CYCLE_SEC - 2 * (YELLOW_SEC + ALL_RED_SEC);
    expect(plan.map((w) => w.id)).toEqual(['NS', 'EW']);
    expect(plan[0]!.greenEnd - plan[0]!.greenStart).toBeCloseTo((green * 4) / 6, 9);
    expect(plan[1]!.greenEnd - plan[1]!.greenStart).toBeCloseTo((green * 2) / 6, 9);
    for (const w of plan) {
      expect(w.yellowEnd - w.greenEnd).toBe(YELLOW_SEC);
      expect(w.redEnd - w.yellowEnd).toBe(ALL_RED_SEC);
    }
    expect(plan[1]!.greenStart).toBe(plan[0]!.redEnd);
    expect(plan[1]!.redEnd).toBeCloseTo(CYCLE_SEC, 9);
  });

  it('reports green, yellow and red at the right moments, repeating every cycle', () => {
    const plan = signalPlan(net.nodes.get('n21')!, conns);
    const ns = plan[0]!;
    expect(signalState(plan, 'NS', 1)).toBe('green');
    expect(signalState(plan, 'NS', ns.greenEnd + 1)).toBe('yellow');
    expect(signalState(plan, 'NS', ns.yellowEnd + 0.5)).toBe('red'); // all-red
    expect(signalState(plan, 'EW', ns.yellowEnd + 0.5)).toBe('red'); // all-red for both
    expect(signalState(plan, 'EW', plan[1]!.greenStart + 1)).toBe('green');
    expect(signalState(plan, 'NS', CYCLE_SEC + 1)).toBe('green');
  });

  it('keeps a single-phase signal green all the time', () => {
    const plan = signalPlan(net.nodes.get('n10')!, conns);
    for (const t of [0, 30, 55, 59.5, 600]) expect(signalState(plan, 'EW', t)).toBe('green');
  });

  it('runs four phases for a protected-left signal, lefts only in their own phase', () => {
    const fake: CompiledNode = {
      id: 'pl', control: 'signalProtectedLeft', inPaths: [], connectors: [],
      phases: [{ id: 'NS-left', paths: ['a'] }, { id: 'NS', paths: ['b', 'c'] }, { id: 'EW-left', paths: ['d'] }, { id: 'EW', paths: ['e', 'f'] }],
    };
    const from = (lane: string) => ({ from: lane }) as ConnectorPath;
    const plan = signalPlan(fake, new Map([['a', from('1')], ['b', from('2')], ['c', from('3')], ['d', from('4')], ['e', from('5')], ['f', from('6')]]));
    expect(plan.map((w) => w.id)).toEqual(['NS-left', 'NS', 'EW-left', 'EW']);
    expect(plan.at(-1)!.redEnd).toBeCloseTo(CYCLE_SEC, 9);
    const mid = (w: (typeof plan)[number]) => (w.greenStart + w.greenEnd) / 2;
    expect(signalState(plan, 'NS-left', mid(plan[0]!))).toBe('green');
    expect(signalState(plan, 'NS-left', mid(plan[1]!))).toBe('red');
    expect(signalState(plan, 'NS', mid(plan[0]!))).toBe('red');
  });
});

describe('vehicle bodies', () => {
  it('a semi straddling a turn occupies both the turn and the lane behind it', () => {
    const net = grid();
    const route = Int32Array.from([0, ...net.next[0]!.slice(0, 1), ...net.next[net.next[0]![0]!]!.slice(0, 1)]);
    const semi: Car = { id: 1, route, leg: 1, s: 5, v: 1, params: VEHICLE_PARAMS.semi };
    expect(bodyPaths(semi, net)).toEqual([route[1], route[0]]);
    const car: Car = { id: 2, route, leg: 1, s: 5, v: 1 };
    expect(bodyPaths(car, net)).toEqual([route[1]]);
  });
});

/** Every pair of connectors whose curves cross. */
function crossingPairs(net: Network): [number, number][] {
  const out: [number, number][] = [];
  for (const p of net.paths) {
    if (p.kind !== 'connector') continue;
    for (const c of p.conflicts) {
      const q = net.byId.get(c.path)!;
      if (c.type === 'cross' && p.index < q) out.push([p.index, q]);
    }
  }
  return out;
}

interface Violations {
  crossing: number;
  overlap: number;
  redEntries: number;
  unstoppedEntries: number;
}

/** Run a preset and check the safety invariants after every step. */
function watch(sim: Sim, seconds: number): Violations {
  const net = sim.net;
  const pairs = crossingPairs(net);
  const v: Violations = { crossing: 0, overlap: 0, redEntries: 0, unstoppedEntries: 0 };
  let before = new Map<number, number>();
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    // What the gate sees right before the step: lights, and who has made their stop.
    const pending = new Map<number, { red: boolean; mustStop: boolean; stopped: boolean }>();
    for (const c of sim.cars) {
      const next = c.route[c.leg + 1];
      if (next === undefined || net.isLane[next] === 1 || net.isLane[currentPath(c)] === 0) continue;
      const ci = net.paths[next] as ConnectorPath;
      pending.set(c.id, { red: sim.control.signalStateOf(next) === 'red', mustStop: ci.stop, stopped: sim.control.hasStopped(c.id, next) });
    }
    sim.step();
    const now = new Map<number, number>();
    const bodies = new Map<number, { id: number; lo: number; hi: number }[]>();
    for (const c of sim.cars) {
      now.set(c.id, currentPath(c));
      // Entered a connector this step from the lane before it?
      const prev = before.get(c.id);
      const p = currentPath(c);
      if (prev !== undefined && prev !== p && net.isLane[prev] === 1 && net.isLane[p] === 0) {
        const pend = pending.get(c.id);
        if (pend?.red) v.redEntries++;
        if (pend?.mustStop && !pend.stopped) v.unstoppedEntries++;
      }
      // Body intervals on each path, front back to tail.
      let hi = c.s;
      let remaining = lengthOf(c);
      for (let leg = c.leg; leg >= 0 && remaining > 1e-6; leg--) {
        const path = c.route[leg]!;
        if (leg < c.leg) hi = net.length[path]!;
        const lo = Math.max(0, hi - remaining);
        remaining -= hi - lo;
        const list = bodies.get(path) ?? [];
        list.push({ id: c.id, lo, hi });
        bodies.set(path, list);
      }
    }
    for (const list of bodies.values()) {
      list.sort((a, b) => a.lo - b.lo);
      for (let k = 1; k < list.length; k++) if (list[k]!.lo < list[k - 1]!.hi - 1e-6) v.overlap++;
    }
    for (const [a, b] of pairs) if (bodies.has(a) && bodies.has(b)) v.crossing++;
    before = now;
  }
  return v;
}

describe('safety on the test grid (30 min per preset)', () => {
  const cases: [string, Preset][] = [
    ['morning', readPreset('morning')],
    ['afternoon', readPreset('afternoon')],
    ['night', readPreset('night')],
    ['morning + trucks', { ...readPreset('morning'), vehicleMix: MIX }],
  ];
  for (const [label, p] of cases) {
    it(`${label}: no crossings, no overlaps, nobody runs a red or a stop sign`, () => {
      const v = watch(new Sim(grid(), p, 20261201), 1800);
      expect(v).toEqual({ crossing: 0, overlap: 0, redEntries: 0, unstoppedEntries: 0 });
    });
  }
});

describe('no deadlocks', () => {
  /** Run 30 min of the preset, then no new arrivals: everything must drain. */
  function drains(p: Preset): { finished: number; requested: number; left: number } {
    const curve = [...p.spawnRate.curve, [p.durationSec + 1, 0], [1e9, 0]] as [number, number][];
    const sim = new Sim(grid(), { ...p, spawnRate: { ...p.spawnRate, curve } }, 20261201, { gridlockSec: Infinity });
    sim.run(p.durationSec);
    for (let m = 0; m < 90 && (sim.cars.length > 0 || sim.waitingCount > 0); m++) sim.run(60);
    const c = sim.counts();
    return { finished: c.finished, requested: c.requested - c.skipped, left: sim.cars.length + sim.waitingCount };
  }

  for (const id of ['morning', 'afternoon', 'night'] as const) {
    it(`${id}: the map empties once arrivals stop, with gridlock removal turned off`, () => {
      const r = drains(readPreset(id));
      expect(r.left).toBe(0);
      expect(r.finished).toBe(r.requested);
    });
  }

  it('morning with trucks and semis also drains', () => {
    const r = drains({ ...readPreset('morning'), vehicleMix: MIX });
    expect(r.left).toBe(0);
  });

  it('never leaves a vehicle stopped inside an intersection (don\'t block the box)', () => {
    const sim = new Sim(grid(), readPreset('night'), 20261201);
    let worst = 0;
    const inBox = new Map<number, number>();
    for (let i = 0; i < 18000; i++) {
      sim.step();
      for (const c of sim.cars) {
        if (sim.net.isLane[currentPath(c)] === 0 && c.v < 0.1) {
          const t = (inBox.get(c.id) ?? 0) + 0.1;
          inBox.set(c.id, t);
          worst = Math.max(worst, t);
        } else inBox.delete(c.id);
      }
    }
    expect(worst).toBeLessThan(5);
  });
});

describe('a stop sign on a side street (yield node)', () => {
  const net = yieldJunction();
  const cmaj = net.byId.get('Cmaj')!;
  const cmin = net.byId.get('Cmin')!;
  const busy = preset({ spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 30]] } });

  it('minor vehicles stop first, then only go with a gap in major traffic', () => {
    const sim = new Sim(net, busy, 2);
    let minorEntries = 0;
    let unsafe = 0;
    let before = new Map<number, number>();
    for (let i = 0; i < 18000; i++) {
      // Major vehicles that would reach the junction within the critical gap.
      const majorSoon = sim.cars.some((c) => c.route[c.leg + 1] === cmaj && c.v >= 0.5 &&
        (net.length[currentPath(c)]! - c.s) / c.v < CRITICAL_GAP_SEC - 0.2);
      const stoppedMinor = new Set(sim.cars.filter((c) => sim.control.hasStopped(c.id, cmin)).map((c) => c.id));
      sim.step();
      for (const c of sim.cars) {
        if (currentPath(c) === cmin && before.get(c.id) !== cmin) {
          minorEntries++;
          expect(stoppedMinor.has(c.id), `minor #${c.id} entered without stopping`).toBe(true);
          if (majorSoon) unsafe++;
        }
      }
      before = new Map(sim.cars.map((c) => [c.id, currentPath(c)]));
    }
    expect(minorEntries).toBeGreaterThan(30);
    expect(unsafe).toBe(0);
  });

  it('major vehicles never stop for the sign; they only wait while a minor vehicle is already in the junction', () => {
    const sim = new Sim(net, busy, 2);
    let majorSteps = 0;
    let heldWithJunctionClear = 0;
    for (let i = 0; i < 18000; i++) {
      const minorInJunction = sim.control.isOccupied(cmin);
      sim.step();
      for (const c of sim.cars) {
        if (c.route[c.leg + 1] !== cmaj) continue;
        majorSteps++;
        if (sim.held.has(c.id) && !minorInJunction && !sim.control.isOccupied(cmin)) heldWithJunctionClear++;
      }
    }
    expect(majorSteps).toBeGreaterThan(1000);
    expect(heldWithJunctionClear).toBe(0);
  });
});

describe('throughput with control on', () => {
  it('afternoon and night have no gridlock removals; morning only a handful (it is over capacity)', () => {
    for (const id of ['afternoon', 'night'] as const) {
      const sim = new Sim(grid(), readPreset(id), 20261201);
      sim.run(1800);
      expect(sim.counts().gridlockRemovals, id).toBe(0);
    }
    // Morning's demand exceeds what the signalized test grid can carry (hundreds wait
    // to enter), so a few vehicles queue past the 300 s limit. S10 tunes demand.
    const sim = new Sim(grid(), readPreset('morning'), 20261201);
    sim.run(1800);
    expect(sim.counts().gridlockRemovals).toBeLessThanOrEqual(5);
  });
});
