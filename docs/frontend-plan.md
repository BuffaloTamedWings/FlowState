# Front-end plan (Dev)

Steps from empty repo to the MVP, then polish. Each step has a **Done when** check. Tick boxes as work lands. Spec references are to `FlowState-PRD.md`.

## Sequencing: test grid first

**Everything gets built and proven on `test-grid` before any Dallas data is loaded.** The downtown import (step 8) moves to *after* the full vertical slice works end to end, so that when real data arrives the only new variable is the data itself.

**Step numbers below are unchanged** — step 8 is still "step 8" even though it now runs late. Renumbering would invalidate the references in code comments, commit messages and this file's Log. Read the date table for the order of work, not the step numbers.

**MVP** = steps 1–7, 9, 10 **on the test grid**: cars through signals, morning preset, lane-count options (`widen`, `roadDiet`), Run/Pause/edit with restart, heatmap. Downtown (step 8) is the second phase, not part of the MVP.

**Known ceiling of this approach.** The test grid is deliberately clean and cannot exercise some things at all, so passing every test below is *not* evidence that real data will work:

| Not covered by `test-grid` | Why it matters |
|---|---|
| 23 of 25 edges are straight 2-point lines; only the 2 ramps bend | Averaged-normal corner offsetting is barely tested; downtown is all multi-vertex curves |
| No node with >4 approaches | Downtown has 5- and 6-way junctions |
| No roundabout / `yield` / protected-left **selected** | Compile rules 8 and 10 stay unexercised by the golden file |
| `residential` and `uturn` road classes absent; elevation only on 2 ramps | Untested geometry and classification paths |

Mitigation: **step 4 ends with a hand-written "hard case" fixture** that fakes this nastiness without needing OSM, so the question moves from the last 48 hours to Tue 11/24.

| Target date | Steps |
|---|---|
| Mon 11/23 | 1, 2, 3 ✅ |
| Tue 11/24 | 4 (compile + golden + hard-case fixture) |
| Wed 11/25 | 5, 6 |
| Thu 11/26 | 7 |
| Fri 11/27 | 9 (real engine, test grid) |
| Sat 11/28 | 10 → **MVP complete on the test grid** |
| Sun 11/29 | 8 (downtown import) |
| Mon 11/30 | 8 finish, 11, rehearsal |

---

