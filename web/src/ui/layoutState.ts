/**
 * Owns the player's layout choices: which option is selected on each edge and
 * node. Pure — no DOM, no Three.js — so it unit-tests in plain Node. `main.ts`
 * is the only thing that drives it from a UI event.
 */

import type { Scenario } from '@shared/scenario.js';

/** Deterministic deep clone: structuredClone preserves key order and nesting without re-serializing through JSON.stringify's own ordering quirks. */
function cloneScenario(scenario: Scenario): Scenario {
  return structuredClone(scenario);
}

export class LayoutState {
  readonly scenario: Scenario;

  /** `elementId -> selected option id` at construction time, for `revertAll`. */
  private readonly originalEdgeSelected = new Map<string, string>();
  private readonly originalNodeSelected = new Map<string, string>();

  /** The hash recorded the last time `markRunBaseline` was called, or `null` before any run. */
  private runBaselineHash: string | null = null;

  constructor(base: Scenario) {
    this.scenario = cloneScenario(base);
    for (const edge of this.scenario.edges) this.originalEdgeSelected.set(edge.id, edge.selected);
    for (const node of this.scenario.nodes) this.originalNodeSelected.set(node.id, node.selected);
  }

  selectEdgeOption(edgeId: string, optionId: string): void {
    const edge = this.scenario.edges.find((e) => e.id === edgeId);
    if (!edge) throw new Error(`no such edge: ${edgeId}`);
    if (edge.locked) throw new Error(`edge ${edgeId} is locked`);
    const option = edge.options.find((o) => o.id === optionId);
    if (!option) throw new Error(`edge ${edgeId} has no option ${optionId}`);
    edge.selected = optionId;
  }

  selectNodeOption(nodeId: string, optionId: string): void {
    const node = this.scenario.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`no such node: ${nodeId}`);
    if (node.locked) throw new Error(`node ${nodeId} is locked`);
    const option = node.options.find((o) => o.id === optionId);
    if (!option) throw new Error(`node ${nodeId} has no option ${optionId}`);
    node.selected = optionId;
  }

  /** Restores every element's `selected` to what it was when this LayoutState was constructed. */
  revertAll(): void {
    for (const edge of this.scenario.edges) {
      const original = this.originalEdgeSelected.get(edge.id);
      if (original !== undefined) edge.selected = original;
    }
    for (const node of this.scenario.nodes) {
      const original = this.originalNodeSelected.get(node.id);
      if (original !== undefined) node.selected = original;
    }
  }

  /**
   * Deterministic hash of the current selections: `edgeId=optionId` and
   * `nodeId=optionId` pairs, in scenario order, joined by `|`. Depends only
   * on the selections, not on how many times or in what order they were
   * made, so two LayoutStates with the same choices always agree.
   */
  hash(): string {
    const parts: string[] = [];
    for (const edge of this.scenario.edges) parts.push(`${edge.id}=${edge.selected}`);
    for (const node of this.scenario.nodes) parts.push(`${node.id}=${node.selected}`);
    return parts.join('|');
  }

  /** True if the current selections differ from the baseline recorded at the last `markRunBaseline`. */
  isDirty(): boolean {
    return this.hash() !== this.runBaselineHash;
  }

  /** Records the current hash as the baseline a Run was last performed with. */
  markRunBaseline(): void {
    this.runBaselineHash = this.hash();
  }
}
