import { describe, expect, it } from 'vitest';
import { DEFAULT_IDM, equilibriumSpeed, idmAccel, integrate } from '../src/idm.js';

const V0 = 13.41;

describe('idmAccel', () => {
  it('accelerates at max rate from rest on a free road', () => {
    expect(idmAccel(0, V0, Infinity, 0)).toBeCloseTo(DEFAULT_IDM.maxAccel, 6);
  });

  it('stops accelerating at the desired speed on a free road', () => {
    expect(idmAccel(V0, V0, Infinity, 0)).toBeCloseTo(0, 6);
  });

  it('is ~0 at the equilibrium gap behind an equal-speed leader', () => {
    const gap = 30;
    const v = equilibriumSpeed(gap, V0);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(V0);
    expect(Math.abs(idmAccel(v, V0, gap, v))).toBeLessThan(1e-6);
  });

  it('brakes hard when closing fast on a stopped car (a stop line)', () => {
    expect(idmAccel(V0, V0, 20, 0)).toBeLessThan(-DEFAULT_IDM.comfortDecel);
  });

  it('stays still when already at the minimum gap behind a stopped car', () => {
    expect(idmAccel(0, V0, DEFAULT_IDM.minGap, 0)).toBeLessThanOrEqual(0);
  });
});

describe('integrate', () => {
  it('never produces negative speed or backward motion', () => {
    const { v, ds } = integrate(0.5, -8, 0.1);
    expect(v).toBe(0);
    expect(ds).toBeGreaterThanOrEqual(0);
    expect(ds).toBeLessThanOrEqual(0.5 * 0.1);
  });

  it('matches constant-acceleration kinematics', () => {
    const { v, ds } = integrate(10, 1, 0.1);
    expect(v).toBeCloseTo(10.1, 9);
    expect(ds).toBeCloseTo(1.005, 9);
  });
});
