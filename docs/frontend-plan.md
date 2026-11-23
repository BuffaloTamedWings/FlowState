# Front-end plan (Dev)

Steps from empty repo to the MVP, then polish. Each step has a **Done when** check. Tick boxes as work lands. Spec references are to `FlowState-PRD.md`.

**MVP** = steps 1–10: downtown map, cars through signals, morning preset, lane-count options (`widen`, `roadDiet`), Run/Pause/edit with restart, heatmap.

| Target date | Steps |
|---|---|
| Mon 11/23 | 1, 2 |
| Tue 11/24 | 2 (sign-off), 3, 4 |
| Wed 11/25 | 5, 6, start 8 |
| Thu 11/26 | 8 |
| Fri 11/27 | 7, 9 (test grid) |
| Sat 11/28 | 9 (downtown), 10 |
| Sun 11/29 – Mon 11/30 | 11, rehearsal |

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
- [ ] Polyline helpers: length, offset (averaged normals), trim from both ends, point + tangent at distance `s`.
- [ ] Lane layout per edge option: widths, offsets, two-way vs one-way placement, lane index = full-direction index.
- [ ] Node setbacks (intersection 12 m, merge/diverge 8 m, boundary/rampEnd 0, roundabout radius + 6 m).
- [ ] Connector curve: quadratic Bézier from lane end to lane start, control point at the tangent intersection, straight fallback; sampled polyline.
- [ ] Arc-length lookup table per path for fast `(s) → (x, y, heading)`.

**Done when:** unit tests reproduce a few lane endpoints and lengths from the starter compiled file.

## 4. Compile step (`web/src/compile/`) + `tools/compile-cli.ts`
- [ ] Port PRD §7.4 rules 1–9 from `tools/reference/make_sample.py`: lane paths, movement classification, lane turn assignment, lane-entry mapping (single-lane fan-out), merge/diverge, conflicts, signal phases, yields, point access.
- [ ] Rule 10 (roundabout ring) and protected-left / yield compiles — can wait until step 11, but leave clear TODOs.
- [ ] Deterministic output ordering (same input → byte-identical JSON).
- [ ] CLI: `npm run compile -- data/scenarios/test-grid.scenario.json out.json`.
- [ ] **Golden test** vs `data/compiled/test-grid.compiled.json`: same path IDs and order, same `next`, lengths within 0.05 m, same conflicts/yields/phases.
- [ ] Validation helper: no dead-end lanes, no unreachable lanes, every spawn reaches a sink (same checks as the reference).

**Done when:** golden test passes.

## 5. First render of the test grid (`web/src/render/`)
- [ ] Lane ribbons from geometry (one mesh per lane path, flat at z unless `elevation`).
- [ ] Intersection fill polygons.
- [ ] Simple lane-line rendering (plain lines are fine; the shader comes in step 11).
- [ ] Camera framed on `meta.bounds`.

**Done when:** the test grid in the browser matches `test-grid-preview.png`.

## 6. Stub engine + car rendering
- [ ] `web/src/sim/engineClient.ts` — starts a worker, sends `load`/`run`/`pause`/`setSpeed`/`skip`/`reset`, receives `tick`/`stats`/`metrics` per `shared/messages.ts`.
- [ ] `web/src/sim/stubEngine.ts` — worker that spawns fake cars at spawn points and moves them along random valid `next` paths at the speed limit; sends ticks in the real buffer layout. Seeded.
- [ ] `InstancedMesh` cars, slot per `vehicleId`; position via arc-length lookup; interpolate between the last two ticks in x/y; heading from tangent; brake-light flag.
- [ ] Swap point: one line to choose stub vs real engine.

**Done when:** ~1,000 stub cars move smoothly across lanes and turns at 60 FPS.

## 7. Editing + Run/Pause/restart
- [ ] Raycast picking for edges and intersection nodes; highlight selection.
- [ ] Options panel listing `options` for the selection; disabled while running; locked elements show as read-only.
- [ ] Applying an option rebuilds only that edge and its two end nodes' meshes.
- [ ] Layout hash; Run logic per CLAUDE.md (changed → compile + `load` + `run` with warm-up 2× for 5 s; unchanged → `run`).
- [ ] Revert all.
- [ ] MVP options: `widen`, `roadDiet`. Others can display but may be disabled until step 11.

**Done when:** pause → widen a section → Run restarts from empty with the new lane visible and cars using it.

## 8. Downtown import (`tools/import/`)
- [ ] `import_osm.py` per PRD §11: area polygon (Historic District core extended south to I-30), OSMnx pull with motorway excluded, projection, simplify/consolidate (never merge diamond signal pairs), clip with boundary/rampEnd nodes, classify, lanes with `estimated`, controls, restrictions (best effort), merge/diverge with `branch.side`, points, parking capacity estimate, option generation, raw `tags`/`osmIds`.
- [ ] `overrides.json` applied last; lunch zones live there.
- [ ] Validation before writing (same checks as step 4).
- [ ] `README.md` with setup (venv, `pip install osmnx shapely pyproj`) and run instructions.
- [ ] Render it; fix problems via overrides; send `downtown-dallas.scenario.json` (+ compiled) to Sashank.

**Done when:** downtown loads, passes validation, compiles, and looks right in the browser.

## 9. Integrate the real engine
- [ ] Swap stub → Sashank's worker on the test grid.
- [ ] Then downtown.
- [ ] Fix contract mismatches together (no silent changes to `shared/`).

**Done when:** downtown runs the morning preset with Sashank's engine, cars stop at signals, and edits work.

## 10. Heatmap + HUD
- [ ] Per-lane color from `stats` (`meanSpeed/speedLimit`: ≥0.7 green, 0.4–0.7 yellow, <0.4 red, blended).
- [ ] HUD: preset picker, Run/Pause, speed 1×/4×, Skip 5 min, Reset, Revert all, sim clock, "© OpenStreetMap contributors".

**Done when:** congestion visibly builds and clears in the morning preset. **← MVP complete**

## 11. Polish (after MVP)
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
