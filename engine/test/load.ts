/**
 * S2 "done when": load a compiled network and report what's in it.
 *
 *   npx tsx engine/test/load.ts data/compiled/test-grid.compiled.json
 *
 * Prints path / node / point counts, or the validation error and exits 1.
 */
import { readFileSync } from 'node:fs';
import { describeNetwork, loadNetwork } from '../src/network.js';

const file = process.argv[2] ?? 'data/compiled/test-grid.compiled.json';

try {
  const net = loadNetwork(JSON.parse(readFileSync(file, 'utf8')));
  const d = describeNetwork(net);
  console.log(`Loaded ${file} (scenario "${d.scenario}")`);
  console.log(`  paths:  ${d.paths}  (${d.lanes} lanes, ${d.connectors} connectors)`);
  console.log(`  nodes:  ${d.nodes}  ${JSON.stringify(d.nodesByControl)}`);
  console.log(`  points: ${d.points}  ${JSON.stringify(d.pointsByType)}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
