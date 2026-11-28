/**
 * Assembles the drawable Three.js representation of a compiled network:
 * lane ribbons, connector ribbons, intersection fill polygons and lane
 * boundary lines, as child `Group`s so they can be toggled independently
 * later (e.g. a heatmap overlay in step 10).
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineSegments,
  Mesh,
  Uint32BufferAttribute,
} from 'three';
import type { Point2, Polyline } from '@shared/common.js';
import type { CompiledNetwork } from '@shared/network.js';
import { isConnectorPath } from '@shared/network.js';
import type { Scenario } from '@shared/scenario.js';

import { Z, writeThree } from './coords.js';
import { ribbonBuffers } from './ribbon.js';
import { nodeFootprint } from './hull.js';
import { drawableLanes, laneBoundaries } from './laneGeometry.js';
import { laneMaterial, lineMaterials, surfaceMaterials } from './materials.js';

export interface NetworkView {
  group: Group;
  dispose(): void;
}

/** Linear interpolation of `n` z values from `zStart` to `zEnd`, by index fraction. */
function lerpZ(n: number, zStart: number, zEnd: number): number[] {
  if (n <= 1) return [zStart];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(zStart + (zEnd - zStart) * t);
  }
  return out;
}

/** Builds a `BufferGeometry` from local-meter ribbon buffers, mapped into Three space, plus a render-layer epsilon added to each vertex's physical height. */
function toThreeGeometry(buffers: { positions: Float32Array; indices: Uint32Array }, zEpsilon: number): BufferGeometry {
  const n = buffers.positions.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const base = i * 3;
    const x = buffers.positions[base] ?? 0;
    const y = buffers.positions[base + 1] ?? 0;
    const z = buffers.positions[base + 2] ?? 0;
    writeThree(out, base, x, y, z + zEpsilon);
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(out, 3));
  geom.setIndex(new Uint32BufferAttribute(buffers.indices, 1));
  geom.computeVertexNormals();
  return geom;
}

/** Builds a `LineSegments`-ready `BufferGeometry`: one pair of vertices per polyline segment. */
function lineSegmentsGeometry(points: Polyline, z: number[], zEpsilon: number): BufferGeometry {
  const segCount = Math.max(0, points.length - 1);
  const positions = new Float32Array(segCount * 2 * 3);
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[i + 1];
    const za = (z[i] ?? 0) + zEpsilon;
    const zb = (z[i + 1] ?? 0) + zEpsilon;
    if (!a || !b) continue;
    writeThree(positions, i * 6, a[0], a[1], za);
    writeThree(positions, i * 6 + 3, b[0], b[1], zb);
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geom;
}

/** Fan-triangulates a convex polygon (already CCW in local x/y) at a flat height. */
function fanGeometry(polygon: Point2[], z: number): BufferGeometry | null {
  if (polygon.length < 3) return null;
  const positions = new Float32Array(polygon.length * 3);
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    if (!p) continue;
    writeThree(positions, i * 3, p[0], p[1], z);
  }
  const indexCount = (polygon.length - 2) * 3;
  const indices = new Uint32Array(indexCount);
  for (let i = 1, k = 0; i < polygon.length - 1; i++, k += 3) {
    indices[k] = 0;
    indices[k + 1] = i;
    indices[k + 2] = i + 1;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setIndex(new Uint32BufferAttribute(indices, 1));
  geom.computeVertexNormals();
  return geom;
}

