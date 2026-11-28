/**
 * The front end never talks to a `Worker` directly — it talks to an
 * `EngineTransport`. That's what lets the real engine worker
 * (`workerTransport.ts`), the stub worker (`stubTransport.ts`) and the
 * in-process test harness (`web/test/sim/engineClient.test.ts`, which wraps
 * Sashank's `EngineHost` with a fake clock) all plug into the same
 * `EngineClient` unchanged.
 */

import type { EngineToUI, UIToEngine } from '@shared/messages.js';

export interface EngineTransport {
  /** Send a message to the engine. `transfer` lists buffers to hand over rather than copy. */
  post(message: UIToEngine, transfer?: Transferable[]): void;
  /** Registers the (single) handler for messages coming back from the engine. */
  onMessage(handler: (message: EngineToUI) => void): void;
  /** Releases whatever resource backs this transport (a worker, mainly). */
  terminate(): void;
}
