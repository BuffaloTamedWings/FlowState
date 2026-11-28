/**
 * The single place the local-meter -> Three.js coordinate convention lives
 * (PRD §7.1 / CLAUDE.md): x = east, y = north, z = up, mapped to Three's
 * `(x, y, z) -> (x, z, -y)`. Every other render module converts through
 * `toThree`/`writeThree` rather than restating the mapping.
 */

import { Vector3 } from 'three';

/** Local meters `(x, y, z)` -> a Three.js `Vector3`. */
export function toThree(x: number, y: number, z = 0): Vector3 {
  return new Vector3(x, z, -y);
}

/** Same mapping, written directly into a buffer at `[i, i+1, i+2]`. No allocation. */
export function writeThree(out: Float32Array, i: number, x: number, y: number, z: number): void {
  out[i] = x;
  out[i + 1] = z;
  out[i + 2] = -y;
}

/**
 * Render heights (Three.js `y`, i.e. local `z`) for each layer, so stacking
 * order is defined in one place. Connectors sit above the intersection fill;
 * lane boundary lines sit above the lane surface they mark.
 */
export const Z = {
  ground: -0.02,
  nodeFill: 0.0,
  connector: 0.03,
  lane: 0.02,
  laneLine: 0.05,
} as const;
