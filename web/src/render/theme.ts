/**
 * The single source of every visual number in the renderer (plan step 11).
 *
 * Nothing else in `render/` may hold a colour, a size or a lighting value as a
 * literal: materials, scenery, the ground, the heatmap and the lighting rig all
 * read from the mutable `theme` object below, and `web/src/ui/tuningPanel.ts`
 * binds a `lil-gui` panel straight to it so every one of these numbers can be
 * dragged live in the browser. Dev tunes the look there, hits "Copy theme
 * source", and pastes the result back in here as the new defaults.
 *
 * Conventions this file relies on:
 *
 * - **Every colour property name ends in `Color`** and holds a `0xRRGGBB`
 *   integer. `themeToSource()` and the tuning panel both key off that suffix
 *   (hex formatting / colour pickers), so a new colour that breaks the naming
 *   convention silently shows up as a plain number slider.
 * - The heatmap stops are the one exception: they stay as `{ r, g, b }` in
 *   0-1, because `heatmap.ts`'s public `speedRatioColor` returns that shape.
 * - Sizes are meters, angles are degrees (converted where used), intensities
 *   are Three.js light intensities.
 *
 * No Three.js import here on purpose — plain data, so `heatmap.ts` (and any
 * future pure module) can read the theme without pulling in the renderer.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** 0-1 channel values, matching `THREE.Color.setRGB` / `heatmap.ts`'s `RGB`. */
export interface ThemeRGB {
  r: number;
  g: number;
  b: number;
}

export interface RoadTheme {
  /** Lane surfaces, by `Lane['type']`. */
  carColor: number;
  bikeColor: number;
  transitColor: number;
  /** Intersection fill polygon. */
  nodeFillColor: number;
  /** Connector (turn) ribbons inside an intersection. */
  connectorColor: number;
  /** Width of a connector ribbon, meters. */
  connectorWidth: number;
  /** Lane boundary lines. */
  edgeLineColor: number;
  dividerLineColor: number;
  centerlineColor: number;
  /** Selection highlight (`web/src/ui/highlight.ts`). */
  highlightEmissiveColor: number;
  highlightIntensity: number;
}

export interface CarTheme {
  bodyColor: number;
  brakeColor: number;
  /** Placeholder box height, meters. */
  height: number;

  // --- Night headlights (`render/headlights.ts`) -------------------------
  /** Radius of one headlight glow pool on the road, meters. */
  headlightRadius: number;
  /** Forward stretch multiplier on that pool (1 = circular). */
  headlightStretch: number;
  /** How far ahead of the car's nose the pool's centre sits, meters. */
  headlightForwardOffset: number;
  headlightColor: number;
  headlightOpacity: number;

  taillightRadius: number;
  taillightStretch: number;
  /** How far behind the car's tail the pool's centre sits, meters. */
  taillightBackwardOffset: number;
  taillightColor: number;
  taillightOpacity: number;

  /** Lateral offset of each lamp of a pair from the car's centreline, meters. */
  lampSideOffset: number;
  /** Height of the glow pools above the road surface, meters. */
  lampHeight: number;
}

export interface SceneryTheme {
  // Buildings, tinted by `Building.use`.
  officeColor: number;
  residentialColor: number;
  retailColor: number;
  otherColor: number;
  /**
   * Per-building brightness jitter, +/- this fraction, derived deterministically
   * from the building's `id` (never `Math.random()`). 0 = one flat mass.
   */
  buildingJitter: number;
  /** Brightness multiplier applied to buildings whose height is a guess (`estimated.height`). */
  estimatedDim: number;

  parkColor: number;
  freewayColor: number;
  groundColor: number;
  /** Sloped bank between ground level and the freeway trench floor. */
  trenchBankColor: number;

  /**
   * Extra flat trench floor on each side of the freeway surface, meters. This
   * is what the ramp ends land on: `eROff`/`eROn` meet the freeway at its `z`
   * but a little to the side of it, so a floor exactly as wide as the mainline
   * would leave their tips poking into the bank slope.
   */
  trenchFloorMargin: number;
  /** Horizontal width of each bank of the freeway cut, meters. */
  trenchBankWidth: number;
  /** How far below the freeway surface the trench floor sits, meters. */
  trenchFloorDrop: number;
  /** Extra ground beyond the scenario bounds / freeway extents, meters. */
  groundPadding: number;

  /**
   * Extra flat floor on each side of a sunken edge (ramp) that isn't a
   * `scenery.freeway`, meters, added to its selected option's total lane
   * width. Smaller than `trenchFloorMargin` because a ramp corridor only has
   * to clear its own lanes, not someone else's ramp tips.
   */
  rampFloorMargin: number;
  /**
   * Grid step of the ground heightfield, meters. The ground (and its cuts)
   * is one continuous displaced mesh rather than a flat plane with holes, so
   * this is the resolution at which the trench floor and banks are sampled;
   * smaller is smoother but more triangles.
   */
  groundGridStep: number;

