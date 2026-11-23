/**
 * Headless S1 demo: prints a space-time diagram of the ring road.
 *
 *   npm run wave
 *   npm run wave -- --cars 50 --seconds 900
 *
 * Each row is a moment in time (top = start). Each column is a stretch of road.
 * Characters show the slowest car in that stretch:
 *   '#' stopped (< 2 m/s)   '+' crawling (< 6)   '-' slow (< 10)   '.' moving   ' ' empty
 * Stop-and-go waves show up as diagonal bands of '#' drifting left (backward) over time.
 */
import { DEFAULT_RING, runRing } from '../src/ring.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  const v = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

const cars = arg('cars', DEFAULT_RING.cars);
const seconds = arg('seconds', DEFAULT_RING.durationSec);
const rowEvery = arg('row', 10);
const cols = 80;

const { samples, minGap } = runRing({ cars, durationSec: seconds, sampleEverySec: 1 });
const length = DEFAULT_RING.length;

console.log(`Ring ${length} m, ${cars} cars, ${seconds} s. Car 0 slows to ${DEFAULT_RING.slowdown.speed} m/s ` +
  `from t=${DEFAULT_RING.slowdown.fromSec}s to t=${DEFAULT_RING.slowdown.toSec}s.`);
console.log(`position → (each column ≈ ${(length / cols).toFixed(1)} m)`);

for (const s of samples) {
  if (Math.round(s.t) % rowEvery !== 0) continue;
  const slowest = new Array<number>(cols).fill(Infinity);
  for (let i = 0; i < s.pos.length; i++) {
    const c = Math.min(cols - 1, Math.floor((s.pos[i]! / length) * cols));
    slowest[c] = Math.min(slowest[c]!, s.speed[i]!);
  }
  const row = slowest
    .map((v) => (v === Infinity ? ' ' : v < 2 ? '#' : v < 6 ? '+' : v < 10 ? '-' : '.'))
    .join('');
  const stopped = Array.from(s.speed).filter((v) => v < 2).length;
  console.log(`${String(Math.round(s.t)).padStart(4)}s |${row}| stopped: ${stopped}`);
}

console.log(`\nSmallest gap between any two cars: ${minGap.toFixed(2)} m ${minGap > 0 ? '(no collisions)' : '(COLLISION)'}`);
