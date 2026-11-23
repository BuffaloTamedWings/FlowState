import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dataDir = resolve(import.meta.dirname, '../../data');

function readJson(relPath: string): Record<string, unknown> {
  const text = readFileSync(resolve(dataDir, relPath), 'utf8');
  const parsed: unknown = JSON.parse(text);
  expect(parsed, relPath).toBeTypeOf('object');
  return parsed as Record<string, unknown>;
}

describe('starter data files', () => {
  it('scenario has the expected format, version and size', () => {
    const scenario = readJson('scenarios/test-grid.scenario.json');
    expect(scenario.format).toBe('flowstate-scenario');
    expect(scenario.version).toBe(1);
    expect(scenario.nodes).toHaveLength(22);
    expect(scenario.edges).toHaveLength(25);
    expect(Array.isArray(scenario.points)).toBe(true);
    expect((scenario.meta as { id?: string }).id).toBe('test-grid');
  });

  it('compiled network has the expected format and version', () => {
    const network = readJson('compiled/test-grid.compiled.json');
    expect(network.format).toBe('flowstate-network');
    expect(network.version).toBe(1);
    expect(network.scenario).toBe('test-grid');
    expect(Array.isArray(network.paths)).toBe(true);

    const paths = network.paths as Array<{ kind: string }>;
    const lanes = paths.filter((p) => p.kind === 'lane');
    const connectors = paths.filter((p) => p.kind === 'connector');
    // PRD §16: 54 lane paths, 93 connectors.
    expect(lanes).toHaveLength(54);
    expect(connectors).toHaveLength(93);
  });

  it.each(['morning', 'afternoon', 'night'])('preset %s has the expected format and version', (id) => {
    const preset = readJson(`presets/${id}.json`);
    expect(preset.format).toBe('flowstate-preset');
    expect(preset.version).toBe(1);
    expect(preset.id).toBe(id);
    expect(preset.durationSec).toBeTypeOf('number');
    expect(Array.isArray((preset.spawnRate as { curve?: unknown }).curve)).toBe(true);
  });
});
