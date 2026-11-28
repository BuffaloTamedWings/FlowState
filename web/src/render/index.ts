/**
 * Public surface of the render module (PRD §7.1 conventions; step 5 of
 * `docs/frontend-plan.md`). Three.js is allowed here — unlike `geometry/`
 * and `compile/` — but the coordinate mapping `(x, y, z) -> (x, z, -y)`
 * appears exactly once, in `coords.ts`.
 */

export { Z, toThree, writeThree } from './coords.js';

export type { RibbonBuffers } from './ribbon.js';
export { ribbonBuffers } from './ribbon.js';

export { convexHull, nodeFootprint } from './hull.js';

export { elevationSampler, polylineElevations } from './elevation.js';

export type { DrawableLane, LaneBoundary } from './laneGeometry.js';
export { drawableLanes, laneBoundaries } from './laneGeometry.js';

export { disposeMaterials, laneMaterial, lineMaterials, surfaceMaterials, SCENE_BACKGROUND } from './materials.js';

export type { NetworkView, PickTag } from './networkView.js';
export { buildNetworkView } from './networkView.js';

export { frameBounds } from './camera.js';

export { buildPathLookup, samplePath } from './pathLookup.js';

export type { CarPose } from './carsCore.js';
export { interpolateCarPose, SlotAllocator } from './carsCore.js';

export type { CarsView } from './cars.js';
export { createCarsView } from './cars.js';
