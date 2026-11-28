/**
 * Web Worker entry point for the stub engine. All the logic is in
 * `StubHost` (`stubHost.ts`); this file only wires it to the worker's
 * message port and clock, mirroring `engine/src/worker.ts`'s relationship
 * to `EngineHost`.
 */
import type { EngineToUI, UIToEngine } from '@shared/messages.js';

import { StubHost } from './stubHost.js';

const port = self as unknown as {
  postMessage(message: EngineToUI, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<UIToEngine>) => void) | null;
};

const host = new StubHost({
  post: (message, transfer) => port.postMessage(message, transfer),
  now: () => performance.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

port.onmessage = (e) => host.handle(e.data);
