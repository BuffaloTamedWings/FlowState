# Scenarios

`flowstate-scenario` files (PRD §7.2). Don't hand-edit generated outputs — see the project's `CLAUDE.md` for ownership rules.

- `test-grid.scenario.json` — hand-made 3x3 grid used to build and prove the app end to end before any OSM data is loaded. 22 nodes, 25 edges. Its compiled golden output lives at `../compiled/test-grid.compiled.json`.
- `hard-case.scenario.json` — hand-written fixture (step 4) exercising what `test-grid` can't: multi-vertex curved centerlines (including a tight bend), a 5-way intersection, a selected `yield` node with `majorEdges`, a selected `signalProtectedLeft` node, an edge with `elevation`, a per-lane `width` override, a one-way edge, a lane with pinned `turns`, a node `restrictions` entry, and a `merge`/`diverge` pair with `branch`. A roundabout option is **offered but not selected**: PRD §7.4 rule 10 (the ring) is deferred to step 11, and compiling a selected roundabout throws on purpose. No golden compile exists for it — the point is that it compiles and validates without crashing or producing dead lanes.
- `downtown-dallas.scenario.json` (step 8, later) — real OSM import of the Historic District core, produced by `tools/import/import_osm.py`.
