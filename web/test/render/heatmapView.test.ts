import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import { MeshLambertMaterial } from 'three';

import { STATS_FLOW, STATS_OCCUPANCY, STATS_QUEUE_LENGTH, STATS_SPEED_RATIO, STATS_STRIDE } from '@shared/messages.js';
import { isLanePath } from '@shared/network.js';
import type { Scenario } from '@shared/scenario.js';

import { compileScenario } from '@web/compile/index.js';
import { createHeatmapView } from '@web/render/heatmapView.js';
import { buildNetworkView } from '@web/render/networkView.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const scenario = JSON.parse(
  readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8'),
) as Scenario;
const network = compileScenario(scenario);
const lanePaths = network.paths.filter(isLanePath);

/** A stats buffer with one speedRatio/occupancy pair set per lane path, everything else 0. */
function statsBuffer(valueByIndex: Map<number, { speedRatio: number; occupancy: number }>): Float32Array {
  const buf = new Float32Array(network.paths.length * STATS_STRIDE);
  for (const [index, v] of valueByIndex) {
    const o = index * STATS_STRIDE;
    buf[o + STATS_SPEED_RATIO] = v.speedRatio;
    buf[o + STATS_OCCUPANCY] = v.occupancy;
    buf[o + STATS_QUEUE_LENGTH] = 0;
    buf[o + STATS_FLOW] = 0;
  }
  return buf;
}

function findLaneMesh(root: ReturnType<typeof buildNetworkView>['group'], laneId: string): Mesh {
  const mesh = root.getObjectByName(laneId) as Mesh | undefined;
  if (!mesh) throw new Error(`lane mesh ${laneId} not found`);
  return mesh;
}

describe('createHeatmapView', () => {
  it('does nothing while disabled', () => {
    const view = buildNetworkView(scenario, network);
    const heatmap = createHeatmapView(view.group);
    const lane = lanePaths[0]!;
    const originalMaterial = findLaneMesh(view.group, lane.id).material;

    const buf = statsBuffer(new Map([[lane.index, { speedRatio: 0, occupancy: 0.5 }]]));
    heatmap.update(buf, network);

    expect(findLaneMesh(view.group, lane.id).material).toBe(originalMaterial);
    view.dispose();
  });

  it('colors a jammed lane (low speedRatio, nonzero occupancy) and leaves an empty lane alone', () => {
    const view = buildNetworkView(scenario, network);
    const heatmap = createHeatmapView(view.group);
    heatmap.setEnabled(true);

    const jammed = lanePaths[0]!;
    const empty = lanePaths[1]!;
    const originalEmptyMaterial = findLaneMesh(view.group, empty.id).material;

    const buf = statsBuffer(
      new Map([
        [jammed.index, { speedRatio: 0, occupancy: 0.8 }],
        [empty.index, { speedRatio: 1, occupancy: 0 }], // engine reports speedRatio 1 for an empty path
      ]),
    );
    heatmap.update(buf, network);

    const jammedMesh = findLaneMesh(view.group, jammed.id);
    expect(jammedMesh.material).toBeInstanceOf(MeshLambertMaterial);
    expect(jammedMesh.material).not.toBe(originalEmptyMaterial);
    const color = (jammedMesh.material as MeshLambertMaterial).color;
    expect(color.r).toBeCloseTo(0.82, 2);

    const emptyMesh = findLaneMesh(view.group, empty.id);
    expect(emptyMesh.material).toBe(originalEmptyMaterial);

    view.dispose();
    heatmap.dispose();
  });

  it('reuses the same material instance across repeated updates rather than allocating a new one each time', () => {
    const view = buildNetworkView(scenario, network);
    const heatmap = createHeatmapView(view.group);
    heatmap.setEnabled(true);
    const lane = lanePaths[0]!;

    heatmap.update(statsBuffer(new Map([[lane.index, { speedRatio: 0.1, occupancy: 0.5 }]])), network);
    const first = findLaneMesh(view.group, lane.id).material;

    heatmap.update(statsBuffer(new Map([[lane.index, { speedRatio: 0.9, occupancy: 0.5 }]])), network);
    const second = findLaneMesh(view.group, lane.id).material;

    expect(second).toBe(first);
    view.dispose();
    heatmap.dispose();
  });

  it('setEnabled(false) restores every colored lane to its base material', () => {
    const view = buildNetworkView(scenario, network);
    const heatmap = createHeatmapView(view.group);
    heatmap.setEnabled(true);
    const lane = lanePaths[0]!;
    const originalMaterial = findLaneMesh(view.group, lane.id).material;

    heatmap.update(statsBuffer(new Map([[lane.index, { speedRatio: 0.2, occupancy: 0.5 }]])), network);
    expect(findLaneMesh(view.group, lane.id).material).not.toBe(originalMaterial);

    heatmap.setEnabled(false);
    expect(findLaneMesh(view.group, lane.id).material).toBe(originalMaterial);
    view.dispose();
  });

  it('survives networkView.rebuild() after rebind() -- the recreated mesh gets colored again', () => {
    const edge = scenario.edges[0]!;
    const view = buildNetworkView(scenario, network);
    const heatmap = createHeatmapView(view.group);
    heatmap.setEnabled(true);

    const laneOnEdge = lanePaths.find((p) => p.edge === edge.id);
    expect(laneOnEdge).toBeDefined();
    const lane = laneOnEdge!;

    view.rebuild(scenario, network, { edges: [edge.id], nodes: [edge.from, edge.to] });
    heatmap.rebind();

    const buf = statsBuffer(new Map([[lane.index, { speedRatio: 0, occupancy: 0.9 }]]));
    expect(() => heatmap.update(buf, network)).not.toThrow();

    const mesh = findLaneMesh(view.group, lane.id);
    expect(mesh.material).toBeInstanceOf(MeshLambertMaterial);
    expect((mesh.material as MeshLambertMaterial).color.r).toBeCloseTo(0.82, 2);

    view.dispose();
    heatmap.dispose();
  });
});

describe('base material capture', () => {
  it('restores the real base material even if a lane was re-materialised before the first stats message', () => {
    // Reproduces the selection-highlight case: ui/highlight.ts swaps
    // mesh.material while a lane is selected. If the heatmap captured its
    // "original" lazily at first color, it would record the highlight clone
    // and restore to *that* forever. The base is captured at index() time.
    const view = buildNetworkView(scenario, network);
    const heatmap = createHeatmapView(view.group);
    const lane = lanePaths[0]!;
    const mesh = findLaneMesh(view.group, lane.id);
    const base = mesh.material;

    // Something else (the highlighter) swaps the material after binding.
    const impostor = (base as MeshLambertMaterial).clone();
    impostor.color.setRGB(1, 0, 1);
    mesh.material = impostor;

    heatmap.setEnabled(true);
    heatmap.update(statsBuffer(new Map([[lane.index, { speedRatio: 0.1, occupancy: 0.6 }]])), network);
    expect(mesh.material).not.toBe(base); // heat colour is applied
    expect(mesh.material).not.toBe(impostor);

    heatmap.setEnabled(false);
    expect(mesh.material).toBe(base); // not the impostor
    view.dispose();
  });
});
