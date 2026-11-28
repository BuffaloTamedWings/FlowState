import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Mesh } from 'three';

import type { Scenario } from '@shared/scenario.js';

import { compileScenario } from '@web/compile/index.js';
import { buildNetworkView } from '@web/render/networkView.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const scenario = JSON.parse(
  readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8'),
) as Scenario;
const network = compileScenario(scenario);

function hasNaN(geom: BufferGeometry): boolean {
  const pos = geom.getAttribute('position');
  if (!pos) return false;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < arr.length; i++) {
    if (Number.isNaN(arr[i])) return true;
  }
  return false;
}

describe('buildNetworkView', () => {
  it('returns a group with children and no empty groups', () => {
    const view = buildNetworkView(scenario, network);
    expect(view.group.children.length).toBeGreaterThan(0);

    let totalLeaves = 0;
    view.group.traverse((obj) => {
      if ((obj as Mesh).isMesh || (obj as { isLineSegments?: boolean }).isLineSegments) {
        totalLeaves++;
      }
    });
    expect(totalLeaves).toBeGreaterThan(0);
    view.dispose();
  });

  it('has no NaN in any position buffer', () => {
    const view = buildNetworkView(scenario, network);
    let checked = 0;
    view.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh && mesh.geometry) {
        expect(hasNaN(mesh.geometry)).toBe(false);
        checked++;
      }
      const lines = obj as unknown as { isLineSegments?: boolean; geometry?: BufferGeometry };
      if (lines.isLineSegments && lines.geometry) {
        expect(hasNaN(lines.geometry)).toBe(false);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(0);
    view.dispose();
  });

  it('dispose() runs without throwing', () => {
    const view = buildNetworkView(scenario, network);
    expect(() => view.dispose()).not.toThrow();
  });
});
