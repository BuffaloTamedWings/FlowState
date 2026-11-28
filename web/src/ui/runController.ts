/**
 * Decides what the Run button should do: a fresh compile/load/run (the
 * layout or preset changed since the last run, or there was no last run) or
 * a plain resume. Pure function, no DOM — see CLAUDE.md's "Run semantics"
 * paragraph, which this implements.
 */

export type RunAction = 'compile-load-run' | 'resume';

export function decideRunAction(currentHash: string, lastRunHash: string | null): RunAction {
  if (lastRunHash === null || currentHash !== lastRunHash) return 'compile-load-run';
  return 'resume';
}
