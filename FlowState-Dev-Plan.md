# FlowState — Dev Plan & Work Split

**Team:** Dev (front end) · Sashank (back end / traffic engine)
**Final demos:** December 1 & 3

> **Assumptions to confirm** (shout if any of these are wrong):
> - Both halves are written in **TypeScript**. The engine runs in the browser in a Web Worker, not as a separate server.
> - The real-data import script is **Python** and is run once, offline, on Dev's laptop.
> - Everything runs locally on Dev's laptop from one `npm run dev`.

---

## 1. What we're building

A browser-based 3D traffic sandbox of **downtown Dallas**. The map is built from real OpenStreetMap data, cleaned up, and converted into our own format. The player watches traffic, edits roads (lane counts, roundabouts, bike/transit lanes), and sees how the change ripples through the network.

**Scope for the demo**
- **One area:** downtown Dallas, bounded by the freeway loop (I-30, I-35E, I-345/US-75, Woodall Rodgers). We may expand later.
- **Three presets on the same map:** Morning, Afternoon, Night. Each has its own traffic pattern (see §6).
- **Highways are not simulated.** We render a short stub of each on-ramp and off-ramp. Cars **appear** at off-ramps and **disappear** at on-ramps. Highway mainlines are static scenery.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language (both halves) | **TypeScript** | One language and one set of shared types for the data contract. Type errors catch contract mismatches before runtime. |
| Rendering | **Three.js (WebGL2)** | We already use it in class. Custom **GLSL shaders** via `ShaderMaterial` (road markings, heatmap) tie it back to the OpenGL material. |
| Vehicles | Three.js **`InstancedMesh`** | One draw call for all cars, so hundreds to low thousands of cars stay at 60 FPS. |
| Build / dev server | **Vite** | Fast local dev server with Web Worker support built in. |
| UI overlay | Plain HTML/CSS on top of the canvas (+ `lil-gui` for debug sliders) | No framework needed for a handful of panels. |
| Traffic engine | **TypeScript, no DOM or Three.js imports**, run in a **Web Worker** in the browser | No network hop, and the sim can't freeze rendering. The same code runs headless in Node for tests. |
| Engine ↔ UI | Worker `postMessage` with **transferable `Float32Array`s** for vehicle data | Sends hundreds of car positions per tick without copying overhead. |
| Engine tests / headless runs | **Vitest** + Node (`tsx`) | Run presets with no graphics and log throughput and delay. |
| Real-data import | **Python 3 + OSMnx** (+ `shapely`, `pyproj`) | OSMnx is the easiest way to pull and clean OpenStreetMap road networks. It runs offline once, and its output JSON is committed to the repo. |
| Source control | GitHub, one repo, a branch per person, PRs into `main` | Keeps parallel work from colliding. |

**Why not a separate backend server?** Everything runs on one laptop anyway. A server would add a network layer, a second language or runtime, and per-frame serialization for no benefit. The Web Worker gives us the same "separate engine" boundary with less to build.

---

## 3. Architecture

```mermaid
flowchart LR
  OSM[(OpenStreetMap)] -->|tools/import (Python, offline)| SJ[scenario JSON<br/>data/scenarios/]
  PJ[preset JSON<br/>data/presets/] --> ENG
  SJ --> WEB[web/ — Three.js front end]
  SJ --> ENG[engine/ — traffic sim<br/>in a Web Worker]
  WEB -->|edit events, play/pause, preset| ENG
  ENG -->|vehicle buffer, segment congestion, scores| WEB
```

- The **scenario JSON** describes the map, and both sides read the same file. The front end builds meshes from it, and the engine builds its graph from it.
- The **preset JSON** describes traffic demand. Only the engine reads it.
- At runtime the front end **only sends events** and **only draws what the engine reports**. The front end does no traffic logic.

---

## 4. Repo layout

```
flowstate/
├── shared/            # Data contract: TS types + message protocol   (Dev owns, both review)
│   └── contract.ts
├── engine/            # Traffic sim, no DOM/Three imports              (Sashank)
│   ├── src/
│   └── test/          # Headless harness + Vitest
├── web/               # Three.js app, UI, worker bootstrap             (Dev)
│   └── src/
├── tools/import/      # Python OSM → scenario JSON script              (Dev)
└── data/
    ├── scenarios/     # downtown-dallas.json (+ tiny test-grid.json)
    └── presets/       # morning.json, afternoon.json, night.json      (Sashank)
```

---

## 5. The data contract (Dev — first task)

Dev writes `shared/contract.ts` plus a small sample scenario file. Sashank reviews it, and then we build in parallel. **Changes after sign-off go through a PR that both of us approve.**

The contract will define:

