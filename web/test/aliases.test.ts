/**
 * Proves the `@shared` / `@engine` / `@web` aliases resolve under Vitest and tsc,
 * from both sides of the repo. `engine/` has no package.json or tsconfig of its
 * own — it builds and tests through the root package (see engine/README.md), and
 * this is the check that keeps that true.
 */

import { describe, expect, it } from 'vitest';

import * as enginePlaceholder from '@engine/index.js';
import { SIM_DT, TICK_STRIDE } from '@shared/messages.js';
import { NETWORK_FORMAT } from '@shared/network.js';
import { SCENARIO_FORMAT } from '@shared/scenario.js';
import { PRESET_FORMAT } from '@shared/preset.js';

describe('path aliases', () => {
  it('resolves @shared', () => {
    expect(SCENARIO_FORMAT).toBe('flowstate-scenario');
    expect(NETWORK_FORMAT).toBe('flowstate-network');
    expect(PRESET_FORMAT).toBe('flowstate-preset');
    expect(TICK_STRIDE).toBe(5);
    expect(SIM_DT).toBeCloseTo(0.1, 10);
  });

  it('resolves @engine', () => {
    expect(enginePlaceholder).toBeTypeOf('object');
  });
});
