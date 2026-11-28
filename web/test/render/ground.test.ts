/**
 * The ground with the freeway cut, generalised to every sunken edge (plan
 * step 11, then generalised). The bug this guards against: a ramp's own
 * descent is gentler than the freeway bank's slope, so for the shallow
 * stretch near the top of the ramp the ground used to sit *above* the ramp
 * surface -- the ramp was buried even though the trench around the freeway
 * itself looked right. See `groundHeightAt`'s module comment in `ground.ts`
 * for the full writeup of the fix (a displaced heightfield instead of a
 * `Shape` with one hole per corridor, because overlapping holes break
 * triangulation and there's no polygon-union library here to merge them).
 *
 * Coordinates in the mesh assertions are Three space, because that is what
 * the geometry holds: local `(x, y, z)` is stored as `(x, z, -y)`
 * (`coords.ts`), so a vertex's *height* is index 1 and its local north/south
 * is `-array[2]`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Mesh, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import type { Edge, Scenario } from '@shared/scenario.js';
import { laneWidth, selectedEdgeOption } from '@shared/scenario.js';

import { buildCorridors, buildGround, groundHeightAt } from '@web/render/ground.js';
import { elevationSampler } from '@web/render/elevation.js';
import { theme } from '@web/render/theme.js';

const dataDir = resolve(import.meta.dirname, '../../../data');

function loadTestGrid(): Scenario {
  return JSON.parse(readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8')) as Scenario;
}

function edgeById(scenario: Scenario, id: string): Edge {
  const edge = scenario.edges.find((e) => e.id === id);
  if (!edge) throw new Error(`no edge ${id} in the test grid`);
  return edge;
}

function meshNamed(scenario: Scenario, name: string): { mesh: Mesh | undefined; dispose(): void } {
  const view = buildGround(scenario);
  const mesh = view.group.getObjectByName(name) as Mesh | undefined;
  return { mesh, dispose: () => view.dispose() };
}

function positions(mesh: Mesh): Float32Array {
  return (mesh.geometry as BufferGeometry).getAttribute('position').array as Float32Array;
}

/** Dense samples of `edge`'s road surface: `{ x, y, z }` every `step` meters along its centerline. */
function sampleRoadSurface(edge: Edge, step = 1): { x: number; y: number; z: number }[] {
  const pts = edge.centerline;
  const sample = elevationSampler(edge);
  const out: { x: number; y: number; z: number }[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const n = Math.max(1, Math.round(total / step));
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const stepsInSeg = Math.max(1, Math.round((segLen / total) * n));
    for (let s = 0; s <= stepsInSeg; s++) {
      const t = s / stepsInSeg;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const tTotal = total === 0 ? 0 : (acc + segLen * t) / total;
      out.push({ x, y, z: sample(tTotal) });
    }
    acc += segLen;
  }
  return out;
}

