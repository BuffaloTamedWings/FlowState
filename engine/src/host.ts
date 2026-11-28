/**
 * S7: the engine side of the runtime protocol (PRD §7.6, `shared/messages.ts`).
 *
 * `EngineHost` owns one `Sim` and turns UI messages into sim actions and sim
 * state into outgoing messages. It has no Worker APIs in it: the caller supplies
 * `post`, a clock and a timer, so the same code runs in the Web Worker
 * (`worker.ts`) and in Node tests with a fake clock.
 *
 * Timing: a real-time loop wakes ~60×/s and runs as many fixed 0.1 s steps as
 * real time × playback speed allows (10 steps/s at 1×, 40 at 4×). Playback speed
 * never changes the step size, so a run is identical in sim time however the
 * wakes fall. A slow frame can't snowball: at most MAX_STEPS_PER_WAKE steps run
 * per wake and the rest of that backlog is dropped.
 */
import {
  METRICS_INTERVAL_SEC,
  SIM_DT,
  STATS_INTERVAL_SEC,
  TICK_FLAG_BRAKING,
  TICK_FLAG_STOPPED,
  TICK_FLAG_YIELDING,
  TICK_STRIDE,
  withVehicleCode,
  writeTickCar,
  type EngineToUI,
  type LoadMessage,
  type Metrics,
  type UIToEngine,
} from '@shared/messages.js';
import { loadNetwork } from './network.js';
import { Sim } from './sim.js';
import { computeStats } from './stats.js';
import { currentPath } from './traffic.js';
import { vehicleCode } from './vehicles.js';

/** How the host talks to the outside world. */
export interface HostIO {
  /** Send a message; `transfer` lists buffers to hand over rather than copy. */
  post(message: EngineToUI, transfer: ArrayBuffer[]): void;
  /** Milliseconds, monotonic (e.g. `performance.now()`). */
  now(): number;
  /** Run `fn` after about `ms` milliseconds; returns a handle for `cancel`. */
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** Real-time wake interval (ms). */
export const WAKE_MS = 1000 / 60;
/** Most steps run in one wake (2 s of sim at 4× and 60 wakes/s is ~0.67 steps/wake normally). */
export const MAX_STEPS_PER_WAKE = 20;
/** Deceleration harder than this sets the braking flag (m/s²). */
export const BRAKING_ACCEL = -0.5;
/** Below this speed the stopped flag is set (m/s). */
export const STOPPED_FLAG_SPEED = 0.1;

const STATS_EVERY = Math.round(STATS_INTERVAL_SEC / SIM_DT);
const METRICS_EVERY = Math.round(METRICS_INTERVAL_SEC / SIM_DT);

export class EngineHost {
  private sim: Sim | null = null;
  private last: LoadMessage | null = null;
  private running = false;
  private multiplier = 1;
  private timer: unknown = null;
  private lastWake = 0;
  /** Sim seconds owed to real time but not yet stepped. */
  private owed = 0;

  constructor(private readonly io: HostIO) {}

  /** Handle one message from the UI. Never throws: failures become `error` messages. */
  handle(msg: UIToEngine): void {
    try {
      switch (msg.type) {
        case 'load': return this.load(msg);
        case 'run': return this.run();
        case 'pause': return this.pause();
        case 'setSpeed': this.multiplier = msg.multiplier; return;
        case 'skip': return this.skip(msg.simSeconds);
        case 'reset': if (this.last) this.load(this.last); return;
        default: this.fail(`unknown message type ${JSON.stringify((msg as { type?: unknown }).type)}`);
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The current simulation, for tests and debugging. */
  get current(): Sim | null {
    return this.sim;
  }

  private load(msg: LoadMessage): void {
    this.pause();
    this.sim = null;
    const net = loadNetwork(msg.network);
    this.sim = new Sim(net, msg.preset, msg.seed);
    this.last = msg;
    this.owed = 0;
    this.io.post({ type: 'ready', pathCount: net.count }, []);
    this.postTick();
  }

  private run(): void {
    if (!this.sim) return this.fail('run before load');
    if (this.running) return;
    this.running = true;
    this.lastWake = this.io.now();
    this.owed = 0;
    this.timer = this.io.schedule(this.wake, WAKE_MS);
  }

  private pause(): void {
    this.running = false;
    if (this.timer !== null) this.io.cancel(this.timer);
    this.timer = null;
  }

  private readonly wake = (): void => {
    this.timer = null;
    if (!this.running || !this.sim) return;
    try {
      const now = this.io.now();
      this.owed += ((now - this.lastWake) / 1000) * this.multiplier;
      this.lastWake = now;
      let steps = Math.floor(this.owed / SIM_DT + 1e-9);
      if (steps > MAX_STEPS_PER_WAKE) {
        steps = MAX_STEPS_PER_WAKE;
        this.owed = steps * SIM_DT; // drop the backlog rather than snowball
      }
      this.owed -= steps * SIM_DT;
      for (let i = 0; i < steps; i++) this.step(true);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.running) this.timer = this.io.schedule(this.wake, WAKE_MS);
  };

  private skip(simSeconds: number): void {
    if (!this.sim) return this.fail('skip before load');
    const steps = Math.max(0, Math.round(simSeconds / SIM_DT));
    for (let i = 0; i < steps; i++) this.step(false);
    this.postTick();
    this.postStats();
    this.postMetrics();
  }

  /** One sim step, plus whatever messages fall due. */
  private step(sendTick: boolean): void {
    const sim = this.sim!;
    sim.step();
    if (sendTick) this.postTick();
    if (sim.steps % STATS_EVERY === 0 && sendTick) this.postStats();
    if (sim.steps % METRICS_EVERY === 0 && sendTick) this.postMetrics();
  }

  private postTick(): void {
    const sim = this.sim!;
    const cars = sim.cars;
    const buf = new Float32Array(cars.length * TICK_STRIDE);
    cars.forEach((c, i) => {
      let flags = 0;
      if ((c.a ?? 0) < BRAKING_ACCEL) flags |= TICK_FLAG_BRAKING;
      if (c.v < STOPPED_FLAG_SPEED) flags |= TICK_FLAG_STOPPED;
      if (sim.held.has(c.id)) flags |= TICK_FLAG_YIELDING;
      flags = withVehicleCode(flags, vehicleCode(c.type ?? 'car'));
      writeTickCar(buf, i, { vehicleId: c.id, pathIndex: currentPath(c), s: c.s, speed: c.v, flags });
    });
    this.io.post({ type: 'tick', simTime: sim.time, count: cars.length, buf }, [buf.buffer]);
  }

  private postStats(): void {
    const sim = this.sim!;
    const buf = computeStats(sim.net, sim.cars, sim.takeExits(), STATS_INTERVAL_SEC);
    this.io.post({ type: 'stats', simTime: sim.time, buf }, [buf.buffer]);
  }

  private postMetrics(): void {
    const sim = this.sim!;
    const c = sim.counts();
    // completedTrips: since the last message. nodes / paths: running totals since load
    // (average control delay and vehicles served per node, max queue per path). counts: now.
    const metrics: Metrics = {
      completedTrips: sim.takeCompleted(),
      nodes: sim.metrics.nodes(),
      paths: sim.metrics.paths(),
      counts: {
        carsActive: c.carsActive,
        carsWaitingToEnter: c.carsWaitingToEnter,
        parkingFailed: c.parkingFailed,
        gridlockRemovals: c.gridlockRemovals,
      },
    };
    this.io.post({ type: 'metrics', simTime: sim.time, metrics }, []);
  }

  private fail(message: string): void {
    this.pause();
    this.io.post({ type: 'error', message }, []);
  }
}
