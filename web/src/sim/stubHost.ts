/**
 * The stub engine's pure logic — step 6 of `docs/frontend-plan.md`. Mirrors
 * how `engine/src/host.ts`'s `EngineHost` is a plain class driven by an
 * injected `HostIO`, with `engine/src/worker.ts` as the thin Worker wrapper:
 * here, `StubHost` is the pure, test-drivable class and `stubEngine.ts` is
 * its thin Worker wrapper.
 *
 * This is deliberately **not** a traffic simulation. The real engine
 * (`engine/`) is finished and is the primary target (see `createTransport` in
 * `index.ts`); this exists only as a fallback that produces *something*
 * moving along the network's own paths, for rendering work that needs cars
 * before the real engine is wired up, or for debugging the renderer in
 * isolation. Cars move at a fixed path speed limit (no car-following, no
 * braking, no signals) and turn by picking uniformly among the valid `next`
 * paths with a seeded PRNG.
 */
import {
  METRICS_INTERVAL_SEC,
  SIM_DT,
  STATS_INTERVAL_SEC,
  STATS_STRIDE,
  TICK_STRIDE,
  writeTickCar,
  type EngineToUI,
  type LoadMessage,
  type Metrics,
  type UIToEngine,
} from '@shared/messages.js';
import type { CompiledNetwork, CompiledPath } from '@shared/network.js';
import { spawnRateAt } from '@shared/preset.js';

import { mulberry32, randInt, type Rng } from './prng.js';

/** How the host talks to the outside world. Same shape as the real engine's `HostIO`. */
export interface StubHostIO {
  post(message: EngineToUI, transfer: Transferable[]): void;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export interface StubHostOptions {
  /** Cars spawned beyond this are simply not spawned. Defaults to 1500 so ~1,000 is comfortable. */
  maxCars?: number;
}

/** Real-time wake interval (ms), matching the real engine's cadence. */
export const WAKE_MS = 1000 / 60;
/** Caps steps run in a single wake, same rationale as `engine/src/host.ts`. */
export const MAX_STEPS_PER_WAKE = 20;

const STATS_EVERY = Math.round(STATS_INTERVAL_SEC / SIM_DT);
const METRICS_EVERY = Math.round(METRICS_INTERVAL_SEC / SIM_DT);
const DEFAULT_MAX_CARS = 1500;

interface ResolvedPath {
  readonly length: number;
  readonly speedLimit: number;
  /** Indices of paths reachable from the end of this one. */
  readonly next: readonly number[];
}

interface SpawnAccess {
  pathIndex: number;
  s: number;
}

interface StubCar {
  id: number;
  pathIndex: number;
  s: number;
  speed: number;
}

export class StubHost {
  private network: CompiledNetwork | null = null;
  private paths: ResolvedPath[] = [];
  private spawnAccess: SpawnAccess[] = [];
  private last: LoadMessage | null = null;

  private time = 0;
  private running = false;
  private multiplier = 1;
  private timer: unknown = null;
  private lastWake = 0;
  private owed = 0;
  private spawnCredit = 0;
  private nextId = 0;
  private rng: Rng = mulberry32(1);
  private stepCount = 0;
  private readonly maxCars: number;

  readonly cars = new Map<number, StubCar>();

  constructor(private readonly io: StubHostIO, options: StubHostOptions = {}) {
    this.maxCars = options.maxCars ?? DEFAULT_MAX_CARS;
  }

  /** Never throws: failures become `error` messages, same contract as `EngineHost`. */
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

  get simTime(): number {
    return this.time;
  }

  private load(msg: LoadMessage): void {
    this.pause();
    this.network = msg.network;
    this.last = msg;
    this.rng = mulberry32(msg.seed);
    this.time = 0;
    this.owed = 0;
    this.spawnCredit = 0;
    this.nextId = 0;
    this.stepCount = 0;
    this.cars.clear();
    this.resolveNetwork(msg.network);
    this.io.post({ type: 'ready', pathCount: this.paths.length }, []);
    this.postTick();
  }

  private resolveNetwork(network: CompiledNetwork): void {
    const indexById = new Map<string, number>();
    network.paths.forEach((p, i) => indexById.set(p.id, i));

    this.paths = network.paths.map((p: CompiledPath) => ({
      length: p.length,
      speedLimit: p.speedLimit,
      next: p.next.map((id) => indexById.get(id)).filter((i): i is number => i !== undefined),
    }));

    // Spawn at every access point of a point type that originates trips. Sinks,
    // parking and lunch zones are not spawn sources for the stub.
    const spawnTypes = new Set(['edgeSpawn', 'rampSpawn']);
    this.spawnAccess = [];
    for (const point of network.points) {
      if (!spawnTypes.has(point.type)) continue;
      for (const access of point.access) {
        const pathIndex = indexById.get(access.path);
        if (pathIndex !== undefined) this.spawnAccess.push({ pathIndex, s: access.s });
      }
    }
  }

