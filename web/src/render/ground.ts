/**
 * The ground, with a trench corridor cut into it along the freeway and along
 * any other edge that dives below grade (plan step 11, then generalised).
 *
 * The original version cut one hole per freeway out of a flat `Shape`, with a
 * flat trench floor and sloped banks built as a separate band mesh. That hid
 * the freeway mainline correctly but buried most of each on/off ramp:
 * `eROn`/`eROff` descend from grade to the freeway's `z` over their own
 * length, more gently than the freeway bank's slope, so for the stretch where
 * the ramp is still shallow it punches under the bank and disappears. See the
 * regression test in `ground.test.ts` for the exact crossing (`y = -16` on
 * the test grid) worked out from both profiles.
 *
 * Fix, and the two things that changed shape as a result:
 *
 * 1. **A corridor is cut for every sunken edge, not just `scenery.freeways`.**
 *    Any `Edge` whose `elevation` dips below `SUNKEN_THRESHOLD` gets one,
 *    sized from its *selected* option's total lane width (`laneWidth`, both
 *    directions) plus `theme.scenery.rampFloorMargin` -- so picking a wider
 *    option still fits under its own cut.
 * 2. **A ramp corridor's floor is not flat.** It follows the edge's own
 *    elevation profile (`elevationSampler`/`polylineElevations`, reused
 *    as-is rather than re-derived) along its length, dropping from grade at
 *    one end to the freeway's depth at the other.
 *
 * That creates a new problem the original shape-with-holes design can't
 * survive: a ramp corridor's footprint overlaps the freeway corridor's right
 * where the ramp lands. Two overlapping holes in one `Shape` is exactly the
 * case earcut triangulation (`ShapeGeometry`) breaks on, and there is no
 * polygon-boolean library in this repo to merge the rings first.
 *
 * **Chosen fix: stop cutting holes. Build the ground as a single displaced
 * heightfield instead.** The ground plane becomes a regular grid; each vertex
 * gets a height from `groundHeightAt`, which walks every corridor, finds how
 * far the vertex is from that corridor's centerline and how far along it
 * (`closestPointOnPolyline`), turns that into "flat floor / sloped bank /
 * untouched" for that corridor alone, and keeps the *minimum* (deepest)
 * result across all corridors. Overlap is then just arithmetic -- min() of
 * two numbers -- with no polygons to merge and nothing for triangulation to
 * choke on. The grid is still split into two meshes (`ground/surface` for
 * triangles entirely at grade, `ground/cut` for anything touched by a
 * corridor) purely so the two can keep their separate materials/colors; the
 * split is a per-triangle classification after the heights are known, not a
 * geometric hole.
 *
 * Everything is derived from `scenery.freeways`, the scenario's edges and
 * bounds, and `theme.ts` -- nothing about the test grid is hardcoded, so the
 * same code handles downtown's I-30 corridor and its ramps. With no sunken
 * edges at all it falls back to a single flat plane, which is exactly the
 * old behaviour.
 */

import { BufferGeometry, Float32BufferAttribute, GridHelper, Group, Mesh, MeshLambertMaterial } from 'three';

import type { Bounds, Point2, Polyline } from '@shared/common.js';
import type { Edge, Freeway, Scenario } from '@shared/scenario.js';
import { laneWidth, selectedEdgeOption } from '@shared/scenario.js';

import { closestPointOnPolyline } from '@web/geometry/polyline.js';

import { Z, writeThree } from './coords.js';
import { elevationSampler } from './elevation.js';
import { subscribeTheme, theme } from './theme.js';

export interface GroundView {
  group: Group;
  /** False when the scenario has no usable freeway or sunken edge and the flat-plane fallback was used. */
  hasTrench: boolean;
  dispose(): void;
}

/** An edge counts as "sunken" (gets its own corridor) once it dips this far below grade, meters. */
const SUNKEN_THRESHOLD = -0.5;

