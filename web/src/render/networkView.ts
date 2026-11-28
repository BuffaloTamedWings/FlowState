/**
 * Assembles the drawable Three.js representation of a compiled network:
 * lane ribbons, connector ribbons, intersection fill polygons and lane
 * boundary lines.
 *
 * Meshes are parented one subgroup per edge (`edge/{edgeId}`, lane ribbons +
 * boundary lines) and one subgroup per node (`node/{nodeId}`, intersection
 * fill + connectors), so `rebuild()` can dispose and recreate only the
 * subgroups an edit touched instead of every mesh in the network (step 7,
 * `docs/frontend-plan.md`). Every pickable mesh carries `userData.pick`
 * (`web/src/ui/picking.ts` reads it instead of parsing names).
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
import { drawableLanes, laneBoundaries, type DrawableLane, type LaneBoundary } from './laneGeometry.js';
import { laneMaterial, lineMaterials, surfaceMaterials } from './materials.js';
import { theme } from './theme.js';

/** What a pickable mesh's `userData.pick` holds (see `web/src/ui/picking.ts`). */
export interface PickTag {
  kind: 'edge' | 'node';
  id: string;
}

export interface NetworkView {
  group: Group;
  /** Disposes and recreates only the named edge/node subgroups. */
  rebuild(scenario: Scenario, network: CompiledNetwork, touched: { edges: string[]; nodes: string[] }): void;
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

function tagPick(obj: Mesh | LineSegments, pick: PickTag): void {
  obj.userData['pick'] = pick;
}

/** Builds the one subgroup for `edgeId`: its lane ribbons and boundary lines. Geometries created go into `geomSink` so the caller can dispose them later. */
function buildEdgeGroup(
  edgeId: string,
  lanesByEdge: Map<string, DrawableLane[]>,
  boundariesByEdge: Map<string, LaneBoundary[]>,
  geomSink: BufferGeometry[],
): Group {
  const group = new Group();
  group.name = `edge/${edgeId}`;

  for (const dl of lanesByEdge.get(edgeId) ?? []) {
    if (dl.centerline.length < 2) continue; // setback ate the whole lane
    const buffers = ribbonBuffers(dl.centerline, dl.width, dl.z);
    const geom = toThreeGeometry(buffers, Z.lane);
    geomSink.push(geom);
    const mesh = new Mesh(geom, laneMaterial(dl.type));
    mesh.receiveShadow = true;
    mesh.name = dl.id;
    tagPick(mesh, { kind: 'edge', id: edgeId });
    group.add(mesh);
  }

  for (const boundary of boundariesByEdge.get(edgeId) ?? []) {
    if (boundary.points.length < 2) continue;
    const geom = lineSegmentsGeometry(boundary.points, boundary.z, Z.laneLine);
    geomSink.push(geom);
    const mat = lineMaterials[boundary.kind];
    const line = new LineSegments(geom, mat);
    tagPick(line, { kind: 'edge', id: edgeId });
    group.add(line);
  }

  return group;
}

/** Builds the one subgroup for `nodeId`: its connector ribbons and intersection fill. Empty (no group entry in `network.nodes`) when the node has no connectors (e.g. a boundary node). */
function buildNodeGroup(
  nodeId: string,
  network: CompiledNetwork,
  laneZById: Map<string, number[]>,
  geomSink: BufferGeometry[],
): Group {
  const group = new Group();
  group.name = `node/${nodeId}`;

  const connectorsAt = network.paths.filter(isConnectorPath).filter((c) => c.node === nodeId);
  if (connectorsAt.length === 0) return group;

  // Connector ribbons: width `theme.roads.connectorWidth`, z lerped from the end-z of the lane they
  // leave to the start-z of the lane they enter. Missing debugPolyline (the
  // in-memory handoff strips it) is skipped quietly, not an error.
  for (const path of connectorsAt) {
    const poly = path.debugPolyline;
    if (!poly || poly.length < 2) continue;
    const fromZArr = laneZById.get(path.from);
    const toZArr = laneZById.get(path.to);
    const zStart = fromZArr && fromZArr.length > 0 ? (fromZArr[fromZArr.length - 1] ?? 0) : 0;
    const zEnd = toZArr && toZArr.length > 0 ? (toZArr[0] ?? 0) : 0;
    const z = lerpZ(poly.length, zStart, zEnd);
    const buffers = ribbonBuffers(poly, theme.roads.connectorWidth, z);
    const geom = toThreeGeometry(buffers, Z.connector);
    geomSink.push(geom);
    const mesh = new Mesh(geom, surfaceMaterials.connector);
    mesh.receiveShadow = true;
    mesh.name = path.id;
    tagPick(mesh, { kind: 'node', id: nodeId });
    group.add(mesh);
  }

  // Intersection fill: convex hull of the node's connector geometry,
  // fan-triangulated at the mean elevation of its source points.
  const polygon = nodeFootprint(network, nodeId);
  if (polygon.length >= 3) {
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
    if (geom) {
      geomSink.push(geom);
      const mesh = new Mesh(geom, surfaceMaterials.nodeFill);
      mesh.receiveShadow = true;
      mesh.name = `node-fill/${nodeId}`;
      tagPick(mesh, { kind: 'node', id: nodeId });
      group.add(mesh);
    }
  }

  return group;
}

function groupByEdge<T extends { edge: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const arr = map.get(item.edge);
    if (arr) arr.push(item);
    else map.set(item.edge, [item]);
  }
  return map;
}

