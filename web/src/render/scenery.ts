/**
 * The static backdrop: buildings, parks and the freeway mainline (plan step
 * 11). Read from `scenario.scenery`, which the engine never sees — this is
 * purely what makes the map look like a city instead of a wiring diagram.
 *
 * Draw-call budget: one `InstancedMesh`-free merged `Mesh` per building-use
 * bucket (office / residential / retail / other), one for every park and one
 * per freeway. At downtown scale that is a handful of meshes rather than one
 * per element. Per-building colour variation survives the merge by riding in a
 * vertex-colour attribute (a flat multiplier per building), so the bucket's
 * single material colour can still be re-tinted live from the theme.
 *
 * Determinism: the per-building jitter is hashed from the building's `id`
 * (`theme.ts`'s `idJitter`), never `Math.random()` — the same scenario draws
 * identically on every load, and `scenery.test.ts` pins that.
 *
 * Tolerance: a missing, empty or partially-filled `scenery` block is normal
 * (hand-written fixtures, early imports). Anything unusable is skipped
 * quietly; nothing here throws on data.
 */

import {
  BufferGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  Shape,
  ShapeGeometry,
  Uint32BufferAttribute,
  Vector2,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Polygon } from '@shared/common.js';
import type { Building, Freeway, Park, Scenario } from '@shared/scenario.js';

import { Z, writeThree } from './coords.js';
import { ribbonBuffers } from './ribbon.js';
import { idJitter, subscribeTheme, theme } from './theme.js';

/** Park fill height above the ground plane, meters. Just enough to beat z-fighting. */
const PARK_Z = Z.ground + 0.01;

/** The building-use buckets. Anything `Building.use` isn't one of lands in `other`. */
const USES = ['office', 'residential', 'retail', 'other'] as const;
type Use = (typeof USES)[number];

export interface SceneryView {
  group: Group;
  dispose(): void;
}

function useBucket(use: string | undefined): Use {
  switch (use) {
    case 'office':
    case 'residential':
    case 'retail':
      return use;
    default:
      return 'other';
  }
}

function bucketColor(use: Use): number {
  switch (use) {
    case 'office':
      return theme.scenery.officeColor;
    case 'residential':
      return theme.scenery.residentialColor;
    case 'retail':
      return theme.scenery.retailColor;
    case 'other':
      return theme.scenery.otherColor;
  }
}

/**
 * Drops a repeated closing vertex and any duplicate neighbours, so a polygon
 * written either open or closed (both show up in OSM exports) triangulates the
 * same way. Returns `null` if fewer than 3 distinct points survive.
 */
function cleanPolygon(polygon: Polygon | undefined): Polygon | null {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  const out: Polygon = [];
  for (const p of polygon) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = p[0];
    const y = p[1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) continue;
    out.push([x, y]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
    out.pop();
  }
  return out.length >= 3 ? out : null;
}

/**
 * A `Shape` from a local-meter polygon. Arbitrary (possibly non-convex)
 * outlines are fine: `ExtrudeGeometry`/`ShapeGeometry` run Three's ear-clipping
 * triangulator, unlike the fan used for the (convex by construction)
 * intersection footprints in `networkView.ts`.
 */
function toShape(polygon: Polygon): Shape {
  return new Shape(polygon.map(([x, y]) => new Vector2(x, y)));
}

/**
 * Rewrites a geometry's positions from local meters into Three space, in place,
 * via `coords.ts` — the mapping still lives in exactly one module. Normals and
 * uvs are dropped: normals are recomputed after the merge, and nothing here is
 * textured.
 */
function mapToThree(geom: BufferGeometry): BufferGeometry {
  const attr = geom.getAttribute('position');
  const array = attr.array as Float32Array;
  const out = new Float32Array(array.length);
  for (let i = 0; i < array.length; i += 3) {
    writeThree(out, i, array[i] ?? 0, array[i + 1] ?? 0, array[i + 2] ?? 0);
  }
  geom.setAttribute('position', new Float32BufferAttribute(out, 3));
  geom.deleteAttribute('normal');
  geom.deleteAttribute('uv');
  return geom;
}

/** Fills a geometry's `color` attribute with one flat multiplier, so a merged bucket still varies per building. */
function paintFlat(geom: BufferGeometry, shade: number): void {
  const count = geom.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < colors.length; i++) colors[i] = shade;
  geom.setAttribute('color', new Float32BufferAttribute(colors, 3));
}

/**
 * The brightness multiplier for one building: deterministic jitter from its
 * `id`, dimmed further when its height is a guess (`estimated.height`) so a
 * block of invented 3-storey boxes reads as softer than surveyed towers.
 */
export function buildingShade(building: Building): number {
  const jitter = idJitter(building.id ?? '') * theme.scenery.buildingJitter;
  const dim = building.estimated?.height ? theme.scenery.estimatedDim : 1;
  return Math.max(0.05, (1 + jitter) * dim);
}

/** One building's extruded box, in Three space, with its shade baked into vertex colours. Null when the footprint or height is unusable. */
function buildingGeometry(building: Building): BufferGeometry | null {
  const polygon = cleanPolygon(building.footprint);
  if (!polygon) return null;
  const height = Number.isFinite(building.height) && building.height > 0 ? building.height : 0;
  if (height <= 0) return null;

  const geom = new ExtrudeGeometry(toShape(polygon), { depth: height, bevelEnabled: false });
  mapToThree(geom);
  paintFlat(geom, buildingShade(building));
  return geom.index ? (geom.toNonIndexed() as BufferGeometry) : geom;
}

