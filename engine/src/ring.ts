/**
 * S1 test bed: a single-lane ring road with IDM cars, before the real network exists.
 *
 * A ring keeps traffic going forever, so a disturbance can be watched as it travels
 * backward through the line. One car (the "slow car") brakes down to a low speed for a
 * while, then recovers. With dense enough traffic, IDM turns that into stop-and-go waves.
 */
import { SIM_DT } from '@shared/messages.js';
import { DEFAULT_IDM, equilibriumSpeed, idmAccel, integrate, type IdmParams } from './idm.js';

export interface RingOptions {
  /** Ring circumference (m). */
  length: number;
  /** Number of cars, spaced evenly at t = 0. */
  cars: number;
  /** Desired speed for every car (m/s). 13.41 m/s = 30 mph. */
  speedLimit: number;
  /** Total simulated time (s). */
  durationSec: number;
  /** The slow car's speed cap and when it applies. */
  slowdown: { car: number; speed: number; fromSec: number; toSec: number };
  /** Record a snapshot every this many seconds. */
  sampleEverySec: number;
  idm: IdmParams;
}

export const DEFAULT_RING: Readonly<RingOptions> = Object.freeze({
  length: 1000,
  // 60 cars/km (~12 m bumper-to-bumper) is dense enough that IDM is string-unstable:
  // the disturbance grows into a lasting stop-and-go wave instead of fading out.
  cars: 60,
  speedLimit: 13.41,
  durationSec: 600,
  slowdown: { car: 0, speed: 2, fromSec: 60, toSec: 75 },
  sampleEverySec: 1,
  idm: DEFAULT_IDM,
});

export interface RingSample {
  t: number;
  /** Position along the ring (m), per car. */
  pos: Float64Array;
  /** Speed (m/s), per car. */
  speed: Float64Array;
}

export interface RingResult {
  samples: RingSample[];
  /** Smallest bumper-to-bumper gap seen during the whole run (m). Negative = collision. */
  minGap: number;
}

export function runRing(opts: Partial<RingOptions> = {}): RingResult {
  const o: RingOptions = { ...DEFAULT_RING, ...opts };
  const n = o.cars;
  const len = o.idm.carLength;

  // Cars start evenly spaced in ascending position order, already moving at the steady
  // speed for that spacing, so the only disturbance is the slow car.
  // Car i's leader is car (i + 1) % n.
  const pos = new Float64Array(n);
  const speed = new Float64Array(n);
  const v0Start = equilibriumSpeed(o.length / n - len, o.speedLimit, o.idm);
  for (let i = 0; i < n; i++) {
    pos[i] = (i * o.length) / n;
    speed[i] = v0Start;
  }

  const accel = new Float64Array(n);
  const samples: RingSample[] = [];
  let minGap = Infinity;
  const steps = Math.round(o.durationSec / SIM_DT);
  const sampleEvery = Math.max(1, Math.round(o.sampleEverySec / SIM_DT));

  const gapTo = (i: number): number => {
    const lead = (i + 1) % n;
    const ahead = (pos[lead]! - pos[i]! + o.length) % o.length;
    return ahead - len;
  };

  for (let step = 0; step <= steps; step++) {
    const t = step * SIM_DT;
    if (step % sampleEvery === 0) {
      samples.push({ t, pos: pos.slice(), speed: speed.slice() });
    }
    if (step === steps) break;

    // Phase 1: every car decides its acceleration from the same snapshot (fixed order by ID).
    for (let i = 0; i < n; i++) {
      let v0 = o.speedLimit;
      if (i === o.slowdown.car && t >= o.slowdown.fromSec && t < o.slowdown.toSec) {
        v0 = o.slowdown.speed;
      }
      const lead = (i + 1) % n;
      const gap = n > 1 ? gapTo(i) : Infinity;
      let a = idmAccel(speed[i]!, v0, gap, speed[lead]!, o.idm);
      // When the cap drops below current speed, IDM's free-road term brakes very hard.
      // Limit it to the comfortable rate, like a driver easing off.
      if (v0 < o.speedLimit) a = Math.max(a, -o.idm.comfortDecel);
      accel[i] = a;
    }

    // Phase 2: move everyone.
    for (let i = 0; i < n; i++) {
      const { v, ds } = integrate(speed[i]!, accel[i]!, SIM_DT);
      speed[i] = v;
      pos[i] = (pos[i]! + ds) % o.length;
    }

    for (let i = 0; i < n; i++) minGap = Math.min(minGap, gapTo(i));
  }

  return { samples, minGap };
}
