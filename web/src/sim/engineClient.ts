/**
 * The front end's single point of contact with whichever engine is running
 * (real worker, stub worker, or — in tests — an in-process harness). Talks
 * only through an `EngineTransport` (`transport.ts`), never a `Worker`
 * directly, and turns the raw `shared/messages.ts` protocol into something
 * `main.ts` and the renderer can use frame to frame.
 */
import {
  readTickCar,
  type EngineToUI,
  type Metrics,
  type PlaybackSpeed,
  type TickCar,
  type TickMessage,
  type UIToEngine,
} from '@shared/messages.js';
import type { CompiledNetwork } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';

import type { EngineTransport } from './transport.js';

/** One tick's worth of cars, unpacked and keyed by `vehicleId` for O(1) lookup during interpolation. */
export interface TickFrame {
  simTime: number;
  cars: ReadonlyMap<number, TickCar>;
}

export interface EngineClientOptions {
  transport: EngineTransport;
  onTick?(frame: TickFrame): void;
  onStats?(simTime: number, buf: Float32Array): void;
  onMetrics?(simTime: number, metrics: Metrics): void;
  onError?(message: string): void;
  /**
   * How warm-up is realized after `load`'s `ready` arrives. Default `'skip'`.
   * See the long comment on `applyWarmup` below for why `'skip'` is the
   * default and not the engine owner's original proposal.
   */
  warmupMode?: 'skip' | 'playback';
}

/** Only the two most recent ticks are ever kept; see `handleTick`. */
export class EngineClient {
  private readonly transport: EngineTransport;
  private readonly onTickCb: ((frame: TickFrame) => void) | undefined;
  private readonly onStatsCb: ((simTime: number, buf: Float32Array) => void) | undefined;
  private readonly onMetricsCb: ((simTime: number, metrics: Metrics) => void) | undefined;
  private readonly onErrorCb: ((message: string) => void) | undefined;
  private readonly warmupMode: 'skip' | 'playback';

  private ticks: TickFrame[] = [];
  private lastPreset: Preset | null = null;
  private readyWaiters: Array<() => void> = [];
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `reset` so the run continues across the re-`load` it triggers. */
  private resumeAfterReady = false;

  simTime = 0;
  carCount = 0;
  running = false;

  constructor(options: EngineClientOptions) {
    this.transport = options.transport;
    this.onTickCb = options.onTick;
    this.onStatsCb = options.onStats;
    this.onMetricsCb = options.onMetrics;
    this.onErrorCb = options.onError;
    this.warmupMode = options.warmupMode ?? 'skip';
    this.transport.onMessage((message) => this.handle(message));
  }

  /** Posts `load`; the returned promise resolves when `ready` arrives. */
  load(network: CompiledNetwork, preset: Preset, seed: number): Promise<void> {
    this.lastPreset = preset;
    return new Promise((resolve) => {
      this.readyWaiters.push(resolve);
      this.post({ type: 'load', network, preset, seed });
    });
  }

  run(): void {
    this.running = true;
    this.post({ type: 'run' });
  }

  pause(): void {
    this.running = false;
    this.post({ type: 'pause' });
  }

  setSpeed(multiplier: PlaybackSpeed): void {
    this.post({ type: 'setSpeed', multiplier });
  }

  skip(simSeconds: number): void {
    this.post({ type: 'skip', simSeconds });
  }

  /**
   * Re-`load`s the engine's last network/preset/seed. The engine answers with
   * a fresh `ready`, which clears car state and re-runs warm-up; if the sim
   * was running when reset was pressed, it resumes afterwards rather than
   * leaving the player looking at a frozen map they didn't ask to pause.
   */
  reset(): void {
    this.resumeAfterReady = this.running;
    this.post({ type: 'reset' });
  }

  /** The newest tick seen so far, or `null` before the first one. */
  latestTick(): TickFrame | null {
    return this.ticks[this.ticks.length - 1] ?? null;
  }