/** A trench corridor, reduced to the numbers `groundHeightAt` needs. */
export interface Corridor {
  /** Centerline the corridor is measured from. Extended past both ends for a freeway; exact for an edge. */
  centerline: Polyline;
  /** Half the flat floor width: the road's own half-width plus its margin. */
  halfWidth: number;
  /** Horizontal width of the sloped bank on each side, beyond `halfWidth`. */
  bankWidth: number;
  /** Floor height (local meters) at arc-length fraction `t` in `[0, 1]` along `centerline`. */
  floorAt(t: number): number;
}

function usableFreeway(freeway: Freeway | undefined): boolean {
  if (!freeway) return false;
  const pts = freeway.centerline;
  if (!Array.isArray(pts) || pts.length < 2) return false;
  if (!Number.isFinite(freeway.width) || freeway.width <= 0) return false;
  return pts.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function isSunkenEdge(edge: Edge | undefined): boolean {
  if (!edge) return false;
  const elevation = edge.elevation;
  if (!Array.isArray(elevation) || elevation.length === 0) return false;
  const pts = edge.centerline;
  if (!Array.isArray(pts) || pts.length < 2) return false;
  if (!pts.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return false;
  return elevation.some((z) => Number.isFinite(z) && z < SUNKEN_THRESHOLD);
}

/** Extends a polyline by `distance` meters at both ends, along its end tangents. */
function extendEnds(points: Polyline, distance: number): Polyline {
  const out: Point2[] = points.map((p) => [p[0], p[1]] as Point2);
  const first = out[0];
  const second = out[1];
  const last = out[out.length - 1];
  const penultimate = out[out.length - 2];
  if (first && second) {
    const dx = first[0] - second[0];
    const dy = first[1] - second[1];
    const len = Math.hypot(dx, dy) || 1;
    out.unshift([first[0] + (dx / len) * distance, first[1] + (dy / len) * distance]);
  }
  if (last && penultimate) {
    const dx = last[0] - penultimate[0];
    const dy = last[1] - penultimate[1];
    const len = Math.hypot(dx, dy) || 1;
    out.push([last[0] + (dx / len) * distance, last[1] + (dy / len) * distance]);
  }
  return out;
}

/** Total lane width of an edge's selected option, both directions summed -- how wide its cut needs to be. */
function selectedEdgeWidth(edge: Edge): number {
  const option = selectedEdgeOption(edge);
  let total = 0;
  for (const lane of option.forward) total += laneWidth(lane);
  for (const lane of option.backward) total += laneWidth(lane);
  return total;
}

/** One corridor per usable freeway, flat-floored at its own `z`. */
function freewayCorridors(freeways: Freeway[], padding: number): Corridor[] {
  const bankWidth = Math.max(0.5, theme.scenery.trenchBankWidth);
  const floorDrop = Math.max(0, theme.scenery.trenchFloorDrop);
  const corridors: Corridor[] = [];
  for (const freeway of freeways) {
    if (!usableFreeway(freeway)) continue;
    const floorZ = (Number.isFinite(freeway.z) ? freeway.z : 0) - floorDrop;
    corridors.push({
      centerline: extendEnds(freeway.centerline, padding / 2),
      halfWidth: freeway.width / 2 + Math.max(0, theme.scenery.trenchFloorMargin),
      bankWidth,
      floorAt: () => floorZ,
    });
  }
  return corridors;
}

/**
 * One corridor per sunken edge, floor following its elevation profile. Not
 * extended past the edge's own ends: a ramp's endpoints are at (or close to)
 * grade already (that's what "comes up to a node" means), so the bank there
 * is already shallow and there is no cliff to hide by running the cut past
 * the map edge the way the freeway corridor does.
 */
function sunkenEdgeCorridors(edges: Edge[]): Corridor[] {
  const bankWidth = Math.max(0.5, theme.scenery.trenchBankWidth);
  const floorDrop = Math.max(0, theme.scenery.trenchFloorDrop);
  const margin = Math.max(0, theme.scenery.rampFloorMargin);
  const corridors: Corridor[] = [];
  for (const edge of edges) {
    if (!isSunkenEdge(edge)) continue;
    const sample = elevationSampler(edge);
    corridors.push({
      centerline: edge.centerline,
      halfWidth: selectedEdgeWidth(edge) / 2 + margin,
      bankWidth,
      floorAt: (t: number) => sample(t) - floorDrop,
    });
  }
  return corridors;
}

/**
 * Height contribution of one corridor at world point `(x, y)`, or `null` if
 * the point is outside the corridor's reach entirely (so it doesn't pull the
 * min in `groundHeightAt`).
 */
function corridorHeightAt(corridor: Corridor, x: number, y: number): number | null {
  const { distance, t } = closestPointOnPolyline(corridor.centerline, [x, y]);
  const reach = corridor.halfWidth + corridor.bankWidth;
  if (!(distance < reach)) return null;
  const floor = corridor.floorAt(t);
  if (distance <= corridor.halfWidth) return floor;
  const bankFrac = corridor.bankWidth === 0 ? 1 : (distance - corridor.halfWidth) / corridor.bankWidth;
  return floor + (Z.ground - floor) * Math.min(1, Math.max(0, bankFrac));
}

/**
 * The ground surface height at `(x, y)`: grade, unless one or more corridors
 * reach that point, in which case the lowest (deepest) of their
 * contributions wins. That `min` is the whole overlap story -- where a ramp
 * corridor and the freeway corridor both cover a point, whichever one
 * prescribes the deeper cut determines the surface, so the ground is
 * guaranteed at or below every corridor's own floor everywhere, including at
 * the seam between them.
 */
export function groundHeightAt(corridors: Corridor[], x: number, y: number): number {
  let z: number = Z.ground;
  for (const corridor of corridors) {
    const h = corridorHeightAt(corridor, x, y);
    if (h !== null && h < z) z = h;
  }
  return z;
}

/** The ground outline: scenario bounds unioned with every corridor's extent, then padded. */
function groundRect(bounds: Bounds, corridors: Corridor[], padding: number): Bounds {
  let minX = bounds.minX;
  let minY = bounds.minY;
  let maxX = bounds.maxX;
  let maxY = bounds.maxY;
  for (const corridor of corridors) {
    const reach = corridor.halfWidth + corridor.bankWidth;
    for (const [x, y] of corridor.centerline) {
      minX = Math.min(minX, x - reach);
      minY = Math.min(minY, y - reach);
      maxX = Math.max(maxX, x + reach);
      maxY = Math.max(maxY, y + reach);
    }
  }
  return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
}

/** Grid sample coordinates covering `[min, max]` at `step` apart, always including both ends. */
function gridAxis(min: number, max: number, step: number): number[] {
  const span = Math.max(1e-6, max - min);
  const count = Math.max(1, Math.ceil(span / Math.max(1e-6, step)));
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + (span * i) / count);
  return out;
}

const GRADE_EPSILON = 1e-6;

/**
 * The ground heightfield: a regular grid over `rect`, with each vertex's
 * height from `groundHeightAt`, split per-triangle into `surface` (every
 * corner exactly at grade -- untouched by any corridor) and `cut` (anything
 * else, i.e. a floor or a bank). Both are plain non-indexed triangle soups in
 * local meters; the caller maps them into Three space.
 */
function heightfield(
  rect: Bounds,
  corridors: Corridor[],
  step: number,
): { surface: number[]; cut: number[] } {
  const xs = gridAxis(rect.minX, rect.maxX, step);
  const ys = gridAxis(rect.minY, rect.maxY, step);
  const heights: number[][] = ys.map((y) => xs.map((x) => groundHeightAt(corridors, x, y)));

  const surface: number[] = [];
  const cut: number[] = [];

  const pushTri = (
    into: number[],
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void => {
    into.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  for (let iy = 0; iy < ys.length - 1; iy++) {
    for (let ix = 0; ix < xs.length - 1; ix++) {
      const x0 = xs[ix]!;
      const x1 = xs[ix + 1]!;
      const y0 = ys[iy]!;
      const y1 = ys[iy + 1]!;
      const z00 = heights[iy]![ix]!;
      const z10 = heights[iy]![ix + 1]!;
      const z01 = heights[iy + 1]![ix]!;
      const z11 = heights[iy + 1]![ix + 1]!;

      const flat = (...zs: number[]): boolean => zs.every((z) => Math.abs(z - Z.ground) < GRADE_EPSILON);

      // Two CCW (in local x/y, x east "right" / y north "up") triangles per cell.
      const tri1Flat = flat(z00, z10, z11);
      pushTri(tri1Flat ? surface : cut, x0, y0, z00, x1, y0, z10, x1, y1, z11);

      const tri2Flat = flat(z00, z11, z01);
      pushTri(tri2Flat ? surface : cut, x0, y0, z00, x1, y1, z11, x0, y1, z01);
    }
  }

  return { surface, cut };
}

/** Local-meter triangle soup (`[x, y, z, x, y, z, ...]`) -> a Three-space, non-indexed `BufferGeometry`. */
function toGeometry(flatTriangles: number[]): BufferGeometry {
  const n = flatTriangles.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const base = i * 3;
    writeThree(out, base, flatTriangles[base] ?? 0, flatTriangles[base + 1] ?? 0, flatTriangles[base + 2] ?? 0);
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(out, 3));
  geom.computeVertexNormals();
  return geom;
}

/**
 * Every corridor the ground cuts for a scenario: one per usable freeway, one
 * per sunken edge. Exported so tests (and `groundHeightAt`) can sample the
 * exact same corridor set `buildGround` renders, without duplicating the
 * selection/sizing logic.
 */
export function buildCorridors(scenario: Scenario): Corridor[] {
  const freeways = Array.isArray(scenario.scenery?.freeways) ? scenario.scenery.freeways : [];
  const edges = Array.isArray(scenario.edges) ? scenario.edges : [];
  const padding = Math.max(1, theme.scenery.groundPadding);
  return [...freewayCorridors(freeways, padding), ...sunkenEdgeCorridors(edges)];
}

export function buildGround(scenario: Scenario): GroundView {
  const group = new Group();
  group.name = 'ground';

  const bounds: Bounds = scenario.meta?.bounds ?? { minX: -500, minY: -500, maxX: 500, maxY: 500 };
  const padding = Math.max(1, theme.scenery.groundPadding);
  const step = Math.max(0.5, theme.scenery.groundGridStep);

  const corridors = buildCorridors(scenario);
  const rect = groundRect(bounds, corridors, padding);

  const geometries: BufferGeometry[] = [];
  const { surface: surfaceTris, cut: cutTris } = heightfield(rect, corridors, step);

  const groundMaterial = new MeshLambertMaterial({ color: theme.scenery.groundColor });
  const surfaceGeom = toGeometry(surfaceTris);
  geometries.push(surfaceGeom);
  const surfaceMesh = new Mesh(surfaceGeom, groundMaterial);
  surfaceMesh.receiveShadow = true;
  surfaceMesh.name = 'ground/surface';
  group.add(surfaceMesh);

  const bankMaterial = new MeshLambertMaterial({ color: theme.scenery.trenchBankColor });
  if (cutTris.length > 0) {
    const cutGeom = toGeometry(cutTris);
    geometries.push(cutGeom);
    const cutMesh = new Mesh(cutGeom, bankMaterial);
    cutMesh.receiveShadow = true;
    cutMesh.name = 'ground/cut';
    group.add(cutMesh);
  }

  // --- Reference grid -------------------------------------------------------
  const span = Math.max(1, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)) * 1.5;
  const grid = new GridHelper(
    span,
    Math.max(1, Math.round(span / 25)),
    theme.scenery.gridMajorColor,
    theme.scenery.gridMinorColor,
  );
  grid.name = 'ground/grid';
  grid.position.set((bounds.minX + bounds.maxX) / 2, Z.ground + 0.01, -(bounds.minY + bounds.maxY) / 2);
  grid.visible = theme.scenery.gridVisible;
  group.add(grid);

  const unsubscribe = subscribeTheme(() => {
    groundMaterial.color.setHex(theme.scenery.groundColor);
    bankMaterial.color.setHex(theme.scenery.trenchBankColor);
    grid.visible = theme.scenery.gridVisible;
  });

  return {
    group,
    hasTrench: corridors.length > 0,
    dispose(): void {
      unsubscribe();
      for (const g of geometries) g.dispose();
      groundMaterial.dispose();
      bankMaterial.dispose();
      grid.geometry.dispose();
      (grid.material as { dispose?: () => void }).dispose?.();
    },
  };
}