describe('buildGround with a freeway (the test grid)', () => {
  it('reports a trench and draws both the holed surface and the cut', () => {
    const view = buildGround(loadTestGrid());
    expect(view.hasTrench).toBe(true);
    expect(view.group.getObjectByName('ground/surface')).toBeDefined();
    expect(view.group.getObjectByName('ground/cut')).toBeDefined();
    view.dispose();
  });

  it('puts the freeway floor at freeway z minus the configured drop', () => {
    const scenario = loadTestGrid();
    const freeway = scenario.scenery.freeways[0]!;
    const corridors = buildCorridors(scenario);
    const expectedFloor = freeway.z - theme.scenery.trenchFloorDrop;
    // Dead center of the mainline, far from either ramp.
    expect(groundHeightAt(corridors, 100, freeway.centerline[0]![1])).toBeCloseTo(expectedFloor, 5);
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

  it('covers the scenario bounds and the whole freeway extent', () => {
    const scenario = loadTestGrid();
    const { mesh, dispose } = meshNamed(scenario, 'ground/surface');
    expect(mesh).toBeDefined();
    const pos = positions(mesh!);
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
});

describe('the ramps -- the bug this step fixes', () => {
  const SUNKEN_EDGE_IDS = ['eROn', 'eROff'];

  it.each(SUNKEN_EDGE_IDS)(
    'keeps the ground at or below the road surface everywhere along %s (dense sampling)',
    (id) => {
      const scenario = loadTestGrid();
      const edge = edgeById(scenario, id);
      const corridors = buildCorridors(scenario);
      const samples = sampleRoadSurface(edge, 0.5);
      expect(samples.length).toBeGreaterThan(10);

      const tolerance = 0.02; // local meters; just float slop
      let worst = -Infinity;
      for (const { x, y, z } of samples) {
        const ground = groundHeightAt(corridors, x, y);
        worst = Math.max(worst, ground - z);
        expect(ground, `(${x.toFixed(1)}, ${y.toFixed(1)})`).toBeLessThanOrEqual(z + tolerance);
      }
      // The ground should actually dip under the road, not just tie it --
      // otherwise this test could pass by accident with a floor permanently
      // pinned at grade.
      expect(worst).toBeLessThan(-0.1);
    },
  );

  it('regression: the documented y = -16 crossing on eROn is no longer buried', () => {
    // Worked out in the plan from the two linear profiles:
    // ramp z = y/4; old bank z = 0.5(y + 8); they cross at y = -16, and for
    // y in (-16, 0] the old ground sat above the ramp.
    const scenario = loadTestGrid();
    const corridors = buildCorridors(scenario);
    for (const y of [-16, -12, -8, -4, -1]) {
      const rampZ = y / 4;
      const groundZ = groundHeightAt(corridors, -60 + (y / -28) * (-150 - -60), y);
      expect(groundZ, `y=${y}`).toBeLessThanOrEqual(rampZ + 0.02);
    }
  });

  it('merges the ramp corridor into the freeway corridor without NaN or thrown errors near the seam', () => {
    const scenario = loadTestGrid();
    expect(() => buildGround(scenario)).not.toThrow();
    const view = buildGround(scenario);
    const freeway = scenario.scenery.freeways[0]!;
    const corridors = buildCorridors(scenario);
    // Sample a grid of points right around where eROn's tip (y=-28) meets the
    // freeway (y=-45): this is exactly the overlap region between the two
    // corridors that broke hole-based triangulation.
    for (let y = -50; y <= -20; y += 2) {
      for (let x = -170; x <= -130; x += 4) {
        const z = groundHeightAt(corridors, x, y);
        expect(Number.isFinite(z), `(${x}, ${y})`).toBe(true);
        expect(z).toBeLessThanOrEqual(-0.02 + 1e-6);
      }
    }
    expect(freeway.z).toBeLessThan(0);
    view.dispose();
  });

  it('still fits a widened ramp inside its own cut', () => {
    // The real ramps are locked (no alternate options), so construct the case
    // synthetically: clone eROn and give it a much wider selected option.
    const scenario = loadTestGrid();
    const narrow = edgeById(scenario, 'eROn');
    const corridorsNarrow = buildCorridors(scenario);
    const narrowHalfWidth = corridorsNarrow.find((c) => c.centerline === narrow.centerline)?.halfWidth;

    const widened: Edge = {
      ...narrow,
      options: [
        ...narrow.options,
        {
          id: 'wide',
          label: 'Widened (synthetic, for the test)',
          kind: 'current',
          forward: [{ type: 'car' }, { type: 'car' }, { type: 'car' }, { type: 'car' }],
          backward: [],
        },
      ],
      selected: 'wide',
    };
    const widenedScenario: Scenario = {
      ...scenario,
      edges: scenario.edges.map((e) => (e.id === 'eROn' ? widened : e)),
    };

    const corridorsWide = buildCorridors(widenedScenario);
    const wideCorridor = corridorsWide.find((c) => c.centerline === widened.centerline);
    expect(wideCorridor).toBeDefined();
    expect(wideCorridor!.halfWidth).toBeGreaterThan(narrowHalfWidth ?? 0);

    // And the widened ramp's own surface (now 4 lanes wide, one-way centered)
    // must still sit entirely within the flat floor, not spilling into the bank.
    const selected = selectedEdgeOption(widened);
    const totalWidth =
      selected.forward.reduce((sum, lane) => sum + laneWidth(lane), 0) +
      selected.backward.reduce((sum, lane) => sum + laneWidth(lane), 0);
    const edgeHalf = totalWidth / 2;
    expect(edgeHalf).toBeLessThanOrEqual(wideCorridor!.halfWidth);

    expect(() => buildGround(widenedScenario)).not.toThrow();
    const view = buildGround(widenedScenario);
    view.group.traverse((obj) => {
      if (!(obj as Mesh).isMesh) return;
      for (const value of positions(obj as Mesh)) expect(Number.isFinite(value)).toBe(true);
    });
    view.dispose();
  });
});

describe('buildGround without a freeway or any sunken edge', () => {
  it('falls back to a usable flat plane', () => {
    const scenario = loadTestGrid();
    scenario.scenery.freeways = [];
    // Flatten every edge so nothing counts as "sunken" either.
    scenario.edges = scenario.edges.map((e) => ({ ...e, elevation: null }));
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
    // The test grid's own ramps (eROn/eROff) are still sunken edges, so there
    // is still a trench -- just none contributed by the junk freeway entries.
    expect(view.hasTrench).toBe(true);
    view.dispose();
  });

  it('tolerates a scenario with no scenery block at all', () => {
    const scenario = loadTestGrid();
    delete (scenario as unknown as Record<string, unknown>)['scenery'];
    const view = buildGround(scenario);
    // Same reasoning: no `scenery.freeways` to read, but the ramps still count.
    expect(view.hasTrench).toBe(true);
    expect(view.group.getObjectByName('ground/surface')).toBeDefined();
    view.dispose();
  });

  it('truly falls back with neither freeways nor sunken edges', () => {
    const scenario = loadTestGrid();
    scenario.scenery.freeways = [];
    scenario.edges = scenario.edges.map((e) => ({ ...e, elevation: null }));
    const view = buildGround(scenario);
    expect(view.hasTrench).toBe(false);
    view.dispose();
  });
});