  private run(): void {
    if (!this.network) return this.fail('run before load');
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
    if (!this.running || !this.network) return;
    try {
      const now = this.io.now();
      this.owed += ((now - this.lastWake) / 1000) * this.multiplier;
      this.lastWake = now;
      let steps = Math.floor(this.owed / SIM_DT + 1e-9);
      if (steps > MAX_STEPS_PER_WAKE) {
        steps = MAX_STEPS_PER_WAKE;
        this.owed = steps * SIM_DT;
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
    if (!this.network) return this.fail('skip before load');
    const steps = Math.max(0, Math.round(simSeconds / SIM_DT));
    for (let i = 0; i < steps; i++) this.step(false);
    this.postTick();
    this.postStats();
    this.postMetrics();
  }

  private step(sendTick: boolean): void {
    this.time += SIM_DT;
    this.stepCount++;
    this.trySpawn();
    this.advanceCars();
    if (sendTick) this.postTick();
    if (this.stepCount % STATS_EVERY === 0 && sendTick) this.postStats();
    if (this.stepCount % METRICS_EVERY === 0 && sendTick) this.postMetrics();
  }

  private trySpawn(): void {
    if (this.spawnAccess.length === 0 || !this.last) return;
    const rate = spawnRateAt(this.last.preset.spawnRate, this.time);
    this.spawnCredit += (rate / 60) * SIM_DT;
    while (this.spawnCredit >= 1 && this.cars.size < this.maxCars) {
      this.spawnCredit -= 1;
      const access = this.spawnAccess[randInt(this.rng, this.spawnAccess.length)];
      if (!access) break;
      const path = this.paths[access.pathIndex];
      if (!path) continue;
      const id = this.nextId++;
      this.cars.set(id, { id, pathIndex: access.pathIndex, s: access.s, speed: path.speedLimit });
    }
  }

  private advanceCars(): void {
    for (const car of this.cars) {
      this.advanceCar(car[1]);
    }
  }

  /** Moves one car by one step, hopping to a randomly-chosen `next` path at path ends. */
  private advanceCar(car: StubCar): void {
    // Guard against pathological 0-length paths or an empty `next` chain in one
    // step by bounding the number of path hops per car per step.
    for (let hop = 0; hop < 8; hop++) {
      const path = this.paths[car.pathIndex];
      if (!path) {
        this.cars.delete(car.id);
        return;
      }
      car.speed = path.speedLimit;
      const advanced = car.s + path.speedLimit * SIM_DT;
      if (advanced <= path.length || path.length <= 0) {
        car.s = Math.min(Math.max(advanced, 0), Math.max(path.length, 0));
        return;
      }
      const overshoot = advanced - path.length;
      if (path.next.length === 0) {
        // Reached a sink / dead end: the trip is "complete" for stub purposes.
        this.cars.delete(car.id);
        return;
      }
      const nextIndex = path.next[randInt(this.rng, path.next.length)];
      if (nextIndex === undefined) {
        this.cars.delete(car.id);
        return;
      }
      car.pathIndex = nextIndex;
      car.s = Math.max(overshoot, 0);
    }
  }

  private postTick(): void {
    const cars = [...this.cars.values()];
    const buf = new Float32Array(cars.length * TICK_STRIDE);
    cars.forEach((c, i) => {
      writeTickCar(buf, i, { vehicleId: c.id, pathIndex: c.pathIndex, s: c.s, speed: c.speed, flags: 0 });
    });
    this.io.post({ type: 'tick', simTime: this.time, count: cars.length, buf }, [buf.buffer]);
  }

  private postStats(): void {
    // The stub has no occupancy/queue model; a flat buffer (speedRatio = 1, the
    // rest 0) is a valid, if uninteresting, stats message.
    const buf = new Float32Array(this.paths.length * STATS_STRIDE);
    for (let p = 0; p < this.paths.length; p++) buf[p * STATS_STRIDE] = 1;
    this.io.post({ type: 'stats', simTime: this.time, buf }, [buf.buffer]);
  }

  private postMetrics(): void {
    const metrics: Metrics = {
      completedTrips: [],
      nodes: {},
      paths: {},
      counts: {
        carsActive: this.cars.size,
        carsWaitingToEnter: 0,
        parkingFailed: 0,
        gridlockRemovals: 0,
      },
    };
    this.io.post({ type: 'metrics', simTime: this.time, metrics }, []);
  }

  private fail(message: string): void {
    this.pause();
    this.io.post({ type: 'error', message }, []);
  }
}
