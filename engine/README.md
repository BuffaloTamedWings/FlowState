# engine/ — Sashank's traffic simulation

**Owner: Sashank.** Dev does not edit anything in this folder.

The engine is TypeScript running in a Web Worker (and headless in Node for
tests). It must not import Three.js and must not touch the DOM.

It receives a **compiled network** plus a preset and moves cars by distance along
paths, reporting `(pathIndex, s, speed, flags)` per car. It never computes a
coordinate — the front end owns all geometry.

## This folder has no build config of its own

`engine/` is part of the **root package**. There is one `package.json`, one
`tsconfig.json`, one Vitest install and one `node_modules/` for the whole repo,
so `npm run typecheck` and `npm test` at the root cover both halves of the
project and integration problems show up in one command.

The root config already includes `engine/src` and `engine/test`. So:

- **don't add** `engine/package.json`, `engine/tsconfig.json`,
  `engine/package-lock.json`, or a separate `engine/node_modules/`
- run `npm install`, `npm test`, `npm run typecheck` from the repo root
- add engine-only scripts to the root `package.json` (`npm run sim` is reserved
  for the headless harness and is currently a placeholder)

If you had a local `engine/package.json` + `engine/tsconfig.json` +
`engine/package-lock.json`, delete those three when you merge; everything they
configured is in the root versions. The root compiler options are a superset of
what was there (`strict`, `noUncheckedIndexedAccess`, `isolatedModules`,
ES2022/bundler), so the code itself shouldn't need changes.

## Importing the contract

The contract types live in `shared/` and are reachable through the `@shared`
alias from anywhere in the repo:

```ts
import type { CompiledNetwork, LanePath } from '@shared/network.js';
import { SIM_DT, TICK_STRIDE, writeTickCar } from '@shared/messages.js';
```

`SIM_DT` (0.1 s) and the tick/stats buffer offsets are defined once in
`shared/messages.ts` — import them rather than redeclaring, so the two sides
cannot drift. `shared/` is jointly owned: changes need both owners' agreement.
