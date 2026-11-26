/**
 * Web Worker entry point for the traffic engine (S7). All the logic is in
 * `EngineHost`; this file only wires it to the worker's message port and clock.
 *
 * From the front end (e.g. web/src/sim/engineClient.ts):
 *
 *   const worker = new Worker(new URL('../../../engine/src/worker.ts', import.meta.url), { type: 'module' });
 *   worker.onmessage = (e: MessageEvent<EngineToUI>) => { ... };
 *   worker.postMessage({ type: 'load', network, preset, seed } satisfies UIToEngine);
 *   // wait for { type: 'ready' }, then:
 *   worker.postMessage({ type: 'run' });
 */
import type { EngineToUI, UIToEngine } from '@shared/messages.js';
import { EngineHost } from './host.js';

const port = self as unknown as {
  postMessage(message: EngineToUI, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<UIToEngine>) => void) | null;
};

const host = new EngineHost({
  post: (message, transfer) => port.postMessage(message, transfer),
  now: () => performance.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

port.onmessage = (e) => host.handle(e.data);
