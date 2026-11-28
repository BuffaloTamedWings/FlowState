/**
 * Constructs the real `CarsView` / `HeadlightsView` (not just their pure
 * halves in `carsCore.ts`). `InstancedMesh` needs no WebGL context to be
 * built, so these run in plain Node.
 *
 * This file exists because of a shipped bug: `headlights.ts` called the
 * hoisted `makeMesh` before the `const hidden` it reads was initialised, so
 * `createHeadlightsView` threw `ReferenceError: Cannot access 'hidden' before
 * initialization` on the very first call. Nothing caught it -- every car test
 * covered `carsCore.ts`'s pure functions and no test had ever constructed the
 * view itself. In the browser it took down `startSim`, which left `main.ts`'s
 * `client` null and made every button in the HUD a silent no-op.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Scenario } from '@shared/scenario.js';

import { compileScenario } from '@web/compile/index.js';
import { createCarsView } from '@web/render/cars.js';
import { createHeadlightsView } from '@web/render/headlights.js';
import { buildPathLookup } from '@web/render/pathLookup.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const scenario = JSON.parse(
  readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8'),
) as Scenario;
const lookup = buildPathLookup(compileScenario(scenario));

describe('createHeadlightsView', () => {
  it('constructs without throwing', () => {
    expect(() => createHeadlightsView(64)).not.toThrow();
  });

  it('starts hidden, and tracks setEnabled', () => {
    const view = createHeadlightsView(64);
    expect(view.isEnabled()).toBe(false);
    expect(view.object.visible).toBe(false);
    view.setEnabled(true);
    expect(view.isEnabled()).toBe(true);
    expect(view.object.visible).toBe(true);
    view.dispose();
  });

  it('places and hides a slot, and grows capacity, without throwing', () => {
    const view = createHeadlightsView(4);
    view.setEnabled(true);
    view.place(0, 10, 20, 1, 0, 4.5);
    view.hideSlot(0);
    view.ensureCapacity(256);
    view.place(200, 10, 20, 0, 1, 4.5);
    view.commit();
    view.dispose();
  });
});

describe('createCarsView', () => {
  it('constructs without throwing (this is what startSim does on load)', () => {
    expect(() => createCarsView(lookup)).not.toThrow();
  });

  it('exposes an object to parent into the scene, and accepts a headlight toggle', () => {
    const view = createCarsView(lookup);
    expect(view.object).toBeDefined();
    view.setHeadlights(true);
    view.setHeadlights(false);
    view.dispose();
  });

  it('renders a tick without throwing, with and without a previous tick', () => {
    const view = createCarsView(lookup);
    const frame = (simTime: number, s: number) => ({
      simTime,
      cars: new Map([[1, { vehicleId: 1, pathIndex: 0, s, speed: 12, flags: 0 }]]),
    });
    view.update(frame(1, 5), null, 1);
    view.update(frame(1.1, 6), frame(1, 5), 0.5);
    // A car leaving the map frees its slot; the next update must not throw.
    view.update({ simTime: 1.2, cars: new Map() }, frame(1.1, 6), 1);
    view.dispose();
  });
});