export function buildNetworkView(scenario: Scenario, network: CompiledNetwork): NetworkView {
  const geometries: BufferGeometry[] = [];
  const edgeGeoms = new Map<string, BufferGeometry[]>();
  const nodeGeoms = new Map<string, BufferGeometry[]>();
  const edgeGroups = new Map<string, Group>();
  const nodeGroups = new Map<string, Group>();

  const edgesGroup = new Group();
  edgesGroup.name = 'edges';
  const nodesGroup = new Group();
  nodesGroup.name = 'nodes';

  const group = new Group();
  group.name = 'network';
  group.add(edgesGroup, nodesGroup);

  function populate(scn: Scenario, net: CompiledNetwork, edgeIds: string[], nodeIds: string[]): void {
    const lanesByEdge = groupByEdge(drawableLanes(scn));
    const boundariesByEdge = groupByEdge(laneBoundaries(scn));
    const laneZById = new Map<string, number[]>();
    for (const dl of drawableLanes(scn)) laneZById.set(dl.id, dl.z);

    for (const edgeId of edgeIds) {
      const sink: BufferGeometry[] = [];
      const g = buildEdgeGroup(edgeId, lanesByEdge, boundariesByEdge, sink);
      edgeGeoms.set(edgeId, sink);
      edgeGroups.set(edgeId, g);
      edgesGroup.add(g);
      geometries.push(...sink);
    }

    for (const nodeId of nodeIds) {
      const sink: BufferGeometry[] = [];
      const g = buildNodeGroup(nodeId, net, laneZById, sink);
      nodeGeoms.set(nodeId, sink);
      nodeGroups.set(nodeId, g);
      nodesGroup.add(g);
      geometries.push(...sink);
    }
  }

  populate(
    scenario,
    network,
    scenario.edges.map((e) => e.id),
    scenario.nodes.map((n) => n.id),
  );

  return {
    group,
    rebuild(scn: Scenario, net: CompiledNetwork, touched: { edges: string[]; nodes: string[] }): void {
      for (const edgeId of touched.edges) {
        const oldGroup = edgeGroups.get(edgeId);
        if (oldGroup) {
          edgesGroup.remove(oldGroup);
        }
        const oldGeoms = edgeGeoms.get(edgeId);
        if (oldGeoms) {
          for (const g of oldGeoms) {
            g.dispose();
            const idx = geometries.indexOf(g);
            if (idx >= 0) geometries.splice(idx, 1);
          }
        }
      }
      for (const nodeId of touched.nodes) {
        const oldGroup = nodeGroups.get(nodeId);
        if (oldGroup) {
          nodesGroup.remove(oldGroup);
        }
        const oldGeoms = nodeGeoms.get(nodeId);
        if (oldGeoms) {
          for (const g of oldGeoms) {
            g.dispose();
            const idx = geometries.indexOf(g);
            if (idx >= 0) geometries.splice(idx, 1);
          }
        }
      }
      populate(scn, net, touched.edges, touched.nodes);
    },
    dispose(): void {
      for (const g of geometries) g.dispose();
    },
  };
}
