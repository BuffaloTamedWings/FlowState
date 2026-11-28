/**
 * Fake night headlights (plan step 11).
 *
 * Real `SpotLight`s are out of the question — a few hundred cars downtown
 * would mean a few hundred shadow-casting lights. Instead each car gets four
 * additive-blended discs lying flat on the road: a bright warm pair just ahead
 * of its nose and a dim red pair behind its tail. Additive blending means they
 * brighten whatever they are drawn over and never darken it, which reads as
 * light spilling onto asphalt without any lighting maths at all.
 *
 * Two `InstancedMesh`es (front, rear), each with two instances per car slot,
 * indexed `slot * 2` (left lamp) and `slot * 2 + 1` (right lamp). The slot
 * numbers are `cars.ts`'s own — this view never allocates, it is told which
 * slot to write — so the lamps can never drift out of lockstep with the cars.
 *
 * Everything about the look (radius, forward stretch, offsets, colours,
 * opacity) is in `theme.cars`, and the whole thing switches off with
 * `setEnabled(false)` if it reads badly.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Uint32BufferAttribute,
  Vector3,
  type Object3D,
} from 'three';

import { toThree, writeThree } from './coords.js';
import { subscribeTheme, theme } from './theme.js';

/** Triangle fan resolution of one glow disc. Cheap: 16 tris x 4 per car. */
const DISC_SEGMENTS = 16;

/** Lamps per car, per mesh (left + right). */
const LAMPS_PER_CAR = 2;

/**
 * A unit-radius disc, flat in the local x/y plane at local z = 0, mapped into
 * Three space through `coords.ts` (so the `(x, y, z) -> (x, z, -y)` convention
 * still appears exactly once in the codebase). After the mapping the disc lies
 * in Three's x/z plane facing up, so an instance matrix can scale it laterally
 * (x) and along the car's forward axis (z).
 */
function discGeometry(): BufferGeometry {
  const vertexCount = DISC_SEGMENTS + 1;
  const positions = new Float32Array(vertexCount * 3);
  writeThree(positions, 0, 0, 0, 0);
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const angle = (i / DISC_SEGMENTS) * Math.PI * 2;
    writeThree(positions, (i + 1) * 3, Math.cos(angle), Math.sin(angle), 0);
  }

  const indices = new Uint32Array(DISC_SEGMENTS * 3);
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    indices[i * 3] = 0;
    indices[i * 3 + 1] = 1 + i;
    indices[i * 3 + 2] = 1 + ((i + 1) % DISC_SEGMENTS);
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setIndex(new Uint32BufferAttribute(indices, 1));
  geom.computeVertexNormals();
  return geom;
}

export interface HeadlightsView {
  /** Parent this under the cars' root so it moves and is disposed with them. */
  readonly object: Object3D;
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  /** Grows the lamp meshes to match a car capacity, if needed. */
  ensureCapacity(carCapacity: number): void;
  /**
   * Writes both lamp pairs for one car. `heading` is the local (east, north)
   * unit vector `cars.ts` already has; `length` is the vehicle's length in
   * meters.
   */
  place(slot: number, x: number, y: number, headingX: number, headingY: number, length: number): void;
  /** Blanks both lamp pairs for a slot whose car has left the map. */
  hideSlot(slot: number): void;
  /** Flushes the instance matrices to the GPU. Call once per frame, after the last `place`. */
  commit(): void;
  dispose(): void;
}

