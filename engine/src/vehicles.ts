/**
 * Per-vehicle driving parameters. Every vehicle carries its own IdmParams, so
 * longer, slower vehicles (trucks, semis) need no special cases elsewhere.
 *
 * **Lengths come from `shared/vehicles.ts`**, the single source of truth the
 * front end also draws from, so engine gaps and on-screen meshes always agree.
 * Only driving behavior (acceleration, headway, braking) is defined here.
 */
import { vehicleTypeById, VEHICLE_TYPES, type VehicleTypeId } from '@shared/vehicles.js';
import { DEFAULT_IDM, type IdmParams } from './idm.js';

export type { VehicleTypeId };

type Behavior = Omit<IdmParams, 'carLength'>;

const BEHAVIOR: Readonly<Record<VehicleTypeId, Behavior>> = {
  car: { timeHeadway: DEFAULT_IDM.timeHeadway, maxAccel: DEFAULT_IDM.maxAccel, comfortDecel: DEFAULT_IDM.comfortDecel, minGap: DEFAULT_IDM.minGap, delta: DEFAULT_IDM.delta },
  truck: { timeHeadway: 1.8, maxAccel: 0.7, comfortDecel: 1.5, minGap: 2.5, delta: 4 },
  semi: { timeHeadway: 2.2, maxAccel: 0.5, comfortDecel: 1.2, minGap: 3, delta: 4 },
};

/** Full IDM params per type: engine behavior + shared length. */
export const VEHICLE_PARAMS: Readonly<Record<VehicleTypeId, Readonly<IdmParams>>> = Object.freeze(
  Object.fromEntries(
    VEHICLE_TYPES.map((t) => [t.id, Object.freeze({ ...BEHAVIOR[t.id], carLength: vehicleTypeById(t.id).length })]),
  ) as Record<VehicleTypeId, Readonly<IdmParams>>,
);

/** Tick-flag code for a type (bits 3–4 of `flags`, see `shared/messages.ts`). */
export const vehicleCode = (type: VehicleTypeId): number => vehicleTypeById(type).code;
