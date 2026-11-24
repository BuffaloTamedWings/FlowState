/**
 * The engine's only source of randomness (PRD §8.1). Same seed ⇒ same sequence ⇒
 * same run. Never use Math.random() in anything that feeds the sim.
 */

export type Rng = () => number;

/** mulberry32: small, fast, good enough for traffic. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick an index with probability proportional to its weight. Non-positive weights
 * are never picked. Returns -1 if nothing has positive weight.
 */
export function pickWeighted(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) if (w > 0) total += w;
  if (total <= 0) return -1;
  let r = rng() * total;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (w <= 0) continue;
    last = i;
    if (r < w) return i;
    r -= w;
  }
  return last; // float rounding fell off the end
}

/** Number of events in one interval for a Poisson process with the given mean. */
export function poisson(rng: Rng, mean: number): number {
  if (mean <= 0) return 0;
  // Knuth's method; fine for the small per-step means the sim uses (≪ 1).
  const limit = Math.exp(-mean);
  let k = 0;
  let p = rng();
  while (p > limit) {
    k++;
    p *= rng();
  }
  return k;
}
