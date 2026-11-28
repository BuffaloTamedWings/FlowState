/**
 * `warmupTargetSec` — how far a fresh load fast-forwards before the player
 * takes control. See its doc comment for why the preset's literal
 * `realSeconds * playbackSpeed` (10 sim seconds for morning) was the wrong
 * number: it left Run looking broken on an almost-empty map.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { spawnRateAt, type Preset } from '@shared/preset.js';

import { warmupTargetSec } from '@web/sim/engineClient.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
function preset(id: string): Preset {
  return JSON.parse(readFileSync(resolve(dataDir, `presets/${id}.json`), 'utf8')) as Preset;
}

describe('warmupTargetSec', () => {
  it('lands on the busiest point of the spawn curve, for every starter preset', () => {
    for (const id of ['morning', 'afternoon', 'night']) {
      const p = preset(id);
      const target = warmupTargetSec(p);
      const rateAtTarget = spawnRateAt(p.spawnRate, target);
      const peakRate = Math.max(...p.spawnRate.curve.map(([, rate]) => rate));
      expect(rateAtTarget, id).toBeCloseTo(peakRate, 6);
      // ...and it is a real fast-forward, not the old 10-second no-op.
      expect(target, id).toBeGreaterThan(p.warmup.realSeconds * p.warmup.playbackSpeed);
      expect(target, id).toBeLessThanOrEqual(p.durationSec);
    }
  });

  it('is a pure function of the preset, so two runs of one preset start identically', () => {
    const p = preset('morning');
    expect(warmupTargetSec(p)).toBe(warmupTargetSec(p));
  });

  it('prefers an explicit override (re-run after an edit resumes the same moment of the day)', () => {
    const p = preset('morning');
    expect(warmupTargetSec(p, 432)).toBe(432);
  });

  it('ignores a non-positive override and falls back to the curve peak', () => {
    const p = preset('morning');
    expect(warmupTargetSec(p, 0)).toBe(warmupTargetSec(p));
    expect(warmupTargetSec(p, -5)).toBe(warmupTargetSec(p));
  });

  it('falls back to the wall-clock warm-up when the curve peaks at t=0 or is empty', () => {
    const base = preset('morning');
    const flat: Preset = { ...base, spawnRate: { ...base.spawnRate, curve: [[0, 30], [600, 10]] } };
    expect(warmupTargetSec(flat)).toBe(base.warmup.realSeconds * base.warmup.playbackSpeed);

    const empty: Preset = { ...base, spawnRate: { ...base.spawnRate, curve: [] } };
    expect(warmupTargetSec(empty)).toBe(base.warmup.realSeconds * base.warmup.playbackSpeed);
  });

  it('never overshoots the preset duration', () => {
    const base = preset('morning');
    const late: Preset = { ...base, durationSec: 120, spawnRate: { ...base.spawnRate, curve: [[0, 5], [900, 60]] } };
    expect(warmupTargetSec(late)).toBe(120);
  });
});
