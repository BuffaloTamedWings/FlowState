/**
 * Compiling the test grid with a *different* option selected.
 *
 * The golden file only pins the `current` layout, which selects `signal`,
 * `allStop`, `merge` and `none` — it never exercises `signalProtectedLeft`
 * (rule 8's four-phase case), `yield` (rule 9) or `roundabout` (rule 10).
 * Those are exactly the paths step 7's option panel will hit, so they are
 * tested here by flipping `selected` on a node the scenario already offers
 * the option on, which is what the app does at run time.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compileScenario } from '@web/compile/index.js';
import { isConnectorPath, isLanePath, PROTECTED_LEFT_PHASE_IDS } from '@shared/network.js';
import type { ConnectorPath } from '@shared/network.js';
import type { Scenario } from '@shared/scenario.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const base = JSON.parse(
  readFileSync(resolve(repoRoot, 'data/scenarios/test-grid.scenario.json'), 'utf8'),
) as Scenario;

/** The scenario with one node switched to another of its offered options. */
function withSelection(nodeId: string, optionId: string): Scenario {
  const s = structuredClone(base);
  const node = s.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`test setup: no node ${nodeId}`);
  if (!node.options.some((o) => o.id === optionId)) {
    throw new Error(`test setup: node ${nodeId} does not offer option ${optionId}`);
  }
  node.selected = optionId;
  return s;
}

function connectorsAt(scenario: Scenario, nodeId: string): ConnectorPath[] {
  return compileScenario(scenario)
    .paths.filter(isConnectorPath)
    .filter((c) => c.node === nodeId);
}

describe('compiling a non-default option', () => {
  it('leaves the rest of the network alone (switching control adds no paths)', () => {
    const net = compileScenario(withSelection('n11', 'signalProtectedLeft'));
    expect(net.paths.filter(isLanePath)).toHaveLength(54);
    expect(net.paths.filter(isConnectorPath)).toHaveLength(93);
    expect(net.layout.nodes['n11']).toBe('signalProtectedLeft');
  });

  describe('signalProtectedLeft (rule 8, four phases)', () => {
    const nodeId = 'n11';

    it('puts every left in its axis-specific left phase and nothing else there', () => {
      const cs = connectorsAt(withSelection(nodeId, 'signalProtectedLeft'), nodeId);
      expect(cs.length).toBeGreaterThan(0);
      for (const c of cs) {
        expect(c.phase).not.toBeNull();
        const isLeftPhase = c.phase?.endsWith('-left') ?? false;
        expect(
          isLeftPhase,
          `${c.id} turns ${c.turn} but is in phase ${String(c.phase)}`,
        ).toBe(c.turn === 'left');
      }
    });

    it('names phases from PROTECTED_LEFT_PHASE_IDS, in that order, dropping empty ones', () => {
      const net = compileScenario(withSelection(nodeId, 'signalProtectedLeft'));
      const node = net.nodes.find((n) => n.id === nodeId);
      const ids = node?.phases?.map((p) => p.id) ?? [];
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(PROTECTED_LEFT_PHASE_IDS).toContain(id);
      const rank = (id: string): number => PROTECTED_LEFT_PHASE_IDS.indexOf(id as never);
      expect(ids.map(rank)).toEqual([...ids.map(rank)].sort((a, b) => a - b));
      for (const p of node?.phases ?? []) expect(p.paths.length).toBeGreaterThan(0);
    });

    it('has no permissive yields — a protected left shares its phase with nothing', () => {
      // PRD §8.4: "Same, with the four phases from the compile step and no
      // permissive yields." It falls out of the phase split rather than being
      // special-cased, so this is the assertion that proves the split.
      for (const c of connectorsAt(withSelection(nodeId, 'signalProtectedLeft'), nodeId)) {
        expect(c.yieldTo, `${c.id} should not yield under a protected left`).toEqual([]);
      }
    });

    it('nobody stops at a signal', () => {
      for (const c of connectorsAt(withSelection(nodeId, 'signalProtectedLeft'), nodeId)) {
        expect(c.stop).toBe(false);
      }
    });
  });

  describe('yield (rule 9)', () => {
    // n12 and n21 both offer `yield` and both have a `majorEdges` subset.
    for (const nodeId of ['n12', 'n21']) {
      it(`${nodeId}: minor approaches stop, major approaches do not`, () => {
        const scenario = withSelection(nodeId, 'yield');
        const node = scenario.nodes.find((n) => n.id === nodeId);
        const major = new Set(node?.options.find((o) => o.id === 'yield')?.params.majorEdges ?? []);
        expect(major.size).toBeGreaterThan(0);

        const net = compileScenario(scenario);
        const lanesById = new Map(net.paths.filter(isLanePath).map((l) => [l.id, l]));
        const cs = net.paths.filter(isConnectorPath).filter((c) => c.node === nodeId);

        let stopped = 0;
        for (const c of cs) {
          const src = lanesById.get(c.from);
          const onMajor = major.has(src?.edge ?? '');
          expect(c.stop, `${c.id} comes off ${String(src?.edge)}`).toBe(!onMajor);
          if (c.stop) stopped++;
        }
        expect(stopped).toBeGreaterThan(0);
        expect(stopped).toBeLessThan(cs.length);
      });

      it(`${nodeId}: a stopping connector yields to exactly its non-stopping conflicts`, () => {
        const cs = connectorsAt(withSelection(nodeId, 'yield'), nodeId);
        const byId = new Map(cs.map((c) => [c.id, c]));
        for (const c of cs) {
          const expected = c.conflicts
            .filter((cf) => byId.get(cf.path)?.stop === false)
            .map((cf) => cf.path);
          expect(c.yieldTo, c.id).toEqual(c.stop ? expected : []);
        }
        expect(cs.some((c) => c.yieldTo.length > 0)).toBe(true);
      });

      it(`${nodeId}: no phases, since a yield node has no signal`, () => {
        const net = compileScenario(withSelection(nodeId, 'yield'));
        expect(net.nodes.find((n) => n.id === nodeId)?.phases).toBeNull();
        for (const c of connectorsAt(withSelection(nodeId, 'yield'), nodeId)) {
          expect(c.phase).toBeNull();
        }
      });
    }
  });

  describe('allStop', () => {
    it('every connector stops and none yields (first-come-first-served via conflicts)', () => {
      const cs = connectorsAt(withSelection('n11', 'allStop'), 'n11');
      expect(cs.length).toBeGreaterThan(0);
      for (const c of cs) {
        expect(c.stop, c.id).toBe(true);
        expect(c.yieldTo, c.id).toEqual([]);
      }
    });
  });

  describe('roundabout (rule 10)', () => {
    it('throws a clear not-implemented error rather than emitting a wrong network', () => {
      // Deferred to step 11: the ring needs its own connector geometry, and
      // PRD §7.4 rule 10 does not yet define what `from`/`to`/`turn` hold for
      // a ring section. Failing loudly is the contract until then — the
      // options panel must not offer a roundabout before that lands.
      expect(() => compileScenario(withSelection('n01', 'roundabout'))).toThrow(/roundabout/i);
      expect(() => compileScenario(withSelection('n01', 'roundabout'))).toThrow(/not implemented/i);
    });
  });
});
