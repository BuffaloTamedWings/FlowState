/**
 * Applies the congestion heatmap (`heatmap.ts`'s pure color logic) to the
 * lane meshes of a `NetworkView` (plan step 10).
 *
 * Only **lane** paths are colored — connectors are short and sit inside
 * intersections, where the plan says not to bother. Lane meshes are found by
 * name: `buildEdgeGroup` in `networkView.ts` names each lane mesh with its
 * `DrawableLane.id`, which equals the compiled `LanePath.id` for car lanes
 * (`L/{edge}/{dir}/{laneIndex}`); bike/transit lanes share the same naming
 * scheme but never appear in `CompiledNetwork.paths`, so they're naturally
 * skipped here.
 *
 * Materials: one cloned `MeshLambertMaterial` per lane mesh, created lazily
 * the first time that lane gets a color and reused (its `.color` is mutated
 * in place) for every later `update()` — never replaced, and the shared
 * singleton materials in `materials.ts` are never touched. This matters
 * because this runs every sim second (`STATS_INTERVAL_SEC`) with up to a few
 * thousand lanes at downtown scale.
 *
 * `networkView.rebuild()` disposes and recreates edge/node subgroups after an
 * edit, which throws away the old meshes (and this view's old clones with
 * them) — call `rebind()` afterwards to re-scan for the new meshes.
 *
 * Known rough edge: edge/node selection highlighting (`ui/highlight.ts`) and
 * this view both ultimately assign `mesh.material`. Highlighting clones
 * whatever material is *currently* assigned when a lane is first selected, so
 * a lane heatmap-colored before it is ever selected keeps that color under
 * the highlight tint; but if the heatmap updates a lane's color *while it is
 * already selected*, the highlighted clone was taken from an earlier color
 * and won't track the new one until the lane is deselected and reselected.
 * Acceptable for the MVP — selection is for editing, which only happens
 * paused, and the heatmap is most useful while running.
 */

import { type Group, type Mesh, type Object3D, MeshLambertMaterial } from 'three';

import { readPathStats, type StatsMessage } from '@shared/messages.js';
import { isLanePath, type CompiledNetwork } from '@shared/network.js';

import { speedRatioColor } from './heatmap.js';

/** Occupancy at or below this is treated as "no cars on this lane" (see `engine/src/stats.ts`). */
const OCCUPANCY_EPSILON = 1e-4;

interface Entry {
  original: MeshLambertMaterial;
  heat: MeshLambertMaterial;
}

export interface HeatmapView {
  /** Colors (or re-colors) every lane mesh from one `stats` buffer. No-op while disabled. */
  update(buf: Float32Array, network: CompiledNetwork): void;
  /** Turns the heatmap on/off. Turning off restores every lane's base material immediately. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** Re-scans `group` (or the original group, if omitted) for lane meshes. Call after `networkView.rebuild()`. */
  rebind(group?: Group): void;
  dispose(): void;
}

function isMesh(obj: Object3D): obj is Mesh {
  return (obj as Mesh).isMesh === true;
}

export function createHeatmapView(group: Group): HeatmapView {
  let root = group;
  let enabled = false;
  const cache = new WeakMap<Mesh, Entry>();
  /**
   * Each lane's base material, captured during `index()` — that is, straight
   * after the group is built or rebuilt, before anything else can swap
   * `mesh.material`. Reading it lazily on first color instead would record
   * whatever happened to be assigned at that moment: a lane still selected
   * when the first `stats` message lands would have the *highlight* clone
   * recorded as its base, and restoring it (heatmap off, or the lane
   * emptying) would leave it highlighted for good.
   */
  const baseByMesh = new WeakMap<Mesh, MeshLambertMaterial>();
  let lanesByPathId = new Map<string, Mesh>();

  function index(): void {
    const next = new Map<string, Mesh>();
    root.traverse((obj) => {
      if (!isMesh(obj)) return;
      if (!obj.name.startsWith('L/')) return;
      next.set(obj.name, obj);
      baseByMesh.set(obj, obj.material as MeshLambertMaterial);
    });
    lanesByPathId = next;
  }
  index();

  function restore(mesh: Mesh): void {
    const entry = cache.get(mesh);
    if (entry) mesh.material = entry.original;
  }

  return {
    update(buf: Float32Array, network: CompiledNetwork): void {
      if (!enabled) return;
      for (const path of network.paths) {
        if (!isLanePath(path)) continue;
        const mesh = lanesByPathId.get(path.id);
        if (!mesh) continue;

        const stats = readPathStats(buf, path.index);
        const ratio = stats.occupancy > OCCUPANCY_EPSILON ? stats.speedRatio : null;
        const color = speedRatioColor(ratio);

        if (color === null) {
          restore(mesh);
          continue;
        }

        let entry = cache.get(mesh);
        if (!entry) {
          // The heat clone stays lazy (thousands of lanes downtown, most of
          // them empty most of the time); only the base is eager.
          const original = baseByMesh.get(mesh) ?? (mesh.material as MeshLambertMaterial);
          entry = { original, heat: original.clone() };
          cache.set(mesh, entry);
        }
        entry.heat.color.setRGB(color.r, color.g, color.b);
        mesh.material = entry.heat;
      }
    },
    setEnabled(next: boolean): void {
      enabled = next;
      if (!enabled) {
        for (const mesh of lanesByPathId.values()) restore(mesh);
      }
    },
    isEnabled(): boolean {
      return enabled;
    },
    rebind(nextGroup?: Group): void {
      if (nextGroup) root = nextGroup;
      index();
    },
    dispose(): void {
      for (const mesh of lanesByPathId.values()) {
        const entry = cache.get(mesh);
        entry?.heat.dispose();
      }
    },
  };
}

/** Convenience wrapper around `update` that takes the raw `stats` message. */
export function applyStatsToHeatmap(view: HeatmapView, message: StatsMessage, network: CompiledNetwork): void {
  view.update(message.buf, network);
}
