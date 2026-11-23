# engine/ — Sashank's traffic simulation

**Owner: Sashank.** Dev does not edit anything in this folder.

The engine is TypeScript running in a Web Worker (and headless in Node for
tests). It must not import Three.js and must not touch the DOM.

It receives a **compiled network** plus a preset and moves cars by distance along
paths, reporting `(pathIndex, s, speed, flags)` per car. It never computes a
coordinate — the front end owns all geometry.

- Contract types and the message protocol live in `shared/` (changes need both owners' agreement).
- `src/index.ts` is a placeholder so `@engine/*` imports resolve.
- Until this engine is ready the front end runs against `web/src/sim/stubEngine.ts`.

## Layout
- `src/idm.ts` — Intelligent Driver Model car following (PRD §8.2), fixed dt = 0.1 s.
- `src/ring.ts` — S1 test bed: single-lane 1 km ring where one slow car triggers a stop-and-go wave.
- `src/network.ts` — S2 loader: validates a compiled network (v2) and builds index-based arrays (`length`, `speedLimit`, `next`, `prev`, …).
- `src/traffic.ts` — S2 cars on routes: per-path occupancy, leader lookup along the route across path boundaries, braking for slower paths ahead, `stepCars`.
- `test/*.test.ts` — Vitest suites (run by the root `npm test`).
- `test/wave.ts` — headless space-time diagram of the ring road.

## Commands (from the repo root)
- `npm test` — all tests, including the engine's.
- `npm run typecheck` — covers `engine/src` and `engine/test`.
- `npx tsx engine/test/load.ts [file]` — load a compiled network (default: the test grid) and print its counts, or the validation error.
- `npx tsx engine/test/wave.ts [--cars 60] [--seconds 600] [--row 10]` — print the S1 wave diagram.
  Inside a sandbox that blocks local pipes, use `node --import tsx engine/test/wave.ts` instead.