export function createHeadlightsView(carCapacity: number): HeadlightsView {
  const geometry = discGeometry();

  function lampMaterial(color: number, opacity: number): MeshBasicMaterial {
    return new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
      // The discs sit a few centimetres above the road; without this they
      // z-fight with lane ribbons at grazing camera angles.
      depthTest: true,
    });
  }

  const frontMaterial = lampMaterial(theme.cars.headlightColor, theme.cars.headlightOpacity);
  const rearMaterial = lampMaterial(theme.cars.taillightColor, theme.cars.taillightOpacity);

  const root = new Group();
  root.name = 'headlights';
  let enabled = false;
  root.visible = false;

  let capacity = Math.max(1, carCapacity);
  let front = makeMesh(frontMaterial, capacity);
  let rear = makeMesh(rearMaterial, capacity);
  root.add(front, rear);

  const matrix = new Matrix4();
  const scale = new Vector3();
  const hidden = new Matrix4().makeScale(0, 0, 0);

  function makeMesh(material: MeshBasicMaterial, cap: number): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, cap * LAMPS_PER_CAR);
    mesh.count = cap * LAMPS_PER_CAR;
    mesh.frustumCulled = false; // instances move every frame; the bounding sphere is meaningless
    for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, hidden);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  const unsubscribe = subscribeTheme(() => {
    frontMaterial.color.setHex(theme.cars.headlightColor);
    frontMaterial.opacity = theme.cars.headlightOpacity;
    rearMaterial.color.setHex(theme.cars.taillightColor);
    rearMaterial.opacity = theme.cars.taillightOpacity;
  });

  /** Writes one lamp pair into `mesh`, `distance` meters along the car's forward axis from its centre. */
  function placePair(
    mesh: InstancedMesh,
    slot: number,
    x: number,
    y: number,
    fx: number,
    fy: number,
    distance: number,
    radius: number,
    stretch: number,
  ): void {
    // Right of travel in local coords: rotate the forward vector -90 degrees.
    const rx = fy;
    const ry = -fx;
    const yaw = Math.atan2(fx, -fy); // same convention as cars.ts
    const side = theme.cars.lampSideOffset;

    for (let lamp = 0; lamp < LAMPS_PER_CAR; lamp++) {
      const sign = lamp === 0 ? -1 : 1;
      const px = x + fx * distance + rx * side * sign;
      const py = y + fy * distance + ry * side * sign;
      const pos = toThree(px, py, theme.cars.lampHeight);
      scale.set(radius, 1, radius * stretch);
      matrix.makeRotationY(yaw);
      matrix.scale(scale);
      matrix.setPosition(pos);
      mesh.setMatrixAt(slot * LAMPS_PER_CAR + lamp, matrix);
    }
  }

  return {
    get object() {
      return root;
    },
    setEnabled(on: boolean): void {
      enabled = on;
      root.visible = on;
    },
    isEnabled(): boolean {
      return enabled;
    },
    ensureCapacity(nextCarCapacity: number): void {
      if (nextCarCapacity <= capacity) return;
      capacity = nextCarCapacity;
      root.remove(front, rear);
      front.dispose();
      rear.dispose();
      front = makeMesh(frontMaterial, capacity);
      rear = makeMesh(rearMaterial, capacity);
      root.add(front, rear);
    },
    place(slot: number, x: number, y: number, headingX: number, headingY: number, length: number): void {
      if (!enabled) return;
      if (slot * LAMPS_PER_CAR + LAMPS_PER_CAR > front.count) return;
      const nose = length / 2 + theme.cars.headlightForwardOffset;
      const tail = -(length / 2 + theme.cars.taillightBackwardOffset);
      placePair(front, slot, x, y, headingX, headingY, nose, theme.cars.headlightRadius, theme.cars.headlightStretch);
      placePair(rear, slot, x, y, headingX, headingY, tail, theme.cars.taillightRadius, theme.cars.taillightStretch);
    },
    hideSlot(slot: number): void {
      if (slot * LAMPS_PER_CAR + LAMPS_PER_CAR > front.count) return;
      for (let lamp = 0; lamp < LAMPS_PER_CAR; lamp++) {
        front.setMatrixAt(slot * LAMPS_PER_CAR + lamp, hidden);
        rear.setMatrixAt(slot * LAMPS_PER_CAR + lamp, hidden);
      }
    },
    commit(): void {
      if (!enabled) return;
      front.instanceMatrix.needsUpdate = true;
      rear.instanceMatrix.needsUpdate = true;
    },
    dispose(): void {
      unsubscribe();
      geometry.dispose();
      frontMaterial.dispose();
      rearMaterial.dispose();
      front.dispose();
      rear.dispose();
    },
  };
}
