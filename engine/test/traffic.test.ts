import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompiledNetwork } from '@shared/network.js';
import { SIM_DT } from '@shared/messages.js';
import { DEFAULT_IDM } from '../src/idm.js';
import { loadNetwork, type Network } from '../src/network.js';
import { currentPath, lookAhead, Occupancy, stepCars, type Car } from '../src/traffic.js';

const CAR = DEFAULT_IDM.carLength;

/** lane A (100 m, 15 m/s) → connector C (20 m, 6.7 m/s) → lane B (100 m, 15 m/s). */
function tinyNetwork(): Network {
  const raw: CompiledNetwork = {
    format: 'flowstate-network',
    version: 2,
    scenario: 'tiny',
    layout: { edges: {}, nodes: {} },
    units: { length: 'm', speed: 'm/s', time: 's' },
    paths: [
      { id: 'L/a/f/0', kind: 'lane', index: 0, edge: 'a', dir: 'f', laneIndex: 0, fromNode: 'x', toNode: 'n',
        length: 100, speedLimit: 15, turns: null, next: ['C/n/a/f/0>b/f/0'] },
      { id: 'C/n/a/f/0>b/f/0', kind: 'connector', index: 1, node: 'n', from: 'L/a/f/0', to: 'L/b/f/0',
        turn: 'right', length: 20, speedLimit: 6.7, phase: null, stop: false, conflicts: [], yieldTo: [], next: ['L/b/f/0'] },
      { id: 'L/b/f/0', kind: 'lane', index: 2, edge: 'b', dir: 'f', laneIndex: 0, fromNode: 'n', toNode: 'y',
        length: 100, speedLimit: 15, turns: null, next: [] },
    ],
    nodes: [],
    points: [],
  };
  return loadNetwork(raw);
}

const ROUTE = Int32Array.from([0, 1, 2]);
const car = (id: number, leg: number, s: number, v = 10): Car => ({ id, route: ROUTE, leg, s, v });

function scan(net: Network, cars: Car[], who: Car, lookahead?: number) {
  const occ = new Occupancy(net.count);
  occ.rebuild(cars);
  return lookAhead(who, net, occ, DEFAULT_IDM, lookahead);
}

describe('lookAhead on a lane → turn → lane road', () => {
  const net = tinyNetwork();

  it('finds the car ahead on the same path', () => {
    const front = car(1, 0, 50);
    const back = car(2, 0, 20);
    expect(scan(net, [front, back], back).leader?.gap).toBeCloseTo(50 - 20 - CAR, 9);
    expect(scan(net, [front, back], front).leader).toBeNull();
  });

  it('finds a leader on the next path across the boundary', () => {
    const ahead = car(1, 1, 5);
    const me = car(2, 0, 90);
    expect(scan(net, [ahead, me], me).leader?.gap).toBeCloseTo(10 + 5 - CAR, 9);
  });

  it('looks past an empty connector to the lane after it', () => {
    const ahead = car(1, 2, 10, 3);
    const me = car(2, 0, 90);
    const { leader } = scan(net, [ahead, me], me);
    expect(leader?.gap).toBeCloseTo(10 + 20 + 10 - CAR, 9);
    expect(leader?.speed).toBe(3);
  });

  it('ignores cars beyond the lookahead distance', () => {
    const ahead = car(1, 2, 10);
    const me = car(2, 0, 0);
    expect(scan(net, [ahead, me], me, 50).leader).toBeNull();
  });

  it('has no leader at the end of its route', () => {
    expect(scan(net, [car(1, 2, 50)], car(1, 2, 50)).leader).toBeNull();
  });

  it('caps acceleration so the car reaches a slower turn at its limit', () => {
    const me = car(1, 0, 90, 10); // 10 m before the 6.7 m/s connector, going 10 m/s
    expect(scan(net, [me], me).maxAccel).toBeCloseTo(-(10 ** 2 - 6.7 ** 2) / (2 * 10), 9);
    expect(scan(net, [me], me).v0).toBe(15); // desired speed is still this lane's limit
    const slow = car(1, 0, 90, 5); // already under the turn's limit: no cap
    expect(scan(net, [slow], slow).maxAccel).toBe(Infinity);
  });

  it('drives one car through, slowing for the turn and finishing at the end', () => {
    const cars = [car(1, 0, 0, 15)];
    const occ = new Occupancy(net.count);
    let maxOnTurn = 0;
    let finishedAt = -1;
    for (let step = 0; step < 2000 && finishedAt < 0; step++) {
      const r = stepCars(net, cars, occ);
      const c = cars[0];
      if (c && currentPath(c) === 1) maxOnTurn = Math.max(maxOnTurn, c.v);
      if (r.finished.includes(1)) finishedAt = step;
    }
    expect(finishedAt).toBeGreaterThan(0);
    expect(cars).toHaveLength(0);
    expect(maxOnTurn).toBeGreaterThan(5);
    expect(maxOnTurn).toBeLessThan(6.7 + 0.5);
  });
});