export function buildNetworkView(scenario: Scenario, network: CompiledNetwork): NetworkView {
  const geometries: BufferGeometry[] = [];

  const lanesGroup = new Group();
  lanesGroup.name = 'lanes';
  const connectorsGroup = new Group();
  connectorsGroup.name = 'connectors';
  const nodesGroup = new Group();
  nodesGroup.name = 'nodeFill';
  const linesGroup = new Group();
  linesGroup.name = 'laneBoundaries';

  // Lane ribbons, and an id -> z[] lookup the connectors below reuse to find
  // each car lane's end/start elevation.
  const laneZById = new Map<string, number[]>();
  for (const dl of drawableLanes(scenario)) {
    laneZById.set(dl.id, dl.z);
    if (dl.centerline.length < 2) continue; // setback ate the whole lane
    const buffers = ribbonBuffers(dl.centerline, dl.width, dl.z);
    const geom = toThreeGeometry(buffers, Z.lane);
    geometries.push(geom);
    const mesh = new Mesh(geom, laneMaterial(dl.type));
    mesh.name = dl.id;
    lanesGroup.add(mesh);
  }

  // Connector ribbons: width 3.5 m, z lerped from the end-z of the lane they
  // leave to the start-z of the lane they enter. Missing debugPolyline (the
  // in-memory handoff strips it) is skipped quietly, not an error.
  for (const path of network.paths) {
    if (!isConnectorPath(path)) continue;
    const poly = path.debugPolyline;
    if (!poly || poly.length < 2) continue;
    const fromZArr = laneZById.get(path.from);
    const toZArr = laneZById.get(path.to);
    const zStart = fromZArr && fromZArr.length > 0 ? (fromZArr[fromZArr.length - 1] ?? 0) : 0;
    const zEnd = toZArr && toZArr.length > 0 ? (toZArr[0] ?? 0) : 0;
    const z = lerpZ(poly.length, zStart, zEnd);
    const buffers = ribbonBuffers(poly, 3.5, z);
    const geom = toThreeGeometry(buffers, Z.connector);
    geometries.push(geom);
    const mesh = new Mesh(geom, surfaceMaterials.connector);
    mesh.name = path.id;
    connectorsGroup.add(mesh);
  }

  // Intersection fill: convex hull of each compiled node's connector
  // geometry, fan-triangulated at the mean elevation of its source points.
  for (const node of network.nodes) {
    const connectorsAt = network.paths.filter(isConnectorPath).filter((c) => c.node === node.id);
    if (connectorsAt.length === 0) continue;
    const polygon = nodeFootprint(network, node.id);
    if (polygon.length < 3) continue;

    const srcZs: number[] = [];
    for (const c of connectorsAt) {
      const fromZArr = laneZById.get(c.from);
      const toZArr = laneZById.get(c.to);
      const fZ = fromZArr && fromZArr.length > 0 ? (fromZArr[fromZArr.length - 1] ?? 0) : 0;
      const tZ = toZArr && toZArr.length > 0 ? (toZArr[0] ?? 0) : 0;
      srcZs.push(fZ, tZ);
      if (c.debugPolyline && c.debugPolyline.length > 0) {
        for (const z of lerpZ(c.debugPolyline.length, fZ, tZ)) srcZs.push(z);
      }
    }
    const meanZ = srcZs.length > 0 ? srcZs.reduce((a, b) => a + b, 0) / srcZs.length : 0;

    const geom = fanGeometry(polygon, meanZ + Z.nodeFill);
    if (!geom) continue;
    geometries.push(geom);
    const mesh = new Mesh(geom, surfaceMaterials.nodeFill);
    mesh.name = `node-fill/${node.id}`;
    nodesGroup.add(mesh);
  }

  // Lane boundary / divider / centerline lines.
  for (const boundary of laneBoundaries(scenario)) {
    if (boundary.points.length < 2) continue;
    const geom = lineSegmentsGeometry(boundary.points, boundary.z, Z.laneLine);
    geometries.push(geom);
    const mat = lineMaterials[boundary.kind];
    const line = new LineSegments(geom, mat);
    linesGroup.add(line);
  }

  const group = new Group();
  group.name = 'network';
  group.add(nodesGroup, lanesGroup, connectorsGroup, linesGroup);

  return {
    group,
    dispose(): void {
      for (const g of geometries) g.dispose();
    },
  };
}