**A. Scenario (map) format**
- **Coordinates:** local meters from a fixed origin in downtown (x = east, y = north). The renderer maps these into Three.js space.
- **Nodes:** intersections and road endpoints, each with a control type (signal / stop / none / roundabout).
- **Segments:** directed road pieces between nodes, each with a centerline polyline, lane count, speed limit, one-way flag, road class, and optional bike/transit lane flags.
- **Lane connections at each node:** which incoming lanes can reach which outgoing lanes.
- **Special points:**
  - `rampSpawn`: top of an off-ramp stub, where cars enter.
  - `rampSink`: end of an on-ramp stub, where cars leave.
  - `edgeSpawn` / `edgeSink`: local streets crossing the map boundary.
  - `parking`: garage or lot access node, with a capacity.
  - `lunchZone`: hand-picked restaurant clusters (afternoon destinations).

**B. Preset (demand) format.** Dev defines the shape, and Sashank fills in the values.
- A list of trip types: origin point type → destination point type, with weights.
- A spawn-rate curve over the preset's duration (ramp up → peak → ramp down).
- Initial parking occupancy.

**C. Runtime messages**

| Direction | Message | Contents |
|---|---|---|
| UI → Engine | `loadScenario` | scenario JSON |
| UI → Engine | `setPreset` | `morning` / `afternoon` / `night` |
| UI → Engine | `edit` | e.g. `{ type: "setLanes", segmentId, lanes }`, `addRoundabout`, `setBikeLane`, `setTransitLane`, `addSegment`, `removeSegment` |
| UI → Engine | `play` / `pause` / `setSpeed` / `reset` | — |
| Engine → UI | `tick` | sim time + `Float32Array` of `[x, y, heading, speed]` per vehicle + vehicle IDs |
| Engine → UI | `segmentStats` | congestion value 0–1 per segment (for the heatmap) |
| Engine → UI | `scores` | efficiency, happiness, plus the sub-metrics behind them |
| Engine → UI | `editResult` | edit accepted or rejected (with a reason) |

**Timing:** The engine steps at a **fixed timestep** (start at 0.1 s). The front end renders at 60 FPS and **interpolates** between the last two ticks so motion stays smooth.

---

## 6. Presets

Same map, same engine. Only the demand changes.

| Preset | Main flow | Notes |
|---|---|---|
| **Morning** | Ramp/edge spawns → **parking**. Cars despawn on entering a garage, and occupancy goes up. | Heaviest load, concentrated at off-ramps. The best preset for the "added lane trap" demo. |
| **Afternoon** | Parking → lunch zone → back to parking. Low volume, short trips. | The calm baseline, a good contrast to the other two. |
| **Night** | **Morning reversed:** parking → ramp/edge sinks. | Reuse the morning trip list with origins and destinations swapped. Starts with garages full. |

- **Every preset includes a little through traffic** (edge → edge) so the grid never looks empty.
- **Spawn rates ramp up, peak, and ramp down** within each preset. Congestion should visibly build and then clear.
- The front end also changes **lighting per preset** (morning sun, noon, night with headlights).

---

## 7. Work split

### Dev — Front end

