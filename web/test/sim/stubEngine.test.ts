/**
 * Tests the stub engine's pure logic (`StubHost`), not the Worker wrapper
 * (`stubEngine.ts`, which has no logic of its own to test and can't run
 * under plain Node anyway).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readTickCar, type EngineToUI, type TickMessage } from '@shared/messages.js';
import type { CompiledNetwork } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';

import { StubHost, type StubHostIO } from '@web/sim/stubHost.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}
const grid = (): CompiledNetwork => readJson<CompiledNetwork>('compiled/test-grid.compiled.json');
const morning = (): Preset => readJson<Preset>('presets/morning.json');

/** Same fake-clock-and-message-log shape used in `engineClient.test.ts` and `engine/test/host.test.ts`. */
class FakeIO implements StubHostIO {
  time = 0;
  posts: EngineToUI[] = [];
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  post(message: EngineToUI): void {
    this.posts.push(message);
  }
  now(): number {
    return this.time;
  }
  schedule(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  }
  cancel(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.time = Math.max(this.time, t.at);
      t.fn();
    }
    this.time = end;
  }
  of<T extends EngineToUI['type']>(type: T): Extract<EngineToUI, { type: T }>[] {
    return this.posts.filter((m): m is Extract<EngineToUI, { type: T }> => m.type === type);
  }
}

function run(seed: number, ms: number, maxCars = 1500): { io: FakeIO; host: StubHost } {
  const io = new FakeIO();
  const host = new StubHost(io, { maxCars });
  host.handle({ type: 'load', network: grid(), preset: morning(), seed });
  host.handle({ type: 'run' });
  io.advance(ms);
  return { io, host };
}

describe('determinism', () => {
  it('same seed produces byte-identical tick sequences', () => {
    const a = run(42, 20_000);
    const b = run(42, 20_000);
    const ticksA = a.io.of('tick');
    const ticksB = b.io.of('tick');
    expect(ticksA.length).toBe(ticksB.length);
    expect(ticksA.length).toBeGreaterThan(0);
    for (let i = 0; i < ticksA.length; i++) {
      expect(Array.from(ticksA[i]!.buf)).toEqual(Array.from(ticksB[i]!.buf));
      expect(ticksA[i]!.simTime).toBeCloseTo(ticksB[i]!.simTime, 9);
    }
  });

  it('different seeds produce different tick sequences', () => {
    const a = run(1, 20_000);
    const b = run(2, 20_000);
    const ticksA = a.io.of('tick');
    const ticksB = b.io.of('tick');
    const anyDifferent = ticksA.some((t, i) => {
      const other = ticksB[i];
      return !other || Array.from(t.buf).join(',') !== Array.from(other.buf).join(',');
    });
    expect(anyDifferent).toBe(true);
  });
});

describe('movement', () => {
  it('cars stay within [0, path.length] and only move onto a listed `next` path', () => {
    const { io, host: _host } = run(7, 60_000);
    void _host;
    const network = grid();
    const byIndex = network.paths;
    const nextSets = byIndex.map((p) => new Set(p.next.map((id) => byIndex.findIndex((q) => q.id === id))));

    const ticks = io.of('tick') as TickMessage[];
    // Track each car's previous path per tick to verify transitions are legal.
    const prevPath = new Map<number, number>();
    for (const tick of ticks) {
      const seenIds = new Set<number>();
      for (let i = 0; i < tick.count; i++) {
        const car = readTickCar(tick.buf, i);
        seenIds.add(car.vehicleId);
        const path = byIndex[car.pathIndex];
        expect(path).toBeDefined();
        expect(car.s).toBeGreaterThanOrEqual(0);
        expect(car.s).toBeLessThanOrEqual(path!.length + 1e-6);

        const prev = prevPath.get(car.vehicleId);
        if (prev !== undefined && prev !== car.pathIndex) {
          expect(nextSets[prev]!.has(car.pathIndex)).toBe(true);
        }
        prevPath.set(car.vehicleId, car.pathIndex);
      }
      // Cars absent from this tick left the map; stop tracking them.
      for (const id of [...prevPath.keys()]) if (!seenIds.has(id)) prevPath.delete(id);
    }
    expect(ticks.at(-1)!.count).toBeGreaterThan(0);
  });

  it('respects a maxCars cap', () => {
    const { io } = run(3, 120_000, 5);
    const ticks = io.of('tick') as TickMessage[];
    for (const t of ticks) expect(t.count).toBeLessThanOrEqual(5);
  });
});

describe('protocol', () => {
  it('ready then one empty tick on load, and reset restarts identically', () => {
    const io = new FakeIO();
    const host = new StubHost(io);
    host.handle({ type: 'load', network: grid(), preset: morning(), seed: 9 });
    expect(io.posts.map((p) => p.type)).toEqual(['ready', 'tick']);
    expect(io.of('tick')[0]!.count).toBe(0);

    host.handle({ type: 'run' });
    io.advance(5000);
    const first = io.of('tick').map((t) => Array.from(t.buf));

    host.handle({ type: 'reset' });
    io.posts.length = 0;
    host.handle({ type: 'run' });
    io.advance(5000);
    const second = io.of('tick').map((t) => Array.from(t.buf));
    // The fake clock's `now()` doesn't reset between runs, so wake alignment
    // can shift by one tick at the tail (same caveat as
    // `engine/test/host.test.ts`'s own reset test) -- compare the overlap.
    const n = Math.min(second.length, first.length - 1);
    expect(n).toBeGreaterThan(10);
    expect(second.slice(0, n)).toEqual(first.slice(1, n + 1)); // first[0] is the pre-run empty tick
  });

  it('skip jumps ahead with one tick, stats and metrics', () => {
    const io = new FakeIO();
    const host = new StubHost(io);
    host.handle({ type: 'load', network: grid(), preset: morning(), seed: 1 });
    io.posts.length = 0;
    host.handle({ type: 'skip', simSeconds: 100 });
    expect(io.posts.map((p) => p.type)).toEqual(['tick', 'stats', 'metrics']);
    expect(io.of('tick')[0]!.simTime).toBeCloseTo(100, 6);
  });
});
