/**
 * Public surface of the compile module (PRD §7.4; see
 * `tools/reference/make_sample.py` lines ~320-620 for the ported logic).
 * Pure TypeScript — no Three.js, no DOM — so it runs headlessly from
 * `tools/compile-cli.ts` and from tests.
 */

export { compileScenario } from './compile.js';

export type { LanePathsResult } from './lanePaths.js';
export { buildLanePaths } from './lanePaths.js';

export type { ConnectorBuildResult } from './connectors.js';
export { buildConnectors } from './connectors.js';

export { assignConflicts, connectorsCross, segmentsCross } from './conflicts.js';

export { buildNodes } from './control.js';

export { buildPoints } from './points.js';

export type { ValidationProblem } from './validate.js';
export { assertValid, validateNetwork } from './validate.js';

export { assignTurns, groupApproaches, turnOf } from './movements.js';