  /** The tick before the newest one, or `null` if fewer than two have arrived. */
  previousTick(): TickFrame | null {
    return this.ticks.length >= 2 ? this.ticks[this.ticks.length - 2]! : null;
  }

  dispose(): void {
    if (this.playbackTimer !== null) clearTimeout(this.playbackTimer);
    this.transport.terminate();
  }

  private post(message: UIToEngine): void {
    this.transport.post(message);
  }

  private handle(message: EngineToUI): void {
    switch (message.type) {
      case 'ready':
        this.handleReady();
        return;
      case 'tick':
        this.handleTick(message);
        return;
      case 'stats':
        this.onStatsCb?.(message.simTime, message.buf);
        return;
      case 'metrics':
        this.onMetricsCb?.(message.simTime, message.metrics);
        return;
      case 'error':
        this.running = false;
        this.onErrorCb?.(message.message);
        return;
    }
  }

  /**
   * Clears all car state on `ready` itself, not on the first (empty) tick
   * that follows it: an empty tick is also what a fully-drained map looks
   * like mid-run, so keying the "fresh load" reset off tick emptiness would
   * misfire the moment every car happens to finish its trip at once.
   */
  private handleReady(): void {
    this.ticks = [];
    this.simTime = 0;
    this.carCount = 0;
    this.running = false;
    const waiter = this.readyWaiters.shift();
    waiter?.();
    this.applyWarmup();
    if (this.resumeAfterReady) {
      this.resumeAfterReady = false;
      this.run();
    }
  }

  private handleTick(message: TickMessage): void {
    const cars = new Map<number, TickCar>();
    for (let i = 0; i < message.count; i++) {
      const car = readTickCar(message.buf, i);
      cars.set(car.vehicleId, car);
    }
    this.ticks.push({ simTime: message.simTime, cars });
    // The engine can send up to 40 ticks/real-second at 4x playback speed, well
    // above any screen's frame rate. Dropping everything but the two most
    // recent is the deliberate, correct behaviour (not a backlog bug): the
    // renderer only ever needs "where was this car last" and "where is it now"
    // to interpolate from, and holding more would just be unused memory.
    if (this.ticks.length > 2) this.ticks.shift();
    this.simTime = message.simTime;
    this.carCount = message.count;
    this.onTickCb?.({ simTime: message.simTime, cars });
  }

  /**
   * Warm-up: run the map for a bit after `load` so Run doesn't start on an
   * empty map (PRD, `Preset.warmup`).
   *
   * **Deliberate deviation from the engine owner's suggested design.** His
   * proposal was `setSpeed(preset.warmup.playbackSpeed)` right after `ready`,
   * then `setSpeed(1)` again after `preset.warmup.realSeconds` of *wall-clock*
   * time. That makes the sim time at which the player takes control depend on
   * how fast frames actually arrived, so two runs of the same layout — even
   * with the same seed — don't start from the same state, which breaks an A/B
   * layout comparison (the whole point of this app).
   *
   * The default here, `warmupMode: 'skip'`, keeps the same intent and the
   * same preset fields but makes it exactly reproducible: after `ready`, post
   * `skip { simSeconds: realSeconds * playbackSpeed }` — the same amount of
   * sim time the playback approach would *eventually* reach, computed instead
   * of waited for. `'playback'` is kept as the alternative (same mechanism as
   * originally proposed) in case the instant fill reads worse on demo day
   * than watching the map fill in.
   */
  private applyWarmup(): void {
    if (!this.lastPreset) return;
    const { warmup } = this.lastPreset;
    if (this.warmupMode === 'skip') {
      const simSeconds = warmup.realSeconds * warmup.playbackSpeed;
      if (simSeconds > 0) this.skip(simSeconds);
      return;
    }
    // 'playback': run fast for the warm-up window, then drop back to 1x.
    const speed = warmup.playbackSpeed as PlaybackSpeed;
    this.setSpeed(speed);
    if (this.playbackTimer !== null) clearTimeout(this.playbackTimer);
    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = null;
      this.setSpeed(1);
    }, warmup.realSeconds * 1000);
  }
}
