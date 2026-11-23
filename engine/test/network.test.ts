import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompiledNetwork } from '@shared/network.js';
import { describeNetwork, loadNetwork, NetworkError } from '../src/network.js';

const FILE = resolve(import.meta.dirname, '../../data/compiled/test-grid.compiled.json');
const readGrid = (): CompiledNetwork => JSON.parse(readFileSync(FILE, 'utf8')) as CompiledNetwork;

describe('loadNetwork on the test grid', () => {
  const net = loadNetwork(readGrid());

  it('reports the expected counts', () => {
    const d = describeNetwork(net);
    expect(d.paths).toBe(147);
    expect(d.lanes).toBe(54);
    expect(d.connectors).toBe(93);
    expect(d.nodes).toBe(11);
    expect(d.points).toBe(21);
  });

  it('copies lengths and speed limits by index', () => {
    net.paths.forEach((p, i) => {
      expect(net.length[i]).toBe(p.length);
      expect(net.speedLimit[i]).toBe(p.speedLimit);
      expect(net.byId.get(p.id)).toBe(i);
    });
  });

  it('builds prev as the exact mirror of next', () => {
    for (let i = 0; i < net.count; i++) {
      for (const j of net.next[i]!) expect(Array.from(net.prev[j]!)).toContain(i);
      for (const j of net.prev[i]!) expect(Array.from(net.next[j]!)).toContain(i);
    }
  });

  it('has no dead-end lanes except where the map ends', () => {
    // A lane with no way out must end at a node that isn't compiled (boundary / rampEnd).
    for (const p of net.paths) {
      if (p.kind !== 'lane' || p.next.length > 0) continue;
      expect(net.nodes.has(p.toNode), `${p.id} dead-ends at compiled node ${p.toNode}`).toBe(false);
    }
  });

  it('has a way in to every path except where the map starts', () => {
    for (const p of net.paths) {
      if (net.prev[p.index]!.length > 0) continue;
      expect(p.kind).toBe('lane');
      if (p.kind === 'lane') expect(net.nodes.has(p.fromNode), `${p.id} unreachable`).toBe(false);
    }
  });
});

describe('loadNetwork rejects bad files', () => {
  const expectError = (mutate: (n: CompiledNetwork) => void, message: RegExp): void => {
    const raw = readGrid();
    mutate(raw);
    expect(() => loadNetwork(raw)).toThrow(NetworkError);
    expect(() => loadNetwork(raw)).toThrow(message);
  };

  it('rejects a v1 file', () => {
    expectError((n) => { n.version = 1; }, /version is 1.*reads version 2/);
  });

  it('rejects the wrong format', () => {
    expectError((n) => { (n as { format: string }).format = 'flowstate-scenario'; }, /format/);
  });

  it('rejects a broken next reference', () => {
    expectError((n) => { n.paths[0]!.next = ['C/nowhere']; }, /L\/eF5\/f\/0\.next refers to unknown path C\/nowhere/);
  });

  it('rejects an index that does not match the position', () => {
    expectError((n) => { n.paths[3]!.index = 99; }, /index 99 but sits at position 3/);
  });

  it('rejects point access outside the lane', () => {
    expectError((n) => { n.points[0]!.access[0]!.s = 1e6; }, /outside/);
  });

  it('ignores unknown fields', () => {
    const raw = readGrid() as CompiledNetwork & { extra: unknown };
    raw.extra = { anything: true };
    (raw.paths[0] as unknown as Record<string, unknown>).futureField = 42;
    expect(() => loadNetwork(raw)).not.toThrow();
  });
});
