# Engine context (Sashank's side)

Running notes on how the traffic engine works, the decisions behind it, and what's left.
Kept up to date per milestone, so a new session (or Sashank) can pick up without re-reading the code.
Spec references are to `FlowState-PRD.md`. Commands run from the repo root.

**Status (2026-11-23):** S1 ✅ · S2 ✅ · S3 ✅ · S4 ✅ on `backend` (`d78fde1`, not yet merged to `main`).
Next: S5 (intersection control) + S7 (worker wrapper), due Wed 11/25.

---

## Big picture

```
compiled network (JSON) ──loadNetwork──▶ Network (flat arrays)
preset (JSON) ─────────────────────────┐
seed ──────────────────────────────────┤
                                       ▼
                              Sim(network, preset, seed)
                                 step() every 0.1 s
   ┌────────────┬──────────────┬─────────────┬─────────────┬──────────────┐
   │ demand.ts  │ sim.ts       │ traffic.ts  │ routing.ts  │ idm.ts       │
   │ who spawns │ entry queues,│ move cars,  │ which way   │ how hard to  │
   │ & where to │ parking,     │ find leader │ to go       │ accelerate   │
   │            │ despawn      │             │             │              │
   └────────────┴──────────────┴─────────────┴─────────────┴──────────────┘
```

- The engine **never uses coordinates**. A vehicle is `(route, leg, s, v)`: which path it's on, meters along it (front bumper), speed. The front end turns that into x/y.
- **Determinism:** one seeded RNG (`rng.ts`), vehicles processed in ID order, two-phase steps (everyone decides from the same snapshot, then everyone moves). Same network + preset + seed ⇒ identical run. Tests check this.
- Fixed step `SIM_DT = 0.1 s` from `shared/messages.ts`. Playback speed will only change steps per real second (S7).

## Files

