/**
 * The ground, with the freeway corridor cut out of it (plan step 11).
 *
 * The flat quad this replaces was the reason the ramps were invisible:
 * `eROn`/`eROff` descend to the freeway's `z` (-7 m on the test grid) and the
 * single ground plane at `Z.ground` sat right on top of them, so both ramps and
 * the freeway mainline were buried. Here the ground is a `Shape` with one hole
 * per freeway, and each hole is filled by a trench floor plus a sloped bank on
 * either side, so the freeway sits in a cut and the ramps visibly dive into it.
 *
 * Everything is derived from `scenery.freeways` (centerline, width, z) plus the
 * scenario bounds — nothing about the test grid is hardcoded, so the same code
 * handles downtown's I-30 corridor. With no freeways at all it falls back to a
 * single flat plane, which is exactly the old behaviour.
 *
 * Shape: the trench runs past the ends of its centerline (half the ground
 * padding) so the cut leaves the playable area instead of ending in a visible
 * pit wall; the ground rectangle is padded further still, so every hole stays
 * strictly inside the outline (a hole crossing the outline would wreck the
 * triangulation).
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  Mesh,
  MeshLambertMaterial,
  Path,
  Shape,
  ShapeGeometry,
  Uint32BufferAttribute,
  Vector2,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Bounds, Point2, Polygon, Polyline } from '@shared/common.js';
import type { Freeway, Scenario } from '@shared/scenario.js';

import { offsetPolyline } from '@web/geometry/polyline.js';

import { Z, toThree, writeThree } from './coords.js';
import { subscribeTheme, theme } from './theme.js';

export interface GroundView {
  group: Group;
  /** False when the scenario has no usable freeway and the flat-plane fallback was used. */
  hasTrench: boolean;
  dispose(): void;
}

/** A freeway reduced to the numbers the cut needs. */
interface Corridor {
  /** Centerline, extended past both ends so the cut runs off the map. */
  centerline: Polyline;
  /** Half the flat trench floor: the freeway's own half-width plus the ramp margin. */
  halfWidth: number;
  bankWidth: number;
  /** Trench floor height (just under the freeway surface). */
  floorZ: number;
}

function usableFreeway(freeway: Freeway | undefined): boolean {
  if (!freeway) return false;
  const pts = freeway.centerline;
  if (!Array.isArray(pts) || pts.length < 2) return false;
  if (!Number.isFinite(freeway.width) || freeway.width <= 0) return false;
  return pts.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
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

/** Closed ring around a corridor at `offset` meters from its centerline: left side out, right side back. */
function corridorRing(centerline: Polyline, offset: number): Polygon {
  const left = offsetPolyline(centerline, -offset);
  const right = offsetPolyline(centerline, offset);
  return [...left, ...[...right].reverse()];
}

/** The quad strip between two matched polylines, each at its own flat height. Local meters. */
function bandBuffers(
  inner: Polyline,
  outer: Polyline,
  innerZ: number,
  outerZ: number,
): { positions: Float32Array; indices: Uint32Array } {
  const n = Math.min(inner.length, outer.length);
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const a = inner[i];
    const b = outer[i];
    if (!a || !b) continue;
    const base = i * 6;
    positions[base] = a[0];
    positions[base + 1] = a[1];
    positions[base + 2] = innerZ;
    positions[base + 3] = b[0];
    positions[base + 4] = b[1];
    positions[base + 5] = outerZ;
  }
  const indices = new Uint32Array(Math.max(0, n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const base = i * 6;
    indices[base] = 2 * i;
    indices[base + 1] = 2 * i + 1;
    indices[base + 2] = 2 * (i + 1) + 1;
    indices[base + 3] = 2 * i;
    indices[base + 4] = 2 * (i + 1) + 1;
    indices[base + 5] = 2 * (i + 1);
  }
  return { positions, indices };
}

/** Local-meter `[x, y, z]` buffers -> a Three-space `BufferGeometry`, via `coords.ts`. */
function toGeometry(buffers: { positions: Float32Array; indices: Uint32Array }): BufferGeometry {
  const n = buffers.positions.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const base = i * 3;
    writeThree(out, base, buffers.positions[base] ?? 0, buffers.positions[base + 1] ?? 0, buffers.positions[base + 2] ?? 0);
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(out, 3));
  geom.setIndex(new Uint32BufferAttribute(buffers.indices, 1));
  return geom;
}

/** Non-indexed copy, for merging with other non-indexed parts. */
function flatten(geom: BufferGeometry): BufferGeometry {
  const out = geom.index ? (geom.toNonIndexed() as BufferGeometry) : geom;
  if (out !== geom) geom.dispose();
  out.deleteAttribute('normal');
  out.deleteAttribute('uv');
  return out;
}

/** The ground outline: scenario bounds unioned with every freeway's extent, then padded. */
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

