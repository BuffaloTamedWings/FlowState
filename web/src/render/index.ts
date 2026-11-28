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

export { disposeMaterials, laneMaterial, lineMaterials, retintMaterials, surfaceMaterials, SCENE_BACKGROUND } from './materials.js';

export type { LightingModeTheme, ShadowTheme, Theme, ThemeChange, ThemeListener, ThemeRGB } from './theme.js';
export {
  clearThemeListeners,
  hexToRGB,
  idJitter,
  lightingMode,
  notifyThemeChanged,
  resolveLightingName,
  subscribeTheme,
  theme,
  themeToSource,
} from './theme.js';

export type { LightingRig } from './lighting.js';
export {
  applyLighting,
  configureShadowCamera,
  createLightingRig,
  enableShadows,
  LIGHTING_MODE_NAMES,
  refreshLighting,
  sunPosition,
} from './lighting.js';

export type { SceneryView } from './scenery.js';
export { buildingShade, buildScenery } from './scenery.js';

export type { GroundView } from './ground.js';
export { buildGround } from './ground.js';

export type { NetworkView, PickTag } from './networkView.js';
export { buildNetworkView } from './networkView.js';

export { frameBounds } from './camera.js';

export { buildPathLookup, samplePath } from './pathLookup.js';

export type { CarPose } from './carsCore.js';
export { interpolateCarPose, SlotAllocator } from './carsCore.js';

export type { CarsView } from './cars.js';
export { createCarsView } from './cars.js';

export type { HeadlightsView } from './headlights.js';
export { createHeadlightsView } from './headlights.js';

export type { RGB } from './heatmap.js';
export { speedRatioColor } from './heatmap.js';

export type { HeatmapView } from './heatmapView.js';
export { applyStatsToHeatmap, createHeatmapView } from './heatmapView.js';
