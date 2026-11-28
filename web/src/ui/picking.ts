/**
 * Pointer-down -> pointer-up raycast picking against the network group.
 * Reads `userData.pick` (set in `web/src/render/networkView.ts`) rather than
 * parsing `mesh.name`, so lane ribbons and connector/intersection-fill
 * meshes are both pickable without name-format assumptions.
 */

import { Raycaster, Vector2, type Camera, type Object3D } from 'three';

import type { PickTag } from '@web/render/index.js';

export type PickResult = PickTag | null;

/** Pointer moved more than this many CSS pixels between down and up counts as a drag, not a click. */
const CLICK_MOVE_THRESHOLD_PX = 4;

export interface PointerPos {
  x: number;
  y: number;
}

/** True if `up` is close enough to `down` to treat the gesture as a click rather than a camera drag. */
export function isClick(down: PointerPos, up: PointerPos, threshold = CLICK_MOVE_THRESHOLD_PX): boolean {
  const dx = up.x - down.x;
  const dy = up.y - down.y;
  return Math.hypot(dx, dy) <= threshold;
}

/**
 * Raycasts from a normalized-device-coordinate pointer position (`-1..1` on
 * both axes) through `camera` against `root`, returning the first hit's
 * `userData.pick` tag, or `null` if nothing pickable was hit.
 */
export function pick(ndc: PointerPos, camera: Camera, root: Object3D): PickResult {
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
  const hits = raycaster.intersectObject(root, true);
  for (const hit of hits) {
    const tag = findPickTag(hit.object);
    if (tag) return tag;
  }
  return null;
}

/** Walks up from a hit object to find the nearest ancestor (or itself) carrying a `userData.pick` tag. */
function findPickTag(object: Object3D | null): PickTag | null {
  let cur: Object3D | null = object;
  while (cur) {
    const tag = cur.userData['pick'] as PickTag | undefined;
    if (tag) return tag;
    cur = cur.parent;
  }
  return null;
}

/** Converts a pointer event's client coordinates + the canvas's bounding rect into NDC `(-1..1)`. */
export function toNdc(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): PointerPos {
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
}
