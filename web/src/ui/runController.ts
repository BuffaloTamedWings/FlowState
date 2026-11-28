/**
 * Decides what the Run button should do: a fresh compile/load/run (the
 * layout or preset changed since the last run, or there was no last run) or
 * a plain resume. Pure function, no DOM — see CLAUDE.md's "Run semantics"
 * paragraph, which this implements.
 *
 * A preset change is a layout-equivalent change for this purpose: it's sent
 * in the same `load` message as the compiled network and the engine can't
 * resume into a different demand curve, so switching Morning -> Night must
 * restart from empty exactly like widening a lane would (plan step 10).
 */

export type RunAction = 'compile-load-run' | 'resume';

/**
 * `currentPresetId`/`lastRunPresetId` default to `null` so existing call
 * sites (and the pre-step-10 tests) that only ever ran one preset keep
 * working unchanged: `null === null` still falls through to the hash
 * comparison below.
 */
export function decideRunAction(
  currentHash: string,
  lastRunHash: string | null,
  currentPresetId: string | null = null,
  lastRunPresetId: string | null = null,
): RunAction {
  if (lastRunHash === null || currentHash !== lastRunHash) return 'compile-load-run';
  if (currentPresetId !== lastRunPresetId) return 'compile-load-run';
  return 'resume';
}