  gridVisible: boolean;
  gridMajorColor: number;
  gridMinorColor: number;
}

/** One time-of-day lighting block. `preset.lighting` picks which one applies. */
export interface LightingModeTheme {
  sunColor: number;
  sunIntensity: number;
  /** Degrees above the horizon. */
  sunElevationDeg: number;
  /** Degrees clockwise from north (0 = north, 90 = east, 180 = south). */
  sunAzimuthDeg: number;
  /** How far out the directional light is parked, meters (direction is what matters). */
  sunDistance: number;

  ambientColor: number;
  ambientIntensity: number;

  backgroundColor: number;
  fogEnabled: boolean;
  fogColor: number;
  /** Meters from the camera where fog starts / reaches full strength. */
  fogNear: number;
  fogFar: number;

  /** Night: draw the fake headlight/taillight glows. */
  headlights: boolean;
  /** Whether the sun casts shadows in this mode (pointless at night). */
  shadows: boolean;
}

/**
 * Shadow-map settings, shared by every mode that casts shadows. Separate from
 * the per-mode blocks because the map size and the depth biases are a
 * performance/artifact tradeoff, not a look choice.
 */
export interface ShadowTheme {
  /** Master switch. Turn this off first if shadows look wrong or cost too much. */
  enabled: boolean;
  /** Shadow map resolution per side; powers of two only. */
  mapSize: number;
  bias: number;
  normalBias: number;
  /** Extra meters of scene the shadow camera covers beyond the scenario bounds. */
  padding: number;
}

export interface HeatmapTheme {
  /** Colour at speedRatio 0 (stopped dead). */
  red: ThemeRGB;
  /** Colour at `yellowAt`. */
  yellow: ThemeRGB;
  /** Colour at `greenAt` and above. */
  green: ThemeRGB;
  yellowAt: number;
  greenAt: number;
}

export interface Theme {
  roads: RoadTheme;
  cars: CarTheme;
  scenery: SceneryTheme;
  lighting: {
    morning: LightingModeTheme;
    afternoon: LightingModeTheme;
    night: LightingModeTheme;
  };
  heatmap: HeatmapTheme;
  shadows: ShadowTheme;
}

// ---------------------------------------------------------------------------
// The defaults
// ---------------------------------------------------------------------------

/**
 * Mutable on purpose: the tuning panel writes straight into it and then calls
 * `notifyThemeChanged()`. Read it at use time, never copy a value out at module
 * load (a captured copy stops tracking the panel).
 */
export const theme: Theme = {
  roads: {
    carColor: 0x3b424a,
    bikeColor: 0x2f6b4f,
    transitColor: 0x7a3b3b,
    nodeFillColor: 0x343a41,
    connectorColor: 0x434a53,
    connectorWidth: 3.5,
    edgeLineColor: 0xd9dee3,
    dividerLineColor: 0x9aa4ad,
    centerlineColor: 0xd8b24a,
    highlightEmissiveColor: 0x3a6cff,
    highlightIntensity: 0.55,
  },

  cars: {
    bodyColor: 0x8a93a0,
    brakeColor: 0xd04040,
    height: 1.5,

    headlightRadius: 2.2,
    headlightStretch: 2.6,
    headlightForwardOffset: 2.4,
    headlightColor: 0xfff0c0,
    headlightOpacity: 0.55,

    taillightRadius: 1.1,
    taillightStretch: 1.2,
    taillightBackwardOffset: 1.0,
    taillightColor: 0xff2a14,
    taillightOpacity: 0.4,

    lampSideOffset: 0.6,
    lampHeight: 0.12,
  },

  scenery: {
    officeColor: 0x4a5560,
    residentialColor: 0x5c5147,
    retailColor: 0x565063,
    otherColor: 0x4e5257,
    buildingJitter: 0.14,
    estimatedDim: 0.86,

    parkColor: 0x2c4c33,
    freewayColor: 0x30363d,
    groundColor: 0x2a3138,
    trenchBankColor: 0x242a30,

    trenchFloorMargin: 8,
    trenchBankWidth: 14,
    trenchFloorDrop: 0.25,
    groundPadding: 220,
    rampFloorMargin: 2,
    groundGridStep: 5,

    gridVisible: true,
    gridMajorColor: 0x3c454e,
    gridMinorColor: 0x333b42,
  },

  lighting: {
    // Dev's brief (2026-11-28): keep it simple -- one sun that moves east ->
    // overhead -> west, tinted yellow / white / orange. No second light, no
    // per-mode rig; only these numbers change between the three times of day.
    //
    // Azimuth is degrees clockwise from north, so 90 = due east, 270 = due
    // west; elevation is degrees above the horizon (90 = straight overhead).

    // Sun low in the east, warm yellow.
    morning: {
      sunColor: 0xffd24a,
      sunIntensity: 2.0,
      sunElevationDeg: 22,
      sunAzimuthDeg: 90,
      sunDistance: 900,
      ambientColor: 0xbcd0e6,
      ambientIntensity: 0.85,
      backgroundColor: 0x33465c,
      fogEnabled: true,
      fogColor: 0x47618a,
      fogNear: 700,
      fogFar: 3000,
      headlights: false,
      shadows: true,
    },
    // Straight overhead, neutral white. The reference look.
    afternoon: {
      sunColor: 0xffffff,
      sunIntensity: 2.2,
      sunElevationDeg: 90,
      sunAzimuthDeg: 180,
      sunDistance: 900,
      ambientColor: 0xd4e2f0,
      ambientIntensity: 0.9,
      backgroundColor: 0x5a7a90,
      fogEnabled: true,
      fogColor: 0x7d94a8,
      fogNear: 800,
      fogFar: 3400,
      headlights: false,
      shadows: true,
    },
    // Sun low in the west, orange. This is *evening*, not midnight: Dev's note
    // is that "night" still has to be legible, so the sun stays on (dimmer and
    // orange) and ambient stays high enough to read the road surface, rather
    // than cutting to a near-black scene lit only by headlight sprites.
    night: {
      sunColor: 0xff7a2a,
      sunIntensity: 1.6,
      sunElevationDeg: 16,
      sunAzimuthDeg: 270,
      sunDistance: 900,
      ambientColor: 0x8a93b0,
      ambientIntensity: 0.6,
      backgroundColor: 0x2b2437,
      fogEnabled: true,
      fogColor: 0x4a3a46,
      fogNear: 700,
      fogFar: 3000,
      headlights: true,
      shadows: true,
    },
  },

  heatmap: {
    // Kept at the step 10 values exactly: `heatmap.test.ts` pins them.
    red: { r: 0.82, g: 0.24, b: 0.24 },
    yellow: { r: 0.86, g: 0.7, b: 0.27 },
    green: { r: 0.24, g: 0.66, b: 0.45 },
    yellowAt: 0.4,
    greenAt: 0.7,
  },

  shadows: {
    enabled: true,
    mapSize: 2048,
    bias: -0.0004,
    normalBias: 0.8,
    padding: 120,
  },
};

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