| File | Task | What it does |
|---|---|---|
| `src/idm.ts` | S1 | IDM acceleration formula, equilibrium speed, ballistic integration (never negative speed). |
| `src/ring.ts` | S1 | 1 km single-lane ring test bed; one slow car → stop-and-go wave. |
| `src/network.ts` | S2 | Validates a compiled network (v2) and builds flat arrays: `length`, `speedLimit`, `isLane`, `next`, `prev`, `byId`, nodes, points. |
| `src/traffic.ts` | S2/S3 | `Car`, `Occupancy` (who's on each path, front first), `lookAhead` (leader + speed cap), `stepCars`. |
| `src/rng.ts` | S3 | mulberry32 PRNG, weighted pick, Poisson draws. The only randomness. |
| `src/vehicles.ts` | S3 | Per-vehicle IDM params: car / truck / semi. Default all cars. |
| `src/routing.ts` | S4 | Cost-to-go tables, routes, travel times, re-route rule, free-flow time. |
| `src/demand.ts` | S3 | Arrivals, trip / origin / destination choice, parking weights. |
| `src/sim.ts` | S3 | `Sim` class tying it all together. S7's worker will wrap this. |
| `test/*.test.ts` | | Vitest suites (run by root `npm test`). |
| `test/fixtures.ts` | | Tiny hand-built networks/presets for tests. |
| `test/wave.ts` | S1 | Prints the ring-road space-time diagram. |
| `test/load.ts` | S2 | Loads a compiled file and prints counts, or the validation error. |
| `test/run.ts` | S3 | Headless preset run, one line per sim minute + trip summary (early S9). |

## Commands
- `npm test` / `npm run typecheck`
- `npx tsx engine/test/wave.ts [--cars 60]`
- `npx tsx engine/test/load.ts data/compiled/test-grid.compiled.json`
- `npx tsx engine/test/run.ts --preset morning|afternoon|night [--minutes 30] [--seed N] [--network file]`
- Inside the Claude sandbox, `tsx`'s CLI can't open its pipe; use `node --import tsx <file>` instead.

---

## S1: car following (IDM)
- Each step, a vehicle's acceleration comes from its speed, desired speed, gap to the leader, and the leader's speed (PRD §8.2 params: T 1.5 s, a 1.0, b 2.0, s₀ 2 m, δ 4, length 4.5 m).
- A stop line will be modeled as a stopped leader at the line (S5), so IDM needs no changes for intersections.
- Ring demo: waves only persist in dense traffic. 40 cars/km fades; **60 cars/km** gives a lasting backward-moving jam (the default).
- Guard: `v0` is floored at 0.001 only to avoid divide-by-zero (it was 0.1 until S3, which hid crawling cars from the gridlock check).

## S2: loading the map, following across paths
- **Validation** happens up front with errors that name the bad path: format, version (must be 2), `index` = position, every reference (`next`, `from`/`to`, `conflicts`, `yieldTo`, phases, `inPaths`, point access), lengths > 0, access `s` inside its lane. Unknown fields and `debugPolyline` are ignored.
- **Leader lookup** walks forward along the vehicle's *own route*, so the car ahead can be past a turn or on the next street. Gap = distance to the leader's **rear** using the **leader's** length (matters for trucks).
- **Braking for slower paths:** turn connectors are 6.7 m/s vs ~17.9 on streets. For each slower path ahead at distance d, acceleration is capped at −(v² − limit²)/2d, so vehicles reach the turn at its limit. (Lowering desired speed alone wasn't enough: a test caught cars entering at 9.9 m/s.)
- **Known gap until S5:** vehicles on two different connectors that cross or merge don't see each other.

## S3: spawning, entry queues, parking, despawning
- **Arrivals:** Poisson process at `spawnRateAt(curve, t)` vehicles/min for the whole map. After `durationSec` the last curve value continues.
- **Trip choice** (per new vehicle):
  1. Trip type by `share`.
  2. Origin of the listed types by `weight`; garages weighted by **parked cars** (*my call — PRD only defines garage weights as destinations*).
  3. Destination of the listed types by `weight`, **reachable from that origin only**, excluding the origin itself; garages weighted by **free spaces**.
  4. If a type can't be served on this map (no such points / nothing reachable), its share falls to the others. Requests with no possible trip are counted as `skipped`.
- **Parking:** a vehicle bound for a garage **reserves** a space at spawn. If every garage is full, it's sent to a reachable exit and counted `parkingFailed`. A vehicle leaving a garage frees its space when it's requested. Initial parked = round(capacity × `initialOccupancy`).
- **Entry queues:** one virtual FIFO line per origin access lane. The front vehicle enters only if:
  - the gap to the vehicle ahead is ≥ its min gap and IDM wouldn't brake harder than comfortable;
  - the vehicle behind (same lane, or front vehicle on each feeding path) could brake comfortably for it.

  Lane-start spawns enter at min(limit, leader speed); **mid-lane garages / lunch zones enter from rest**. At most one entry per queue per step.
- **Choosing an origin lane** (when a point has several): cheapest route + 2 s per vehicle already waiting there, which spreads vehicles across entry lanes.
- **Despawn:** when the front bumper reaches the trip's end `s` on its last path (lane end for exits, mid-lane for garages / lunch zones). Garage arrivals: `reserved--`, `parked++`.
- **Gridlock valve:** a vehicle below 0.1 m/s for more than 120 s is removed (`gridlockRemovals`) and its garage reservation released.
- **Trip records** (`CompletedTrip`, for S8): `tripTimeSec` counts **from the request, so entry-queue time is included** (PRD §8.5: a jammed map must not look good), free-flow time (route length ÷ speed limits), stopped time, entry queue time, origin, destination.

## S4: routing
- **Not A*:** A* needs a distance-to-goal estimate from coordinates, which the engine doesn't have. Instead, **backward Dijkstra from each destination** gives a "cost to go" (expected seconds from the start of every path to that destination). There are only ~20 destinations, so all tables are rebuilt every 30 s cheaply.
- **Path cost** = length ÷ expected speed. Expected speed = speed limit when empty, otherwise smoothed (≈30 s) mean speed of vehicles on it, **floored at 1 m/s** so a queue is slow, not impossible.
- **Route** = from the start lane, repeatedly take the next path with the lowest cost to go. This automatically picks the lane that can make the upcoming turn, and the less congested lane when there's a choice.
- **Re-route:** when a vehicle enters a new lane, if the best route from there is > 15% faster than the rest of its current route, it switches (PRD §8.3).
- **Unreachable** = infinite cost. Used to filter origins/destinations at spawn. Layouts never change mid-run (edits restart from empty), so a destination can only be unreachable at spawn time.

## Lanes (decision, 2026-11-23)
- Each lane is its own path, so a vehicle's lane is just its path. **No mid-block lane changes** (PRD §1/§8.3).
- Vehicles choose lanes **at intersections** via connectors (PRD §7.4 rule 4) and the routing cost, which includes congestion, so traffic spreads across lanes. This matters for the added-lane trap: a new lane only helps if vehicles use it.
- Sashank's "road chunks with car-sized slots" idea was discussed and deferred: it would replace the continuous IDM model and change the contract. A cheaper version for after the MVP: lane changes at checkpoints (~every 40 m) with a gap check using the existing leader lookup.

## Vehicle sizes (proposed, 2026-11-23)
- Engine side done: each vehicle has its own `params` (`vehicles.ts`); gaps use the leader's length; entry checks use the new vehicle's length. Truck 9 m / semi 18 m params exist but nothing spawns them until a preset has `vehicleMix`.
- Contract proposal sent to Dev (not merged yet): `shared/vehicles.ts` with lengths as the single source of truth, vehicle type code in tick `flags` bits 3–4, optional preset `vehicleMix`. When it lands: read `carLength` from `shared/vehicles.ts` and write the type bits in ticks (S7).
- S5 must treat a connector as clear only when the vehicle's **tail** has left it, and "don't block the box" must reserve the full length.

---

## Results on the test grid (no signals yet)

`npx tsx engine/test/run.ts --preset <p> --minutes 30`, default seed:

| Preset | Requested | Finished | Garages | Mean trip | Free-flow | Travel time index | Entry queue |
|---|---|---|---|---|---|---|---|
| Morning | 1253 | 1232 | fill 730/730; then 331 `parkingFailed` | 142.5 s | 34.7 s | 4.14 | 49.0 s |
| Afternoon | 611 | 600 | ~80% full throughout | 52.4 s | 29.1 s | 1.90 | 1.1 s |
| Night | 1250 | 1222 | empty by minute 20 | 162.1 s | 43.8 s | 3.53 | 67.4 s |

- **Morning bottleneck (real, not a bug):** `park-g1` (400 spaces, largest, so most-chosen) is only reachable through a single-lane street with two 6.7 m/s turns: ~24 veh/min capacity vs ~25 demanded. The queue backs up 70+ vehicles onto the off-ramp. Traced the leader chain to confirm there's no cycle. Good candidate for an added-lane-trap demo.
- **Night (S10 tuning):** garages (657 cars at 90%) empty within 20 of 30 minutes, then only through traffic remains.
- These numbers will change a lot once S5 adds signals and conflicts.

---

## Contract history the engine depends on
- `flowstate-network` **v2** (PR #4): required `ConnectorPath.stop` (stop sign: all connectors at `allStop`, minor approaches at `yield`). Asked for by Sashank. Engine rejects v1.
- `CompiledPoint.type` is the `PointType` union (PR #4).
- Still open with Dev: what `from` / `to` / `turn` mean for **roundabout ring connectors** (PRD §7.4 rule 10). Blocks S6.
- Still open: who owns **S6** (dropped from the new PRD §13 schedule).
- Asked Dev for `data/compiled/hard-case.compiled.json` alongside the planned hard-case scenario (5-way, roundabout, yield, curves), since the engine only reads compiled files.

## Schedule (PRD §13 as of PR #6)
| Date | Sashank |
|---|---|
| Mon 11/23 | S1, S2 ✅ (+ S3, S4 ✅ early) |
| Tue 11/24 | S3, S4 |
| Wed 11/25 | S5, S7 |
| Thu 11/26 | S8 |
| Fri 11/27 | S5, S9, **first integration** |
| Sat 11/28 | S10, **MVP on test grid** |
| Sun 11/29 | S10 (downtown) |

## Next up: S5 notes to self
- Stop lines = stationary leader at the end of the incoming lane when the vehicle may not enter the connector (red/yellow, stop sign before its full stop, no gap).
- Signals: fixed-time 60 s cycle, green split ∝ incoming car lanes per phase, 3 s yellow, 1 s all-red, phases in array order. Permissive lefts yield via `yieldTo`.
- `stop: true` ⇒ come to a full stop first; `allStop` = first-come-first-served while no conflicting connector is occupied; `yield` = 4 s critical gap to conflicting major vehicles; `merge` = 3 s gap.
- Don't block the box: only enter a connector if the outgoing lane has room for the whole vehicle.
- Conflicts: a connector is occupied until the last vehicle's **tail** leaves it.
