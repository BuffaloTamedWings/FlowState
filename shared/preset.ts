/**
 * Preset file (`flowstate-preset`, v1) — PRD §7.5.
 *
 * The *demand*: how much traffic there is, where it comes from, where it is
 * going, and how that changes over the run. The map stays identical between
 * presets — this is the only thing that makes Morning feel different from Night.
 *
 * Written by Sashank and consumed by the engine. The front end reads exactly one
 * field, `lighting`, plus `label` for the preset picker.
 */

import { VEHICLE_TYPES, type VehicleTypeId } from './vehicles.js';

export const PRESET_FORMAT = 'flowstate-preset';
export const PRESET_VERSION = 1;

export const PRESET_IDS = ['morning', 'afternoon', 'night'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** Front end only: which lighting rig to use. Night adds headlights. */
export const LIGHTINGS = ['morning', 'afternoon', 'night'] as const;
export type Lighting = (typeof LIGHTINGS)[number];

export const SPAWN_RATE_UNITS = ['vehiclesPerMinute'] as const;
export type SpawnRateUnit = (typeof SPAWN_RATE_UNITS)[number];

/** Point types a trip can start from or end at (PRD §7.2 point types). */
export type TripEndpointType = 'edgeSpawn' | 'edgeSink' | 'rampSpawn' | 'rampSink' | 'parking' | 'lunchZone';

/**
 * Run the map at `playbackSpeed` for `realSeconds` before handing control over,
 * so the player doesn't start at an empty map.
 */
export interface Warmup {
  realSeconds: number;
  playbackSpeed: number;
}

/**
 * Total demand for the whole map over time: `[simSecond, vehiclesPerMinute]`
 * pairs, linearly interpolated between them.
 */
export interface SpawnRate {
  unit: SpawnRateUnit;
  curve: [number, number][];
}

/**
 * One class of journey. Each new car picks a trip by `share`, then an origin and
 * destination of the listed point types, weighted by the points' `weight`
 * (parking by free capacity).
 */
export interface Trip {
  /** Fraction of cars taking this trip; shares sum to 1. */
  share: number;
  from: TripEndpointType[];
  to: TripEndpointType[];
}

/** One slice of the vehicle mix. */
export interface VehicleShare {
  type: VehicleTypeId;
  /** Fraction of new vehicles of this type; shares sum to 1. */
  share: number;
}

export interface PresetParking {
  /** Fraction of every garage already full at t = 0. */
  initialOccupancy: number;
}

export interface Preset {
  format: typeof PRESET_FORMAT;
  version: number;
  id: string;
  label: string;
  durationSec: number;
  /** Same network + preset + seed must produce the same run. */
  seed: number;
  lighting: Lighting;
  warmup: Warmup;
  spawnRate: SpawnRate;
  trips: Trip[];
  parking: PresetParking;
  /**
   * Optional. Fraction of new vehicles of each type; shares sum to 1. Omitted
   * means every vehicle is a car, which is why adding this did not need a
   * `version` bump — nothing that already existed changed meaning, and the
   * starter presets stay valid untouched.
   */
  vehicleMix?: VehicleShare[];
}

/** Tolerance for share sums, matching the trip-share check. */
const SHARE_EPSILON = 1e-6;

/**
 * Validates a vehicle mix, returning a list of problems (empty means valid).
 *
 * Returns messages rather than throwing so a caller can report every problem
 * with a preset at once instead of one per run.
 */
export function validateVehicleMix(mix: VehicleShare[] | undefined): string[] {
  if (mix === undefined) return [];

  const errors: string[] = [];
  if (mix.length === 0) {
    errors.push('vehicleMix is present but empty; omit it instead to mean "all cars"');
    return errors;
  }

  const seen = new Set<string>();
  let total = 0;
  for (const entry of mix) {
    if (!VEHICLE_TYPES.some((v) => v.id === entry.type)) {
      errors.push(`unknown vehicle type ${JSON.stringify(entry.type)}`);
    }
    if (seen.has(entry.type)) errors.push(`duplicate vehicle type ${JSON.stringify(entry.type)}`);
    seen.add(entry.type);
    if (!(entry.share >= 0)) errors.push(`share for ${entry.type} must be >= 0, got ${entry.share}`);
    total += entry.share;
  }
  if (Math.abs(total - 1) > SHARE_EPSILON) {
    errors.push(`shares sum to ${total}, expected 1`);
  }
  return errors;
}

/** The mix a preset implies, defaulting to all cars when it declares none. */
export function vehicleMixOf(preset: Preset): VehicleShare[] {
  return preset.vehicleMix ?? [{ type: 'car', share: 1 }];
}

/** Demand at a given sim second, linearly interpolated from the curve. */
export function spawnRateAt(rate: SpawnRate, simSeconds: number): number {
  const curve = rate.curve;
  const first = curve[0];
  if (!first) return 0;
  if (simSeconds <= first[0]) return first[1];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1];
    const next = curve[i];
    if (!prev || !next) break;
    if (simSeconds <= next[0]) {
      const span = next[0] - prev[0];
      if (span <= 0) return next[1];
      const t = (simSeconds - prev[0]) / span;
      return prev[1] + t * (next[1] - prev[1]);
    }
  }
  const last = curve[curve.length - 1];
  return last ? last[1] : 0;
}
