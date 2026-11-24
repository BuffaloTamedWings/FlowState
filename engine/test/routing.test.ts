import { describe, expect, it } from 'vitest';
import type { CompiledPoint } from '@shared/network.js';
import { costToGo, freeFlowTime, REROUTE_GAIN, Router, TravelTimes } from '../src/routing.js';
import type { Car } from '../src/traffic.js';
import { conn, diamond, grid, lane, network } from './fixtures.js';

const point = (id: string, path: string, s: number, type: CompiledPoint['type'] = 'edgeSink'): CompiledPoint =>
  ({ id, type, weight: 1, access: [{ path, s }] });

describe('cost to go', () => {
  // A (100 m @ 15) → C (20 m @ 6.7) → B (100 m @ 15), destination 50 m into B.
  const net = network([lane('A', 100, 15, ['C']), conn('C', 'A', 'B', 20, 6.7), lane('B', 100, 15, [])],
    [point('dest', 'B', 50), point('back', 'A', 10)]);
  const tt = new TravelTimes(net);

  it('matches a hand calculation', () => {
    const ctg = costToGo(net, tt, net.points.get('dest')!);
    expect(ctg[2]).toBeCloseTo(50 / 15, 9);
    expect(ctg[1]).toBeCloseTo(20 / 6.7 + 50 / 15, 9);
    expect(ctg[0]).toBeCloseTo(100 / 15 + 20 / 6.7 + 50 / 15, 9);
  });

  it('is infinite where the destination cannot be reached', () => {
    const ctg = costToGo(net, tt, net.points.get('back')!);
    expect(ctg[1]).toBe(Infinity);
    expect(ctg[2]).toBe(Infinity);
  });

  it('builds the route and ends at the destination s', () => {
    const r = new Router(net, tt).route('dest', 0, 0)!;
    expect(Array.from(r.route)).toEqual([0, 1, 2]);
    expect(r.endS).toBe(50);
  });

  it('stops on the start lane when the destination is just ahead on it', () => {
    const r = new Router(net, tt).route('back', 0, 3)!;
    expect(Array.from(r.route)).toEqual([0]);
    expect(r.endS).toBe(10);
    expect(new Router(net, tt).route('back', 0, 20)).toBeNull(); // already past it, no way back
  });

  it('computes free-flow time from speed limits', () => {
    expect(freeFlowTime(net, Int32Array.from([0, 1, 2]), 40, 50)).toBeCloseTo(60 / 15 + 20 / 6.7 + 50 / 15, 9);
    expect(freeFlowTime(net, Int32Array.from([2]), 10, 50)).toBeCloseTo(40 / 15, 9);
  });
});

describe('choosing between routes', () => {
  const net = diamond([point('end', 'D', 100)]);
  const B1 = net.byId.get('B1')!;
  const B2 = net.byId.get('B2')!;

  it('avoids a lane whose traffic is slow', () => {
    const tt = new TravelTimes(net);
    tt.expectedSpeed[B1] = 2;
    const router = new Router(net, tt);
    expect(Array.from(router.route('end', 0, 0)!.route)).toContain(B2);
    tt.expectedSpeed[B1] = 15;
    tt.expectedSpeed[B2] = 2;
    router.refresh();
    expect(Array.from(router.route('end', 0, 0)!.route)).toContain(B1);
  });

  it(`re-routes only when the gain beats ${REROUTE_GAIN * 100}%`, () => {
    const tt = new TravelTimes(net);
    const router = new Router(net, tt);
    const viaB1 = Int32Array.from([0, 1, 3, 5, 7]);
    const car: Car = { id: 1, route: viaB1, leg: 0, s: 0, v: 10 };

    tt.expectedSpeed[B1] = 13; // a little slower: not worth switching
    router.refresh();
    expect(router.reroute(car, 'end', 100)).toBeNull();

    tt.expectedSpeed[B1] = 2; // much slower: switch to B2
    router.refresh();
    const r = router.reroute(car, 'end', 100);
    expect(r && Array.from(r.route)).toContain(B2);
  });

  it('floors expected speed so a standing queue is slow but not impossible', () => {
    const tt = new TravelTimes(net);
    const occ = { on: (p: number) => (p === B1 ? [{ v: 0 }] : []) } as never;
    for (let i = 0; i < 1000; i++) tt.sample(occ, 1);
    expect(tt.expectedSpeed[B1]).toBe(1);
    expect(tt.cost(B1)).toBe(100);
  });
});

describe('routing on the test grid', () => {
  const net = grid();
  const router = new Router(net, new TravelTimes(net));
  const of = (type: string) => [...net.points.values()].filter((p) => p.type === type);

  it('reaches some exit from every spawn', () => {
    for (const spawn of [...of('edgeSpawn'), ...of('rampSpawn')]) {
      const reachable = [...of('edgeSink'), ...of('rampSink')].some((sink) =>
        spawn.access.some((a) => router.costFrom(sink.id, net.byId.get(a.path)!, a.s) < Infinity));
      expect(reachable, `${spawn.id} can't reach any exit`).toBe(true);
    }
  });

  it('reaches every garage from some spawn, and routes end at the garage entrance', () => {
    for (const g of of('parking')) {
      const spawn = of('edgeSpawn').find((sp) => sp.access.some((a) => router.costFrom(g.id, net.byId.get(a.path)!, a.s) < Infinity));
      expect(spawn, `nothing reaches ${g.id}`).toBeDefined();
      const a = spawn!.access.find((x) => router.costFrom(g.id, net.byId.get(x.path)!, x.s) < Infinity)!;
      const r = router.route(g.id, net.byId.get(a.path)!, a.s)!;
      const last = net.paths[r.route[r.route.length - 1]!]!;
      expect(g.access.some((x) => x.path === last.id && x.s === r.endS)).toBe(true);
      for (let i = 1; i < r.route.length; i++) expect(Array.from(net.next[r.route[i - 1]!]!)).toContain(r.route[i]);
    }
  });
});
