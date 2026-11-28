/**
 * Proves the heatmap is fed real data from a real run, not just synthetic
 * buffers: drives the real `EngineHost` (`@engine/host.js`) the same way
 * `web/test/sim/engineClient.test.ts` does -- an in-process `EngineTransport`
 * with a fake clock the test advances by hand -- loads the morning preset on
 * the test grid, runs long enough to collect several `stats` messages, and
 * asserts every one of them is well-formed and maps through the heatmap
 * without throwing or producing NaN.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EngineHost } from '@engine/host.js';
import { readPathStats, STATS_STRIDE, type EngineToUI, type StatsMessage, type UIToEngine } from '@shared/messages.js';
import { isLanePath, type CompiledNetwork } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';

import { speedRatioColor } from '@web/render/heatmap.js';
import { EngineClient } from '@web/sim/engineClient.js';
import type { EngineTransport } from '@web/sim/transport.js';

const dataDir = resolve(import.meta.dirname, '../../../data');
function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}
const grid = (): CompiledNetwork => readJson<CompiledNetwork>('compiled/test-grid.compiled.json');
const morning = (): Preset => readJson<Preset>('presets/morning.json');

/** Same trick as `web/test/sim/engineClient.test.ts`'s `FakeHostTransport`. */
class FakeHostTransport implements EngineTransport {
  private readonly host: EngineHost;
  private handler: ((message: EngineToUI) => void) | null = null;
  private time = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextTimerId = 1;

  constructor() {
    this.host = new EngineHost({
      post: (message) => this.handler?.(message),
      now: () => this.time,
      schedule: (fn, ms) => {
        const id = this.nextTimerId++;
        this.timers.push({ at: this.time + ms, fn, id });
        return id;
      },
      cancel: (handle) => {
        this.timers = this.timers.filter((t) => t.id !== handle);
      },
    });
  }

  post(message: UIToEngine): void {
    this.host.handle(message);
  }

  onMessage(handler: (message: EngineToUI) => void): void {
    this.handler = handler;
  }

  terminate(): void {
    // no-op
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.time = Math.max(this.time, t.at);
      t.fn();
    }
    this.time = end;
  }
}

describe('heatmap fed by a real run (morning preset, test grid)', () => {
  it('collects several well-formed stats messages and maps every one through the heatmap without throwing or producing NaN', async () => {
    const network = grid();
    const transport = new FakeHostTransport();
    const stats: StatsMessage[] = [];
    const client = new EngineClient({
      transport,
      onStats: (simTime, buf) => stats.push({ type: 'stats', simTime, buf }),
    });

    await client.load(network, morning(), 20261201);
    client.run();
    // 10 real seconds at the default 1x playback = 10 sim seconds -> at least
    // 10 `stats` messages (STATS_INTERVAL_SEC = 1), plus whatever the warm-up
    // skip already produced.
    transport.advance(10_000);

    expect(stats.length).toBeGreaterThanOrEqual(10);

    const lanePaths = network.paths.filter(isLanePath);

    for (const message of stats) {
      // Buffer is exactly pathCount * STATS_STRIDE floats.
      expect(message.buf.length).toBe(network.paths.length * STATS_STRIDE);

      for (const path of lanePaths) {
        const s = readPathStats(message.buf, path.index);

        expect(Number.isNaN(s.speedRatio)).toBe(false);
        expect(s.speedRatio).toBeGreaterThanOrEqual(0);
        expect(s.speedRatio).toBeLessThanOrEqual(1);
        expect(Number.isNaN(s.occupancy)).toBe(false);

        // Mirrors `heatmapView.ts`'s "no data" rule: an empty lane (occupancy
        // ~0) is left uncolored; everything else maps to a real, finite color.
        const ratio = s.occupancy > 1e-4 ? s.speedRatio : null;
        const color = speedRatioColor(ratio);
        if (ratio === null) {
          expect(color).toBeNull();
        } else {
          expect(color).not.toBeNull();
          expect(Number.isNaN(color!.r)).toBe(false);
          expect(Number.isNaN(color!.g)).toBe(false);
          expect(Number.isNaN(color!.b)).toBe(false);
        }
      }
    }
  });
});