/** One park's flat fill polygon, in Three space, just above the ground plane. */
function parkGeometry(park: Park): BufferGeometry | null {
  const polygon = cleanPolygon(park.polygon);
  if (!polygon) return null;
  const geom = new ShapeGeometry(toShape(polygon));
  // ShapeGeometry lays the polygon out at local z = 0; lift it before mapping.
  const attr = geom.getAttribute('position');
  const array = attr.array as Float32Array;
  for (let i = 2; i < array.length; i += 3) array[i] = PARK_Z;
  mapToThree(geom);
  return geom.index ? (geom.toNonIndexed() as BufferGeometry) : geom;
}

/** One freeway's surface ribbon, in Three space, at its own `z`. */
function freewayGeometry(freeway: Freeway): BufferGeometry | null {
  const points = freeway.centerline;
  if (!Array.isArray(points) || points.length < 2) return null;
  const width = Number.isFinite(freeway.width) && freeway.width > 0 ? freeway.width : 0;
  if (width <= 0) return null;
  const z = Number.isFinite(freeway.z) ? freeway.z : 0;

  let buffers;
  try {
    buffers = ribbonBuffers(points, width, z);
  } catch {
    return null; // degenerate centerline (repeated points); nothing to draw
  }
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

/** Merges a bucket's geometries into one, disposing the parts. Returns null for an empty bucket. */
function mergeBucket(parts: BufferGeometry[]): BufferGeometry | null {
  if (parts.length === 0) return null;
  const only = parts[0];
  if (parts.length === 1 && only) {
    only.computeVertexNormals();
    return only;
  }
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) return null;
  merged.computeVertexNormals();
  return merged;
}

/**
 * Builds the whole scenery group. Safe to call with any scenario, including one
 * whose `scenery` block is missing entirely.
 */
export function buildScenery(scenario: Scenario): SceneryView {
  const group = new Group();
  group.name = 'scenery';

  const geometries: BufferGeometry[] = [];
  const materials: MeshLambertMaterial[] = [];

  const scenery = scenario.scenery as Scenario['scenery'] | undefined;
  const buildings = Array.isArray(scenery?.buildings) ? scenery.buildings : [];
  const parks = Array.isArray(scenery?.parks) ? scenery.parks : [];
  const freeways = Array.isArray(scenery?.freeways) ? scenery.freeways : [];

  // --- Buildings, one merged mesh per use bucket ---------------------------
  const byUse = new Map<Use, BufferGeometry[]>();
  for (const building of buildings) {
    if (!building) continue;
    const geom = buildingGeometry(building);
    if (!geom) continue;
    const bucket = useBucket(building.use);
    const list = byUse.get(bucket);
    if (list) list.push(geom);
    else byUse.set(bucket, [geom]);
  }

  const buildingMaterials = new Map<Use, MeshLambertMaterial>();
  for (const use of USES) {
    const parts = byUse.get(use);
    if (!parts) continue;
    const merged = mergeBucket(parts);
    if (!merged) continue;
    const material = new MeshLambertMaterial({ color: bucketColor(use), vertexColors: true });
    buildingMaterials.set(use, material);
    materials.push(material);
    geometries.push(merged);
    const mesh = new Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `scenery/buildings/${use}`;
    group.add(mesh);
  }

  // --- Parks, one merged mesh -----------------------------------------------
  const parkParts: BufferGeometry[] = [];
  for (const park of parks) {
    if (!park) continue;
    const geom = parkGeometry(park);
    if (geom) parkParts.push(geom);
  }
  const parkMaterial = new MeshLambertMaterial({ color: theme.scenery.parkColor });
  const mergedParks = mergeBucket(parkParts);
  if (mergedParks) {
    geometries.push(mergedParks);
    materials.push(parkMaterial);
    const mesh = new Mesh(mergedParks, parkMaterial);
    mesh.receiveShadow = true;
    mesh.name = 'scenery/parks';
    group.add(mesh);
  } else {
    parkMaterial.dispose();
  }

  // --- Freeways, one merged mesh -------------------------------------------
  const freewayParts: BufferGeometry[] = [];
  for (const freeway of freeways) {
    if (!freeway) continue;
    const geom = freewayGeometry(freeway);
    if (geom) freewayParts.push(geom);
  }
  const freewayMaterial = new MeshLambertMaterial({ color: theme.scenery.freewayColor });
  const mergedFreeways = mergeBucket(freewayParts);
  if (mergedFreeways) {
    geometries.push(mergedFreeways);
    materials.push(freewayMaterial);
    const mesh = new Mesh(mergedFreeways, freewayMaterial);
    mesh.receiveShadow = true;
    mesh.name = 'scenery/freeways';
    group.add(mesh);
  } else {
    freewayMaterial.dispose();
  }

  // Colour edits re-tint in place; the jitter/dim multipliers are baked into
  // vertex colours and only change on a rebuild (the tuning panel marks those
  // knobs structural, and `main.ts` rebuilds the scenery when it sees one).
  const unsubscribe = subscribeTheme(() => {
    for (const [use, material] of buildingMaterials) material.color.setHex(bucketColor(use));
    parkMaterial.color.setHex(theme.scenery.parkColor);
    freewayMaterial.color.setHex(theme.scenery.freewayColor);
  });

  return {
    group,
    dispose(): void {
      unsubscribe();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
