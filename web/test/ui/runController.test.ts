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

  it('resumes when the hash and preset both match the last run', () => {
    expect(decideRunAction('abc', 'abc', 'morning', 'morning')).toBe('resume');
  });

  it('compiles/loads/runs on a preset change alone, same layout', () => {
    expect(decideRunAction('abc', 'abc', 'night', 'morning')).toBe('compile-load-run');
  });

  it('compiles/loads/runs when both the layout and the preset changed', () => {
    expect(decideRunAction('abc', 'xyz', 'night', 'morning')).toBe('compile-load-run');
  });

  it('treats no-preset-tracked (null, null) the same as before -- resumes on a hash match', () => {
    expect(decideRunAction('abc', 'abc', null, null)).toBe('resume');
  });
});
