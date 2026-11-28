import { describe, expect, it } from 'vitest';

import { formatSimClock } from '@web/ui/clock.js';

describe('formatSimClock', () => {
  it('formats zero as 00:00', () => {
    expect(formatSimClock(0)).toBe('00:00');
  });

  it('formats a sub-minute value as mm:ss', () => {
    expect(formatSimClock(5)).toBe('00:05');
    expect(formatSimClock(59)).toBe('00:59');
  });

  it('formats exactly a minute as 01:00', () => {
    expect(formatSimClock(60)).toBe('01:00');
  });

  it('formats a few minutes as mm:ss', () => {
    expect(formatSimClock(125)).toBe('02:05');
  });

  it('formats exactly an hour as h:mm:ss, not 60:00', () => {
    expect(formatSimClock(3600)).toBe('1:00:00');
  });

  it('formats past an hour as h:mm:ss', () => {
    expect(formatSimClock(3661)).toBe('1:01:01');
  });

  it('formats several hours', () => {
    expect(formatSimClock(2 * 3600 + 3 * 60 + 4)).toBe('2:03:04');
  });

  it('floors fractional seconds rather than rounding', () => {
    expect(formatSimClock(59.9)).toBe('00:59');
    expect(formatSimClock(60 - 1e-9)).toBe('00:59');
  });

  it('clamps negative or non-finite input to zero', () => {
    expect(formatSimClock(-5)).toBe('00:00');
    expect(formatSimClock(Number.NaN)).toBe('00:00');
    expect(formatSimClock(Number.POSITIVE_INFINITY)).toBe('00:00');
  });
});
