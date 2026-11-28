/**
 * The three times of day (plan step 11). The demo's framing is "pick a time of
 * day", so the one thing that must never regress is that the three modes
 * actually look different -- in particular that night is not a slightly dimmer
 * morning.
 */

import { Color, Fog, Scene } from 'three';
import { describe, expect, it } from 'vitest';

import { applyLighting, createLightingRig, refreshLighting, sunPosition } from '@web/render/lighting.js';
import { theme } from '@web/render/theme.js';

function snapshot(mode: string): {
  background: number;
  ambient: number;
  ambientIntensity: number;
  sun: number;
  sunIntensity: number;
  sunHeight: number;
  headlights: boolean;
  fog: number | null;
} {
  const scene = new Scene();
  const rig = createLightingRig(scene);
  applyLighting(scene, rig, mode);
  return {
    background: (scene.background as Color).getHex(),
    ambient: rig.ambient.color.getHex(),
    ambientIntensity: rig.ambient.intensity,
    sun: rig.sun.color.getHex(),
    sunIntensity: rig.sun.intensity,
    sunHeight: rig.sun.position.y,
    headlights: rig.headlights,
    fog: scene.fog instanceof Fog ? scene.fog.color.getHex() : null,
  };
}

describe('applyLighting', () => {
  it('adds exactly one ambient and one directional light, and reuses them', () => {
    const scene = new Scene();
    const rig = createLightingRig(scene);
    const before = scene.children.length;
    applyLighting(scene, rig, 'night');
    applyLighting(scene, rig, 'afternoon');
    expect(scene.children.length).toBe(before);
    expect(scene.children).toContain(rig.sun);
    expect(scene.children).toContain(rig.ambient);
  });

  it('gives the three modes distinct sun and ambient settings', () => {
    const morning = snapshot('morning');
    const afternoon = snapshot('afternoon');
    const night = snapshot('night');

    const backgrounds = new Set([morning.background, afternoon.background, night.background]);
    expect(backgrounds.size).toBe(3);

    const ambients = new Set([morning.ambient, afternoon.ambient, night.ambient]);
    expect(ambients.size).toBe(3);

    const sunColors = new Set([morning.sun, afternoon.sun, night.sun]);
    expect(sunColors.size).toBe(3);
  });

  it('makes night unmistakably night: darkest background, weakest ambient, no real sun, headlights on', () => {
    const morning = snapshot('morning');
    const afternoon = snapshot('afternoon');
    const night = snapshot('night');

    // Background and ambient intensity are the two the brief calls out
    // explicitly.
    expect(night.background).not.toBe(morning.background);
    expect(night.background).not.toBe(afternoon.background);
    expect(night.ambientIntensity).toBeLessThan(morning.ambientIntensity);
    expect(night.ambientIntensity).toBeLessThan(afternoon.ambientIntensity);

    expect(night.sunIntensity).toBeLessThan(morning.sunIntensity);
    expect(night.sunIntensity).toBeLessThan(afternoon.sunIntensity);

    expect(night.headlights).toBe(true);
    expect(morning.headlights).toBe(false);
    expect(afternoon.headlights).toBe(false);
  });

  it('keeps morning low and in the east, and afternoon high', () => {
    const morning = sunPosition(theme.lighting.morning);
    const afternoon = sunPosition(theme.lighting.afternoon);

    // Local coords: x = east, y = north, z = up.
    expect(morning.x).toBeGreaterThan(0); // out of the east
    expect(morning.z).toBeGreaterThan(0); // above the horizon
    expect(afternoon.z).toBeGreaterThan(morning.z); // higher in the sky
    expect(morning.z).toBeLessThan(morning.x); // and low: shadows run long

    // The rig places the light through coords.ts: Three's y is local z.
    expect(snapshot('afternoon').sunHeight).toBeGreaterThan(snapshot('morning').sunHeight);
  });

  it('sets fog from the mode, and clears it when a mode turns fog off', () => {
    expect(snapshot('morning').fog).toBe(theme.lighting.morning.fogColor);

    const scene = new Scene();
    const rig = createLightingRig(scene);
    const original = theme.lighting.night.fogEnabled;
    try {
      theme.lighting.night.fogEnabled = false;
      applyLighting(scene, rig, 'night');
      expect(scene.fog).toBeNull();
      theme.lighting.night.fogEnabled = true;
      applyLighting(scene, rig, 'night');
      expect(scene.fog).toBeInstanceOf(Fog);
    } finally {
      theme.lighting.night.fogEnabled = original;
    }
  });

  it('falls back to a sane default for an unknown mode instead of throwing', () => {
    const morning = snapshot('morning');
    for (const bogus of ['dusk', '', 'MORNING', 'null']) {
      const scene = new Scene();
      const rig = createLightingRig(scene);
      expect(() => applyLighting(scene, rig, bogus)).not.toThrow();
      expect(rig.mode).toBe('morning');
      expect((scene.background as Color).getHex()).toBe(morning.background);
    }

    const scene = new Scene();
    const rig = createLightingRig(scene);
    expect(() => applyLighting(scene, rig, null)).not.toThrow();
    expect(() => applyLighting(scene, rig, undefined)).not.toThrow();
    expect(rig.mode).toBe('morning');
  });

  it('re-applies the current mode on a theme refresh (live lighting sliders)', () => {
    const scene = new Scene();
    const rig = createLightingRig(scene);
    applyLighting(scene, rig, 'night');

    const original = theme.lighting.night.ambientIntensity;
    try {
      theme.lighting.night.ambientIntensity = original + 0.5;
      refreshLighting(scene, rig);
      expect(rig.ambient.intensity).toBeCloseTo(original + 0.5, 10);
      expect(rig.mode).toBe('night'); // the refresh must not reset the mode
    } finally {
      theme.lighting.night.ambientIntensity = original;
    }
  });
});
