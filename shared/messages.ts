/**
 * Runtime message protocol — PRD §7.6.
 *
 * The other contract files describe *things*; this one describes the
 * *conversation* between the UI (main thread) and the engine (Web Worker), and
 * the packing layout of the raw float buffers that carry car positions.
 *
 * Car data comes back as a flat `Float32Array`, thousands of numbers many times
 * a second, because that is the only way to move it between threads cheaply —
 * the buffer is transferred, not copied. A flat array is meaningless without an
 * agreed layout, so the offsets live here and both sides read them by name.
 * Changing a layout constant is a contract change: it needs both owners.
 */

import type { CompiledNetwork } from './network.js';
import type { Preset } from './preset.js';
import { VEHICLE_CODE_BITS } from './vehicles.js';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Engine step size in sim seconds. One `tick` is sent per step. */
export const SIM_DT = 0.1;
/** `stats` cadence, in sim seconds. */
export const STATS_INTERVAL_SEC = 1;
/** `metrics` cadence, in sim seconds. */
export const METRICS_INTERVAL_SEC = 5;

/** Playback speeds the UI offers. */
export const PLAYBACK_SPEEDS = [1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

// ---------------------------------------------------------------------------
// Tick buffer: 5 floats per car, `count` cars, no padding
// ---------------------------------------------------------------------------

export const TICK_STRIDE = 5;
/** Stable for the car's lifetime, unique within a run. The front end keys its instance slots on this. */
export const TICK_VEHICLE_ID = 0;
/** Index into `CompiledNetwork.paths`. */
export const TICK_PATH_INDEX = 1;
/**
 * Meters along that path, measured to the vehicle's **front bumper**.
 *
 * A vehicle extends *backward* from `s` by its length
 * (`shared/vehicles.ts`), so for anything longer than a car the rear may still
 * be on the path the vehicle came from. When the front end draws long
 * vehicles it should place the rear at `s - length`, walking back onto the
 * previous path when that goes negative, so a trailer follows a turn instead
 * of cutting the corner.
 *
 * Two things that walk-back needs and the tick doesn't carry: predecessor
 * links (`CompiledPath` has `next` but no `prev` — invert it) and *which*
 * predecessor this vehicle actually came from, since a connector can have
 * several. The front end already keeps the last two ticks per `vehicleId` for
 * interpolation, so it can read the previous path from there. None of that is
 * needed yet; this records the convention so the renderer is built against it.
 */
export const TICK_S = 2;
/** Meters per second. */
export const TICK_SPEED = 3;
/** Bit field; see the `TICK_FLAG_*` masks. */
export const TICK_FLAGS = 4;

export const TICK_FLAG_BRAKING = 1 << 0;
export const TICK_FLAG_STOPPED = 1 << 1;
export const TICK_FLAG_YIELDING = 1 << 2;

/**
 * Bits 3-4 of `TICK_FLAGS` carry the vehicle type `code` from
 * `shared/vehicles.ts`, so per-vehicle size rides along without widening the
 * tick (`TICK_STRIDE` stays 5).
 *
 * Backward compatible by construction: a sender that knows nothing about
 * vehicle types leaves these bits at 0, which decodes to `car`.
 */
export const TICK_FLAG_VEHICLE_SHIFT = 3;
export const TICK_FLAG_VEHICLE_MASK = ((1 << VEHICLE_CODE_BITS) - 1) << TICK_FLAG_VEHICLE_SHIFT;

// ---------------------------------------------------------------------------
// Stats buffer: 4 floats per path, indexed by the path's `index`
// ---------------------------------------------------------------------------

export const STATS_STRIDE = 4;
/** `meanSpeed / speedLimit`, 0-1. Drives the heatmap colors. */
export const STATS_SPEED_RATIO = 0;
/** Share of the path occupied by cars, 0-1. */
export const STATS_OCCUPANCY = 1;
/** Standing queue at the end of the path, in meters. */
export const STATS_QUEUE_LENGTH = 2;
/** Throughput in vehicles per minute. */
export const STATS_FLOW = 3;

// ---------------------------------------------------------------------------
// Metrics (PRD §9.1) — covers the period since the last message, plus totals
// ---------------------------------------------------------------------------

export interface CompletedTrip {
  tripTimeSec: number;
  /** Route length ÷ speed limits: the trip with no other traffic. */
  freeFlowTimeSec: number;
  stoppedTimeSec: number;
  /** Time spent waiting to enter the map at all. */
  entryQueueTimeSec: number;
  origin: string;
  destination: string;
}

export interface NodeMetrics {
  /** Time through the approach and node minus free-flow time, per vehicle. */
  avgControlDelaySec: number;
  carsServed: number;
}

export interface PathMetrics {
  maxQueueLengthM: number;
}

export interface MetricsCounts {
  carsActive: number;
  carsWaitingToEnter: number;
  /** Cars that reached a garage and found it full. */
  parkingFailed: number;
  /** Cars removed because they were deadlocked. */
  gridlockRemovals: number;
}

export interface Metrics {
  completedTrips: CompletedTrip[];
  /** Keyed by node ID. */
  nodes: Record<string, NodeMetrics>;
  /** Keyed by path ID. */
  paths: Record<string, PathMetrics>;
  counts: MetricsCounts;
}

// ---------------------------------------------------------------------------
// UI -> Engine
// ---------------------------------------------------------------------------

/**
 * Build engine state from scratch, empty of cars. Sent on Run when the layout or
 * the preset changed since the last run.
 */
export interface LoadMessage {
  type: 'load';
  network: CompiledNetwork;
  preset: Preset;
  seed: number;
}

/** Start or resume stepping. */
export interface RunMessage {
  type: 'run';
}

/** Stop stepping but keep state. Editing is only allowed while paused. */
export interface PauseMessage {
  type: 'pause';
}

export interface SetSpeedMessage {
  type: 'setSpeed';
  multiplier: PlaybackSpeed;
}

/** Simulate ahead as fast as possible without sending ticks, then send one tick. */
export interface SkipMessage {
  type: 'skip';
  simSeconds: number;
}

/** Re-`load` the last network, preset and seed. */
export interface ResetMessage {
  type: 'reset';
}

export type UIToEngine =
  | LoadMessage
  | RunMessage
  | PauseMessage
  | SetSpeedMessage
  | SkipMessage
  | ResetMessage;

// ---------------------------------------------------------------------------
// Engine -> UI
// ---------------------------------------------------------------------------

/** Sent once after `load`. */
export interface ReadyMessage {
  type: 'ready';
  pathCount: number;
}

/** Every sim step. `buf` is transferred, so the sender must not touch it after posting. */
export interface TickMessage {
  type: 'tick';
  simTime: number;
  count: number;
  /** `count * TICK_STRIDE` floats. */
  buf: Float32Array;
}

/** Every `STATS_INTERVAL_SEC`. One `STATS_STRIDE`-float group per path, in `index` order. */
export interface StatsMessage {
  type: 'stats';
  simTime: number;
  buf: Float32Array;
}

/** Every `METRICS_INTERVAL_SEC`. */
export interface MetricsMessage {
  type: 'metrics';
  simTime: number;
  metrics: Metrics;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type EngineToUI = ReadyMessage | TickMessage | StatsMessage | MetricsMessage | ErrorMessage;

// ---------------------------------------------------------------------------
// Buffer helpers (shared so both sides pack and unpack identically)
// ---------------------------------------------------------------------------

/** One car's slice of a tick buffer. */
export interface TickCar {
  vehicleId: number;
  pathIndex: number;
  s: number;
  speed: number;
  flags: number;
}

/** Read car `i` out of a tick buffer. */
export function readTickCar(buf: Float32Array, i: number): TickCar {
  const o = i * TICK_STRIDE;
  return {
    vehicleId: buf[o + TICK_VEHICLE_ID] ?? 0,
    pathIndex: buf[o + TICK_PATH_INDEX] ?? 0,
    s: buf[o + TICK_S] ?? 0,
    speed: buf[o + TICK_SPEED] ?? 0,
    flags: buf[o + TICK_FLAGS] ?? 0,
  };
}

/** Write car `i` into a tick buffer. */
export function writeTickCar(buf: Float32Array, i: number, car: TickCar): void {
  const o = i * TICK_STRIDE;
  buf[o + TICK_VEHICLE_ID] = car.vehicleId;
  buf[o + TICK_PATH_INDEX] = car.pathIndex;
  buf[o + TICK_S] = car.s;
  buf[o + TICK_SPEED] = car.speed;
  buf[o + TICK_FLAGS] = car.flags;
}

export function hasFlag(flags: number, mask: number): boolean {
  return (flags & mask) !== 0;
}

/** Reads the vehicle type code out of a flags word. Pair with `vehicleTypeByCode`. */
export function vehicleCodeOf(flags: number): number {
  return (flags & TICK_FLAG_VEHICLE_MASK) >>> TICK_FLAG_VEHICLE_SHIFT;
}

/**
 * Returns `flags` with the vehicle type code replaced, leaving the braking,
 * stopped and yielding bits untouched.
 *
 * `code` is masked to the reserved width rather than validated: this runs once
 * per vehicle per tick, and `VEHICLE_TYPES` codes are range-checked by a
 * contract test, so the only way to arrive here out of range is a bug that
 * should not take down a frame.
 */
export function withVehicleCode(flags: number, code: number): number {
  const bits = (code << TICK_FLAG_VEHICLE_SHIFT) & TICK_FLAG_VEHICLE_MASK;
  return (flags & ~TICK_FLAG_VEHICLE_MASK) | bits;
}

/** One path's slice of a stats buffer, by the path's `index`. */
export interface PathStats {
  speedRatio: number;
  occupancy: number;
  queueLengthM: number;
  flowPerMin: number;
}

export function readPathStats(buf: Float32Array, pathIndex: number): PathStats {
  const o = pathIndex * STATS_STRIDE;
  return {
    speedRatio: buf[o + STATS_SPEED_RATIO] ?? 0,
    occupancy: buf[o + STATS_OCCUPANCY] ?? 0,
    queueLengthM: buf[o + STATS_QUEUE_LENGTH] ?? 0,
    flowPerMin: buf[o + STATS_FLOW] ?? 0,
  };
}
