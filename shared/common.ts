/**
 * Shapes used by more than one contract file.
 *
 * Conventions (PRD §7.1), restated because everything here depends on them:
 * - Units are meters, seconds and m/s. Never mph or km/h in data.
 * - Coordinates are local meters from `Scenario.meta.origin`: x = east, y = north,
 *   z = up. Three.js mapping is `(x, y, z)` -> `(x, z, -y)`.
 * - Unknown fields are allowed anywhere and must be ignored, never treated as errors.
 */

/** A point in the local meter grid: `[x, y]`, x = east, y = north. */
export type Point2 = [number, number];

/** An open polyline in the local meter grid. */
export type Polyline = Point2[];

/** A closed ring (first point is not repeated at the end). */
export type Polygon = Point2[];

/** Unit labels carried by data files so a reader can assert them. */
export interface Units {
  length: 'm';
  speed: 'm/s';
  time: 's';
}

/**
 * Which values the importer guessed rather than read from OSM, keyed by field
 * name, e.g. `{ speedLimit: true, lanes: false }`.
 */
export type Estimated = Record<string, boolean>;

/** Unprocessed OSM tags. Read freely; nothing in the sim depends on them. */
export type Tags = Record<string, unknown>;

/** Axis-aligned extent of a scenario, in local meters. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
