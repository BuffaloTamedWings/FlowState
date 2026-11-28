import { describe, expect, it } from 'vitest';

import { decideRunAction } from '@web/ui/runController.js';

describe('decideRunAction', () => {
  it('compiles/loads/runs on the first run (no baseline yet)', () => {
    expect(decideRunAction('abc', null)).toBe('compile-load-run');
  });

  it('compiles/loads/runs when the hash changed since the last run', () => {
    expect(decideRunAction('abc', 'xyz')).toBe('compile-load-run');
  });

  it('resumes when the hash matches the last run', () => {
    expect(decideRunAction('abc', 'abc')).toBe('resume');
  });
});
