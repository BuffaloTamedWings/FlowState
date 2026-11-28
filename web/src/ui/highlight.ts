/**
 * Selection highlight: an emissive material swap on the picked edge/node's
 * subgroup (`edge/{id}` or `node/{id}` in the network group, see
 * `web/src/render/networkView.ts`). Meshes in that subgroup share materials
 * with every other mesh of the same lane type, so highlighting clones the
 * material per-mesh rather than mutating the shared one — otherwise
 * "highlight this edge" would recolor every lane in the network.
 */

import { MeshLambertMaterial, type Group, type Mesh, type Object3D } from 'three';

import { theme } from '@web/render/theme.js';

interface Entry {
  original: MeshLambertMaterial;
  highlighted: MeshLambertMaterial;
}

const cache = new WeakMap<Mesh, Entry>();

function isMesh(obj: Object3D): obj is Mesh {
  return (obj as Mesh).isMesh === true;
}

/** Sets or clears the highlight on every `MeshLambertMaterial`-backed mesh under `group`. */
export function setGroupHighlighted(group: Group, highlighted: boolean): void {
  group.traverse((obj) => {
    if (!isMesh(obj)) return;
    const mesh = obj;
    const material = mesh.material;
    if (!(material instanceof MeshLambertMaterial) && !cache.has(mesh)) return;

    if (highlighted) {
      let entry = cache.get(mesh);
      if (!entry) {
        const original = mesh.material as MeshLambertMaterial;
        const clone = original.clone();
        clone.emissive.setHex(theme.roads.highlightEmissiveColor);
        clone.emissiveIntensity = theme.roads.highlightIntensity;
        entry = { original, highlighted: clone };
        cache.set(mesh, entry);
      }
      mesh.material = entry.highlighted;
    } else {
      const entry = cache.get(mesh);
      if (entry) mesh.material = entry.original;
    }
  });
}

/** Finds the `edge/{id}` or `node/{id}` subgroup by name, or null if it isn't present (e.g. an empty node). */
export function findSubgroup(root: Object3D, kind: 'edge' | 'node', id: string): Group | null {
  const found = root.getObjectByName(`${kind}/${id}`);
  return (found as Group | undefined) ?? null;
}
