import { describe, expect, it } from 'vitest';
import {
  hasFlag,
  readPathStats,
  readTickCar,
  STATS_STRIDE,
  TICK_FLAG_STOPPED,
  TICK_FLAG_YIELDING,
  vehicleCodeOf,
  type EngineToUI,
  type MetricsMessage,
  type StatsMessage,
  type TickMessage,
  type UIToEngine,
} from '@shared/messages.js';
import type { CompiledNetwork } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';
import { EngineHost, MAX_STEPS_PER_WAKE, type HostIO } from '../src/host.js';
import { currentPath } from '../src/traffic.js';
import { readGridRaw, readPreset } from './fixtures.js';

/** A fake clock + timer + message log, so tests control real time exactly. */
class FakeIO implements HostIO {
  time = 0;
  posts: { message: EngineToUI; transfer: ArrayBuffer[] }[] = [];
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  post(message: EngineToUI, transfer: ArrayBuffer[]): void { this.posts.push({ message, transfer }); }
  now(): number { return this.time; }
  schedule(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  }
  cancel(handle: unknown): void { this.timers = this.timers.filter((t) => t.id !== handle); }

  /** Advance real time, firing timers in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.time = Math.max(this.time, t.at); // a late timer fires late, it doesn't rewind the clock
      t.fn();
    }
    this.time = end;
  }

  of<T extends EngineToUI['type']>(type: T): Extract<EngineToUI, { type: T }>[] {
    return this.posts.map((p) => p.message).filter((m): m is Extract<EngineToUI, { type: T }> => m.type === type);
  }
  clear(): void { this.posts = []; }
}

function setup(preset: Preset = readPreset('morning'), network: CompiledNetwork = readGridRaw()) {
  const io = new FakeIO();
  const host = new EngineHost(io);
  const send = (m: UIToEngine) => host.handle(m);
  send({ type: 'load', network, preset, seed: 20261201 });
  return { io, host, send };
}

describe('load', () => {
  it('replies ready with the path count, then one empty tick, and stays paused', () => {
    const { io, host } = setup();
    expect(io.posts.map((p) => p.message.type)).toEqual(['ready', 'tick']);
    expect(io.of('ready')[0]!.pathCount).toBe(147);
    expect(io.of('tick')[0]!.count).toBe(0);
    expect(host.isRunning).toBe(false);
    io.advance(5000);
    expect(io.of('tick')).toHaveLength(1); // nothing happens until run
  });

  it('reports bad input as an error message instead of throwing', () => {
    const v1 = readGridRaw();
    v1.version = 1;
    const { io } = setup(readPreset('morning'), v1);
    expect(io.of('error')[0]!.message).toMatch(/version is 1/);

    const broken = readGridRaw();
    broken.paths[0]!.next = ['nowhere'];
    expect(setup(readPreset('morning'), broken).io.of('error')[0]!.message).toMatch(/unknown path nowhere/);

    const badMix = { ...readPreset('morning'), vehicleMix: [{ type: 'car' as const, share: 0.5 }] };
    expect(setup(badMix).io.of('error')[0]!.message).toMatch(/shares sum to 0.5/);
  });

  it('errors on run before load', () => {
    const io = new FakeIO();
    new EngineHost(io).handle({ type: 'run' });
    expect(io.of('error')[0]!.message).toMatch(/before load/);
  });
});

describe('running', () => {
  it('sends a tick per 0.1 s step whose buffer matches the vehicles, transferred not copied', () => {
    const { io, host, send } = setup();
    io.clear();
    send({ type: 'run' });
    io.advance(60_000); // 60 s real at 1× → 600 steps
    const ticks = io.of('tick');
    expect(ticks.length).toBeGreaterThanOrEqual(598);
    expect(ticks.length).toBeLessThanOrEqual(601);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.simTime - ticks[i - 1]!.simTime).toBeCloseTo(0.1, 9);

    const last = ticks.at(-1)!;
    const sim = host.current!;
    expect(last.count).toBe(sim.cars.length);
    expect(last.count).toBeGreaterThan(5);
    sim.cars.forEach((c, i) => {
      const t = readTickCar(last.buf, i);
      expect(t.vehicleId).toBe(c.id);
      expect(t.pathIndex).toBe(currentPath(c));
      expect(t.s).toBeCloseTo(c.s, 3);
      expect(t.speed).toBeCloseTo(c.v, 3);
    });
    const post = io.posts.find((p) => p.message === last)!;
    expect(post.transfer).toEqual([last.buf.buffer]);
  });

  it('runs 4× as many steps per real second at 4× speed, and stops on pause', () => {
    const { io, send } = setup();
    send({ type: 'run' });
    io.advance(10_000);
    const at1x = io.of('tick').length;
    send({ type: 'setSpeed', multiplier: 4 });
    io.clear();
    io.advance(10_000);
    expect(io.of('tick').length).toBeGreaterThanOrEqual(395);
    expect(io.of('tick').length).toBeLessThanOrEqual(401);
    expect(at1x).toBeGreaterThan(95);

    send({ type: 'pause' });
    io.clear();
    io.advance(10_000);
    expect(io.posts).toHaveLength(0);
  });

  it('drops the backlog after a long stall instead of trying to catch up', () => {
    const { io, send } = setup();
    send({ type: 'run' });
    io.advance(1000);
    io.clear();
    // Freeze the loop for 10 s (e.g. a backgrounded tab), then let one wake fire.
    io.time += 10_000;
    io.advance(1);
    expect(io.of('tick').length).toBeLessThanOrEqual(MAX_STEPS_PER_WAKE);
  });

  it('flags vehicles waiting at a red light as stopped + yielding', () => {
    const { io, send } = setup();
    send({ type: 'run' });
    io.advance(120_000);
    const tick = io.of('tick').at(-1)!;
    let waiting = 0;
    for (let i = 0; i < tick.count; i++) {
      const f = readTickCar(tick.buf, i).flags;
      if (hasFlag(f, TICK_FLAG_YIELDING) && hasFlag(f, TICK_FLAG_STOPPED)) waiting++;
    }
    expect(waiting).toBeGreaterThan(0);
  });

  it('carries the vehicle type code for trucks and semis', () => {
    const mix = { ...readPreset('morning'), vehicleMix: [{ type: 'car' as const, share: 0.5 }, { type: 'truck' as const, share: 0.3 }, { type: 'semi' as const, share: 0.2 }] };
    const { io, host, send } = setup(mix);
    send({ type: 'run' });
    io.advance(60_000);
    const tick = io.of('tick').at(-1)!;
    const want: Record<string, number> = { car: 0, truck: 1, semi: 2 };
    const codes = new Set<number>();
    host.current!.cars.forEach((c, i) => {
      const code = vehicleCodeOf(readTickCar(tick.buf, i).flags);
      expect(code).toBe(want[c.type ?? 'car']);
      codes.add(code);
    });
    expect(codes).toEqual(new Set([0, 1, 2]));
  });
});

describe('skip and reset', () => {
  it('skip jumps ahead with exactly one tick, plus stats and metrics', () => {
    const { io, send } = setup();
    io.clear();
    send({ type: 'skip', simSeconds: 300 });
    expect(io.posts.map((p) => p.message.type)).toEqual(['tick', 'stats', 'metrics']);
    expect(io.of('tick')[0]!.simTime).toBeCloseTo(300, 6);
  });

  it('reset restarts from empty with the same seed, giving identical ticks', () => {
    const { io, send } = setup();
    send({ type: 'run' });
    io.advance(30_000);
    const first = io.of('tick').map((t) => Array.from(t.buf));
    send({ type: 'reset' });
    expect(io.posts.at(-2)!.message.type).toBe('ready');
    io.clear();
    send({ type: 'run' });
    io.advance(30_000);
    const second = [io.of('tick')].flat().map((t: TickMessage) => Array.from(t.buf));
    expect(second.slice(0, 250)).toEqual(first.slice(1, 251)); // first[0] is the empty tick after load
  });
});

describe('stats and metrics', () => {
  it('sends stats every sim-second, 4 floats per path, with sane values', () => {
    const { io, send } = setup();
    send({ type: 'run' });
    io.advance(120_000);
    const stats = io.of('stats') as StatsMessage[];
    expect(stats.length).toBeGreaterThanOrEqual(118);
    for (let i = 1; i < stats.length; i++) expect(stats[i]!.simTime - stats[i - 1]!.simTime).toBeCloseTo(1, 6);
    const last = stats.at(-1)!;
    expect(last.buf.length).toBe(147 * STATS_STRIDE);
    let queued = 0;
    let flowing = 0;
    for (let p = 0; p < 147; p++) {
      const s = readPathStats(last.buf, p);
      expect(s.speedRatio).toBeGreaterThanOrEqual(0);
      expect(s.speedRatio).toBeLessThan(1.2);
      expect(s.occupancy).toBeGreaterThanOrEqual(0);
      expect(s.occupancy).toBeLessThanOrEqual(1);
      expect(s.queueLengthM).toBeGreaterThanOrEqual(0);
      if (s.queueLengthM > 0) queued++;
    }
    for (const st of stats) for (let p = 0; p < 147; p++) if (readPathStats(st.buf, p).flowPerMin > 0) flowing++;
    expect(queued).toBeGreaterThan(0); // queues at red lights
    expect(flowing).toBeGreaterThan(0);
  });

  it('sends metrics every 5 sim-seconds with completed trips and counts', () => {
    const { io, send } = setup();
    send({ type: 'run' });
    io.advance(120_000);
    const metrics = io.of('metrics') as MetricsMessage[];
    expect(metrics.length).toBeGreaterThanOrEqual(23);
    for (let i = 1; i < metrics.length; i++) expect(metrics[i]!.simTime - metrics[i - 1]!.simTime).toBeCloseTo(5, 6);
    const trips = metrics.flatMap((m) => m.metrics.completedTrips);
    expect(trips.length).toBeGreaterThan(10);
    expect(metrics.at(-1)!.metrics.counts.carsActive).toBeGreaterThan(0);
  });
});
