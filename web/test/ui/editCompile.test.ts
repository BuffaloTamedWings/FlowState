/**
 * The real safety net for step 7: every edit the panel can offer must still
 * produce a network `compileScenario` accepts and `validateNetwork` reports
 * zero errors for. Also pins down that a selected roundabout still throws
 * (the guard in `options.ts` depends on this staying true) and that
 * reverting returns a byte-identical compile to the untouched scenario.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Scenario } from '@shared/scenario.js';
import { compileScenario } from '@web/compile/index.js';
import { validateNetwork } from '@web/compile/validate.js';
import { LayoutState } from '@web/ui/layoutState.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const scenarioJson = readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8');

function loadScenario(): Scenario {
  return JSON.parse(scenarioJson) as Scenario;
}

const ROUNDABOUT_NODE_IDS = ['n01', 'n02', 'n11', 'n22'];

describe('editing + compile safety net (test grid)', () => {
  const base = loadScenario();
  const unlockedEdges = base.edges.filter((e) => !e.locked);

  it('has at least one unlocked edge offering widen and one offering roadDiet (so this test exercises something)', () => {
    expect(unlockedEdges.some((e) => e.options.some((o) => o.kind === 'widen'))).toBe(true);
    expect(unlockedEdges.some((e) => e.options.some((o) => o.kind === 'roadDiet'))).toBe(true);
  });

  for (const edge of unlockedEdges) {
    const widenOption = edge.options.find((o) => o.kind === 'widen');
    const roadDietOption = edge.options.find((o) => o.kind === 'roadDiet');

    if (widenOption) {
      it(`${edge.id}: selecting widen compiles and validates clean`, () => {
        const state = new LayoutState(loadScenario());
        state.selectEdgeOption(edge.id, widenOption.id);
        const network = compileScenario(state.scenario);
        const problems = validateNetwork(network).filter((p) => p.severity === 'error');
        expect(problems).toEqual([]);
      });
    }

    if (roadDietOption) {
      it(`${edge.id}: selecting roadDiet compiles and validates clean`, () => {
        const state = new LayoutState(loadScenario());
        state.selectEdgeOption(edge.id, roadDietOption.id);
        const network = compileScenario(state.scenario);
        const problems = validateNetwork(network).filter((p) => p.severity === 'error');
        expect(problems).toEqual([]);
      });
    }

    if (!widenOption && !roadDietOption) {
      it(`${edge.id}: offers neither widen nor roadDiet (noted, not a failure)`, () => {
        expect(edge.options.some((o) => o.kind === 'widen' || o.kind === 'roadDiet')).toBe(false);
      });
    }
  }

  for (const nodeId of ROUNDABOUT_NODE_IDS) {
    it(`${nodeId}: selecting its roundabout option throws at compile time`, () => {
      const state = new LayoutState(loadScenario());
      const node = state.scenario.nodes.find((n) => n.id === nodeId);
      expect(node).toBeDefined();
      if (!node) return;
      const roundabout = node.options.find((o) => o.control === 'roundabout');
      expect(roundabout).toBeDefined();
      if (!roundabout) return;
      state.selectNodeOption(nodeId, roundabout.id);
      expect(() => compileScenario(state.scenario)).toThrow();
    });
  }

  it('revertAll returns a network byte-identical to the original compile', () => {
    const original = compileScenario(loadScenario());

    const state = new LayoutState(loadScenario());
    // Touch a handful of edges and nodes, including both widen and roadDiet.
    const widenEdge = unlockedEdges.find((e) => e.options.some((o) => o.kind === 'widen'));
    const dietEdge = unlockedEdges.find((e) => e.options.some((o) => o.kind === 'roadDiet'));
    if (widenEdge) state.selectEdgeOption(widenEdge.id, widenEdge.options.find((o) => o.kind === 'widen')!.id);
    if (dietEdge) state.selectEdgeOption(dietEdge.id, dietEdge.options.find((o) => o.kind === 'roadDiet')!.id);
    const n11 = state.scenario.nodes.find((n) => n.id === 'n11');
    if (n11) {
      const allStop = n11.options.find((o) => o.control === 'allStop');
      if (allStop) state.selectNodeOption('n11', allStop.id);
    }

    state.revertAll();
    const reverted = compileScenario(state.scenario);

    expect(JSON.stringify(reverted)).toBe(JSON.stringify(original));
  });
});
