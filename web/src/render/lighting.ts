/**
 * The three times of day (plan step 11).
 *
 * `preset.lighting` ('morning' | 'afternoon' | 'night') was dead data until
 * now: all three presets rendered under the same flat white rig, which made the
 * demo's whole "pick a time of day" framing invisible. This module turns that
 * string into a sun direction/colour/intensity, an ambient fill, a scene
 * background and a fog band, all read from `theme.lighting[mode]`.
 *
 * It is a *look* change, not a sim change: `main.ts` applies it the moment the
 * preset picker changes, without waiting for a Run.
 *
 * Reusing one `DirectionalLight` and one `AmbientLight` for every mode (rather
 * than swapping rigs) keeps Three's material shader programs stable — changing
 * the *number* of lights in a scene forces a shader recompile and a visible
 * hitch on every material.
 */

import { AmbientLight, Color, DirectionalLight, Fog, PCFSoftShadowMap, type Scene, type WebGLRenderer } from 'three';

import type { Bounds } from '@shared/common.js';

import { toThree } from './coords.js';
import { lightingMode, resolveLightingName, theme, type LightingModeTheme } from './theme.js';

export interface LightingRig {
  sun: DirectionalLight;
  ambient: AmbientLight;
  /** The mode name currently applied. */
  mode: 'morning' | 'afternoon' | 'night';
  /** True when the applied mode wants the fake car headlights on. */
  headlights: boolean;
}

/** Creates the rig and adds both lights to the scene. Apply a mode afterwards. */
export function createLightingRig(scene: Scene): LightingRig {
  const ambient = new AmbientLight(0xffffff, 1);
  ambient.name = 'ambient';
  const sun = new DirectionalLight(0xffffff, 1);
  sun.name = 'sun';
  scene.add(ambient, sun);
  const rig: LightingRig = { sun, ambient, mode: 'morning', headlights: false };
  applyLighting(scene, rig, 'morning');
  return rig;
}

/**
 * Sun position from `(elevation, azimuth)` in local meters, where azimuth is
 * degrees clockwise from north (0 = north, 90 = east, 180 = south) and
 * elevation is degrees above the horizon. The light is *directional*, so only
 * the direction from the origin matters; `sunDistance` just parks it far enough
 * out to look like a sky light.
 */
export function sunPosition(mode: LightingModeTheme): { x: number; y: number; z: number } {
  const azimuth = (mode.sunAzimuthDeg * Math.PI) / 180;
  const elevation = (mode.sunElevationDeg * Math.PI) / 180;
  const horizontal = Math.cos(elevation) * mode.sunDistance;
  return {
    x: horizontal * Math.sin(azimuth),
    y: horizontal * Math.cos(azimuth),
    z: Math.sin(elevation) * mode.sunDistance,
  };
}

/**
 * Applies a time of day to the scene and rig. `mode` comes straight from
 * `preset.lighting`; anything unrecognised (an older preset, a typo, a future
 * value) falls back to morning rather than throwing — a wrong-looking scene is
 * always better than a dead one mid-demo.
 */
export function applyLighting(scene: Scene, rig: LightingRig, mode: string | null | undefined): LightingRig {
  const name = resolveLightingName(mode);
  const settings = lightingMode(name);

  rig.sun.color.setHex(settings.sunColor);
  rig.sun.intensity = settings.sunIntensity;
  const pos = sunPosition(settings);
  rig.sun.position.copy(toThree(pos.x, pos.y, pos.z));
  rig.sun.target.position.set(0, 0, 0);

  // Shadows: configured here, aimed by `configureShadowCamera` once the
  // scenario's bounds are known. Night casts none -- there is no sun to cast
  // them, and the map would only get muddier.
  rig.sun.castShadow = theme.shadows.enabled && settings.shadows;
  rig.sun.shadow.mapSize.set(theme.shadows.mapSize, theme.shadows.mapSize);
  rig.sun.shadow.bias = theme.shadows.bias;
  rig.sun.shadow.normalBias = theme.shadows.normalBias;
  rig.sun.shadow.needsUpdate = true;

  rig.ambient.color.setHex(settings.ambientColor);
  rig.ambient.intensity = settings.ambientIntensity;

  const background = scene.background;
  if (background instanceof Color) background.setHex(settings.backgroundColor);
  else scene.background = new Color(settings.backgroundColor);

  if (settings.fogEnabled) {
    const fog = scene.fog;
    if (fog instanceof Fog) {
      fog.color.setHex(settings.fogColor);
      fog.near = settings.fogNear;
      fog.far = settings.fogFar;
    } else {
      scene.fog = new Fog(settings.fogColor, settings.fogNear, settings.fogFar);
    }
  } else {
    scene.fog = null;
  }

  rig.mode = name;
  rig.headlights = settings.headlights;
  return rig;
}

/**
 * Turns on shadow mapping. Call once, on the renderer, before the first frame.
 */
export function enableShadows(renderer: WebGLRenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
}

/**
 * Sizes the sun's orthographic shadow camera to cover the scenario. The light's
 * target is the local origin, so the camera has to reach the furthest bounds
 * corner from there, plus `theme.shadows.padding` for the buildings' own
 * shadows falling outside the road network.
 */
export function configureShadowCamera(rig: LightingRig, bounds: Bounds): void {
  const corners: Array<[number, number]> = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.minX, bounds.maxY],
    [bounds.maxX, bounds.maxY],
  ];
  let reach = 1;
  for (const [x, y] of corners) reach = Math.max(reach, Math.hypot(x, y));
  const half = reach + Math.max(0, theme.shadows.padding);

  const cam = rig.sun.shadow.camera;
  cam.left = -half;
  cam.right = half;
  cam.top = half;
  cam.bottom = -half;
  cam.near = 1;
  // The light sits `sunDistance` out; it has to see past the scene behind it.
  cam.far = Math.max(1000, half * 2 + lightingMode(rig.mode).sunDistance * 2);
  cam.updateProjectionMatrix();
  rig.sun.shadow.needsUpdate = true;
}

/** Re-applies the rig's current mode. Call after a theme edit so lighting sliders take effect live. */
export function refreshLighting(scene: Scene, rig: LightingRig): LightingRig {
  return applyLighting(scene, rig, rig.mode);
}

/** The lighting block names, in demo order. Handy for the tuning panel. */
export const LIGHTING_MODE_NAMES = Object.keys(theme.lighting) as Array<'morning' | 'afternoon' | 'night'>;
