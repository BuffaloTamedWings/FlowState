/**
 * S9 headless harness: run one preset on one network with no graphics.
 *
 *   npm run sim -- --preset morning --minutes 30
 *   npm run sim -- --network data/compiled/test-grid.compiled.json --preset night --seed 7
 *   npm run sim -- --preset morning --quiet        (summary only)
 *
 * Prints one line per sim minute, then throughput, trip delay, and per
 * intersection: vehicles served, average control delay and level of service.
 */
import { readFileSync } from 'node:fs';
import type { Preset } from '@shared/preset.js';
import { loadNetwork } from '../src/network.js';
import { levelOfService } from '../src/metrics.js';
import { Sim } from '../src/sim.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const networkFile = arg('network') ?? 'data/compiled/test-grid.compiled.json';
const presetArg = arg('preset') ?? 'morning';
const presetFile = presetArg.endsWith('.json') ? presetArg : `data/presets/${presetArg}.json`;
const minutes = Number(arg('minutes') ?? 30);
const quiet = process.argv.includes('--quiet');

const net = loadNetwork(JSON.parse(readFileSync(networkFile, 'utf8')));
const preset = JSON.parse(readFileSync(presetFile, 'utf8')) as Preset;
const seed = Number(arg('seed') ?? preset.seed);
const sim = new Sim(net, preset, seed);

console.log(`${preset.label} on ${net.scenario}, seed ${seed}, ${minutes} min`);
if (!quiet) console.log(' min | requested entered finished | on map waiting | parkFail gridlock | garages (parked/capacity)');

const trips: ReturnType<Sim['takeCompleted']> = [];
for (let m = 1; m <= minutes; m++) {
  sim.run(60);
  trips.push(...sim.takeCompleted());
  const c = sim.counts();
  const garages = Object.entries(sim.parkingSnapshot()).map(([id, g]) => `${id} ${g.parked}/${g.capacity}`).join('  ');
  if (!quiet) console.log(
    `${String(m).padStart(4)} | ${String(c.requested).padStart(9)} ${String(c.entered).padStart(7)} ${String(c.finished).padStart(8)} | ` +
      `${String(c.carsActive).padStart(6)} ${String(c.carsWaitingToEnter).padStart(7)} | ${String(c.parkingFailed).padStart(8)} ${String(c.gridlockRemovals).padStart(8)} | ${garages}`,
  );
}

const c = sim.counts();
console.log(`\nThroughput: ${c.finished} trips finished in ${minutes} min (${(c.finished / minutes).toFixed(1)}/min) of ${c.requested} requested; ` +
  `${c.carsWaitingToEnter} still waiting to enter, ${c.carsActive} on the map, ${c.parkingFailed} parking failed, ${c.gridlockRemovals} gridlock removals.`);
if (trips.length > 0) {
  const mean = (f: (t: (typeof trips)[number]) => number) => trips.reduce((a, t) => a + f(t), 0) / trips.length;
  const tti = mean((t) => t.tripTimeSec / Math.max(t.freeFlowTimeSec, 1e-6));
  console.log(`\n${trips.length} trips: mean trip ${mean((t) => t.tripTimeSec).toFixed(1)} s, ` +
    `free-flow ${mean((t) => t.freeFlowTimeSec).toFixed(1)} s, travel time index ${tti.toFixed(2)}, ` +
    `stopped ${mean((t) => t.stoppedTimeSec).toFixed(1)} s, entry queue ${mean((t) => t.entryQueueTimeSec).toFixed(1)} s`);
  const byDest = new Map<string, number>();
  for (const t of trips) byDest.set(t.destination, (byDest.get(t.destination) ?? 0) + 1);
  console.log('by destination:', Object.fromEntries([...byDest].sort()));
  console.log(`mean trip delay (trip − free flow): ${mean((t) => t.tripTimeSec - t.freeFlowTimeSec).toFixed(1)} s`);
}

// Per intersection, busiest first.
const nodeMetrics = sim.metrics.nodes();
const rows = [...net.nodes.values()]
  .map((n) => ({ id: n.id, control: n.control, ...nodeMetrics[n.id]! }))
  .sort((a, b) => b.carsServed - a.carsServed);
console.log('\nIntersections (control delay since start, HCM level of service):');
console.log('  node        control              served   avg delay   LOS');
for (const r of rows) {
  const los = r.carsServed > 0 ? levelOfService(r.avgControlDelaySec, r.control) : '-';
  console.log(`  ${r.id.padEnd(11)} ${r.control.padEnd(20)} ${String(r.carsServed).padStart(6)} ${r.avgControlDelaySec.toFixed(1).padStart(9)} s   ${los}`);
}

// Longest queues seen.
const pathMetrics = sim.metrics.paths();
const queues = Object.entries(pathMetrics).filter(([, q]) => q.maxQueueLengthM > 0)
  .sort((a, b) => b[1].maxQueueLengthM - a[1].maxQueueLengthM).slice(0, 5);
if (queues.length > 0) {
  console.log('\nLongest queues:');
  for (const [id, q] of queues) {
    const len = net.length[net.byId.get(id)!]!;
    console.log(`  ${id.padEnd(30)} ${q.maxQueueLengthM.toFixed(0).padStart(4)} m of ${len.toFixed(0)} m`);
  }
}
