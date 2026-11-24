/**
 * Per-vehicle driving parameters. Every vehicle carries its own IdmParams, so
 * longer, slower vehicles (trucks, semis) need no special cases elsewhere.
 *
 * Lengths here must match what the front end draws. Once `shared/vehicles.ts`
 * lands (proposed to Dev), take `carLength` from there instead of these literals.
 * Until a preset has a `vehicleMix`, every vehicle is a car.
 */
import { DEFAULT_IDM, type IdmParams } from './idm.js';

export type VehicleTypeId = 'car' | 'truck' | 'semi';

export const VEHICLE_PARAMS: Readonly<Record<VehicleTypeId, Readonly<IdmParams>>> = Object.freeze({
  car: DEFAULT_IDM,
  truck: Object.freeze({ timeHeadway: 1.8, maxAccel: 0.7, comfortDecel: 1.5, minGap: 2.5, delta: 4, carLength: 9 }),
  semi: Object.freeze({ timeHeadway: 2.2, maxAccel: 0.5, comfortDecel: 1.2, minGap: 3, delta: 4, carLength: 18 }),
});

export interface VehicleShare {
  type: VehicleTypeId;
  share: number;
}

export const ALL_CARS: readonly VehicleShare[] = [{ type: 'car', share: 1 }];
