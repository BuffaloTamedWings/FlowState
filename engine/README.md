# engine/ — Sashank's traffic simulation

**Owner: Sashank.** Dev does not edit anything in this folder.

The engine is TypeScript running in a Web Worker (and headless in Node for tests).
It must not import Three.js and must not touch the DOM.

It receives a **compiled network** (`shared/network.ts`) plus a preset and moves cars
by distance along paths, reporting `(pathIndex, s, speed, flags)` per car. It never
computes a coordinate — the front end owns all geometry.

- Contract types and the message protocol live in `shared/` (changes need both owners' agreement).
- `src/index.ts` is a placeholder so `@engine/*` imports resolve.
- Until this engine is ready the front end runs against `web/src/sim/stubEngine.ts`.
