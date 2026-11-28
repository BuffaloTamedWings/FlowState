/**
 * Turns an `Edge`/`Node`'s option catalog into what the panel can offer the
 * player: every option, plus whether it is actually safe to select right
 * now. Pure — no DOM. `compileScenario` is the real safety net (see
 * `web/test/ui/editCompile.test.ts`); this module exists so the UI never
 * shows a button that would blow up Run.
 */

import type { Edge, Node } from '@shared/scenario.js';

export interface OfferedOption {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
}

const ROUNDABOUT_REASON = "Roundabouts aren't implemented yet";
const LOCKED_REASON = 'Locked';
/** Kinds the compile step cannot be trusted with yet. Not present in the test grid, but offered-and-disabled rather than silently dropped if a future scenario includes one. */
const UNSUPPORTED_EDGE_KINDS = new Set(['carFree']);

export function edgeOptionsFor(edge: Edge): OfferedOption[] {
  return edge.options.map((option) => {
    const base = { id: option.id, label: option.label };
    if (edge.locked) {
      return { ...base, available: false, reason: LOCKED_REASON };
    }
    if (UNSUPPORTED_EDGE_KINDS.has(option.kind)) {
      return { ...base, available: false, reason: 'Not implemented yet' };
    }
    return { ...base, available: true };
  });
}

export function nodeOptionsFor(node: Node): OfferedOption[] {
  return node.options.map((option) => {
    const base = { id: option.id, label: option.label };
    if (node.locked) {
      return { ...base, available: false, reason: LOCKED_REASON };
    }
    if (option.control === 'roundabout') {
      return { ...base, available: false, reason: ROUNDABOUT_REASON };
    }
    return { ...base, available: true };
  });
}
