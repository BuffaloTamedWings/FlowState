/**
 * scenario JSON -> compiled network JSON (Node, run via `npm run compile -- <in> [out]`).
 *
 * Step 4 of docs/frontend-plan.md implements this on top of web/src/compile/.
 * Serialization matches the reference (`indent=1, ensure_ascii=False` in
 * Python) so the output can be byte-compared against `data/compiled/`.
 *
 * The result is validated before it is written. Errors still write the file —
 * a broken network is easier to debug on disk than in a message — but the exit
 * code is non-zero so a script never mistakes it for a good compile. Pass
 * `--no-validate` to skip the checks.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import type { Scenario } from '@shared/scenario.js';
import type { CompiledNetwork } from '@shared/network.js';
import { isConnectorPath, isLanePath } from '@shared/network.js';

import { compileScenario, validateNetwork } from '@web/compile/index.js';

function main(): void {
  const args = process.argv.slice(2);
  const skipValidate = args.includes('--no-validate');
  const [inPath, outPath] = args.filter((a) => !a.startsWith('--'));
  if (!inPath) {
    console.error('usage: npm run compile -- <scenario.json> [out.json] [--no-validate]');
    process.exit(1);
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(inPath, 'utf8');
  } catch (err) {
    console.error(`could not read ${inPath}: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  let scenario: Scenario;
  try {
    scenario = JSON.parse(raw) as Scenario;
  } catch (err) {
    console.error(`could not parse ${inPath} as JSON: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  let network: CompiledNetwork;
  try {
    network = compileScenario(scenario);
  } catch (err) {
    console.error(`compile failed: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const lanes = network.paths.filter(isLanePath).length;
  const connectors = network.paths.filter(isConnectorPath).length;
  console.error(
    `compiled ${scenario.meta.id}: ${lanes} lanes, ${connectors} connectors, ${network.nodes.length} nodes, ${network.points.length} points`,
  );

  const json = JSON.stringify(network, null, 1);
  if (outPath) {
    writeFileSync(outPath, json);
  } else {
    console.log(json);
  }

  if (skipValidate) return;
  const problems = validateNetwork(network);
  for (const p of problems) {
    const where = p.path ?? p.node ?? p.point ?? '';
    console.error(`  ${p.severity} [${p.code}] ${where ? `${where}: ` : ''}${p.message}`);
  }
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.length - errors;
  if (problems.length > 0) {
    console.error(`validation: ${errors} error(s), ${warnings} warning(s)`);
  }
  if (errors > 0) process.exit(1);
}

main();
