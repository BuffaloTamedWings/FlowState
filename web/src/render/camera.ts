/**
 * Frames a perspective camera on a scenario's local-meter bounds: target at
 * the bounds centre, camera parked south-east and above looking down at
 * roughly 45 degrees, distance chosen so the larger of the bounds' width and
 * height fits inside the vertical field of view (accounting for aspect on
 * the width).
 */

import type { PerspectiveCamera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Bounds } from '@shared/common.js';
import { toThree } from './coords.js';

/** Degrees below the horizontal the camera looks down at. */
const LOOK_DOWN_ANGLE = 45;

export function frameBounds(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  bounds: Bounds,
  // The diagonal already over-covers a box, so this only needs to keep the
  // outermost roads off the edge of the frame.
  padding = 1.05,
): void {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const width = Math.max(1e-6, bounds.maxX - bounds.minX);
  const height = Math.max(1e-6, bounds.maxY - bounds.minY);

  const vFovRad = (camera.fov * Math.PI) / 180;
  // The camera looks in along a diagonal, so the on-screen extent of the
  // bounds is not its width or height but something up to its diagonal,
  // depending on the orbit azimuth. Size to the diagonal (the bounding
  // circle) so no corner clips from any angle the user can orbit to.
  const diagonal = Math.hypot(width, height);
  const effectiveWidth = diagonal / camera.aspect;
  const span = Math.max(diagonal, effectiveWidth) * padding;

  // Distance along the camera's line of sight so `span` fits the vertical FOV.
  const distance = span / 2 / Math.tan(vFovRad / 2);

  const downRad = (LOOK_DOWN_ANGLE * Math.PI) / 180;
  const horizontal = distance * Math.cos(downRad);
  const vertical = distance * Math.sin(downRad);
  // South-east of the target, in local meters: +x (east), -y (south).
  const camX = centerX + horizontal * Math.SQRT1_2;
  const camY = centerY - horizontal * Math.SQRT1_2;

  const target = toThree(centerX, centerY, 0);
  const camPos = toThree(camX, camY, vertical);
  camera.position.copy(camPos);

  camera.near = Math.max(0.1, distance / 100);
  camera.far = Math.max(camera.near + 1, distance * 10);
  camera.updateProjectionMatrix();

  controls.target.copy(target);
  controls.update();
}
