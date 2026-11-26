/**
 * Vehicle types the engine simulates — PRD §7.6.
 *
 * Sizes live here because both sides need the *same* number: the engine uses
 * `length` for car-following gaps and queue spacing, the front end uses it for
 * mesh size. If they disagreed, a truck would visibly overlap the vehicle
 * behind it while the engine believed the gap was fine. This is the same
 * one-definition rule that path lengths follow in `network.ts`.
 *
 * Driving behavior (acceleration, desired headway, comfortable braking) is
 * deliberately **not** here — it is the engine's business and the front end has
 * no use for it. Only what both sides must agree on belongs in this file.
 */

/** One vehicle type. `code` is what travels in the tick flags, not `id`. */
export interface VehicleType {
  /** Stable string ID, used in presets and code. */
  id: string;
  /** 0-3, packed into tick flag bits 3-4. See `shared/messages.ts`. */
  code: number;
  label: string;
  /** Meters, bumper to bumper. The single source of truth for both sides. */
  length: number;
  /** Meters. */
  width: number;
}

export const VEHICLE_TYPES = [
  { id: 'car', code: 0, label: 'Car', length: 4.5, width: 1.8 },
  { id: 'truck', code: 1, label: 'Box truck', length: 9.0, width: 2.4 },
  { id: 'semi', code: 2, label: 'Semi', length: 18.0, width: 2.5 },
] as const satisfies readonly VehicleType[];

export type VehicleTypeId = (typeof VEHICLE_TYPES)[number]['id'];

/** The default when nothing says otherwise, and the fallback for unknown input. */
export const DEFAULT_VEHICLE_TYPE = VEHICLE_TYPES[0];

/**
 * Number of bits reserved for the type code in the tick flags. Four types fit;
 * a fifth would need another bit (bit 5 is free) and a contract change.
 */
export const VEHICLE_CODE_BITS = 2;

/** Lookup by string ID. Returns `car` for an unknown ID rather than throwing. */
export function vehicleTypeById(id: string): VehicleType {
  return VEHICLE_TYPES.find((v) => v.id === id) ?? DEFAULT_VEHICLE_TYPE;
}

/**
 * Lookup by tick-flag code. An unknown code falls back to `car` — a tick is a
 * hot path arriving 10 times a sim-second, and a stale or truncated code should
 * draw something sensible rather than throw mid-frame.
 */
export function vehicleTypeByCode(code: number): VehicleType {
  return VEHICLE_TYPES.find((v) => v.code === code) ?? DEFAULT_VEHICLE_TYPE;
}
