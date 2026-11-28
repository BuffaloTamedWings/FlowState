/**
 * The theme is the single source of every visual number (plan step 11), and
 * Dev tunes it live. These tests guard the two things that would quietly break
 * that: a value a view reads going missing (the view would render `undefined`
 * as black or NaN), and the change notification not firing (a slider that does
 * nothing).
 */

import { describe, expect, it } from 'vitest';

import { speedRatioColor } from '@web/render/heatmap.js';
import {
  clearThemeListeners,
  hexToRGB,
  idJitter,
  lightingMode,
  notifyThemeChanged,
  resolveLightingName,
  subscribeTheme,
  theme,
  themeToSource,
} from '@web/render/theme.js';

/** Every key path the renderer actually reads, as `section.key`. */
const REQUIRED: Record<string, string[]> = {
  roads: [
    'carColor',
    'bikeColor',
    'transitColor',
    'nodeFillColor',
    'connectorColor',
    'connectorWidth',
    'edgeLineColor',
    'dividerLineColor',
    'centerlineColor',
    'highlightEmissiveColor',
    'highlightIntensity',
  ],
  cars: [
    'bodyColor',
    'brakeColor',
    'height',
    'headlightRadius',
    'headlightStretch',
    'headlightForwardOffset',
    'headlightColor',
    'headlightOpacity',
    'taillightRadius',
    'taillightStretch',
    'taillightBackwardOffset',
    'taillightColor',
    'taillightOpacity',
    'lampSideOffset',
    'lampHeight',
  ],
  scenery: [
    'officeColor',
    'residentialColor',
    'retailColor',
    'otherColor',
    'buildingJitter',
    'estimatedDim',
    'parkColor',
    'freewayColor',
    'groundColor',
    'trenchBankColor',
    'trenchFloorMargin',
    'trenchBankWidth',
    'trenchFloorDrop',
    'groundPadding',
    'rampFloorMargin',
    'groundGridStep',
    'gridVisible',
    'gridMajorColor',
    'gridMinorColor',
  ],
  heatmap: ['red', 'yellow', 'green', 'yellowAt', 'greenAt'],
  shadows: ['enabled', 'mapSize', 'bias', 'normalBias', 'padding'],
};

const LIGHTING_KEYS = [
  'sunColor',
  'sunIntensity',
  'sunElevationDeg',
  'sunAzimuthDeg',
  'sunDistance',
  'ambientColor',
  'ambientIntensity',
  'backgroundColor',
  'fogEnabled',
  'fogColor',
  'fogNear',
  'fogFar',
  'headlights',
  'shadows',
];

describe('theme completeness', () => {
  it('has every value the views read', () => {
    for (const [section, keys] of Object.entries(REQUIRED)) {
      const bag = (theme as unknown as Record<string, Record<string, unknown>>)[section];
      expect(bag, section).toBeDefined();
      for (const key of keys) {
        expect(bag![key], `${section}.${key}`).toBeDefined();
      }
    }
  });

  it('has all three lighting modes, each complete', () => {
    expect(Object.keys(theme.lighting).sort()).toEqual(['afternoon', 'morning', 'night']);
    for (const [name, mode] of Object.entries(theme.lighting)) {
      const bag = mode as unknown as Record<string, unknown>;
      for (const key of LIGHTING_KEYS) {
        expect(bag[key], `${name}.${key}`).toBeDefined();
      }
    }
  });

  it('is self-consistent: every *Color is a valid 24-bit integer, every size is a finite number', () => {
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const here = `${path}.${key}`;
        if (key.endsWith('Color')) {
          expect(typeof v, here).toBe('number');
          const hex = v as number;
          expect(Number.isInteger(hex), here).toBe(true);
          expect(hex, here).toBeGreaterThanOrEqual(0);
          expect(hex, here).toBeLessThanOrEqual(0xffffff);
        } else if (typeof v === 'number') {
          expect(Number.isFinite(v), here).toBe(true);
        } else {
          walk(v, here);
        }
      }
    };
    walk(theme, 'theme');
  });

  it('keeps the heatmap stops in 0-1 and in ascending order', () => {
    for (const stop of [theme.heatmap.red, theme.heatmap.yellow, theme.heatmap.green]) {
      for (const channel of [stop.r, stop.g, stop.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    expect(theme.heatmap.yellowAt).toBeLessThan(theme.heatmap.greenAt);
  });
});

describe('theme change notification', () => {
  it('fires subscribers, reports structural-ness, and unsubscribes cleanly', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeTheme((change) => seen.push(change.structural));

    notifyThemeChanged();
    notifyThemeChanged({ structural: true });
    expect(seen).toEqual([false, true]);

    unsubscribe();
    notifyThemeChanged();
    expect(seen).toEqual([false, true]);
  });

  it('survives a subscriber added during a notification', () => {
    let inner = 0;
    const unsubscribe = subscribeTheme(() => {
      subscribeTheme(() => {
        inner++;
      });
    });
    expect(() => notifyThemeChanged()).not.toThrow();
    unsubscribe();
    clearThemeListeners();
    notifyThemeChanged();
    expect(inner).toBe(0); // the inner listener was cleared, not left dangling
  });
});

describe('theme helpers', () => {
  it('maps hex to 0-1 channels', () => {
    expect(hexToRGB(0xffffff)).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRGB(0x000000)).toEqual({ r: 0, g: 0, b: 0 });
    const half = hexToRGB(0x804020);
    expect(half.r).toBeCloseTo(128 / 255, 6);
    expect(half.g).toBeCloseTo(64 / 255, 6);
    expect(half.b).toBeCloseTo(32 / 255, 6);
  });

  it('resolves lighting names, falling back to morning for anything unknown', () => {
    expect(resolveLightingName('night')).toBe('night');
    expect(resolveLightingName('afternoon')).toBe('afternoon');
    expect(resolveLightingName('dusk')).toBe('morning');
    expect(resolveLightingName(null)).toBe('morning');
    expect(resolveLightingName(undefined)).toBe('morning');
    expect(lightingMode('nonsense')).toBe(theme.lighting.morning);
  });

  it('hashes ids into a stable [-1, 1] jitter', () => {
    expect(idJitter('bld-1')).toBe(idJitter('bld-1'));
    expect(idJitter('bld-1')).not.toBe(idJitter('bld-2'));
    for (const id of ['', 'a', 'bld-1', 'way/12345678', 'a much longer identifier']) {
      const value = idJitter(id);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('serialises back to pasteable source with hex colours', () => {
    const source = themeToSource();
    expect(source.startsWith('{')).toBe(true);
    expect(source).toContain('carColor: 0x');
    expect(source).toContain('buildingJitter:');
    expect(source).toContain('headlights:');
    // Colours print as 6 hex digits, not as decimals.
    expect(source).not.toMatch(/Color: \d+,/);
  });
});

describe('the heatmap reads its stops from the theme', () => {
  it('tracks an edited stop colour and threshold', () => {
    const original = { ...theme.heatmap.green };
    const originalAt = theme.heatmap.greenAt;
    try {
      theme.heatmap.green = { r: 0, g: 1, b: 0 };
      theme.heatmap.greenAt = 0.9;
      expect(speedRatioColor(1)).toEqual({ r: 0, g: 1, b: 0 });
      // 0.7 is no longer the free-flow stop, so it must blend rather than
      // return the green stop outright.
      expect(speedRatioColor(0.7)).not.toEqual({ r: 0, g: 1, b: 0 });
    } finally {
      theme.heatmap.green = original;
      theme.heatmap.greenAt = originalAt;
    }
    expect(speedRatioColor(1)).toEqual(original);
  });
});
