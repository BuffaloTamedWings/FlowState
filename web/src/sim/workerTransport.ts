/**
 * Wraps Sashank's real engine worker (`engine/src/worker.ts`) as an
 * `EngineTransport`. The `new Worker(new URL(...))` form below is copied
 * verbatim from that file's own header comment, which documents the exact
 * client usage it expects.
 */

import type { EngineToUI } from '@shared/messages.js';

import type { EngineTransport } from './transport.js';

export function createWorkerTransport(): EngineTransport {
  const worker = new Worker(new URL('../../../engine/src/worker.ts', import.meta.url), { type: 'module' });

  let handler: ((message: EngineToUI) => void) | null = null;

  worker.onmessage = (e: MessageEvent<EngineToUI>) => {
    handler?.(e.data);
  };

  // A worker that fails to start (bad import, syntax error, ...) fires `error`
  // on the Worker object itself, not as an engine message. Surface it as one
  // anyway so a dead worker is visible in the UI instead of silently inert.
  worker.onerror = (e: ErrorEvent) => {
    handler?.({ type: 'error', message: e.message || 'engine worker failed to start' });
  };

  return {
    post(message, transfer = []) {
      worker.postMessage(message, transfer);
    },
    onMessage(h) {
      handler = h;
    },
    terminate() {
      worker.terminate();
    },
  };
}