/** The flat ground surface, holed out where each corridor runs. */
function surfaceGeometry(rect: Bounds, corridors: Corridor[]): BufferGeometry {
  const shape = new Shape([
    new Vector2(rect.minX, rect.minY),
    new Vector2(rect.maxX, rect.minY),
    new Vector2(rect.maxX, rect.maxY),
    new Vector2(rect.minX, rect.maxY),
  ]);

  for (const corridor of corridors) {
    const ring = corridorRing(corridor.centerline, corridor.halfWidth + corridor.bankWidth);
    const hole = new Path(ring.map(([x, y]) => new Vector2(x, y)));
    shape.holes.push(hole);
  }

  // ShapeGeometry lays the outline out at local z = 0; lift it to the ground
  // layer, then map into Three space.
  const geom = new ShapeGeometry(shape);
  const attr = geom.getAttribute('position');
  const array = attr.array as Float32Array;
  for (let i = 2; i < array.length; i += 3) array[i] = Z.ground;
  const n = array.length / 3;
  const out = new Float32Array(array.length);
  for (let i = 0; i < n; i++) {
    const base = i * 3;
    writeThree(out, base, array[base] ?? 0, array[base + 1] ?? 0, array[base + 2] ?? 0);
  }
  geom.setAttribute('position', new Float32BufferAttribute(out, 3));
  return flatten(geom);
}

export function buildGround(scenario: Scenario): GroundView {
  const group = new Group();
  group.name = 'ground';

  const bounds: Bounds = scenario.meta?.bounds ?? { minX: -500, minY: -500, maxX: 500, maxY: 500 };
  const freeways = Array.isArray(scenario.scenery?.freeways) ? scenario.scenery.freeways : [];
  const padding = Math.max(1, theme.scenery.groundPadding);
  const bankWidth = Math.max(0.5, theme.scenery.trenchBankWidth);
  const floorDrop = Math.max(0, theme.scenery.trenchFloorDrop);

  const corridors: Corridor[] = [];
  for (const freeway of freeways) {
    if (!usableFreeway(freeway)) continue;
    corridors.push({
      centerline: extendEnds(freeway.centerline, padding / 2),
      halfWidth: freeway.width / 2 + Math.max(0, theme.scenery.trenchFloorMargin),
      bankWidth,
      floorZ: (Number.isFinite(freeway.z) ? freeway.z : 0) - floorDrop,
    });
  }

  const rect = groundRect(bounds, corridors, padding);

  const geometries: BufferGeometry[] = [];

  const groundMaterial = new MeshLambertMaterial({ color: theme.scenery.groundColor });
  const surface = surfaceGeometry(rect, corridors);
  geometries.push(surface);
  const surfaceMesh = new Mesh(surface, groundMaterial);
  surfaceMesh.receiveShadow = true;
  surfaceMesh.name = 'ground/surface';
  group.add(surfaceMesh);

  // --- The cut: floor + two banks per corridor, one merged mesh ------------
  const bankMaterial = new MeshLambertMaterial({ color: theme.scenery.trenchBankColor });
  const cutParts: BufferGeometry[] = [];
  for (const corridor of corridors) {
    const { centerline, halfWidth, floorZ } = corridor;
    const left = offsetPolyline(centerline, -halfWidth);
    const right = offsetPolyline(centerline, halfWidth);
    const leftTop = offsetPolyline(centerline, -(halfWidth + corridor.bankWidth));
    const rightTop = offsetPolyline(centerline, halfWidth + corridor.bankWidth);

    // Floor, then each bank sloping from the floor up to ground level.
    cutParts.push(flatten(toGeometry(bandBuffers(left, right, floorZ, floorZ))));
    cutParts.push(flatten(toGeometry(bandBuffers(left, leftTop, floorZ, Z.ground))));
    cutParts.push(flatten(toGeometry(bandBuffers(right, rightTop, floorZ, Z.ground))));
  }

  if (cutParts.length > 0) {
    const merged = cutParts.length === 1 ? cutParts[0] : mergeGeometries(cutParts, false);
    if (cutParts.length > 1) for (const p of cutParts) p.dispose();
    if (merged) {
      merged.computeVertexNormals();
      geometries.push(merged);
      const mesh = new Mesh(merged, bankMaterial);
      mesh.receiveShadow = true;
      mesh.name = 'ground/cut';
      group.add(mesh);
    }
  }

  surface.computeVertexNormals();

  // --- Reference grid -------------------------------------------------------
  const span = Math.max(1, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)) * 1.5;
  const grid = new GridHelper(
    span,
    Math.max(1, Math.round(span / 25)),
    theme.scenery.gridMajorColor,
    theme.scenery.gridMinorColor,
  );
  grid.name = 'ground/grid';
  grid.position.copy(toThree((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, Z.ground + 0.01));
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
