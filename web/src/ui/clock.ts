/**
 * Pure formatting for the HUD's sim clock (plan step 10). No DOM.
 */

/**
 * Formats a sim time in seconds as `mm:ss`, or `h:mm:ss` once it reaches an
 * hour. Negative or non-finite input is clamped to `0`. Fractional seconds
 * are floored, not rounded, so the clock doesn't flicker at `:59.6` -> `:00`.
 */
export function formatSimClock(simSeconds: number): string {
  const total = Number.isFinite(simSeconds) ? Math.max(0, Math.floor(simSeconds)) : 0;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
