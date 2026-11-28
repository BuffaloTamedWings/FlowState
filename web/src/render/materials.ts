/**
 * Shared materials for the network view. Created once and reused across the
 * (possibly hundreds of) meshes in a scenario, rather than one material per
 * mesh. `MeshLambertMaterial` for surfaces (the scene provides ambient +
 * directional light); `LineBasicMaterial` for boundary/divider lines.
 */

import { LineBasicMaterial, MeshLambertMaterial } from 'three';
import type { Lane } from '@shared/scenario.js';

export const SCENE_BACKGROUND = 0x11161c;

export const surfaceMaterials = {
  car: new MeshLambertMaterial({ color: 0x3b424a }),
  bike: new MeshLambertMaterial({ color: 0x2f6b4f }),
  transit: new MeshLambertMaterial({ color: 0x7a3b3b }),
  nodeFill: new MeshLambertMaterial({ color: 0x343a41 }),
  connector: new MeshLambertMaterial({ color: 0x434a53 }),
} satisfies Record<Lane['type'] | 'nodeFill' | 'connector', MeshLambertMaterial>;

export const lineMaterials = {
  edge: new LineBasicMaterial({ color: 0xd9dee3 }),
  divider: new LineBasicMaterial({ color: 0x9aa4ad }),
  centerline: new LineBasicMaterial({ color: 0xd8b24a }),
};

/** Lane-surface material for a lane type. */
export function laneMaterial(type: Lane['type']): MeshLambertMaterial {
  return surfaceMaterials[type];
}

/** Disposes every shared material. Call once, when the app is torn down entirely. */
export function disposeMaterials(): void {
  for (const m of Object.values(surfaceMaterials)) m.dispose();
  for (const m of Object.values(lineMaterials)) m.dispose();
}
