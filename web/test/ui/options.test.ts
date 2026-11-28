import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Scenario } from '@shared/scenario.js';
import { edgeOptionsFor, nodeOptionsFor } from '@web/ui/options.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
const scenario = JSON.parse(
  readFileSync(resolve(dataDir, 'scenarios/test-grid.scenario.json'), 'utf8'),
) as Scenario;

const ROUNDABOUT_NODE_IDS = ['n01', 'n02', 'n11', 'n22'];

describe('nodeOptionsFor', () => {
  it('marks every roundabout option on n01, n02, n11, n22 unavailable with a reason', () => {
    for (const nodeId of ROUNDABOUT_NODE_IDS) {
      const node = scenario.nodes.find((n) => n.id === nodeId);
      expect(node).toBeDefined();
      if (!node) continue;
      const offered = nodeOptionsFor(node);
      const roundabout = node.options
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => o.control === 'roundabout');
      expect(roundabout.length).toBeGreaterThan(0);
      for (const { i } of roundabout) {
        const offer = offered[i];
        expect(offer).toBeDefined();
        expect(offer?.available).toBe(false);
        expect(offer?.reason).toBeTruthy();
      }
    }
  });

  it('non-roundabout options on those nodes stay available', () => {
    const node = scenario.nodes.find((n) => n.id === 'n01');
    expect(node).toBeDefined();
    if (!node) return;
    const offered = nodeOptionsFor(node);
    const nonRoundabout = node.options
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.control !== 'roundabout');
    expect(nonRoundabout.length).toBeGreaterThan(0);
    for (const { i } of nonRoundabout) {
      expect(offered[i]?.available).toBe(true);
    }
  });
});

describe('edgeOptionsFor', () => {
  it('offers nothing selectable on locked ramp edges', () => {
    const lockedEdges = scenario.edges.filter((e) => e.locked);
    expect(lockedEdges.length).toBeGreaterThan(0);
    for (const edge of lockedEdges) {
      const offered = edgeOptionsFor(edge);
      expect(offered.length).toBeGreaterThan(0);
      for (const offer of offered) {
        expect(offer.available).toBe(false);
        expect(offer.reason).toBe('Locked');
      }
    }
  });

  it('widen is available on an edge that offers it', () => {
    const edge = scenario.edges.find((e) => !e.locked && e.options.some((o) => o.kind === 'widen'));
    expect(edge).toBeDefined();
    if (!edge) return;
    const offered = edgeOptionsFor(edge);
    const widenIndex = edge.options.findIndex((o) => o.kind === 'widen');
    expect(offered[widenIndex]?.available).toBe(true);
  });

  it('roadDiet is available on an edge that offers it', () => {
    const edge = scenario.edges.find((e) => !e.locked && e.options.some((o) => o.kind === 'roadDiet'));
    expect(edge).toBeDefined();
    if (!edge) return;
    const offered = edgeOptionsFor(edge);
    const dietIndex = edge.options.findIndex((o) => o.kind === 'roadDiet');
    expect(offered[dietIndex]?.available).toBe(true);
  });
});
