import { describe, expect, it } from 'vitest';
import { DEFAULT_RING, runRing } from '../src/ring.js';

describe('ring road (S1)', () => {
  const result = runRing();
  const { slowdown, cars } = DEFAULT_RING;

  it('never lets two cars overlap', () => {
    expect(result.minGap).toBeGreaterThan(0);
  });

  it('is calm before the slow car brakes', () => {
    const before = result.samples.filter((s) => s.t < slowdown.fromSec);
    for (const s of before) for (const v of s.speed) expect(v).toBeGreaterThan(5);
  });

  it('turns one slow car into a stop-and-go wave that travels backward', () => {
    // Long after the slow car has recovered, cars far behind it must still come to a near stop.
    const late = result.samples.filter((s) => s.t > slowdown.toSec + 60);
    const farBehind = Array.from({ length: cars }, (_, i) => i).filter(
      (i) => i !== slowdown.car && (slowdown.car - i + cars) % cars >= 10,
    );
    const stoppedFarCars = farBehind.filter((i) => late.some((s) => s.speed[i]! < 2));
    expect(stoppedFarCars.length).toBeGreaterThan(5);
  });

  it('is deterministic', () => {
    const again = runRing();
    const a = result.samples.at(-1)!;
    const b = again.samples.at(-1)!;
    expect(Array.from(b.pos)).toEqual(Array.from(a.pos));
    expect(Array.from(b.speed)).toEqual(Array.from(a.speed));
  });
});