## 1. Scaffold the repo
- [x] Single `package.json` at the root (no workspaces). Vite with `root: "web"`. TypeScript strict.
- [x] Path aliases in `tsconfig.json` and `vite.config.ts`: `@shared/*` → `shared/*`, `@engine/*` → `engine/src/*`, `@web/*` → `web/src/*`.
- [x] Dependencies: `three`, `@types/three`, `lil-gui`. Dev: `vite`, `typescript`, `vitest`, `tsx`.
- [x] Folders per PRD §6: `shared/`, `engine/src/` (placeholder only — Sashank's), `engine/test/`, `web/src/{geometry,compile,render,ui,sim,scoring}/`, `tools/`.
- [x] Scripts: `dev`, `build`, `preview`, `typecheck`, `test`, `compile`, `sim` (placeholder pointing at engine).
- [x] `web/index.html` + `web/src/main.ts`: full-window Three.js canvas, OrbitControls, a ground plane, and `data/scenarios/test-grid.scenario.json` fetched and its node/edge counts logged.
- [x] `.gitignore` for `node_modules/`, `dist/`, `.venv/`, `__pycache__/`.
- [x] A smoke test in Vitest that loads the three starter JSON files and checks `format`/`version`.

**Done when:** `npm run dev` shows the canvas with a ground plane and the console logs `22 nodes, 25 edges`; `npm run typecheck` and `npm test` pass. Sashank is told the layout exists.

## 2. Contract types (`shared/`)
- [x] `scenario.ts` — Scenario, Node, NodeOption, Edge, EdgeOption, Lane, Point, Scenery (PRD §7.2).
- [x] `network.ts` — CompiledNetwork, LanePath, ConnectorPath, CompiledNode, CompiledPoint (§7.4).
- [x] `preset.ts` — Preset (§7.5).
- [x] `messages.ts` — UI→Engine and Engine→UI message unions, tick/stats buffer layout constants (§7.6).
- [x] Type-check the starter files against these (a test that imports the JSON and assigns it to the types).

**Done when:** types compile, starter files type-check, and Sashank has signed off.

## 3. Geometry module (`web/src/geometry/`, no Three.js)
- [x] Polyline helpers: length, offset (averaged normals), trim from both ends, point + tangent at distance `s`.
- [x] Lane layout per edge option: widths, offsets, two-way vs one-way placement, lane index = full-direction index.
- [x] Node setbacks (intersection 12 m, merge/diverge 8 m, boundary/rampEnd 0, roundabout radius + 6 m).
- [x] Connector curve: quadratic Bézier from lane end to lane start, control point at the tangent intersection, straight fallback; sampled polyline.
- [x] Arc-length lookup table per path for fast `(s) → (x, y, heading)`.

**Done when:** unit tests reproduce a few lane endpoints and lengths from the starter compiled file.

## 4. Compile step (`web/src/compile/`) + `tools/compile-cli.ts`
- [x] Port PRD §7.4 rules 1–9 from `tools/reference/make_sample.py`: lane paths, movement classification, lane turn assignment, lane-entry mapping (single-lane fan-out), merge/diverge, conflicts, signal phases, yields, point access.
- [x] Protected-left and `yield` compiles — both done, not deferred. `yield` came with the network v2 `stop` work; `signalProtectedLeft` was 10 lines on top of the signal branch, so it went in here rather than step 11.
- [ ] **Rule 10 (roundabout ring) — still deferred to step 11.** Compiling a selected roundabout throws a clear not-implemented error rather than emitting a wrong network. Blocked on an open question for Sashank: §7.4 rule 10 doesn't define what `from`/`to`/`turn` hold for a ring section. **The step 7 options panel must not offer a roundabout until this lands** — the test grid offers one on `n01`, `n02`, `n11` and `n22`, and Run would throw.
- [x] Deterministic output ordering (same input → byte-identical JSON).
- [x] CLI: `npm run compile -- data/scenarios/test-grid.scenario.json out.json`. Validates after compiling and exits non-zero on errors; `--no-validate` skips.
- [x] **Golden test** vs `data/compiled/test-grid.compiled.json`: same path IDs and order, same `next`, lengths within 0.05 m, same conflicts/yields/phases.
- [x] Validation helper: no dead-end lanes, no unreachable lanes, every spawn reaches a sink (same checks as the reference).
- [x] **Hard-case fixture** `data/scenarios/hard-case.scenario.json`, hand-written, no OSM needed: multi-vertex curved centerlines, a 5-way intersection, a selected `yield` node and a selected `signalProtectedLeft` node, an edge with `elevation`, and a per-lane `width` override. The roundabout is **offered but not selected**, because selecting it throws until rule 10 lands. It compiles and passes validation — there is no golden file to match, the point is that it doesn't crash or produce dead lanes. This is what stands in for real data until step 8.

**Done when:** golden test passes, and the hard-case fixture compiles and validates. ✅ **Done 2026-11-27** (rule 10 excepted, see above).

## 5. First render of the test grid (`web/src/render/`)
_Test grid only. Downtown is step 8._
- [x] Lane ribbons from geometry (one mesh per lane path, flat at z unless `elevation`). Built from the **scenario**, not the compiled network, so bike and transit lanes draw too — the compile step emits car lanes only. `laneGeometry.ts` mirrors `compile/lanePaths.ts`'s trimming, and a test pins all 54 car lanes to their compiled `debugPolyline` vertex-for-vertex so the two can't drift apart.
- [x] Intersection fill polygons: convex hull of each compiled node's connector geometry, fan-triangulated.
- [x] Simple lane-line rendering (plain `LineSegments`; the shader comes in step 11). Outer edge lines white, lane dividers grey, two-way centerline gold.
- [x] Camera framed on `meta.bounds` — sized to the bounds **diagonal**, because the camera looks in along a diagonal and a box-sized frame clips the corners once you orbit.
- [x] `coords.ts` is the one place the `(x, y, z)` → `(x, z, -y)` mapping appears. `ribbon.ts`, `hull.ts`, `elevation.ts` and `laneGeometry.ts` stay Three-free so they unit-test in plain Node.

**Done when:** the test grid in the browser matches `test-grid-preview.png`. ✅ **Code done 2026-11-27, 593 tests green — pending Dev's visual confirmation in the browser.** The preview's buildings, park and freeway strip are scenery and belong to step 11, so the ground is bare around the roads.

## 6. Stub engine + car rendering
**Reordered: the real engine is the primary target here, not step 9.** Sashank's engine was merged and green (S7, `f2dc7a7`) before this step started, and `EngineHost` takes an injected clock with no Worker APIs in it — so `engineClient.ts` is tested in Node against the **real engine** with a fake clock, which a stub could never prove. The stub stays as the fallback and as a way to isolate front-end bugs from sim bugs. **This largely absorbs step 9.**
- [x] `web/src/sim/engineClient.ts` — sends `load`/`run`/`pause`/`setSpeed`/`skip`/`reset`, receives `tick`/`stats`/`metrics`/`error`. Talks to an `EngineTransport` interface, never a `Worker` directly, so the real worker, the stub and the in-process test harness all plug into the same client.
- [x] `web/src/sim/stubEngine.ts` (+ `stubHost.ts`, `prng.ts`) — seeded fallback engine in the real buffer layout. Its own mulberry32, not Sashank's `rng.ts`.
- [x] `InstancedMesh` cars, slot per `vehicleId`; position via arc-length lookup; interpolate between the last two ticks in x/y; heading from tangent; brake-light flag; per-instance scale from the tick's vehicle-type bits.
- [x] Swap point: `createTransport(kind)`, chosen by `?engine=stub`, defaulting to the real worker.
- [x] **Warm-up uses `skip(realSeconds × playbackSpeed)`, not a wall-clock timer.** A wall-clock warm-up makes the sim time where the player takes control depend on frame timing, so two runs of one layout don't start from the same state and the A/B comparison isn't fair. `warmupMode: 'playback'` keeps the original behaviour if the instant fill reads worse at the demo. **Tell Sashank.**
- [x] Cars clear on `ready`, not on the first empty tick — an empty tick is also what a drained map looks like.
- [x] Interpolation does **not** stop at a path change. Consecutive paths touch by construction, so lerping x/y across the boundary is smooth; snapping there would hitch every car at every intersection. A >50 m jump between ticks is treated as a teleport and snapped instead. A test walks all 186 lane↔connector handoffs in the grid and confirms every one is continuous.

**Done when:** ~1,000 stub cars move smoothly across lanes and turns at 60 FPS. ✅ **Code done 2026-11-27, 623 tests green — pending Dev's visual confirmation in the browser.**

**Open question for Sashank:** is `vehicleId` recycled after a car exits? The slot allocator is written to be correct either way, so it isn't blocking.

## 7. Editing + Run/Pause/restart
- [x] Raycast picking for edges and intersection nodes (via `userData.pick`, not mesh-name parsing); highlight selection with a per-mesh material clone, since the materials are shared singletons.
- [x] Options panel listing `options` for the selection; disabled while running; locked elements read-only.
- [x] Applying an option rebuilds only that edge **and its two end nodes** (a lane-count change rewires the connectors at both ends). `networkView` is now one subgroup per edge and per node so `rebuild()` can touch just those.
- [x] Layout hash; Run logic per CLAUDE.md, as the pure `decideRunAction(currentHash, lastRunHash)`.
- [x] Revert all.
- [x] MVP options: `widen`, `roadDiet`. **Roundabout options are offered but disabled with a reason** — rule 10 is unimplemented and compiling a selected roundabout throws, and the grid offers one on `n01`, `n02`, `n11`, `n22`. A test asserts it still throws, so the guard can't quietly rot.
- [x] **Compile bug found and fixed by the edit safety net** (see Log): widening an edge leaving a `diverge` left its new outermost lane unreachable.

**Done when:** pause → widen a section → Run restarts from empty with the new lane visible and cars using it. ✅ **Code done 2026-11-28, 671 tests green — pending Dev's click-through in the browser.**

## 8. Downtown import (`tools/import/`)
**Runs after steps 9 and 10** — the whole slice is proven on the test grid first, so the only new variable here is the data. Needs internet and a Python toolchain, and is the highest-variance step in the plan; the hard-case fixture from step 4 is what de-risks it in advance. Per PRD §14, if this step goes badly the test grid can carry the demo.
- [ ] `import_osm.py` per PRD §11: area polygon (Historic District core extended south to I-30), OSMnx pull with motorway excluded, projection, simplify/consolidate (never merge diamond signal pairs), clip with boundary/rampEnd nodes, classify, lanes with `estimated`, controls, restrictions (best effort), merge/diverge with `branch.side`, points, parking capacity estimate, option generation, raw `tags`/`osmIds`.
- [ ] `overrides.json` applied last; lunch zones live there.
- [ ] Validation before writing (same checks as step 4).
- [ ] `README.md` with setup (venv, `pip install osmnx shapely pyproj`) and run instructions.
- [ ] Render it; fix problems via overrides; send `downtown-dallas.scenario.json` (+ compiled) to Sashank.

**Done when:** downtown loads, passes validation, compiles, and looks right in the browser.

## 9. Integrate the real engine
**Mostly absorbed into step 6** — the real worker is already wired and is the default. What's left here is confirming it in the browser and fixing whatever that surfaces.
- [x] Swap stub → Sashank's worker on the test grid. Done in step 6; `?engine=stub` selects the fallback.
- [ ] Fix contract mismatches together (no silent changes to `shared/`).
- [ ] Downtown comes later, as part of step 8.

**Done when:** the **test grid** runs the morning preset with Sashank's engine, cars stop at signals, and edits work.

## 10. Heatmap + HUD
- [x] Per-lane color from `stats`, blended through the three stops. **An empty lane is not a fast lane:** `engine/src/stats.ts` reports `speedRatio = 1` for a path with no cars, so the heatmap keys "no data" off `occupancy`, not speed. Without that the whole map paints green at night and before warm-up.
- [x] HUD: preset picker, Run/Pause, speed 1×/2×/4× (the contract allows 2× and it's the same code), Skip 5 min, Reset, Revert all, heatmap toggle, sim clock, metrics counts, attribution from `scenario.meta.attribution` rather than hardcoded.
- [x] **A preset change counts as a layout change** for Run semantics — otherwise switching morning → night would resume the morning run under a night label. `decideRunAction` now takes both.
- [x] Heatmap materials are per-mesh clones created once and mutated in place; the shared singletons in `materials.ts` are never touched. Base materials are captured at bind time, not lazily, so a lane that is selected when the first `stats` lands doesn't get its highlight clone recorded as its base.

**Done when:** congestion visibly builds and clears in the morning preset **on the test grid**. ✅ **Code done 2026-11-28, 703 tests green — pending Dev's confirmation in the browser. ← MVP complete** (downtown is step 8, after this).

## 11. Polish (after MVP)
- [ ] **Per-type vehicle meshes** from `shared/vehicles.ts` (car / box truck / semi), sized by the shared `length`/`width` so they match the gaps the engine leaves. Read the type from tick flag bits 3-4. For long vehicles, place the rear at `s − length`, walking back onto the previous path (invert `next` for predecessors; take *which* predecessor from the previous tick) so trailers follow turns rather than cutting corners.
- [ ] Lane-marking `ShaderMaterial` (lane lines, edge lines, bike green, transit red, stop bars).
- [ ] Ramps at real elevation; freeway mainlines; buildings (extruded); parks.
- [ ] Remaining options: bike/transit lanes, left-turn lane, two-way/one-way, car-free; roundabout, all-way stop, protected-left, yield (compile rule 10 + phases).
- [ ] Preset lighting (morning / afternoon / night with headlights).
- [ ] Scoring from `metrics` (PRD §9.2).
- [ ] Demo scenario: find and bookmark the added-lane trap location.

---

## Log
_Add a line per session: date, what got done, anything blocked._

- **2026-11-23** — Step 1 done on `dev/scaffold`: single-package Vite + TS (strict) app, `@shared`/`@engine`/`@web` aliases in tsconfig + vite, PRD §6 folders, scripts (`compile`/`sim` are stubs), Three.js canvas with OrbitControls + ground plane fetching `test-grid.scenario.json` (logs 22 nodes, 25 edges), `.gitignore`, Vitest smoke test over the starter JSON files. `npm run typecheck` and `npm test` pass; dev server serves `/data/*` via a small Vite plugin (data lives outside the Vite root). Pinned `vitest@^3` — `vitest@>=4` crashes npm 10.9.2's installer (`edgesOut`); revisit after an npm upgrade, which also clears the dev-only tinypool/mocker advisories. Rendering confirmed over HTTP only (page, module and scenario all 200) — Dev to eyeball the canvas. Next: tell Sashank the layout exists, then step 2 (`shared/` contract types).

- **2026-11-23 (later)** — Step 2: `shared/{common,scenario,network,preset,messages}.ts` written against PRD §7, full spec including roundabout/protected-left/yield controls and params (deferred compiles, not deferred types). `shared/contract.test.ts` validates all five starter files — every enum against its `const` array, every ID reference, phase/control consistency, point access, trip shares, and the tick/stats buffer round-trip. 30 tests pass, typecheck clean. Two findings: (a) `network.nodes` excludes boundary/rampEnd nodes, so `LanePath.fromNode` can name a node with no `CompiledNode` — now documented and tested; (b) PRD §7.4 rule 10 doesn't say what `from`/`to`/`turn` hold for roundabout *ring* connectors, flagged for Sashank, blocks nothing before step 11. Also collapsed `engine/` into the root package per Dev — `engine/README.md` tells Sashank to drop his `engine/package.json`, `tsconfig.json` and lockfile on merge, and `web/test/aliases.test.ts` proves `@shared`/`@engine` resolve. Not blocking on sign-off: moving to step 3.

- **2026-11-23 (contract fix)** — `flowstate-network` **v2**: added required `ConnectorPath.stop` after Sashank's review. §8.4 needs a full stop at `allStop` nodes and on the minor approaches of a `yield` node, but `majorEdges` lives in the scenario and never reaches the engine, and `yieldTo` can't stand in (a minor right turn with no conflict has an empty `yieldTo` and still faces a sign). Verified first that `make_sample.py` reproduces all five starter files byte-identically, then patched it to emit `stop` (plus rule 9 `yieldTo` for yield nodes, which the test grid doesn't exercise) and regenerated the golden — diff is exactly 12 `true` at `n02`, 81 `false`, and the version bump. Version bumped per §7.1 because a required field makes v1 files unreadable. Also tightened `CompiledPoint.type` from `string` to the `PointType` union. New tests: `stop` is boolean everywhere and true exactly at `allStop`, and all connectors leaving one lane agree on it (a car stops at the stop line before choosing a connector, so disagreement would be unsimulatable). Note for the record: `stop` is only strictly *necessary* for `yield` — `allStop` was already derivable from `CompiledNode.control`. Checked and found fine: the 5 permissive lefts with empty `yieldTo` are all lefts off one-way streets, so there is no oncoming traffic. Still open for Sashank: PRD rule 10 doesn't define `from`/`to`/`turn` for roundabout ring sections. 43 tests pass.

- **2026-11-23 (step 3)** — Geometry module ported from `make_sample.py` by a Sonnet subagent, reviewed by Opus. `web/src/geometry/{vec2,polyline,laneLayout,connector,arcLength,index}.ts`, no Three.js or DOM. 185 new tests, 228 total, typecheck clean. Verified independently (not just via the agent's own suite): all 54 lane paths and all 93 connectors rebuilt from the scenario and diffed against the golden at **every** point, plus connector lengths, which the agent hadn't checked. Worst cases: lane length 0.0050 m, lane point 0.0047 m, connector sample 0.0066 m, connector length 0.0043 m. Those equal the golden file's 2 dp rounding quantum (0.005, or 0.005·√2 for a 2D distance), so the port is exact and the residual is only rounding — on that basis I tightened the test tolerance from the plan's 0.05 m to **0.01 m**. Ported quirks preserved on purpose: averaged-normal offset with no `1/cos(θ/2)` correction, `trim` past the end yielding a single-point polyline, and the midpoint-control Bézier that reduces to a straight line. One deliberate divergence: `laneCenterlines` honors a per-lane `width` override (PRD §7.1) where the reference always uses the type default; no effect on the golden, may matter for downtown. **For step 4:** the reference rounds each lane's `debugPolyline` to 2 dp and then derives connector headings and control points from the *rounded* points, so rounding must happen before connector geometry or connector lengths will drift. Also `round2` is half-even (Python's `round`), not JS half-up.

- **2026-11-23 (resequencing)** — Dev's call: build and prove everything on `test-grid` first, load Dallas only afterwards. Step 8 (downtown import) moves after steps 9 and 10; MVP is now redefined as steps 1–7, 9, 10 on the test grid. Step numbers deliberately left alone so existing references in code comments, commits and this Log stay valid. Logged the ceiling of this approach in the header — the test grid has only 2 bent edges out of 25, no node above 4 approaches, and no roundabout/yield/protected-left selected, so compile rules 8 and 10 and all curve handling stay unexercised by the golden file. Added a hard-case fixture to step 4 as the mitigation, so that gap gets probed on 11/24 instead of 11/29.

- **2026-11-25 (contract)** — `shared/vehicles.ts` added for vehicle types (car 4.5 m, box truck 9 m, semi 18 m) at Sashank's request, so engine gaps and front-end meshes use one set of lengths. Type code rides in tick flag bits 3-4 — `TICK_STRIDE` unchanged, and code 0 = car keeps today's senders correct with no change. `Preset.vehicleMix` is optional (absent = all cars), so no preset version bump and the starter files are untouched. Also recorded that **`s` is the front bumper**: drawing long vehicles later needs predecessor links, which the compiled network doesn't carry (`next` only — invert it), and needs *which* predecessor a vehicle came from, which only the previous tick knows. Noted in `messages.ts`, PRD §7.6 and step 11 rather than changing the contract, since the front end can resolve both itself. 263 tests.

- **2026-11-27 (step 4)** — Compile step done: `web/src/compile/{movements,lanePaths,connectors,conflicts,control,points,compile,validate,index}.ts`, `tools/compile-cli.ts`, and 242 new tests across `web/test/compile/{golden,options,validate}.test.ts`. 566 tests total, typecheck clean. Ported by two Sonnet subagents in parallel (core port; validation helper + hard-case fixture), reviewed by Opus against the Python reference line by line.

  **Verified independently, not just via the agents' own suites.** Re-confirmed first that `make_sample.py` still reproduces all five committed starter files byte-identically, which is what makes a byte-comparison meaningful. Then diffed the TypeScript output against the golden field by field with my own script — including path *order* (so `index` matches), `conflicts`/`yieldTo` as both sets and counts (to catch duplicates), phase ordering, node/point ordering, and worst-case deltas. Result: **0 differences, 0.000000 m worst case** on lengths, polyline points and point-access `s`. Re-serialized through Python at the same indent, the whole 2853-line diff is nothing but `82` vs `82.0` — JSON has no int/float distinction, so the files parse equal (`json.load` equality `True`) and key order matches too. Determinism checked by compiling three times and comparing md5; no `Math.random`/`Date.now`/`performance.now` anywhere in the compile path. Validator teeth checked with my own 10 mutations of the real network (severed lanes, unreachable spawn, flipped `stop`, dangling id, shuffled paths, unknown phase, negative speed limit, out-of-range `s`, bumped version, plus a no-op control) — all caught, control silent.

  **Changes I made on top of the agents' work:** (1) implemented `signalProtectedLeft`, which the port had stubbed to throw — the axis comes from the arrival heading and a left goes to `${axis}-left`, so PRD §8.4's "no permissive yields" falls out of the phase split instead of being special-cased (a protected left shares its phase with no through or right movement, so the existing yield rule simply never fires); (2) added `web/test/compile/options.test.ts`, 13 tests covering what the golden structurally cannot, by flipping `selected` the way step 7's panel will — the golden only pins `current`, which selects `signal`/`allStop`/`merge`/`none` and never exercises rules 8, 9 or 10; (3) deselected the fixture's roundabout, since rule 10 throws by design, and left the option in place with a `tags` note so nobody re-selects it without implementing the ring; (4) gave the fixture's protected-left node a cross street — it had two collinear arms, so no left turn was geometrically possible and the node compiled to a single through-only phase, i.e. rule 8 was being "covered" vacuously; it now produces all four phases populated; (5) added a `point-no-access` check for a spawn/sink that resolves to no lane (no instance today, but a one-way boundary edge in the downtown import produces exactly that); (6) made the CLI validate after compiling and exit non-zero on errors.

  **For step 5+:** the compiled network is now generated by our own code, and it is byte-equal to the file Sashank's engine tests load. That makes a compile bug our bug in *his* suite too, so the committed `data/compiled/test-grid.compiled.json` should stay reference-generated until there's a reason to change it — the golden test is what keeps the two honest. `laneCenterlines` honoring a per-lane `width` override is now exercised by the fixture rather than only by a comment.

### Log — 2026-11-28, step 7

The step-7 safety net (widen, then roadDiet, on **every** edge of the grid, each
compiled and validated) earned its keep immediately: it found a real bug in
`compile/connectors.ts` that steps 4-6 could not have caught, because the
golden file only ever exercises the `current` layout.

`buildMergeDiverge`'s through-connector loop indexed the outgoing lane by the
*incoming* lane's index, so any outgoing lane past the last incoming one was
never wired to anything. Widening `eF0` (which leaves the `D` diverge) from 2
to 3 lanes therefore produced `L/eF0/f/2: unreachable-lane` — a lane drawn on
screen that no car could ever enter. `buildIntersection` already handled this
by fanning the outermost source lane across the extras; merge/diverge now does
the same. The equivalent `merge` case (`eF4`) didn't reproduce it only by
luck: `merge`'s branch-ramp loop wires the ramp into every mainOut lane and
incidentally covered the gap.

`tools/reference/make_sample.py` has the same gap. **The golden file is
unaffected and still compiles byte-identically** — every merge/diverge in the
default layout has at least as many incoming main lanes as outgoing, so the
new branch never fires there. It fires only on a player edit, which is exactly
why no earlier step saw it.

Regression test lives in `web/test/compile/options.test.ts` alongside the other
non-golden option coverage, not only in the UI suite that happened to find it.

---

## Look pass (2026-11-28) — scenery, lighting, terrain

Pulled forward from step 11 because the demo's frame is "pick a time of day"
and all three looked identical.

- Scenery (buildings, parks, freeway) was sitting unused in every scenario and
  is now rendered. Buildings extrude via `Shape` + `ExtrudeGeometry`, so
  non-convex downtown footprints are safe.
- `preset.lighting` was also unused. Morning / afternoon / night now differ in
  sun, ambient, background and fog, and switch immediately on preset change
  (a look change, not a sim change). Night fakes headlights with additive
  instanced quads rather than thousands of real lights.
- `theme.ts` holds every colour and dimension; `lil-gui` panel on `g` tunes it
  live and can copy the tuned values back out as source.
- **The ground is a heightfield, not a flat quad with holes cut in it.** The
  first attempt cut one polygon hole per corridor, which earcut cannot
  triangulate once a ramp's hole overlaps the freeway's. Each vertex instead
  takes the *minimum* height across all corridors, so overlap is `Math.min`
  of two numbers and the seam is correct by construction.
- **Any edge that goes below grade gets its own cut**, with a floor following
  its elevation — not just the freeway. The freeway-only version left ~60% of
  each ramp buried: a ramp descends 0.25 m per metre of northing while the
  trench bank descends 0.5, so they crossed at y = −16 and everything north of
  that was under the surface. Verified by dense sampling along both ramps;
  the ground is now at or below the road everywhere (worst case 0.25 m below).
  This generalises to downtown, where the I-30 ramps need the same treatment.

---

## Known problems to fix (raised by Dev, 2026-11-28)

These are confirmed from use, not speculation. Both are scheduled after the
look pass.

### P1. After an edit, the map takes far too long to repopulate
**Symptom:** edit a road, press Run, and you wait a long time before there is
enough traffic to judge whether the change helped.

**Cause (diagnosed, not yet fixed):** warm-up is `skip(realSeconds ×
playbackSpeed)` = `5 × 2` = **10 sim seconds**. That is almost nothing — the
morning spawn curve doesn't peak until t ≈ 900 s. So every run restarts at an
essentially empty map and you wait in real time for demand to build.

**Proposed fix — skip to the *previous run's* sim time, not a fixed 10 s.**
If you paused at t = 900 s to make an edit, the new run should fast-forward to
t = 900 s before handing back control. That is both (a) much faster to a
useful state and (b) *more correct for the A/B comparison the whole app is
about*: you compare the two layouts under the same demand, instead of
comparing a busy old run against a nearly-empty new one. Keep a floor (a
minimum warm-up for the very first run) and expose it so the demo can skip
straight to a chosen busy moment.

Needs measuring first: `skip` runs without emitting ticks, but 900 s is 9,000
steps at ~1,000 cars — confirm that is a short pause, not a hang, before
wiring it to a button.

### P2. The heatmap doesn't show anything readable or valuable
**Symptom:** it technically works (colours come from real `stats`) but reading
congestion off it is hard and it doesn't earn its place.

**Candidate causes, in rough order of likely impact** — to be checked against
the real thing rather than assumed:
1. **It colours the wrong quantity.** `speedRatio` is near 1 for most lanes
   most of the time; the interesting signal is the *queue* at an approach,
   which is `queueLengthM` / `occupancy` — both already in the stats buffer
   and both currently unused.
2. **It's instantaneous.** Per-second mean speed flickers. A short rolling
   average would read as congestion rather than noise.
3. **It's physically hard to see.** The tint goes on the lane surface, which
   is a 3.5 m ribbon viewed from ~700 m, largely covered by cars and lane
   lines. An overlay *above* the road, or a widened band, would read far
   better than tinting asphalt.
4. **Low contrast** against dark asphalt and dark cars.

Worth considering a different visual entirely (a raised glowing band per
approach, or per-node delay indicators) rather than only re-tuning the colours.

