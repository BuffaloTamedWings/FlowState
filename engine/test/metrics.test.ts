import { describe, expect, it } from 'vitest';
import type { MetricsMessage, UIToEngine } from '@shared/messages.js';
import { EngineHost } from '../src/host.js';
import { levelOfService } from '../src/metrics.js';
import { Sim } from '../src/sim.js';
import { computeStats } from '../src/stats.js';
import { currentPath } from '../src/traffic.js';
import { conn, grid, lane, network, preset, readGridRaw, readPreset } from './fixtures.js';

describe('level of service (HCM, PRD §9.2)', () => {
  it('grades signalized delay with the signalized table', () => {
    const cases: [number, string][] = [[0, 'A'], [10, 'A'], [10.1, 'B'], [20, 'B'], [35, 'C'], [35.1, 'D'], [55, 'D'], [80, 'E'], [80.1, 'F']];
    for (const [d, los] of cases) expect(levelOfService(d, 'signal'), `${d} s`).toBe(los);
    expect(levelOfService(60, 'signalProtectedLeft')).toBe('E');
  });

  it('grades stop-controlled delay with the stricter unsignalized table', () => {
    const cases: [number, string][] = [[10, 'A'], [15, 'B'], [25, 'C'], [25.1, 'D'], [35, 'D'], [50, 'E'], [50.1, 'F']];
    for (const [d, los] of cases) expect(levelOfService(d, 'allStop'), `${d} s`).toBe(los);
    expect(levelOfService(30, 'yield')).toBe('D');
    expect(levelOfService(30, 'signal')).toBe('C'); // same delay, signalized: a grade better
  });
});

describe('control delay', () => {
  const uncontrolled = () => network(
      [lane('A', 150, 15, ['C']), conn('C', 'A', 'B', 20, 15), lane('B', 150, 15, [])],
      [
        { id: 'in', type: 'edgeSpawn', weight: 1, access: [{ path: 'A', s: 0 }] },
        { id: 'out', type: 'edgeSink', weight: 1, access: [{ path: 'B', s: 150 }] },
      ],
      [{ id: 'n', control: 'none', phases: null, inPaths: ['A'], connectors: ['C'] }],
    );

  it('is zero (to step rounding) for a lone vehicle through an uncontrolled junction', () => {
    const sim = new Sim(uncontrolled(), preset({ spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 0.5]] } }), 3);
    sim.run(3600);
    const n = sim.metrics.nodes()['n']!;
    expect(n.carsServed).toBeGreaterThan(15);
    expect(n.avgControlDelaySec).toBeLessThan(0.2);
  });

  it('counts every vehicle through a busier uncontrolled junction, with only small following delay', () => {
    const sim = new Sim(uncontrolled(), preset({ spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 10]] } }), 3);
    let crossed = 0;
    let before = new Map<number, number>();
    for (let i = 0; i < 6000; i++) {
      sim.step();
      for (const c of sim.cars) if (currentPath(c) === 2 && before.get(c.id) !== 2) crossed++;
      before = new Map(sim.cars.map((c) => [c.id, currentPath(c)]));
    }
    const n = sim.metrics.nodes()['n']!;
    expect(n.carsServed).toBeGreaterThan(50);
    expect(n.carsServed).toBe(crossed);
    // Vehicles entering behind a slower one have to speed up: real, but small.
    expect(n.avgControlDelaySec).toBeLessThan(3);
  });

  it('is clearly positive at signals and the all-way stop, and vehicles served match connector exits', () => {
    const sim = new Sim(grid(), readPreset('afternoon'), 20261201);
    const net = sim.net;
    const exitsByNode = new Map<string, number>();
    let before = new Map<number, number>();
    for (let i = 0; i < 9000; i++) {
      sim.step();
      for (const c of sim.cars) {
        const prev = before.get(c.id);
        const now = currentPath(c);
        if (prev !== undefined && net.isLane[prev] === 0 && net.isLane[now] === 1) {
          const node = (net.paths[prev] as { node: string }).node;
          exitsByNode.set(node, (exitsByNode.get(node) ?? 0) + 1);
        }
      }
      before = new Map(sim.cars.map((c) => [c.id, currentPath(c)]));
    }
    const nodes = sim.metrics.nodes();
    for (const [id, m] of Object.entries(nodes)) {
      expect(m.carsServed, id).toBe(exitsByNode.get(id) ?? 0);
      expect(m.avgControlDelaySec, id).toBeGreaterThanOrEqual(0);
    }
    expect(nodes['n02']!.avgControlDelaySec).toBeGreaterThan(3); // everyone stops at an all-way stop
    for (const id of ['n01', 'n11', 'n12', 'n21', 'n22']) {
      expect(nodes[id]!.avgControlDelaySec, id).toBeGreaterThan(2);
      expect(nodes[id]!.avgControlDelaySec, id).toBeLessThan(300);
    }
    expect(nodes['n10']!.avgControlDelaySec).toBeLessThan(nodes['n22']!.avgControlDelaySec); // always-green vs busy
  });
});

