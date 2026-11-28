/**
 * Scenery rendering (plan step 11), exercised against the real test-grid
 * scenario rather than a hand-made stub: its `scenery` block is the only one
 * that exists until the downtown import lands, so it is what the demo will
 * actually draw.
 *
 * No WebGL here -- building `BufferGeometry`/`Mesh` objects in plain Node is
 * fine; constructing a `WebGLRenderer` is not.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Mesh, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import type { Scenario } from '@shared/scenario.js';

import { buildingShade, buildScenery } from '@web/render/scenery.js';
import { theme } from '@web/render/theme.js';

const dataDir = resolve(import.meta.dirname, '../../../data');

function loadTestGrid(): Scenario {
  const text = readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8');
  return JSON.parse(text) as Scenario;
}

function meshesByName(scenario: Scenario): Map<string, Mesh> {
  const view = buildScenery(scenario);
  const found = new Map<string, Mesh>();
  view.group.traverse((obj) => {
    if ((obj as Mesh).isMesh) found.set(obj.name, obj as Mesh);
  });
  view.dispose();
  return found;
}

function positions(geom: BufferGeometry): Float32Array {
  return geom.getAttribute('position').array as Float32Array;
}

describe('buildScenery on the test grid', () => {
  it('draws buildings, the park and the freeway', () => {
    const scenario = loadTestGrid();
    const view = buildScenery(scenario);

    const names: string[] = [];
    let vertexTotal = 0;
    view.group.traverse((obj) => {
      if (!(obj as Mesh).isMesh) return;
      names.push(obj.name);
      vertexTotal += positions((obj as Mesh).geometry as BufferGeometry).length / 3;
    });

    // The test grid has 4 buildings in 3 use buckets (2 office, 1 residential,
    // 1 retail), 1 park and 1 freeway -> 5 merged meshes, not 6 individual ones.
    expect(names).toContain('scenery/buildings/office');
    expect(names).toContain('scenery/buildings/residential');
    expect(names).toContain('scenery/buildings/retail');
    expect(names).toContain('scenery/parks');
    expect(names).toContain('scenery/freeways');
    expect(names).toHaveLength(5);
    expect(vertexTotal).toBeGreaterThan(0);

    view.dispose();
  });

  it('extrudes buildings to their full height and keeps them above ground', () => {
    const scenario = loadTestGrid();
    const office = meshesByName(scenario).get('scenery/buildings/office');
    expect(office).toBeDefined();

    // Three-space y is local z (coords.ts): heights run 0 .. tallest building.
    const pos = positions(office!.geometry as BufferGeometry);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      minY = Math.min(minY, pos[i] ?? 0);
      maxY = Math.max(maxY, pos[i] ?? 0);
    }
    expect(minY).toBeCloseTo(0, 5);
    // bld-4 is 90 m; bld-1 is 45 m. Both are in the office bucket.
    expect(maxY).toBeCloseTo(90, 5);
  });

  it('puts the freeway at its own negative z, below the road network', () => {
    const scenario = loadTestGrid();
    const freeway = meshesByName(scenario).get('scenery/freeways');
    expect(freeway).toBeDefined();

    const pos = positions(freeway!.geometry as BufferGeometry);
    const heights = new Set<number>();
    for (let i = 1; i < pos.length; i += 3) heights.add(Math.round((pos[i] ?? 0) * 100) / 100);
    expect([...heights]).toEqual([-7]);
  });

  it('triangulates a non-convex footprint without throwing', () => {
    const scenario = loadTestGrid();
    // An L-shape: concave at [40, 40], which a fan triangulation would get wrong
    // and Three's ear-clipping handles.
    scenario.scenery.buildings = [
      {
        id: 'bld-L',
        footprint: [
          [0, 0],
          [80, 0],
          [80, 40],
          [40, 40],
          [40, 80],
          [0, 80],
        ],
        height: 30,
        levels: 8,
        use: 'office',
        estimated: { height: false },
      },
    ];

    const view = buildScenery(scenario);
    let vertices = 0;
    view.group.traverse((obj) => {
      if ((obj as Mesh).isMesh) vertices += positions((obj as Mesh).geometry as BufferGeometry).length / 3;
    });
    // 8 triangles for the two caps of an L (6 verts -> 4 tris each) plus the
    // walls; the exact count is Three's business, that it produced a solid is
    // ours.
    expect(vertices).toBeGreaterThan(24);

    // And no NaN leaked into the buffer from the concave corner.
    view.group.traverse((obj) => {
      if (!(obj as Mesh).isMesh) return;
      for (const value of positions((obj as Mesh).geometry as BufferGeometry)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });
    view.dispose();
  });

  it('is deterministic: the same scenario builds byte-identical geometry twice', () => {
    const first = meshesByName(loadTestGrid());
    const second = meshesByName(loadTestGrid());

    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [name, mesh] of first) {
      const other = second.get(name);
      expect(other, name).toBeDefined();
      expect(Array.from(positions(mesh.geometry as BufferGeometry)), name).toEqual(
        Array.from(positions(other!.geometry as BufferGeometry)),
      );
      const colors = (mesh.geometry as BufferGeometry).getAttribute('color');
      if (colors) {
        const otherColors = (other!.geometry as BufferGeometry).getAttribute('color');
        expect(Array.from(colors.array as Float32Array), name).toEqual(Array.from(otherColors.array as Float32Array));
      }
    }
  });

  it('jitters building shade deterministically from the id, and dims guessed heights', () => {
    const base = { footprint: [], height: 10, levels: 3, use: 'office', estimated: {} };
    const a = buildingShade({ ...base, id: 'bld-1' } as never);
    const again = buildingShade({ ...base, id: 'bld-1' } as never);
    const b = buildingShade({ ...base, id: 'bld-2' } as never);

    expect(a).toBe(again); // same id -> same shade, every load
    expect(a).not.toBe(b); // different ids -> visible variation
    expect(a).toBeGreaterThan(1 - theme.scenery.buildingJitter - 1e-9);
    expect(a).toBeLessThan(1 + theme.scenery.buildingJitter + 1e-9);

    const guessed = buildingShade({ ...base, id: 'bld-1', estimated: { height: true } } as never);
    expect(guessed).toBeCloseTo(a * theme.scenery.estimatedDim, 10);
  });

  it('stores per-building shade as vertex colours so a merged bucket still varies', () => {
    const scenario = loadTestGrid();
    const office = meshesByName(scenario).get('scenery/buildings/office');
    const colors = (office!.geometry as BufferGeometry).getAttribute('color');
    expect(colors).toBeDefined();
    const distinct = new Set<number>();
    const array = colors.array as Float32Array;
    for (let i = 0; i < array.length; i += 3) distinct.add(Math.round((array[i] ?? 0) * 1e6));
    // Two office buildings merged into one mesh -> two distinct shades.
    expect(distinct.size).toBe(2);
  });
});

describe('buildScenery tolerance', () => {
  it('survives a missing scenery block entirely', () => {
    const scenario = loadTestGrid();
    delete (scenario as unknown as Record<string, unknown>)['scenery'];
    const view = buildScenery(scenario);
    expect(view.group.children).toHaveLength(0);
    expect(() => view.dispose()).not.toThrow();
  });

  it('survives an empty scenery block', () => {
    const scenario = loadTestGrid();
    scenario.scenery = { freeways: [], buildings: [], parks: [] };
    const view = buildScenery(scenario);
    expect(view.group.children).toHaveLength(0);
    view.dispose();
  });

  it('skips unusable elements instead of throwing', () => {
    const scenario = loadTestGrid();
    scenario.scenery = {
      // A degenerate footprint, a zero height, a missing height, a 2-point
      // "polygon", a 1-point freeway and a zero-width freeway: all junk, none
      // of it fatal.
      buildings: [
        { id: 'a', footprint: [[0, 0]], height: 10, levels: 1, use: 'office', estimated: {} },
        { id: 'b', footprint: [[0, 0], [10, 0], [10, 10]], height: 0, levels: 0, use: 'retail', estimated: {} },
        { id: 'c', footprint: [[0, 0], [10, 0], [10, 10]], use: 'shed', estimated: {} } as never,
      ],
      parks: [{ id: 'p', name: 'sliver', polygon: [[0, 0], [1, 1]] }],
      freeways: [
        { id: 'f1', name: 'stub', centerline: [[0, 0]], width: 20, z: -5 },
        { id: 'f2', name: 'flat', centerline: [[0, 0], [100, 0]], width: 0, z: -5 },
      ],
    };

    let view!: ReturnType<typeof buildScenery>;
    expect(() => {
      view = buildScenery(scenario);
    }).not.toThrow();
    expect(view.group.children).toHaveLength(0);
    view.dispose();
  });

  it('accepts a closed polygon (first point repeated at the end)', () => {
    const scenario = loadTestGrid();
    scenario.scenery = {
      buildings: [],
      freeways: [],
      parks: [
        {
          id: 'closed',
          name: 'closed ring',
          polygon: [
            [0, 0],
            [50, 0],
            [50, 50],
            [0, 50],
            [0, 0],
          ],
        },
      ],
    };
    const view = buildScenery(scenario);
    const park = view.group.getObjectByName('scenery/parks') as Mesh | undefined;
    expect(park).toBeDefined();
    expect(positions(park!.geometry as BufferGeometry).length).toBeGreaterThan(0);
    view.dispose();
  });
});
