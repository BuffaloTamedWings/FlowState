import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Scenario } from '@shared/scenario.js';
import { LayoutState } from '@web/ui/layoutState.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const scenarioJson = readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8');

function loadScenario(): Scenario {
  return JSON.parse(scenarioJson) as Scenario;
}

describe('LayoutState', () => {
  it('never mutates the base scenario object', () => {
    const base = loadScenario();
    const frozenCopy = JSON.parse(JSON.stringify(base));
    const state = new LayoutState(base);
    state.selectEdgeOption('eF5', 'widen');
    state.selectNodeOption('n11', 'allStop');
    expect(base).toEqual(frozenCopy);
    expect(state.scenario).not.toBe(base);
  });

  it('hash is deterministic regardless of call order', () => {
    const a = new LayoutState(loadScenario());
    a.selectEdgeOption('eF5', 'widen');
    a.selectNodeOption('n11', 'allStop');

    const b = new LayoutState(loadScenario());
    b.selectNodeOption('n11', 'allStop');
    b.selectEdgeOption('eF5', 'widen');

    expect(a.hash()).toBe(b.hash());
  });

  it('two freshly constructed states with no selections agree on hash', () => {
    const a = new LayoutState(loadScenario());
    const b = new LayoutState(loadScenario());
    expect(a.hash()).toBe(b.hash());
  });

  it('a different selection produces a different hash', () => {
    const a = new LayoutState(loadScenario());
    const b = new LayoutState(loadScenario());
    b.selectEdgeOption('eF5', 'widen');
    expect(a.hash()).not.toBe(b.hash());
  });

  it('selecting then reverting restores the original hash', () => {
    const state = new LayoutState(loadScenario());
    const originalHash = state.hash();
    state.selectEdgeOption('eF5', 'widen');
    state.selectNodeOption('n11', 'allStop');
    expect(state.hash()).not.toBe(originalHash);
    state.revertAll();
    expect(state.hash()).toBe(originalHash);
  });

  it('isDirty/markRunBaseline track the last-run selections', () => {
    const state = new LayoutState(loadScenario());
    expect(state.isDirty()).toBe(true); // no baseline yet, and null !== current hash

    state.markRunBaseline();
    expect(state.isDirty()).toBe(false);

    state.selectEdgeOption('eF5', 'widen');
    expect(state.isDirty()).toBe(true);

    state.markRunBaseline();
    expect(state.isDirty()).toBe(false);

    state.revertAll();
    expect(state.isDirty()).toBe(true);
  });

  it('throws a clear error for a bad option id', () => {
    const state = new LayoutState(loadScenario());
    expect(() => state.selectEdgeOption('eF5', 'not-a-real-option')).toThrow();
    expect(() => state.selectNodeOption('n11', 'not-a-real-option')).toThrow();
  });

  it('throws for an unknown element id', () => {
    const state = new LayoutState(loadScenario());
    expect(() => state.selectEdgeOption('no-such-edge', 'widen')).toThrow();
    expect(() => state.selectNodeOption('no-such-node', 'allStop')).toThrow();
  });

  it('throws when selecting on a locked element', () => {
    const state = new LayoutState(loadScenario());
    const scenario = state.scenario;
    const lockedEdge = scenario.edges.find((e) => e.locked);
    expect(lockedEdge).toBeDefined();
    if (!lockedEdge) return;
    expect(() => state.selectEdgeOption(lockedEdge.id, lockedEdge.options[0]!.id)).toThrow();
  });
});