describe('max queue per path', () => {
  it('equals the largest queue the per-second stats ever reported, and 0 where nothing queued', () => {
    const sim = new Sim(grid(), readPreset('morning'), 7);
    const net = sim.net;
    const seen = new Float64Array(net.count);
    for (let i = 1; i <= 6000; i++) {
      sim.step();
      if (i % 10 === 0) {
        const buf = computeStats(net, sim.cars, new Uint32Array(net.count), 1);
        for (let p = 0; p < net.count; p++) seen[p] = Math.max(seen[p]!, buf[p * 4 + 2]!);
      }
    }
    const paths = sim.metrics.paths();
    let queued = 0;
    net.paths.forEach((p, i) => {
      expect(paths[p.id]!.maxQueueLengthM, p.id).toBeCloseTo(seen[i]!, 3);
      if (seen[i]! > 0) queued++;
    });
    expect(queued).toBeGreaterThan(5);
    expect(Object.values(paths).some((q) => q.maxQueueLengthM === 0)).toBe(true);
  });
});

describe('metrics message', () => {
  it('reports every compiled node and every path, with running totals that never go backwards', () => {
    const posts: MetricsMessage[] = [];
    const host = new EngineHost({ post: (m) => { if (m.type === 'metrics') posts.push(m); }, now: () => 0, schedule: () => 0, cancel: () => {} });
    const send = (m: UIToEngine) => host.handle(m);
    send({ type: 'load', network: readGridRaw(), preset: readPreset('morning'), seed: 1 });
    for (let k = 0; k < 12; k++) send({ type: 'skip', simSeconds: 30 });
    expect(posts).toHaveLength(12);
    const last = posts.at(-1)!.metrics;
    expect(Object.keys(last.nodes).sort()).toEqual([...grid().nodes.keys()].sort());
    expect(Object.keys(last.paths)).toHaveLength(147);
    for (let k = 1; k < posts.length; k++) {
      for (const [id, m] of Object.entries(posts[k]!.metrics.nodes)) {
        expect(m.carsServed).toBeGreaterThanOrEqual(posts[k - 1]!.metrics.nodes[id]!.carsServed);
      }
      for (const [id, q] of Object.entries(posts[k]!.metrics.paths)) {
        expect(q.maxQueueLengthM).toBeGreaterThanOrEqual(posts[k - 1]!.metrics.paths[id]!.maxQueueLengthM);
      }
    }
    expect(Object.values(last.nodes).reduce((a, m) => a + m.carsServed, 0)).toBeGreaterThan(300);
  });

  it('starts from zero again after reset', () => {
    const posts: MetricsMessage[] = [];
    const host = new EngineHost({ post: (m) => { if (m.type === 'metrics') posts.push(m); }, now: () => 0, schedule: () => 0, cancel: () => {} });
    host.handle({ type: 'load', network: readGridRaw(), preset: readPreset('morning'), seed: 1 });
    host.handle({ type: 'skip', simSeconds: 300 });
    host.handle({ type: 'reset' });
    host.handle({ type: 'skip', simSeconds: 0.1 });
    expect(Object.values(posts.at(-1)!.metrics.nodes).every((m) => m.carsServed === 0)).toBe(true);
  });
});
