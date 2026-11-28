/**
 * Public surface of the sim module (step 6 of `docs/frontend-plan.md`).
 *
 * `createTransport` is the swap point between the real engine and the stub:
 * one line (the default below) decides which runs. `main.ts` picks via the
 * `?engine=stub` URL query parameter, defaulting to `'worker'` — the real
 * engine is finished and is the primary target; the stub is the fallback.
 */

export type { EngineTransport } from './transport.js';
export { createWorkerTransport } from './workerTransport.js';
export { createStubTransport } from './stubTransport.js';

export type { EngineClientOptions, TickFrame } from './engineClient.js';
export { EngineClient } from './engineClient.js';

import type { EngineTransport } from './transport.js';
import { createStubTransport } from './stubTransport.js';
import { createWorkerTransport } from './workerTransport.js';

export type TransportKind = 'worker' | 'stub';

/** The swap point: change this default to flip which engine `main.ts` uses by default. */
export function createTransport(kind: TransportKind = 'worker'): EngineTransport {
  return kind === 'stub' ? createStubTransport() : createWorkerTransport();
}
