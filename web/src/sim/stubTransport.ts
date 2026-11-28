/**
 * Wraps the stub engine worker (`stubEngine.ts`) as an `EngineTransport`,
 * the fallback half of the swap point in `index.ts`.
 */

import type { EngineToUI } from '@shared/messages.js';

import type { EngineTransport } from './transport.js';

export function createStubTransport(): EngineTransport {
  const worker = new Worker(new URL('./stubEngine.ts', import.meta.url), { type: 'module' });

  let handler: ((message: EngineToUI) => void) | null = null;

  worker.onmessage = (e: MessageEvent<EngineToUI>) => {
    handler?.(e.data);
  };

  worker.onerror = (e: ErrorEvent) => {
    handler?.({ type: 'error', message: e.message || 'stub engine worker failed to start' });
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
