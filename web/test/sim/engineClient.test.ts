/**
 * Tests `EngineClient` against the **real** `EngineHost` (`@engine/host.js`),
 * not a mock, via an in-process `EngineTransport` with a fake clock the test
 * drives manually. This is possible because `EngineHost` takes an injected
 * `HostIO` with no Worker APIs in it — see its header comment.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EngineHost } from '@engine/host.js';
import type { EngineToUI, UIToEngine } from '@shared/messages.js';
import type { CompiledNetwork } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';

import { EngineClient, warmupTargetSec, type TickFrame } from '@web/sim/engineClient.js';
import type { EngineTransport } from '@web/sim/transport.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}
const grid = (): CompiledNetwork => readJson<CompiledNetwork>('compiled/test-grid.compiled.json');
const morning = (): Preset => readJson<Preset>('presets/morning.json');

/**
 * Wraps a real `EngineHost` as an `EngineTransport`, with a fake clock the
 * test advances by hand — same trick as `engine/test/host.test.ts`'s
 * `FakeIO`, just behind the transport interface `EngineClient` actually uses.
 */
class FakeHostTransport implements EngineTransport {
  private readonly host: EngineHost;
  private handler: ((message: EngineToUI) => void) | null = null;
  private time = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextTimerId = 1;
  terminated = false;

  constructor() {
    this.host = new EngineHost({
      post: (message) => this.handler?.(message),
      now: () => this.time,
      schedule: (fn, ms) => {
        const id = this.nextTimerId++;
        this.timers.push({ at: this.time + ms, fn, id });
        return id;
      },
      cancel: (handle) => {
        this.timers = this.timers.filter((t) => t.id !== handle);
      },
    });
  }

  post(message: UIToEngine): void {
    this.host.handle(message);
  }

  onMessage(handler: (message: EngineToUI) => void): void {
    this.handler = handler;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Advances the fake clock, firing due timers in order (mirrors `FakeIO.advance`). */
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
}

function setup(options: { warmupMode?: 'skip' | 'playback'; onError?: (m: string) => void } = {}) {
  const transport = new FakeHostTransport();
  const ticks: TickFrame[] = [];
  const errors: string[] = [];
  const client = new EngineClient({
    transport,
    onTick: (f) => ticks.push(f),
    onError: (m) => {
      errors.push(m);
      options.onError?.(m);
    },
    ...(options.warmupMode ? { warmupMode: options.warmupMode } : {}),
  });
  return { transport, client, ticks, errors };
}

describe('load', () => {
  it('resolves when ready arrives, and warms up via skip by default', async () => {
    const { transport, client, ticks } = setup();
    await client.load(grid(), morning(), 20261201);
    // The warm-up skips to the busiest point of morning.json's spawn curve
    // (t=900s), not to `realSeconds * playbackSpeed` -- see `warmupTargetSec`.
    const latest = client.latestTick();
    expect(latest).not.toBeNull();
    expect(latest!.simTime).toBeCloseTo(warmupTargetSec(morning()), 6);
    expect(ticks.length).toBeGreaterThan(0);
    expect(transport.terminated).toBe(false);
  });
});

describe('running', () => {
  it('run produces ticks and cars appear after warm-up', async () => {
    const { transport, client } = setup();
    await client.load(grid(), morning(), 20261201);
    expect(client.carCount).toBeGreaterThan(0); // warm-up already put cars on the map
    client.run();
    expect(client.running).toBe(true);
    transport.advance(5000);
    expect(client.simTime).toBeGreaterThan(10);
    expect(client.carCount).toBeGreaterThan(0);
  });

  it('pause stops ticks', async () => {
    const { transport, client } = setup();
    await client.load(grid(), morning(), 20261201);
    client.run();
    transport.advance(2000);
    const simTimeAtPause = client.simTime;
    client.pause();
    expect(client.running).toBe(false);
    transport.advance(2000);
    expect(client.simTime).toBeCloseTo(simTimeAtPause, 6);
  });

  it('setSpeed is accepted and changes tick rate', async () => {
    const { transport, client, ticks } = setup();
    await client.load(grid(), morning(), 20261201);
    client.run();
    ticks.length = 0;
    transport.advance(5000);
    const at1x = ticks.length;
    client.setSpeed(4);
    ticks.length = 0;
    transport.advance(5000);
    const at4x = ticks.length;
    expect(at4x).toBeGreaterThan(at1x * 2);
  });
});

describe('skip and reset', () => {
  it('skip advances simTime', async () => {
    const { client } = setup();
    await client.load(grid(), morning(), 20261201);
    const before = client.simTime;
    client.skip(300);
    expect(client.simTime).toBeCloseTo(before + 300, 3);
  });

  it('reset empties the map (state is cleared on ready, before warm-up refills it)', async () => {
    const { transport, client } = setup({ warmupMode: 'skip' });
    await client.load(grid(), morning(), 20261201);
    client.run();
    transport.advance(5000);
    expect(client.carCount).toBeGreaterThan(0);

    // Reset re-sends `ready` (empty) then re-applies warm-up (skip), exactly
    // like a fresh `load` with the same seed -- so the post-reset state
    // should match the post-load state, not stay empty.
    client.reset();
    expect(client.simTime).toBeCloseTo(warmupTargetSec(morning()), 6); // warm-up skip landed again
    expect(client.carCount).toBeGreaterThan(0);
  });
});

describe('error handling', () => {
  it('an error message pauses the client and reaches onError', async () => {
    const { transport, client, errors } = setup();
    const badGrid = grid();
    badGrid.version = 1; // EngineHost rejects this with an `error` message
    // load() never resolves on error (no `ready` arrives, so the promise it
    // returns stays pending forever) -- don't await it. The whole chain
    // (post -> EngineHost.handle -> fail -> error message -> onError) runs
    // synchronously within this call, so the assertions below don't need to wait.
    void client.load(badGrid, morning(), 1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/version is 1/);
    expect(client.running).toBe(false);
    void transport; // transport is still usable; nothing else to assert on it here
  });
});

describe('tick retention', () => {
  it('keeps only the two most recent ticks', async () => {
    const { transport, client } = setup();
    await client.load(grid(), morning(), 20261201);
    client.run();
    transport.advance(1000);
    const latest = client.latestTick();
    const previous = client.previousTick();
    expect(latest).not.toBeNull();
    expect(previous).not.toBeNull();
    expect(latest!.simTime).toBeGreaterThan(previous!.simTime);
    // simTime steps by SIM_DT (0.1s) per tick, so two retained ticks are exactly one step apart.
    expect(latest!.simTime - previous!.simTime).toBeCloseTo(0.1, 6);
  });
});

describe('reset', () => {
  it('resumes running afterwards when the sim was running, and stays paused when it was not', async () => {
    const { transport, client } = setup();
    await client.load(grid(), morning(), 20261201);
    client.run();
    transport.advance(2000);
    client.reset();
    expect(client.running).toBe(true); // the player never asked to pause
    transport.advance(2000);
    expect(client.simTime).toBeGreaterThan(10); // warm-up ran again, then stepped on

    client.pause();
    client.reset();
    expect(client.running).toBe(false);
  });
});
