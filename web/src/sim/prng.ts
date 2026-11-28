/**
 * A tiny deterministic PRNG for the stub engine. Deliberately **not** a copy
 * of (or import from) `engine/src/rng.ts` — that file is Sashank's, and
 * `engine/` is off limits here. This is the standard public-domain
 * mulberry32 generator, reimplemented from scratch.
 *
 * Determinism matters (CLAUDE.md): the stub must never call `Math.random()`.
 * Same seed in -> same tick sequence out, every time.
 */

export type Rng = () => number;

/** Returns a `() => number` in `[0, 1)`, seeded deterministically from `seed`. */
export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in `[0, n)`. `n <= 0` always returns 0. */
export function randInt(rng: Rng, n: number): number {
  if (n <= 0) return 0;
  return Math.floor(rng() * n);
}
