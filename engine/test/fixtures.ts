/** Small hand-built networks and presets for engine tests. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompiledNetwork, CompiledNode, CompiledPath, CompiledPoint } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';
import { loadNetwork, type Network } from '../src/network.js';

const DATA = resolve(import.meta.dirname, '../../data');

export const readGridRaw = (): CompiledNetwork =>
  JSON.parse(readFileSync(resolve(DATA, 'compiled/test-grid.compiled.json'), 'utf8')) as CompiledNetwork;
export const grid = (): Network => loadNetwork(readGridRaw());
export const readPreset = (id: 'morning' | 'afternoon' | 'night'): Preset =>
  JSON.parse(readFileSync(resolve(DATA, `presets/${id}.json`), 'utf8')) as Preset;

export function lane(id: string, length: number, speedLimit: number, next: string[]): CompiledPath {
  return { id, kind: 'lane', index: 0, edge: id, dir: 'f', laneIndex: 0, fromNode: 'x', toNode: 'y', length, speedLimit, turns: null, next };
}

export function conn(id: string, from: string, to: string, length: number, speedLimit: number): CompiledPath {
  return { id, kind: 'connector', index: 0, node: 'n', from, to, turn: 'through', length, speedLimit, phase: null, stop: false, conflicts: [], yieldTo: [], next: [to] };
}

export function network(paths: CompiledPath[], points: CompiledPoint[] = [], nodes: CompiledNode[] = []): Network {
  return loadNetwork({
    format: 'flowstate-network',
    version: 2,
    scenario: 'fixture',
    layout: { edges: {}, nodes: {} },
    units: { length: 'm', speed: 'm/s', time: 's' },
    paths: paths.map((p, index) => ({ ...p, index })),
    nodes,
    points,
  });
}

/** A → C1 → B1 → C3 → D and A → C2 → B2 → C4 → D: two equal routes from A to D. */
export function diamond(points: CompiledPoint[] = []): Network {
  return network([
    lane('A', 100, 15, ['C1', 'C2']),
    conn('C1', 'A', 'B1', 10, 15),
    conn('C2', 'A', 'B2', 10, 15),
    lane('B1', 100, 15, ['C3']),
    lane('B2', 100, 15, ['C4']),
    conn('C3', 'B1', 'D', 10, 15),
    conn('C4', 'B2', 'D', 10, 15),
    lane('D', 100, 15, []),
  ], points);
}

export function preset(overrides: Partial<Preset>): Preset {
  return {
    format: 'flowstate-preset',
    version: 1,
    id: 'test',
    label: 'Test',
    durationSec: 600,
    seed: 1,
    lighting: 'morning',
    warmup: { realSeconds: 0, playbackSpeed: 1 },
    spawnRate: { unit: 'vehiclesPerMinute', curve: [[0, 20]] },
    trips: [{ share: 1, from: ['edgeSpawn'], to: ['edgeSink'] }],
    parking: { initialOccupancy: 0 },
    ...overrides,
  };
}

/**
 * A T-junction with a stop sign on the side street (a `yield` node):
 * major M1 → Cmaj → M2 (no stop), minor m1 → Cmin → M2 (stop, then yield to Cmaj).
 */
export function yieldJunction(): Network {
  const cmaj = { ...conn('Cmaj', 'M1', 'M2', 20, 15), conflicts: [{ path: 'Cmin', type: 'merge' as const }] };
  const cmin = { ...conn('Cmin', 'm1', 'M2', 20, 6.7), turn: 'right' as const, stop: true, yieldTo: ['Cmaj'], conflicts: [{ path: 'Cmaj', type: 'merge' as const }] };
  return network(
    [lane('M1', 150, 15, ['Cmaj']), lane('m1', 100, 10, ['Cmin']), cmaj, cmin, lane('M2', 150, 15, [])],
    [
      { id: 'major', type: 'edgeSpawn', weight: 1, access: [{ path: 'M1', s: 0 }] },
      { id: 'minor', type: 'edgeSpawn', weight: 1, access: [{ path: 'm1', s: 0 }] },
      { id: 'out', type: 'edgeSink', weight: 1, access: [{ path: 'M2', s: 150 }] },
    ],
    [{ id: 'n', control: 'yield', phases: null, inPaths: ['M1', 'm1'], connectors: ['Cmaj', 'Cmin'] }],
  );
}
