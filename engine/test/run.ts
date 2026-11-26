/**
 * Headless run of one preset on one network (early version of the S9 harness).
 *
 *   npx tsx engine/test/run.ts --preset morning --minutes 30
 *   npx tsx engine/test/run.ts --network data/compiled/test-grid.compiled.json --preset night --seed 7
 *
 * Prints one line per sim minute, then a trip summary. No graphics.
 * Note: until S5 there are no signals or stop signs, so vehicles at intersections
 * pass through each other — counts are meaningful, congestion is not yet.
 */
import { readFileSync } from 'node:fs';
import type { Preset } from '@shared/preset.js';
import { loadNetwork } from '../src/network.js';
import { Sim } from '../src/sim.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const networkFile = arg('network') ?? 'data/compiled/test-grid.compiled.json';
const presetArg = arg('preset') ?? 'morning';
const presetFile = presetArg.endsWith('.json') ? presetArg : `data/presets/${presetArg}.json`;
const minutes = Number(arg('minutes') ?? 30);

const net = loadNetwork(JSON.parse(readFileSync(networkFile, 'utf8')));
const preset = JSON.parse(readFileSync(presetFile, 'utf8')) as Preset;
const seed = Number(arg('seed') ?? preset.seed);
const sim = new Sim(net, preset, seed);

console.log(`${preset.label} on ${net.scenario}, seed ${seed}, ${minutes} min`);
console.log(' min | requested entered finished | on map waiting | parkFail gridlock | garages (parked/capacity)');

const trips: ReturnType<Sim['takeCompleted']> = [];
for (let m = 1; m <= minutes; m++) {
  sim.run(60);
  trips.push(...sim.takeCompleted());
  const c = sim.counts();
  const garages = Object.entries(sim.parkingSnapshot()).map(([id, g]) => `${id} ${g.parked}/${g.capacity}`).join('  ');
  console.log(
    `${String(m).padStart(4)} | ${String(c.requested).padStart(9)} ${String(c.entered).padStart(7)} ${String(c.finished).padStart(8)} | ` +
      `${String(c.carsActive).padStart(6)} ${String(c.carsWaitingToEnter).padStart(7)} | ${String(c.parkingFailed).padStart(8)} ${String(c.gridlockRemovals).padStart(8)} | ${garages}`,
  );
}

if (trips.length > 0) {
  const mean = (f: (t: (typeof trips)[number]) => number) => trips.reduce((a, t) => a + f(t), 0) / trips.length;
  const tti = mean((t) => t.tripTimeSec / Math.max(t.freeFlowTimeSec, 1e-6));
  console.log(`\n${trips.length} trips: mean trip ${mean((t) => t.tripTimeSec).toFixed(1)} s, ` +
    `free-flow ${mean((t) => t.freeFlowTimeSec).toFixed(1)} s, travel time index ${tti.toFixed(2)}, ` +
    `stopped ${mean((t) => t.stoppedTimeSec).toFixed(1)} s, entry queue ${mean((t) => t.entryQueueTimeSec).toFixed(1)} s`);
  const byDest = new Map<string, number>();
  for (const t of trips) byDest.set(t.destination, (byDest.get(t.destination) ?? 0) + 1);
  console.log('by destination:', Object.fromEntries([...byDest].sort()));
}
