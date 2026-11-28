/**
 * Pure colour logic for the congestion heatmap (plan step 10). No Three.js,
 * no DOM — `heatmapView.ts` is what actually touches meshes/materials.
 *
 * Per `docs/frontend-plan.md`: `meanSpeed / speedLimit` (`PathStats.speedRatio`)
 * >= 0.7 is green, 0.4-0.7 is yellow, < 0.4 is red, and the transitions are a
 * smooth blend through those stops rather than three hard-edged buckets.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 0-1 channel values, matching `THREE.Color.setRGB`'s default (linear-ish) convention. */
const RED: RGB = { r: 0.82, g: 0.24, b: 0.24 };
const YELLOW: RGB = { r: 0.86, g: 0.7, b: 0.27 };
const GREEN: RGB = { r: 0.24, g: 0.66, b: 0.45 };

/** `[ratio, color]` stops, ascending by ratio. Below the first and above the last, the end color holds flat. */
const STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, RED],
  [0.4, YELLOW],
  [0.7, GREEN],
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/**
 * Maps a speed ratio to a heatmap color, or `null` for "no data" (a lane with
 * no cars on it — the caller should leave the lane's normal asphalt material
 * in place rather than painting it). This is distinct from a ratio of `0`
 * (cars present but stopped dead), which maps to solid red.
 *
 * `ratio` is clamped to `[0, 1]` before blending.
 */
export function speedRatioColor(ratio: number | null | undefined): RGB | null {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return null;

  const clamped = Math.min(1, Math.max(0, ratio));

  const first = STOPS[0]!;
  if (clamped <= first[0]) return { ...first[1] };

  for (let i = 1; i < STOPS.length; i++) {
    const prev = STOPS[i - 1]!;
    const next = STOPS[i]!;
    if (clamped <= next[0]) {
      const span = next[0] - prev[0];
      const t = span > 0 ? (clamped - prev[0]) / span : 0;
      return lerpRGB(prev[1], next[1], t);
    }
  }

  const last = STOPS[STOPS.length - 1]!;
  return { ...last[1] };
}
