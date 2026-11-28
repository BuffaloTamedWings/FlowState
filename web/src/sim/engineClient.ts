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
  /**
   * Sim second the *next* `ready` should warm up to, overriding the preset's
   * own warm-up target. `main.ts` sets this when re-running after an edit so
   * the new layout starts at the same sim time the old one was showing — see
   * `warmupTargetSec`.
   */
  private warmupOverrideSec: number | null = null;

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

  /**
   * Makes the next `load`/`reset` warm up to `simSeconds` instead of this
   * preset's default target. Consumed by the next `ready` and then cleared, so
   * it only ever affects the run it was set for.
   */
  setWarmupTarget(simSeconds: number | null): void {
    this.warmupOverrideSec = simSeconds;
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
      const target = warmupTargetSec(this.lastPreset, this.warmupOverrideSec);
      this.warmupOverrideSec = null;
      if (target > 0) this.skip(target);
      return;
    }
    this.warmupOverrideSec = null;
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

/**
 * The sim second a fresh load should warm up to.
 *
 * `preset.warmup` describes a *wall-clock* window (morning: 5 real seconds at
 * 2x), which as a sim-time target is 10 seconds — and at 10 seconds the
 * morning curve is still at its opening 15 vehicles/minute, i.e. **one car
 * every four seconds**. Pressing Run therefore looked broken: an essentially
 * empty map that took ten real minutes to fill (Dev, 2026-11-28 — "cars are
 * not populating when i hit run"). Measured on the test grid: t=10s gives 1
 * car, t=617s gives 115.
 *
 * So the target is instead the sim second where demand first peaks: the busiest
 * point of `spawnRate.curve`. That is where congestion -- the thing the player
 * is here to edit -- actually exists, and it is a fixed function of the preset,
 * so two runs of the same preset still start from the identical state and an
 * A/B layout comparison stays fair.
 *
 * `overrideSec`, when given, wins: re-running after an edit warms up to the sim
 * time the previous run had reached, so the new layout is compared against the
 * old one at the same moment of the day rather than being thrown back to the
 * peak.
 */
export function warmupTargetSec(preset: Preset, overrideSec: number | null = null): number {
  if (overrideSec !== null && overrideSec > 0) return overrideSec;

  const curve = preset.spawnRate.curve;
  let best = 0;
  let bestRate = -1;
  for (const point of curve) {
    const [time, rate] = point;
    if (rate > bestRate) {
      bestRate = rate;
      best = time;
    }
  }
  // A preset with no curve at all (or a flat one peaking at t=0) still gets the
  // original wall-clock-derived warm-up rather than no warm-up at all.
  if (best <= 0) return preset.warmup.realSeconds * preset.warmup.playbackSpeed;
  return Math.min(best, preset.durationSec);
}
