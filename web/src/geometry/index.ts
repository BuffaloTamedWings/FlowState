/**
 * Public surface of the geometry module (PRD §7.1 conventions; see
 * `tools/reference/make_sample.py` lines ~320-460 for the ported logic).
 * Pure TypeScript — no Three.js, no DOM — so it runs headlessly from
 * `tools/compile-cli.ts` and from tests.
 */

export { add, cross, dot, length, normalize, rightOf, scale, sub } from './vec2.js';

export type { ClosestPoint } from './polyline.js';
export {
  closestPointOnPolyline,
  headingAtEnd,
  headingAtStart,
  offsetPolyline,
  pointAndTangentAt,
  polylineLength,
  round2,
  trimPolyline,
} from './polyline.js';

export type { LaneCenterline } from './laneLayout.js';
export { laneCenterlines, nodeSetback } from './laneLayout.js';

export { connectorCurve } from './connector.js';

export type { ArcSample, ArcTable } from './arcLength.js';
export { buildArcTable, sampleArc } from './arcLength.js';