| # | Task | Description | Done when |
|---|---|---|---|
| D1 | **Data contract** | Write `shared/contract.ts` (§5) and a tiny hand-made `test-grid.json` (about a 4×4 grid with a couple of spawn points and a parking node). | Sashank has reviewed and signed off. |
| D2 | **Downtown data import** | Python + OSMnx script: pull drivable roads, ramps, parking, and building footprints inside the freeway loop. Convert to local meters, merge messy intersection nodes, fill missing lane counts with defaults by road class, tag ramp spawns/sinks, edge points, parking (estimate capacity from footprint when it isn't tagged), and lunch zones. Output `downtown-dallas.json`. | The file loads and passes the contract's type checks. Every segment is connected, and one-way streets are correct. |
| D3 | **Hand cleanup** | Fix what the script can't: divided roads, multi-node intersections, ramp stubs, odd one-ways. | A visual check of the map shows no broken or floating roads. |
| D4 | **Ground and scenery** | Base plane, extruded building footprints, and static freeway mainlines. | Downtown is recognizable from above. |
| D5 | **Procedural road meshes** | Road ribbons from centerlines, lane markings (GLSL), intersection fills, ramp stubs. Meshes rebuild when an edit changes a segment. | Roads render cleanly, and a lane-count change updates the mesh. |
| D6 | **Camera and selection** | Orbit, pan, and zoom. Raycast to select a segment or intersection and highlight it. | Any road can be clicked and highlighted. |
| D7 | **Editing tools UI** | Panel for the selected item: lane count, roundabout, bike/transit lane, add/remove segment. Sends `edit` messages and shows `editResult`. | Each edit type reaches the engine, and rejections are shown to the player. |
| D8 | **Worker bootstrap** | Start the engine worker, send `loadScenario` / `setPreset`, receive `tick`, and interpolate between ticks. | The front end runs against a stub engine that moves fake cars. |
| D9 | **Vehicle rendering** | `InstancedMesh` cars positioned from the tick buffer, plus headlights at night. | Hundreds of cars at 60 FPS. |
| D10 | **Heatmap and HUD** | Color roads green → red from `segmentStats` (shader uniform or vertex colors). Score panels, preset picker, play/pause/speed. | Heatmap and scores update live. |
| D11 | **Preset lighting** | Morning, afternoon, and night lighting and sky. | Switching presets changes the scene's look. |

### Sashank — Back end (traffic engine)

| # | Task | Description | Done when |
|---|---|---|---|
| S1 | **Car-following model** | Intelligent Driver Model (IDM) on a single lane, so cars accelerate toward the speed limit and brake behind the car ahead. **Can start right away** on a hard-coded test road, before the contract is final. | A headless run shows stop-and-go waves forming behind a slow car. |
| S2 | **Network graph builder** | Build a lane-level directed graph from the scenario JSON: segments, lanes, lane connections, and one-way streets respected. | Both `test-grid.json` and `downtown-dallas.json` load with no dangling lanes. |
| S3 | **Intersection control** | Fixed-time signals at signalized nodes, stop logic elsewhere, and yield-on-entry for roundabouts. | Cars move through the test grid with no overlaps or deadlocks. |
| S4 | **Spawning and despawning** | Spawn at `rampSpawn` / `edgeSpawn` / parking. Despawn at `rampSink` / `edgeSink` / parking. Track parking occupancy and stop sending cars to full garages. | Cars appear and disappear at the right points, and occupancy is reported. |
| S5 | **Preset demand profiles** | Write `morning.json`, `afternoon.json`, and `night.json` (night = morning reversed) with spawn-rate curves. Tune volumes so congestion builds and clears. | Each preset has a visibly different flow pattern. |
| S6 | **Routing** | A* over the segment graph, weighted by current travel time. Reroute periodically and after edits. | Closing or narrowing a road shifts traffic onto alternatives. |
| S7 | **Edit handling** | Apply `edit` messages mid-run: rebuild only the affected part of the graph, move or reroute cars on changed segments, and reject invalid edits with a reason. | Every edit type works without restarting the sim. |
| S8 | **Metrics and scoring** | Per-segment congestion (0–1 from speed vs. speed limit and density). An efficiency score (throughput vs. delay) and a happiness score (trip time vs. free-flow time, idle-time penalty, bike/transit access). Exact formulas are Sashank's call. | Scores respond sensibly to edits, e.g. the added-lane trap lowers efficiency. |
| S9 | **Worker wrapper** | Run the sim in a Web Worker per the §5 message protocol, packing vehicle data into transferable `Float32Array`s. | The front end receives ticks with no frame drops. |
| S10 | **Headless test harness** | Node script that runs a scenario + preset for N sim-minutes with no graphics and logs throughput, average delay, and scores. Vitest for core pieces. | `npm run sim -- --preset morning` prints a summary. |

---

## 8. How we work in parallel

1. **Dev:** D1 (contract) first. Sashank starts **S1 at the same time**, since IDM doesn't depend on the format.
2. **Contract sign-off:** Sashank reviews `shared/contract.ts`. Once it's approved, both work independently:
   - Dev tests the front end against a **stub engine** (D8) that moves fake cars along segments.
   - Sashank tests against `test-grid.json` with the **headless harness** (S10), no graphics needed.
3. **Integration:** Swap the stub for the real engine on the test grid first, then on downtown Dallas.
4. **Contract changes** after sign-off go through a PR both of us approve.

---

## 9. Phases

| Phase | Dev | Sashank | Checkpoint |
|---|---|---|---|
| **1. Contract** | D1 | S1 | Contract signed off |
| **2. Build separately** | D2–D6, D8 | S2–S4, S9, S10 | Front end runs on stub engine; engine runs headless on test grid |
| **3. First integration** | Connect real worker on test grid | Fix issues found | Real cars drawn in browser on test grid |
| **4. Downtown + presets** | D7, D9, D10 | S5–S8 | Downtown Dallas running all 3 presets with edits |
| **5. Polish** | D11, UI polish | Tuning volumes and scores | "Added lane trap" demo works reliably |

---

## 10. Priorities (if time gets tight)

**Must have for the demo**
- Downtown map rendering, cars moving, at least the Morning preset
- Lane-count edits with visible ripple effects
- Heatmap and both scores

**Should have**
- All three presets, roundabout edits, preset lighting

**Nice to have**
- Bike/transit lanes, adding/removing segments, lane changing between lanes, buildings

---

## 11. To decide together

- Vehicle cap. Start at about 1,000 and adjust after the first performance test.
- Exact scoring formulas (Sashank proposes, we agree).
- Which spot in downtown we use for the "added lane trap" demo.
- Credit line in the UI: "© OpenStreetMap contributors" (required by OSM's license).
