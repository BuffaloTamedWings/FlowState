/**
 * Shared materials for the network view. Created once and reused across the
 * (possibly hundreds of) meshes in a scenario, rather than one material per
 * mesh. `MeshLambertMaterial` for surfaces (the scene provides ambient +
 * directional light); `LineBasicMaterial` for boundary/divider lines.
 *
 * Every colour here comes from `theme.ts` — nothing is a literal. The module
 * subscribes to theme edits and re-tints the existing material objects in
 * place, so dragging a colour in the tuning panel updates the scene on the
 * next frame without rebuilding a single mesh.
 */

import { LineBasicMaterial, MeshLambertMaterial } from 'three';
import type { Lane } from '@shared/scenario.js';

import { subscribeTheme, theme } from './theme.js';

/**
 * Kept for the module's existing callers (`main.ts` sets an initial canvas
 * background before any preset has loaded). The real, per-time-of-day
 * background lives in `theme.lighting[mode].backgroundColor` and is applied by
 * `lighting.ts`.
 */
export const SCENE_BACKGROUND = theme.lighting.morning.backgroundColor;

export const surfaceMaterials = {
  car: new MeshLambertMaterial({ color: theme.roads.carColor }),
  bike: new MeshLambertMaterial({ color: theme.roads.bikeColor }),
  transit: new MeshLambertMaterial({ color: theme.roads.transitColor }),
  nodeFill: new MeshLambertMaterial({ color: theme.roads.nodeFillColor }),
  connector: new MeshLambertMaterial({ color: theme.roads.connectorColor }),
} satisfies Record<Lane['type'] | 'nodeFill' | 'connector', MeshLambertMaterial>;

export const lineMaterials = {
  edge: new LineBasicMaterial({ color: theme.roads.edgeLineColor }),
  divider: new LineBasicMaterial({ color: theme.roads.dividerLineColor }),
  centerline: new LineBasicMaterial({ color: theme.roads.centerlineColor }),
};

/** Re-reads every road colour from the theme into the shared materials. */
export function retintMaterials(): void {
  surfaceMaterials.car.color.setHex(theme.roads.carColor);
  surfaceMaterials.bike.color.setHex(theme.roads.bikeColor);
  surfaceMaterials.transit.color.setHex(theme.roads.transitColor);
  surfaceMaterials.nodeFill.color.setHex(theme.roads.nodeFillColor);
  surfaceMaterials.connector.color.setHex(theme.roads.connectorColor);
  lineMaterials.edge.color.setHex(theme.roads.edgeLineColor);
  lineMaterials.divider.color.setHex(theme.roads.dividerLineColor);
  lineMaterials.centerline.color.setHex(theme.roads.centerlineColor);
}

subscribeTheme(() => {
  retintMaterials();
});

/** Lane-surface material for a lane type. */
export function laneMaterial(type: Lane['type']): MeshLambertMaterial {
  return surfaceMaterials[type];
}

/** Disposes every shared material. Call once, when the app is torn down entirely. */
export function disposeMaterials(): void {
  for (const m of Object.values(surfaceMaterials)) m.dispose();
  for (const m of Object.values(lineMaterials)) m.dispose();
}
