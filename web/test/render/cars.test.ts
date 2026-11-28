/**
 * Exercises the pure parts of car rendering (`carsCore.ts`) -- slot
 * allocation and x/y interpolation -- without touching the Three.js wrapper
 * (`cars.ts`), so these run with no GPU and no DOM.
 */
import { describe, expect, it } from 'vitest';

import type { TickCar } from '@shared/messages.js';

import type { ArcTable } from '@web/geometry/index.js';
import { buildArcTable } from '@web/geometry/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CompiledNetwork } from '@shared/network.js';
import { interpolateCarPose, MAX_INTERP_DISTANCE_M, SlotAllocator } from '@web/render/carsCore.js';
import { buildPathLookup, samplePath } from '@web/render/pathLookup.js';

function car(overrides: Partial<TickCar>): TickCar {
  return { vehicleId: 0, pathIndex: 0, s: 0, speed: 10, flags: 0, ...overrides };
}

describe('SlotAllocator', () => {
  it('allocates stable slots per id, reusing an id\'s existing slot', () => {
    const a = new SlotAllocator(4);
    const s1 = a.allocate(10);
    const s2 = a.allocate(20);
    expect(a.allocate(10)).toBe(s1); // same id -> same slot
    expect(s1).not.toBe(s2);
  });

  it('releases ids absent from the present set, and reuses their slots', () => {
    const a = new SlotAllocator(4);
    const s1 = a.allocate(10);
    a.allocate(20);
    const freed = a.release(new Set([20])); // 10 is gone
    expect(freed).toEqual([s1]);
    expect(a.slots.has(10)).toBe(false);
    expect(a.slots.has(20)).toBe(true);

    const s3 = a.allocate(30);
    expect(s3).toBe(s1); // the freed slot is reused
  });

  it('is correct whether or not ids are recycled: a released id re-allocated later gets a fresh slot assignment', () => {
    const a = new SlotAllocator(4);
    const first = a.allocate(10);
    a.release(new Set());
    const second = a.allocate(10); // same numeric id comes back after being gone
    // Nothing requires this to differ from `first` -- the point is it's a
    // deliberate, correct allocation either way, not a stale leftover.
    expect(a.slots.get(10)).toBe(second);
    void first;
  });

  it('grows capacity instead of throwing when the free list runs out', () => {
    const a = new SlotAllocator(2);
    a.allocate(1);
    a.allocate(2);
    expect(a.capacity).toBe(2);
    a.allocate(3); // forces a grow
    expect(a.capacity).toBeGreaterThan(2);
    expect(a.slots.size).toBe(3);
  });
});

describe('interpolateCarPose', () => {
  // A straight 10m polyline along +x, so x = s, y = 0, heading = [1, 0].
  const straight: ArcTable = buildArcTable([
    [0, 0],
    [10, 0],
  ]);
  const lookup = [straight];

  it('lerps x/y between the previous and current tick at alpha=0.5', () => {
    const prev = car({ pathIndex: 0, s: 2 });
    const curr = car({ pathIndex: 0, s: 6 });
    const pose = interpolateCarPose(lookup, prev, curr, 0.5);
    expect(pose.x).toBeCloseTo(4, 6);
    expect(pose.y).toBeCloseTo(0, 6);
  });

  it('draws at the newest position outright when there is no previous tick', () => {
    const curr = car({ pathIndex: 0, s: 6 });
    const pose = interpolateCarPose(lookup, undefined, curr, 0.5);
    expect(pose.x).toBeCloseTo(6, 6);
  });

  it('keeps interpolating across a path change, because consecutive paths touch', () => {
    // Two paths joined end to start, the way compile/connectors.ts builds a
    // connector onto the lane it feeds. Crossing that boundary must slide,
    // not snap: a car crosses one every time it passes through a junction,
    // so snapping here would hitch every car at every intersection.
    const second: ArcTable = buildArcTable([
      [10, 0],
      [20, 0],
    ]);
    const joined = [straight, second];
    const prev = car({ pathIndex: 0, s: 9 }); // 1 m from the end of path 0
    const curr = car({ pathIndex: 1, s: 1 }); // 1 m onto path 1
    const pose = interpolateCarPose(joined, prev, curr, 0.5);
    expect(pose.x).toBeCloseTo(10, 6); // halfway between x=9 and x=11
    expect(pose.y).toBeCloseTo(0, 6);
  });

  it('snaps instead of sliding when the two samples are further apart than a car can drive in one tick', () => {
    // Not driving: a reset, a gridlock removal, or a recycled vehicleId
    // landing on a live slot. Sliding across the map would look far worse.
    const far: ArcTable = buildArcTable([
      [1000, 1000],
      [1010, 1000],
    ]);
    const twoPathLookup = [straight, far];
    const prev = car({ pathIndex: 0, s: 9 });
    const curr = car({ pathIndex: 1, s: 1 });
    const pose = interpolateCarPose(twoPathLookup, prev, curr, 0.5);
    const atCurrent = interpolateCarPose(twoPathLookup, undefined, curr, 0.5);
    expect(pose).toEqual(atCurrent);
    expect(pose.x).toBeCloseTo(1001, 6);
  });

  it('every lane -> connector handoff in the real test grid is continuous, so none of them snap', () => {
    const network = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../data/compiled/test-grid.compiled.json'), 'utf8'),
    ) as CompiledNetwork;
    const lookup = buildPathLookup(network);
    const byId = new Map(network.paths.map((p) => [p.id, p]));

    let checked = 0;
    for (const path of network.paths) {
      for (const nextId of path.next) {
        const next = byId.get(nextId);
        if (!next) throw new Error(`${path.id} -> unknown next ${nextId}`);
        // A car at the very end of `path` and one at the very start of
        // `next` must be within a tick's travel of each other.
        const endA = samplePath(lookup, path.index, path.length);
        const startB = samplePath(lookup, next.index, 0);
        expect(
          Math.hypot(endA.x - startB.x, endA.y - startB.y),
          `${path.id} -> ${nextId} is discontinuous`,
        ).toBeLessThan(MAX_INTERP_DISTANCE_M);
        checked++;
      }
    }
    // 93 connectors, each reached from one lane and leading to one lane.
    expect(checked).toBe(186);
  });

  it('clamps alpha into [0, 1]', () => {
    const prev = car({ pathIndex: 0, s: 2 });
    const curr = car({ pathIndex: 0, s: 6 });
    expect(interpolateCarPose(lookup, prev, curr, -1).x).toBeCloseTo(2, 6);
    expect(interpolateCarPose(lookup, prev, curr, 2).x).toBeCloseTo(6, 6);
  });
});
