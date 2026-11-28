/**
 * Car rendering: a single `InstancedMesh` of boxes, one instance per car on
 * the map. Step 11 replaces the box with real per-vehicle-type meshes; this
 * just gets cars moving and sized correctly.
 *
 * The pure bookkeeping (slot allocation, x/y interpolation) lives in
 * `carsCore.ts` so it can be unit tested without a GPU; this file is the
 * thin Three.js wrapper around it.
 */
import { BoxGeometry, Color, InstancedMesh, Matrix4, MeshLambertMaterial, Vector3, type Object3D } from 'three';

import { TICK_FLAG_BRAKING, TICK_FLAG_STOPPED, hasFlag, vehicleCodeOf, type TickCar } from '@shared/messages.js';
import { vehicleTypeByCode } from '@shared/vehicles.js';

import type { ArcTable } from '@web/geometry/index.js';
import type { TickFrame } from '@web/sim/engineClient.js';

import { interpolateCarPose, SlotAllocator } from './carsCore.js';
import { toThree } from './coords.js';

/** Placeholder box height (m). Real per-type meshes arrive in step 11. */
const CAR_HEIGHT = 1.5;
const NORMAL_COLOR = new Color(0x8a93a0);
const BRAKE_COLOR = new Color(0xd04040);

export interface CarsView {
  readonly object: Object3D;
  update(frame: TickFrame, prev: TickFrame | null, alpha: number): void;
  dispose(): void;
}

export function createCarsView(lookup: ArcTable[], capacity = 2048): CarsView {
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshLambertMaterial({ color: 0xffffff });

  let allocator = new SlotAllocator(capacity);
  let mesh = makeMesh(allocator.capacity);

  const matrix = new Matrix4();
  const scale = new Vector3();
  const color = new Color();

  function makeMesh(cap: number): InstancedMesh {
    const m = new InstancedMesh(geometry, material, cap);
    m.count = cap;
    const zero = new Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) m.setMatrixAt(i, zero);
    m.instanceMatrix.needsUpdate = true;
    return m;
  }

  /** Rebuilds the mesh at the allocator's new (larger) capacity, carrying over existing instances. */
  function growMesh(): void {
    const next = makeMesh(allocator.capacity);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      next.setMatrixAt(i, matrix);
      if (mesh.instanceColor) {
        mesh.getColorAt(i, color);
        next.setColorAt(i, color);
      }
    }
    next.instanceMatrix.needsUpdate = true;
    if (next.instanceColor) next.instanceColor.needsUpdate = true;
    const parent = mesh.parent;
    if (parent) {
      parent.add(next);
      parent.remove(mesh);
    }
    mesh.dispose();
    mesh = next;
  }

  function hideSlot(slot: number): void {
    matrix.makeScale(0, 0, 0);
    mesh.setMatrixAt(slot, matrix);
  }

  function update(frame: TickFrame, prev: TickFrame | null, alpha: number): void {
    const presentIds = new Set(frame.cars.keys());

    // Slot allocation: a `vehicleId` not present in the newest tick (whether
    // it left the map or the engine recycled its id into a different car — an
    // open question for Sashank) loses its slot, which is zero-scaled so it
    // disappears, and only a fresh `allocate` call ever hands that slot out
    // again.
    const freed = allocator.release(presentIds);
    for (const slot of freed) hideSlot(slot);

    const capacityBefore = allocator.capacity;
    for (const id of frame.cars.keys()) allocator.allocate(id);
    if (allocator.capacity !== capacityBefore) growMesh();

    for (const [id, car] of frame.cars) {
      const slot = allocator.allocate(id);
      const prevCar: TickCar | undefined = prev?.cars.get(id);
      const pose = interpolateCarPose(lookup, prevCar, car, alpha);
      const type = vehicleTypeByCode(vehicleCodeOf(car.flags));

      const pos = toThree(pose.x, pose.y, 0);
      pos.y += CAR_HEIGHT / 2; // lift the box so it sits on the road, not half-buried in it

      // Heading [hx, hy] is a local (east, north) unit vector. Mapped through
      // the same convention as coords.ts (x -> x, y -> -z), the box's forward
      // (+Z) axis should point along (hx, -hy) in Three space; atan2(x, z) is
      // the standard "yaw that points +Z at (x, z)" formula for Three's
      // right-handed, Y-up rotation. If cars visibly face the wrong way (e.g.
      // backing through turns) in the browser, this is the line to flip.
      const yaw = Math.atan2(pose.heading[0], -pose.heading[1]);

      scale.set(type.width, CAR_HEIGHT, type.length);
      matrix.makeRotationY(yaw);
      matrix.scale(scale);
      matrix.setPosition(pos);
      mesh.setMatrixAt(slot, matrix);

      const braking = hasFlag(car.flags, TICK_FLAG_BRAKING) || hasFlag(car.flags, TICK_FLAG_STOPPED);
      mesh.setColorAt(slot, braking ? BRAKE_COLOR : NORMAL_COLOR);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    get object() {
      return mesh;
    },
    update,
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
