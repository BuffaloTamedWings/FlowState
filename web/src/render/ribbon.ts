/**
 * Flat (or ramped) quad-strip geometry for a lane or connector surface. Pure
 * TypeScript — no Three.js — so it unit-tests in plain Node; `networkView.ts`
 * wraps the output in a `BufferGeometry`.
 *
 * Winding: positions are emitted in local meters (x = east, y = north) and the
 * two triangles per segment are wound so that, viewed from above in the local
 * x/y plane (standard math CCW, looking down the local +z axis), the normal
 * points toward +z ("up"). The `(x, y, z) -> (x, z, -y)` Three.js mapping used
 * everywhere else in `render/` is a proper rotation (determinant +1), so this
 * winding also comes out normal-up in Three space without any extra flip.
 */

import type { Polyline } from '@shared/common.js';

import { offsetPolyline } from '@web/geometry/polyline.js';

export interface RibbonBuffers {
  /** Flat `[x, y, z, x, y, z, ...]`, one triple per vertex, in *local meters* (not yet Three-mapped). */
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Builds a ribbon of `width` meters centered on `points`, at height(s) `z`.
 * `z` is either a single flat height or one height per input point (ramps).
 *
 * The left edge (`-width/2`, north of travel) and right edge (`+width/2`,
 * south of travel) are built with the existing `offsetPolyline` — the same
 * averaged-normal corner handling the golden compile depends on — rather than
 * hand-rolled normals.
 */
export function ribbonBuffers(points: Polyline, width: number, z: number | number[]): RibbonBuffers {
  if (points.length < 2) {
    throw new Error(`ribbonBuffers: need at least 2 points, got ${points.length}`);
  }
  if (Array.isArray(z) && z.length !== points.length) {
    throw new Error(`ribbonBuffers: z array length ${z.length} does not match points length ${points.length}`);
  }

  const left = offsetPolyline(points, -width / 2);
  const right = offsetPolyline(points, width / 2);

  const n = points.length;
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const zi = Array.isArray(z) ? (z[i] ?? 0) : z;
    const l = left[i];
    const r = right[i];
    if (!l || !r) continue;
    const base = i * 2 * 3;
    positions[base] = l[0];
    positions[base + 1] = l[1];
    positions[base + 2] = zi;
    positions[base + 3] = r[0];
    positions[base + 4] = r[1];
    positions[base + 5] = zi;
  }

  const indices = new Uint32Array((n - 1) * 2 * 3);
  for (let i = 0; i < n - 1; i++) {
    const L = 2 * i;
    const R = 2 * i + 1;
    const L1 = 2 * (i + 1);
    const R1 = 2 * (i + 1) + 1;
    const base = i * 6;
    indices[base] = L;
    indices[base + 1] = R;
    indices[base + 2] = R1;
    indices[base + 3] = L;
    indices[base + 4] = R1;
    indices[base + 5] = L1;
  }

  return { positions, indices };
}
