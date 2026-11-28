# Engine context (Sashank's side)

Running notes on how the traffic engine works, the decisions behind it, and what's left.
Kept up to date per milestone, so a new session (or Sashank) can pick up without re-reading the code.
Spec references are to `FlowState-PRD.md`. Commands run from the repo root.

**Status (2026-11-28):** S1–S5, vehicle sizes and S7 merged to `main` (PRs #8, #9); Dev's front end merged (PR #10). **S8 + S9 ✅ on `backend`** (not yet merged).
Next: S10 (tuning: demand, signal splits/offsets, LOS C–D target); S6 roundabouts once the ring-connector format is settled.

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
| `src/vehicles.ts` | S3 | Per-vehicle IDM behavior; lengths from `shared/vehicles.ts`. Default all cars. |
| `src/routing.ts` | S4 | Cost-to-go tables, routes, travel times, re-route rule, free-flow time. |
| `src/demand.ts` | S3 | Arrivals, trip / origin / destination choice, parking weights. |
| `src/control.ts` | S5 | Intersection control: signal plans, vehicle bodies, the gate (signals, stops, yields, merges, don't block the box). |
| `src/sim.ts` | S3 | `Sim` class tying it all together. |
| `src/stats.ts` | S7 | Per-path stats for the heatmap (speed ratio, occupancy, queue length, flow). |
| `src/metrics.ts` | S8 | Control delay per node, max queue per path, HCM level-of-service helper. |
| `src/host.ts` | S7 | `EngineHost`: the §7.6 protocol + real-time loop, with injected post / clock / timer (testable in Node). |
| `src/worker.ts` | S7 | Web Worker entry: wires `self` to `EngineHost`. This is what the front end loads. |
| `src/index.ts` | | Public exports (`EngineHost`, `Sim`, `loadNetwork`, …) for headless use. |
| `test/*.test.ts` | | Vitest suites (run by root `npm test`). |
| `test/fixtures.ts` | | Tiny hand-built networks/presets for tests (incl. a yield T-junction). |
| `test/wave.ts` | S1 | Prints the ring-road space-time diagram. |
| `test/load.ts` | S2 | Loads a compiled file and prints counts, or the validation error. |
| `test/run.ts` | S9 | Headless harness (`npm run sim`): per-minute lines, throughput, trip delay, per-node delay + LOS, longest queues. |

## Commands
- `npm test` / `npm run typecheck`
- `npx tsx engine/test/wave.ts [--cars 60]`
- `npx tsx engine/test/load.ts data/compiled/test-grid.compiled.json`
- `npm run sim -- --preset morning|afternoon|night [--minutes 30] [--seed N] [--network file] [--quiet]` (S9 harness; same as `npx tsx engine/test/run.ts ...`)
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

## S5: intersection control (2026-11-26)
- **Mechanism:** a vehicle about to enter a connector asks `Intersections.gate(car, conn, distToLine)`. If refused, the end of its lane becomes a stopped leader in `lookAhead`, so IDM stops it at the line. No IDM changes. The gate reads one snapshot per step (`control.update`), so runs stay deterministic. Vehicles held at a line are reported in `StepResult.held` / `sim.held` (for S7's yielding flag and S8's metrics).
- **Bodies:** each vehicle covers paths from its front back `length` meters along its route (`bodyPaths`), so a connector stays occupied until the **tail** leaves. Slivers under 1 µm are ignored (float leftovers).
- **Rules for every control:**
  - don't enter while any `cross` or `merge` conflict connector is occupied;
  - give way (critical gap) to each connector in `mustYieldTo`;
  - **don't block the box:** the outgoing lane needs room for length + min gap, after subtracting vehicles already on connectors into it, unless its rear vehicle is moving faster than 3 m/s.
- **`mustYieldTo`** = the data's `yieldTo`, plus a deterministic tie-break: where two conflicting connectors have no yield relation either way (same phase at a signal, or any unsignalled control except all-way stop), the higher-index one yields. Without it both could enter in the same step.
- **Signals:** fixed 60 s cycle, phases in array order, green ∝ distinct incoming lanes per phase, then 3 s yellow and 1 s all-red. Single-phase signals (`n10`) are always green. All offsets are 0 for now (S10 knob). Yellow means go only if you can't stop (v²/2b > distance). Red means stop. Protected-left is the same code with 4 phases.
- **Permissive turns** yield to `yieldTo` traffic with a 4 s gap, using real arrival time = distance ÷ speed. A **stopped or crawling** priority vehicle (< 0.5 m/s) only counts if it could actually go: its own gate is open and IDM would accelerate it ≥ 0.3 m/s². Then use its time from rest. Otherwise a left-turner could wait forever on an oncoming car stuck behind a full lane.
- **"Sneakers":** on yellow, a permissive turner waiting at the line may go, yielding only to oncoming vehicles too close to stop. Without this, lefts at busy signals never got a gap and blocked their lane for minutes.
- **Stop signs** (`stop: true`): a vehicle must be below 0.1 m/s within min gap + 1.5 m of the line before the gate opens, and the stop time is recorded.
  - All-way stop: first come, first served among conflicting approaches, but **only deferring to an earlier arrival that can actually go**. Deferring to one stuck behind a full lane deadlocked `n02` at night.
  - Yield minor approach: stop, then a 4 s gap.
- **Merge:** ramp connectors yield with a 3 s gap. **None** (diverge): shared rules only. **Roundabout:** generic 4 s yield to ring sections in `yieldTo`; real ring handling is S6.
- **Gridlock limit raised 120 → 300 s** (`GRIDLOCK_SEC`, overridable with `new Sim(..., { gridlockSec })`). With signals, an oversaturated approach legitimately holds a queued vehicle for several cycles (measured up to 355 s in morning, with no deadlock). *This deviates from PRD §8.5's 120 s; revisit after S10 brings demand within capacity.*
- **Bugs found and fixed while building it:**
  1. Left-turners waiting forever on stopped oncoming cars (fixed by the free-to-go check and sneakers).
  2. All-way-stop FCFS deadlock (only defer to vehicles that can go).
  3. Float slivers making a cleared connector look occupied.
- **Tests (`test/control.test.ts`):**
  - Signal timing: lane-proportional split, yellow / all-red placement, single-phase always green, 4-phase protected-left.
  - Semi body straddling a turn.
  - **Safety invariants every step for 30 min of each preset, plus morning with trucks:** no two bodies on crossing connectors, no overlaps on any path, no red-light entries, no stop-sign entries without a stop.
  - **Drain tests:** each preset, plus morning with trucks, empties completely once arrivals stop, with gridlock removal off.
  - Nobody stops inside an intersection.
  - Yield T-junction: minor vehicles always stop and only go with a gap; major vehicles only wait while a minor vehicle is already in the junction.
  - Afternoon and night: 0 gridlock removals.

## S7: worker wrapper (2026-11-26)
- **Split:** `EngineHost` (`host.ts`) holds all protocol logic and takes `post`, `now`, `schedule` and `cancel` from outside. `worker.ts` is ~10 lines wiring it to `self`. Tests drive the host with a fake clock.
- **Front end starts it with** `new Worker(new URL('../../../engine/src/worker.ts', import.meta.url), { type: 'module' })` (relative path from `web/src/sim/`). Checked that Vite bundles it (47 KB), and ran the **built** bundle in Node against the test grid: 3 s real at 4× gave 11.9 s sim, all message types, all ticks transferred, no errors.
- **Messages in:**
  - `load` validates and builds `Sim`, then replies `ready {pathCount}` plus an empty tick, and stays paused. Bad input becomes an `error` message.
  - `run` / `pause`.
  - `setSpeed` changes steps per real second, never dt.
  - `skip` simulates ahead with no ticks, then sends one tick + stats + metrics.
  - `reset` re-loads the last network, preset and seed.
  - **Warm-up is the front end's job** (PRD §10: it sends `setSpeed`).
- **Loop:** wakes about 60×/s (`WAKE_MS`) and runs `elapsed × multiplier ÷ 0.1` steps, carrying fractions over. At most 20 steps per wake; after a stall (e.g. a background tab) the backlog is dropped rather than replayed. Sim time is still step-exact, so it stays deterministic.
- **Messages out:**
  - `tick` every step: 5 floats per vehicle, buffer transferred. Flags: braking if a < −0.5 m/s², stopped if v < 0.1, yielding if held at a line (`sim.held`), type code in bits 3–4.
  - `stats` every 1 sim-s (`stats.ts`).
  - `metrics` every 5 sim-s, **partial until S8**: `completedTrips` and `counts` are live, `nodes` / `paths` are `{}`.
  - Any exception becomes `error` and pauses.
- **Stats details:** speed ratio = mean front-on-path speed ÷ limit (1 when empty). Occupancy = body length ÷ path length. Queue = unbroken line of vehicles under 1 m/s starting within minGap + 5 m of the path end. Flow = exits per minute over the interval (`Sim.takeExits`).
- **Tests (`test/host.test.ts`):**
  - ready + empty tick; errors for v1 / broken refs / bad mix / run-before-load;
  - a tick per step whose buffer matches `sim.cars` and is in the transfer list;
  - 1× vs 4× step rates, pause, stall backlog dropped;
  - stopped + yielding flags at red lights, type codes for trucks and semis;
  - skip = exactly one tick + stats + metrics; reset reproduces identical ticks;
  - stats cadence and value ranges, queues and flow present; metrics cadence with trips and counts.

## S8 + S9: metrics and the headless harness (2026-11-28)
- **`metrics` message is now complete:**
  - `completedTrips`: since the last message;
  - `counts`: now;
  - **`nodes` and `paths`: running totals since load.** Per node: average control delay and vehicles served. Per path: max standing queue. *Dev's scoring should read them as cumulative.* LOS is an average over a period, and 5 s windows are shorter than a signal cycle. Reset or restart zeroes them.
- **Control delay** (`MetricsTracker`):
  - the approach starts when a vehicle joins a lane (at its start, or mid-lane for garage exits);
  - when it leaves the connector at the end of that lane, delay = elapsed − (lane remainder ÷ lane limit + connector ÷ connector limit), clamped at 0;
  - every compiled node counts (signals, stops, merge, diverge);
  - vehicles that end mid-lane or are removed as gridlocked aren't counted;
  - fed from `Sim.step` using each vehicle's route leg before re-routing, so a short connector crossed in one step is still caught.
- **Max queue:** same definition as the `stats` queue, sampled every sim-second (also during `skip`).
- **`levelOfService(delay, control)`:** HCM bounds from PRD §9.2. Signals use the signalized table (10/20/35/55/80 s); everything else the unsignalized one (10/15/25/35/50 s). Used by the harness; Dev's scoring grades its own UI.
- **S9:** root `npm run sim` now runs `engine/test/run.ts` (was a placeholder in Dev's `package.json`; Sashank approved the edit). It prints per-minute lines (`--quiet` skips them), throughput, trip delay, a per-intersection table (served, avg delay, LOS) and the 5 longest queues.
- **Tests (`test/metrics.test.ts`):**
  - LOS boundaries for both tables;
  - a lone vehicle through an uncontrolled junction has < 0.2 s delay (step rounding); a busier one < 3 s (following);
  - vehicles served equals connector exits at every grid node;
  - signals and the all-way stop show positive delay; always-green `n10` < busy `n22`;
  - max queue equals the largest per-second stats queue; never-queued paths are 0;
  - the metrics message covers all 11 nodes and 147 paths, totals never decrease, and reset zeroes them.
- **Results, default seed, 30 min on the test grid:**

  | Preset | Intersection grades |
  |---|---|
  | Morning (over capacity) | n22 F 101.7 s · n02 F 181.8 s · M F 65.4 s · n01 E 57.1 s · n20 C · n00/n12/n21/n11 B · n10 A |
  | Afternoon | n21 D 50.2 s · n01 E 61.9 s · n02 E 44.6 s · n11 D · n20/n22 C · n12 B · n10/n00/M/D A |

  PRD §9.2's calibration target is **LOS C–D at the busiest nodes for morning on the current layout**, so S10 has to bring morning demand down.

## Lanes (decision, 2026-11-23)
- Each lane is its own path, so a vehicle's lane is just its path. **No mid-block lane changes** (PRD §1/§8.3).
- Vehicles choose lanes **at intersections** via connectors (PRD §7.4 rule 4) and the routing cost, which includes congestion, so traffic spreads across lanes. This matters for the added-lane trap: a new lane only helps if vehicles use it.
- Sashank's "road chunks with car-sized slots" idea was discussed and deferred: it would replace the continuous IDM model and change the contract. A cheaper version for after the MVP: lane changes at checkpoints (~every 40 m) with a gap check using the existing leader lookup.

## Vehicle sizes (done, 2026-11-26)
- Contract landed in PR #7: `shared/vehicles.ts` (car 4.5 m, box truck 9 m, semi 18 m) is the single source of truth for lengths. Type code goes in tick `flags` bits 3–4 (`withVehicleCode` / `vehicleCodeOf`). Optional preset `vehicleMix` (`validateVehicleMix`, `vehicleMixOf`). Missing = all cars.
- Engine: `vehicles.ts` takes **length from shared** and keeps only driving behavior (truck: a 0.7, b 1.5, T 1.8 s, s₀ 2.5 m; semi: a 0.5, b 1.2, T 2.2 s, s₀ 3 m). Each `Car` has `params` and `type`. Gaps use the leader's length, entry checks use the new vehicle's length. `Sim` throws on an invalid `vehicleMix`.
- S7 must write `withVehicleCode(flags, vehicleCode(car.type ?? 'car'))` into each tick.
- Tests (`test/vehicles.test.ts`): lengths equal shared, flag round-trip, invalid mix rejected, follower sees a semi's 18 m across a path boundary, mixed traffic keeps a positive gap everywhere on a merge-free road (incl. mid-lane garage exits), type shares match the mix.
- Morning on the test grid with the PRD mix (90/8/2): 1214 finished vs 1232 all-cars, mean trip 164.5 s vs 142.5 s, entry queue 55.4 s vs 49.0 s.
- **Pre-S5 issue (fixed by S5's merge rules):** 1 gridlock removal with the mix. A box truck waiting to merge onto `eA1/b/0` kept getting cut off by newer cars from another approach (no merge conflicts yet), and a semi behind it passed 120 s stopped. S5's merge / FCFS rules should fix it; then tighten that test back to `gridlockRemovals === 0`.
- S5 must treat a connector as clear only when the vehicle's **tail** has left it, and "don't block the box" must reserve the full length.

---

## Results on the test grid

`npx tsx engine/test/run.ts --preset <p> --minutes 30`, default seed, **with S5 intersection control**:

| Preset | Requested | Finished | Waiting to enter at 30 min | Gridlock | Mean trip | Free-flow | Travel time index | Stopped / trip | Entry queue |
|---|---|---|---|---|---|---|---|---|---|
| Morning | 1253 | 689 | 431 | 4 | 296.6 s | 33.2 s | 9.90 | 101.2 s | 100.0 s |
| Afternoon | 611 | 514 | 33 | 0 | 148.5 s | 30.9 s | 5.46 | 57.7 s | 6.3 s |
| Night | 1250 | 859 | 222 | 0 | 280.1 s | 40.5 s | 6.33 | 65.1 s | 102.6 s |

Before S5 (no control) morning finished 1232 with a travel time index of 4.14. Signals cut the test grid's capacity a lot.

- **Morning and night are over capacity** on the signalized test grid: hundreds of vehicles are still waiting to enter at 30 min. With arrivals switched off afterwards, everything drains (all 1253 / 1250 trips finish), so it's overload, not deadlock. **S10 must tune demand down** (or signal splits / offsets up).
- **Morning `parkingFailed` (328) happens while garages still have space:** vehicles waiting in entry queues already hold garage reservations (PRD §8.5 reserves at spawn), so free spaces run out on paper. Worth revisiting in S10 (e.g. reserve on entry instead of on request).
- Afternoon is light (25 veh/min) yet trips take ~5× free flow: several fixed 60 s signals per trip, no coordination. Offsets are an S10 knob.
- Earlier, pre-S5: the `park-g1` single-lane bottleneck and night garages emptying by minute 20 (both still true).

---|---|---|---|---|---|---|---|
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

## S5 notes to self (done; kept for reference)
- Stop lines = stationary leader at the end of the incoming lane when the vehicle may not enter the connector (red/yellow, stop sign before its full stop, no gap).
- Signals: fixed-time 60 s cycle, green split ∝ incoming car lanes per phase, 3 s yellow, 1 s all-red, phases in array order. Permissive lefts yield via `yieldTo`.
- `stop: true` ⇒ come to a full stop first; `allStop` = first-come-first-served while no conflicting connector is occupied; `yield` = 4 s critical gap to conflicting major vehicles; `merge` = 3 s gap.
- Don't block the box: only enter a connector if the outgoing lane has room for the whole vehicle.
- Conflicts: a connector is occupied until the last vehicle's **tail** leaves it.
