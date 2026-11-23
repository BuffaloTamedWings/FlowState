# FlowState

Browser-based 3D traffic sandbox of downtown Dallas (CS 4366 graphics class project). The player picks a time of day (Morning / Afternoon / Night), watches traffic, pauses, swaps road sections and intersections between preset options, and runs again to see the ripple effects. Demo: Dec 1 / Dec 3, 2026.

## Current phase: test grid first
Everything is built and proven on `data/scenarios/test-grid.scenario.json` before any Dallas data is loaded — the downtown import (plan step 8) runs after the full slice works end to end. Don't reach for downtown data or the import pipeline unless the work is explicitly step 8. The test grid's blind spots (almost no curves, no node above 4 approaches, no roundabout/yield selected) are listed at the top of `docs/frontend-plan.md`; a hand-written hard-case fixture in step 4 stands in for real data until then.

## Read first
- `FlowState-PRD.md` — the spec. §7 is the data contract both halves code against. §7.4 has the compile rules.
- `docs/frontend-plan.md` — Dev's step-by-step plan with progress checkboxes. **Check it at the start of a session to see where we are; tick items off as they're finished.**
- `tools/reference/make_sample.py` — reference implementation (Python) of the compile rules and option catalog. Port its logic to TypeScript; never import or call it from app code.
- `data/` — starter files: `scenarios/test-grid.scenario.json`, `compiled/test-grid.compiled.json` (the golden compile output), `presets/*.json`.

## Team and ownership
| Area | Owner | Rule |
|---|---|---|
| `web/` (rendering, UI, geometry, compile, scoring), `tools/import/`, `tools/compile-cli.ts` | **Dev** (this is who you're working with) | Edit freely. |
| `engine/` (traffic sim, Web Worker) | **Sashank** | **Don't edit** unless Dev explicitly asks. The front end uses a stub engine (`web/src/sim/stubEngine.ts`) until Sashank's is ready. |
| `shared/` (contract types, message protocol) | Both | Changes need Sashank's agreement. If a change seems necessary, stop and tell Dev instead of making it silently. |
| `data/` | Generated or starter files | Don't hand-edit outputs. Downtown hand fixes go in `tools/import/overrides.json`. |

## Architecture rules (don't break these)
- **The front end owns all geometry.** The engine never computes coordinates. It reports each car as `(pathIndex, s, speed, flags)` and the front end converts to x/y with its own curves.
- On Run, the front end **compiles** the scenario + selected options into a compiled network (lanes, connectors, lengths, conflicts, phases) and sends it to the engine. That compiled network is the only interface between the two sides.
- `web/src/geometry/` and `web/src/compile/` must **not import Three.js or touch the DOM**, so they run in Node for `tools/compile-cli.ts` and tests.
- `engine/` must not import Three.js or touch the DOM.
- Run semantics: if the layout or preset changed since the last run → compile, `load`, `run` (restart from empty, same seed). Otherwise → `run` (resume). Editing is only allowed while paused.

## Conventions
- Units: meters, seconds, m/s. Never mph in data or code (convert at the UI only).
- Coordinates: local meters, **x = east, y = north, z = up**. Three.js mapping: `(x, y, z)` → `new Vector3(x, z, -y)`.
- Edge = one road section between two nodes, both directions. `forward` lanes go `from`→`to`; one-way streets have empty `backward`.
- Lane order: **left to right in the direction of travel, index 0 = leftmost.** Two-way lanes sit right of the centerline per direction; one-way lanes are centered.
- Path IDs: lanes `L/{edge}/{f|b}/{laneIndex}`, connectors `C/{node}/{fromLane}>{toLane}` (without the `L/` prefixes). A path's position in `paths` is its `index`.
- Unknown fields in any JSON must be ignored, never treated as errors. `estimated` flags mark guessed values; `tags` hold raw OSM data.
- Car interpolation happens in **x/y**, not in `s` (a car can switch paths between ticks).
- Determinism matters: same network + preset + seed must produce the same run. Don't introduce `Math.random()` in anything that feeds the sim.

## Commands
- `npm run dev` — Vite dev server for the app
- `npm run build` — production build
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — Vitest (includes the golden compile test once it exists)
- `npm run compile -- <scenario.json> [out.json]` — scenario → compiled network (Node, via `tsx`)
- `npm run sim -- ...` — Sashank's headless harness (engine side)
- Import (Python, needs internet): `python tools/import/import_osm.py` — see `tools/import/README.md`

## Testing expectations
- Geometry and compile changes must keep the **golden test** passing: compiling `data/scenarios/test-grid.scenario.json` must match `data/compiled/test-grid.compiled.json` (same path IDs, same `next` links, lengths within 0.05 m).
- Run `npm run typecheck` and `npm test` before calling a step done.
- For visual work, describe what should be visible so Dev can confirm in the browser; don't claim it looks right without checking.

## Agents
- Opus orchestrates; the actual work — coding, research, searching the codebase — gets delegated to **Sonnet** subagents to save tokens and usage limits. Spawn the plain `general-purpose` agent with `model: "sonnet"` and a specific prompt. Don't reach for persona or specialist agent types; the prompt carries the instructions.
- Subagents start cold, so each prompt must be self-contained: the files to touch, the relevant PRD section or plan step, the conventions that apply, and what "done" looks like (usually `npm run typecheck` + `npm test`).
- Opus keeps the design decisions, contract calls, review of what comes back, and anything touching `shared/`. If a task needs Opus-level reasoning, Dev will say so in chat.

## Git
- Dev works on a local feature branch; Sashank on his own. Merge to `main` via PRs.
- Small commits with clear messages. Don't push unless Dev asks.
- Never commit `node_modules/`, build output, or Python virtualenvs.
