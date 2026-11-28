/**
 * The ground with the freeway cut (plan step 11). The bug this guards against
 * is the one that made the ramps invisible: a single flat plane at `Z.ground`
 * covering everything that descends below grade.
 *
 * Coordinates in the assertions are Three space, because that is what the
 * geometry holds: local `(x, y, z)` is stored as `(x, z, -y)` (`coords.ts`), so
 * a vertex's *height* is index 1 and its local north/south is `-array[2]`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Mesh, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import type { Scenario } from '@shared/scenario.js';

import { buildGround } from '@web/render/ground.js';
import { theme } from '@web/render/theme.js';

const dataDir = resolve(import.meta.dirname, '../../../data');

function loadTestGrid(): Scenario {
  return JSON.parse(readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8')) as Scenario;
}

function meshNamed(scenario: Scenario, name: string): { mesh: Mesh; dispose(): void } {
  const view = buildGround(scenario);
  const mesh = view.group.getObjectByName(name) as Mesh | undefined;
  expect(mesh, name).toBeDefined();
  return { mesh: mesh!, dispose: () => view.dispose() };
}

function positions(mesh: Mesh): Float32Array {
  return (mesh.geometry as BufferGeometry).getAttribute('position').array as Float32Array;
}

describe('buildGround with a freeway (the test grid)', () => {
  it('reports a trench and draws both the holed surface and the cut', () => {
    const view = buildGround(loadTestGrid());
    expect(view.hasTrench).toBe(true);
    expect(view.group.getObjectByName('ground/surface')).toBeDefined();
    expect(view.group.getObjectByName('ground/cut')).toBeDefined();
    view.dispose();
  });

  it('keeps the ramp ends inside the flat trench floor, not buried in a bank', () => {
    // eROff/eROn reach the freeway's z (-7) at y = -28, 17 m off the mainline
    // centerline at y = -45. The flat floor has to reach at least that far or
    // the ramp tips dip under the sloped bank -- the original bug, moved
    // sideways.
    const scenario = loadTestGrid();
    const freeway = scenario.scenery.freeways[0]!;
    const rampTipOffset = Math.abs(-28 - freeway.centerline[0]![1]);
    expect(freeway.width / 2 + theme.scenery.trenchFloorMargin).toBeGreaterThan(rampTipOffset);
  });

  it('puts cut vertices at the freeway height, so the ramps have something to descend into', () => {
    const scenario = loadTestGrid();
    const freeway = scenario.scenery.freeways[0]!;
    const { mesh, dispose } = meshNamed(scenario, 'ground/cut');

    const pos = positions(mesh);
    const expectedFloor = freeway.z - theme.scenery.trenchFloorDrop;
    let atFloor = 0;
    let atGrade = 0;
    let lowest = Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      const height = pos[i] ?? 0;
      lowest = Math.min(lowest, height);
      if (Math.abs(height - expectedFloor) < 1e-4) atFloor++;
      if (Math.abs(height - (-0.02)) < 1e-4) atGrade++; // Z.ground
    }

    expect(atFloor).toBeGreaterThan(0); // the trench floor
    expect(atGrade).toBeGreaterThan(0); // the top of each bank
    expect(lowest).toBeCloseTo(expectedFloor, 5);
    // The freeway surface itself (z = -7) therefore sits above the floor.
    expect(expectedFloor).toBeLessThan(freeway.z);
    dispose();
  });

  it('runs the corridor along the freeway centerline', () => {
    const scenario = loadTestGrid();
    const freeway = scenario.scenery.freeways[0]!;
    const { mesh, dispose } = meshNamed(scenario, 'ground/cut');
    const pos = positions(mesh);

    // The centerline is the straight line y = -45. Every floor vertex should be
    // within half a width (plus the ramp margin) of it; Three stores local y as
    // -array[2].
    const expectedFloor = freeway.z - theme.scenery.trenchFloorDrop;
    let floorVertices = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs((pos[i + 1] ?? 0) - expectedFloor) > 1e-4) continue;
      floorVertices++;
      const localY = -(pos[i + 2] ?? 0);
      expect(Math.abs(localY - -45)).toBeLessThanOrEqual(freeway.width / 2 + theme.scenery.trenchFloorMargin + 1e-3);
    }
    expect(floorVertices).toBeGreaterThan(0);
    dispose();
  });

  it('cuts a hole in the ground surface over the corridor, and keeps the rest', () => {
    const scenario = loadTestGrid();
    const freeway = scenario.scenery.freeways[0]!;
    const { mesh, dispose } = meshNamed(scenario, 'ground/surface');
    const pos = positions(mesh);

    // No surface triangle may have its centroid inside the corridor: that is
    // precisely the hole. Checking centroids (not vertices) is the point --
    // the hole's own boundary vertices sit exactly on the corridor edge.
    const reach = freeway.width / 2 + theme.scenery.trenchFloorMargin + theme.scenery.trenchBankWidth;
    let inside = 0;
    let total = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const localY = -(((pos[i + 2] ?? 0) + (pos[i + 5] ?? 0) + (pos[i + 8] ?? 0)) / 3);
      total++;
      if (Math.abs(localY - -45) < reach - 1e-3) inside++;
    }
    expect(total).toBeGreaterThan(2);
    expect(inside).toBe(0);

    // Everything is flat at the ground layer and finite.
    for (let i = 1; i < pos.length; i += 3) expect(pos[i]).toBeCloseTo(-0.02, 6);
    for (const value of pos) expect(Number.isFinite(value)).toBe(true);
    dispose();
  });

  it('covers the scenario bounds and the whole freeway extent', () => {
    const scenario = loadTestGrid();
    const { mesh, dispose } = meshNamed(scenario, 'ground/surface');
    const pos = positions(mesh);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i] ?? 0);
      maxX = Math.max(maxX, pos[i] ?? 0);
    }
    // Freeway runs x = -200 .. 470, wider than the bounds (-150 .. 420).
    expect(minX).toBeLessThan(-200);
    expect(maxX).toBeGreaterThan(470);
    dispose();
  });

  it('produces no NaN anywhere in the group', () => {
    const view = buildGround(loadTestGrid());
    view.group.traverse((obj) => {
      if (!(obj as Mesh).isMesh) return;
      for (const value of positions(obj as Mesh)) expect(Number.isFinite(value)).toBe(true);
    });
    view.dispose();
  });

  it('includes the reference grid, toggled by the theme', () => {
    const view = buildGround(loadTestGrid());
    const grid = view.group.getObjectByName('ground/grid');
    expect(grid).toBeDefined();
    expect(grid!.visible).toBe(theme.scenery.gridVisible);
    view.dispose();
  });
});

describe('buildGround without a freeway', () => {
  it('falls back to a usable flat plane', () => {
    const scenario = loadTestGrid();
    scenario.scenery.freeways = [];
    const view = buildGround(scenario);

    expect(view.hasTrench).toBe(false);
    expect(view.group.getObjectByName('ground/cut')).toBeUndefined();

    const surface = view.group.getObjectByName('ground/surface') as Mesh;
    expect(surface).toBeDefined();
    const pos = positions(surface);
    expect(pos.length).toBeGreaterThanOrEqual(18); // at least two triangles
    for (let i = 1; i < pos.length; i += 3) expect(pos[i]).toBeCloseTo(-0.02, 6);
    for (const value of pos) expect(Number.isFinite(value)).toBe(true);

    // It still reaches past the scenario bounds on every side.
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i] ?? 0);
      maxX = Math.max(maxX, pos[i] ?? 0);
    }
    expect(minX).toBeLessThan(scenario.meta.bounds.minX);
    expect(maxX).toBeGreaterThan(scenario.meta.bounds.maxX);
    view.dispose();
  });

  it('ignores a junk freeway rather than throwing', () => {
    const scenario = loadTestGrid();
    scenario.scenery.freeways = [
      { id: 'bad', name: 'one point', centerline: [[0, 0]], width: 30, z: -7 },
      { id: 'worse', name: 'no width', centerline: [[0, 0], [10, 0]], width: 0, z: -7 },
    ];
    let view!: ReturnType<typeof buildGround>;
    expect(() => {
      view = buildGround(scenario);
    }).not.toThrow();
    expect(view.hasTrench).toBe(false);
    view.dispose();
  });

  it('tolerates a scenario with no scenery block at all', () => {
    const scenario = loadTestGrid();
    delete (scenario as unknown as Record<string, unknown>)['scenery'];
    const view = buildGround(scenario);
    expect(view.hasTrench).toBe(false);
    expect(view.group.getObjectByName('ground/surface')).toBeDefined();
    view.dispose();
  });
});