// ---------------------------------------------------------------------------

const GRID = resolve(import.meta.dirname, '../../data/compiled/test-grid.compiled.json');
const grid = (): Network => loadNetwork(JSON.parse(readFileSync(GRID, 'utf8')) as CompiledNetwork);

/** Test-only shortest-by-hops route. S4 replaces this with A* by travel time. */
function bfs(net: Network, from: number, targets: ReadonlySet<number>): Int32Array | null {
  const prev = new Int32Array(net.count).fill(-1);
  const seen = new Uint8Array(net.count);
  const queue = [from];
  seen[from] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    if (targets.has(i)) {
      const route = [i];
      while (route[0] !== from) route.unshift(prev[route[0]!]!);
      return Int32Array.from(route);
    }
    for (const j of net.next[i]!) {
      if (!seen[j]) { seen[j] = 1; prev[j] = i; queue.push(j); }
    }
  }
  return null;
}

/** The longest BFS route from any edge spawn lane to any edge sink lane. */
function longestSpawnToSinkRoute(net: Network): Int32Array {
  const lanesOf = (type: string) =>
    [...net.points.values()].filter((p) => p.type === type).flatMap((p) => p.access.map((a) => net.byId.get(a.path)!));
  const sinks = new Set(lanesOf('edgeSink'));
  let best: Int32Array | null = null;
  let bestLen = 0;
  for (const start of lanesOf('edgeSpawn')) {
    const r = bfs(net, start, sinks);
    const len = r ? r.reduce((sum, i) => sum + net.length[i]!, 0) : 0;
    if (r && len > bestLen) { best = r; bestLen = len; }
  }
  if (!best) throw new Error('no spawn → sink route on the test grid');
  return best;
}

/** Put `n` cars on the route, `spacing` m apart, the first one `spacing` m in. Front car gets id 0. */
function platoon(net: Network, route: Int32Array, n: number, spacing: number): Car[] {
  const cars: Car[] = [];
  for (let k = 0; k < n; k++) {
    let d = (n - k) * spacing;
    let leg = 0;
    while (leg < route.length - 1 && d >= net.length[route[leg]!]!) { d -= net.length[route[leg]!]!; leg++; }
    cars.push({ id: k, route, leg, s: d, v: 0 });
  }
  return cars;
}

/** Distance from the start of the route to the car. */
function odometer(net: Network, c: Car): number {
  let d = c.s;
  for (let l = 0; l < c.leg; l++) d += net.length[c.route[l]!]!;
  return d;
}

interface PlatoonRun {
  route: Int32Array;
  finishOrder: number[];
  minGap: number;
  maxSpeedOverLimit: number;
  steps: number;
  trace: number[];
}

function runPlatoon(): PlatoonRun {
  const net = grid();
  const route = longestSpawnToSinkRoute(net);
  const cars = platoon(net, route, 10, 30);
  const occ = new Occupancy(net.count);
  const finishOrder: number[] = [];
  const trace: number[] = [];
  let minGap = Infinity;
  let maxSpeedOverLimit = -Infinity;
  let steps = 0;
  for (; steps < 6000 && cars.length > 0; steps++) {
    finishOrder.push(...stepCars(net, cars, occ).finished);
    for (let k = 1; k < cars.length; k++) {
      minGap = Math.min(minGap, odometer(net, cars[k - 1]!) - odometer(net, cars[k]!) - CAR);
    }
    for (const c of cars) {
      maxSpeedOverLimit = Math.max(maxSpeedOverLimit, c.v - net.speedLimit[currentPath(c)]!);
      trace.push(c.leg, c.s, c.v);
    }
  }
  return { route, finishOrder, minGap, maxSpeedOverLimit, steps, trace };
}

describe('a platoon driving a real route on the test grid', () => {
  const run = runPlatoon();

  it('uses a route that crosses several intersections', () => {
    const net = grid();
    const connectors = Array.from(run.route).filter((i) => net.isLane[i] === 0).length;
    expect(connectors).toBeGreaterThanOrEqual(2);
  });

  it('gets every car to the end of the route, in order', () => {
    expect(run.finishOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(run.steps * SIM_DT).toBeLessThan(600);
  });

  it('never lets a car run into the one ahead, across path boundaries', () => {
    expect(run.minGap).toBeGreaterThan(0);
  });

  it('keeps cars at or under each path speed limit, turns included', () => {
    expect(run.maxSpeedOverLimit).toBeLessThan(0.5);
  });

  it('is deterministic', () => {
    expect(runPlatoon().trace).toEqual(run.trace);
  });
});
