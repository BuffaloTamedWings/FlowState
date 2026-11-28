/**
 * Pure colour logic for the congestion heatmap (plan step 10). No Three.js,
 * no DOM — `heatmapView.ts` is what actually touches meshes/materials.
 *
 * Per `docs/frontend-plan.md`: `meanSpeed / speedLimit` (`PathStats.speedRatio`)
 * >= 0.7 is green, 0.4-0.7 is yellow, < 0.4 is red, and the transitions are a
 * smooth blend through those stops rather than three hard-edged buckets.
 *
 * The colours and the two thresholds themselves live in `theme.ts`.
 */

import { theme } from './theme.js';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * `[ratio, color]` stops, ascending by ratio. Below the first and above the
 * last, the end color holds flat. Read from `theme.ts` on every call (not
 * captured at module load) so the tuning panel can move the colours and the
 * two thresholds live.
 */
function stops(): ReadonlyArray<readonly [number, RGB]> {
  const h = theme.heatmap;
  return [
    [0, h.red],
    [h.yellowAt, h.yellow],
    [h.greenAt, h.green],
  ];
}

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

  const STOPS = stops();
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
