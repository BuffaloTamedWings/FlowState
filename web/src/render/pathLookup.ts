/**
 * Per-path arc-length lookup tables for the compiled network, built once
 * after compile/load and queried every frame by the cars renderer to turn
 * `(pathIndex, s)` into `(x, y, heading)`. Pure TypeScript — no Three.js —
 * so it's testable headlessly like the rest of `web/src/geometry/`.
 */
import type { ArcSample, ArcTable } from '@web/geometry/index.js';
import { buildArcTable, sampleArc } from '@web/geometry/index.js';
import type { CompiledNetwork } from '@shared/network.js';

/** A degenerate table for a path with no `debugPolyline`, so lookups return the origin rather than throwing. */
const EMPTY_TABLE: ArcTable = buildArcTable([]);

/**
 * One `ArcTable` per path, indexed by the path's `index` (its position in
 * `CompiledNetwork.paths`). Paths without a `debugPolyline` (shouldn't happen
 * for an in-memory compile result handed straight to render, but
 * `debugPolyline` is documented as optional) get `EMPTY_TABLE`.
 */
export function buildPathLookup(network: CompiledNetwork): ArcTable[] {
  return network.paths.map((p) => (p.debugPolyline && p.debugPolyline.length > 0 ? buildArcTable(p.debugPolyline) : EMPTY_TABLE));
}

/**
 * Samples a path by index. Out-of-range `s` is clamped by `sampleArc` itself
 * (the compiled `length` is rounded to 2 dp, so `s` can exceed the arc
 * table's total by a hair); an out-of-range `pathIndex` returns the origin
 * rather than throwing, since this runs in the render hot path.
 */
export function samplePath(lookup: ArcTable[], pathIndex: number, s: number): ArcSample {
  const table = lookup[pathIndex];
  if (!table) return { x: 0, y: 0, heading: [0, 0] };
  return sampleArc(table, s);
}