/**
 * `structural: true` means a number changed that is baked into geometry or
 * vertex data (building jitter, trench width, the grid) and can only take
 * effect by rebuilding the affected view. Plain colour/intensity changes come
 * through with `structural: false` and are handled by re-tinting materials,
 * which is cheap enough to run on every frame of a slider drag.
 */
export interface ThemeChange {
  structural: boolean;
}

export type ThemeListener = (change: ThemeChange) => void;

const listeners = new Set<ThemeListener>();

/** Subscribes to theme edits. Returns an unsubscribe function. */
export function subscribeTheme(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every subscriber the theme changed. The tuning panel calls this; so can tests. */
export function notifyThemeChanged(change: ThemeChange = { structural: false }): void {
  for (const listener of [...listeners]) listener(change);
}

/** Test/teardown helper: drops every subscription. */
export function clearThemeListeners(): void {
  listeners.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `0xRRGGBB` integer as `{ r, g, b }` in 0-1. */
export function hexToRGB(hex: number): ThemeRGB {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
  };
}

/** Looks up the lighting block for a `preset.lighting` string, falling back to morning for anything unrecognised. */
export function lightingMode(mode: string | null | undefined): LightingModeTheme {
  const modes = theme.lighting as Record<string, LightingModeTheme | undefined>;
  return modes[mode ?? ''] ?? theme.lighting.morning;
}

/** The lighting-mode name `lightingMode` would resolve `mode` to. */
export function resolveLightingName(mode: string | null | undefined): 'morning' | 'afternoon' | 'night' {
  if (mode === 'afternoon' || mode === 'night' || mode === 'morning') return mode;
  return 'morning';
}

/**
 * Deterministic per-element variation in `[-1, 1]`, hashed from a string id.
 * Used for building colour jitter — never `Math.random()`, so the scene is
 * byte-identical on every load (CLAUDE.md's determinism rule).
 */
export function idJitter(id: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash / 0xffffffff) * 2 - 1;
}

/**
 * The current theme as pasteable TypeScript source: colour keys (anything
 * ending in `Color`) print as `0xRRGGBB`, everything else as a plain literal.
 * The tuning panel's "Copy theme source" button dumps this so a tuned look can
 * replace the defaults above verbatim.
 */
export function themeToSource(value: unknown = theme, indent = 0): string {
  const pad = '  '.repeat(indent + 1);
  const closePad = '  '.repeat(indent);

  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  const entries = Object.entries(value as Record<string, unknown>);
  const body = entries
    .map(([key, v]) => {
      const printed =
        key.endsWith('Color') && typeof v === 'number'
          ? `0x${Math.max(0, Math.round(v)).toString(16).padStart(6, '0')}`
          : themeToSource(v, indent + 1);
      return `${pad}${key}: ${printed},`;
    })
    .join('\n');

  return `{\n${body}\n${closePad}}`;
}
