/**
 * Rules 8-9 (PRD §7.4) plus `CompiledNode` assembly. Ported from
 * `tools/reference/make_sample.py`'s node loop (lines ~598-661): control
 * resolution, all-way-stop, yield stop/yieldTo, signal phases and yields, and
 * merge yields.
 *
 * Rule 10 (the roundabout ring) is not implemented — the test grid never
 * selects a roundabout, so this throws rather than silently emitting a wrong
 * network if a scenario ever does.
 */

import { selectedNodeOption } from '@shared/scenario.js';
import type { Scenario } from '@shared/scenario.js';
import type { CompiledControl, CompiledNode, ConnectorPath, LanePath, Phase } from '@shared/network.js';
import { PROTECTED_LEFT_PHASE_IDS, SIGNAL_PHASE_IDS } from '@shared/network.js';

import { headingAtEnd } from '@web/geometry/polyline.js';

export function buildNodes(
  scenario: Scenario,
  connectorsByNode: Map<string, ConnectorPath[]>,
  lanesById: Map<string, LanePath>,
  branchIds: Set<string>,
): CompiledNode[] {
  const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
  const compiledNodes: CompiledNode[] = [];

  for (const [nid, cs] of connectorsByNode) {
    const node = nodesById.get(nid);
    if (!node) throw new Error(`connector references unknown node ${nid}`);

    let control: CompiledControl = selectedNodeOption(node).control;
    if (node.kind === 'merge') control = 'merge';
    else if (node.kind === 'diverge') control = 'none';

    if (control === 'roundabout') {
      // TODO (step 11): implement rule 10, the roundabout ring (cars treat
      // ring sections like any lane, yielding to traffic already circulating).
      throw new Error(`node ${nid}: roundabout compile rule (rule 10) is not implemented yet (step 11)`);
    }

    const csById = new Map(cs.map((c) => [c.id, c]));

    if (control === 'allStop') {
      for (const c of cs) c.stop = true;
    } else if (control === 'yield') {
      const major = new Set(selectedNodeOption(node).params.majorEdges ?? []);
      for (const c of cs) {
        const src = lanesById.get(c.from);
        if (!src) throw new Error(`connector ${c.id}: unknown source lane ${c.from}`);
        c.stop = !major.has(src.edge);
      }
      // Rule 9: after stopping, a minor approach gives way to the major
      // approaches it conflicts with.
      for (const c of cs) {
        if (!c.stop) continue;
        c.yieldTo = c.conflicts
          .filter((cf) => {
            const other = csById.get(cf.path);
            return other !== undefined && !other.stop;
          })
          .map((cf) => cf.path);
      }
    }

    let phases: Phase[] | null = null;
    if (control === 'signal' || control === 'signalProtectedLeft') {
      const protectedLeft = control === 'signalProtectedLeft';
      const phaseIds = protectedLeft ? PROTECTED_LEFT_PHASE_IDS : SIGNAL_PHASE_IDS;
      const groups = new Map<string, string[]>(phaseIds.map((id) => [id, []]));
      for (const c of cs) {
        const src = lanesById.get(c.from);
        if (!src) throw new Error(`connector ${c.id}: unknown source lane ${c.from}`);
        const pts = src.debugPolyline;
        if (!pts) throw new Error(`lane ${src.id} has no debugPolyline`);
        const [hx, hy] = headingAtEnd(pts);
        // The approach's axis comes from the heading the car arrives on, not
        // from the movement it then makes.
        const axis = Math.abs(hx) >= Math.abs(hy) ? 'EW' : 'NS';
        // Rule 8: with protected lefts, a left runs only in its axis's own
        // left phase; everything else runs in the axis's main phase.
        c.phase = protectedLeft && c.turn === 'left' ? `${axis}-left` : axis;
        const bucket = groups.get(c.phase);
        if (!bucket) throw new Error(`unexpected phase ${c.phase}`);
        bucket.push(c.id);
      }
      phases = [...groups.entries()].filter(([, paths]) => paths.length > 0).map(([id, paths]) => ({ id, paths }));

      // Within one phase, the permissive yields of PRD §8.4. Under
      // `signalProtectedLeft` the left rule below can never fire — a left is
      // alone in its own phase, so it shares a phase with no through or right
      // movement — which is exactly what "no permissive yields" means. The
      // right-turn-on-merge rule still applies in the main phases.
      for (const c of cs) {
        for (const cf of c.conflicts) {
          const other = csById.get(cf.path);
          if (!other || other.phase !== c.phase) continue;
          if (c.turn === 'left' && (other.turn === 'through' || other.turn === 'right')) {
            c.yieldTo.push(other.id);
          } else if (c.turn === 'right' && other.turn === 'through' && cf.type === 'merge') {
            c.yieldTo.push(other.id);
          }
        }
      }
    } else if (control === 'merge') {
      for (const c of cs) {
        if (branchIds.has(c.id)) {
          c.yieldTo = c.conflicts.map((cf) => cf.path);
        }
      }
    }

    compiledNodes.push({
      id: nid,
      control,
      phases,
      inPaths: [...new Set(cs.map((c) => c.from))].sort(),
      connectors: cs.map((c) => c.id),
    });
  }

  return compiledNodes;
}
