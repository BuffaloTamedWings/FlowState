import { describe, expect, it } from 'vitest';

import { speedRatioColor } from '@web/render/heatmap.js';

describe('speedRatioColor', () => {
  it('maps the red stop at ratio 0', () => {
    const color = speedRatioColor(0);
    expect(color).toEqual({ r: 0.82, g: 0.24, b: 0.24 });
  });

  it('maps the yellow stop at ratio 0.4 (the low edge of "yellow")', () => {
    const color = speedRatioColor(0.4);
    expect(color).toEqual({ r: 0.86, g: 0.7, b: 0.27 });
  });

  it('maps the green stop at ratio 0.7 (the low edge of "green")', () => {
    const color = speedRatioColor(0.7);
    expect(color).toEqual({ r: 0.24, g: 0.66, b: 0.45 });
  });

  it('stays green above 0.7, including at 1', () => {
    expect(speedRatioColor(0.85)).toEqual({ r: 0.24, g: 0.66, b: 0.45 });
    expect(speedRatioColor(1)).toEqual({ r: 0.24, g: 0.66, b: 0.45 });
  });

  it('blends smoothly between red and yellow -- 0.2 is distinct from both stops', () => {
    const red = speedRatioColor(0)!;
    const yellow = speedRatioColor(0.4)!;
    const mid = speedRatioColor(0.2)!;
    expect(mid).not.toEqual(red);
    expect(mid).not.toEqual(yellow);
    // Halfway between the stops, each channel sits halfway between the two colors.
    expect(mid.r).toBeCloseTo((red.r + yellow.r) / 2, 6);
    expect(mid.g).toBeCloseTo((red.g + yellow.g) / 2, 6);
    expect(mid.b).toBeCloseTo((red.b + yellow.b) / 2, 6);
  });

  it('blends smoothly between yellow and green -- 0.55 is distinct from both stops', () => {
    const yellow = speedRatioColor(0.4)!;
    const green = speedRatioColor(0.7)!;
    const mid = speedRatioColor(0.55)!;
    expect(mid).not.toEqual(yellow);
    expect(mid).not.toEqual(green);
    expect(mid.r).toBeCloseTo((yellow.r + green.r) / 2, 6);
    expect(mid.g).toBeCloseTo((yellow.g + green.g) / 2, 6);
    expect(mid.b).toBeCloseTo((yellow.b + green.b) / 2, 6);
  });

  it('clamps ratios below 0 to the red stop', () => {
    expect(speedRatioColor(-0.5)).toEqual(speedRatioColor(0));
  });

  it('clamps ratios above 1 to the same color as ratio 1', () => {
    expect(speedRatioColor(1.5)).toEqual(speedRatioColor(1));
  });

  it('treats no data (null/undefined) as distinct from ratio 0 (stopped traffic)', () => {
    expect(speedRatioColor(null)).toBeNull();
    expect(speedRatioColor(undefined)).toBeNull();
    expect(speedRatioColor(0)).not.toBeNull();
  });

  it('treats NaN as no data rather than throwing or producing a NaN color', () => {
    expect(speedRatioColor(Number.NaN)).toBeNull();
  });

  it('is deterministic -- same input, same output, every time', () => {
    const a = speedRatioColor(0.55);
    const b = speedRatioColor(0.55);
    expect(a).toEqual(b);
    for (let i = 0; i < 5; i++) {
      expect(speedRatioColor(0.55)).toEqual(a);
    }
  });

  it('never returns a NaN channel across the full range', () => {
    for (let r = -0.2; r <= 1.2; r += 0.05) {
      const color = speedRatioColor(r);
      expect(color).not.toBeNull();
      expect(Number.isNaN(color!.r)).toBe(false);
      expect(Number.isNaN(color!.g)).toBe(false);
      expect(Number.isNaN(color!.b)).toBe(false);
    }
  });
});
