/**
 * Scenario file (`flowstate-scenario`, v1) — PRD §7.2.
 *
 * The map *before* any choice has been made: roads, intersections, and the menu
 * of alternatives available at each one. Produced by `tools/import/`, read only
 * by the front end. The engine never sees a scenario — it gets the compiled
 * network (`network.ts`) instead.
 *
 * Each enum is declared as a `const` array so there is both a compile-time union
 * and a runtime list to validate data against.
 */

import type { Bounds, Estimated, Polygon, Polyline, Tags, Units } from './common.js';

export const SCENARIO_FORMAT = 'flowstate-scenario';
export const SCENARIO_VERSION = 1;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SCENARIO_SOURCES = ['osm', 'hand'] as const;
export type ScenarioSource = (typeof SCENARIO_SOURCES)[number];

/**
 * `merge`/`diverge` are where a ramp joins or leaves a frontage road mid-block.
 * `boundary` is a street crossing the map edge; `rampEnd` a clipped ramp stub.
 */
export const NODE_KINDS = ['intersection', 'merge', 'diverge', 'boundary', 'rampEnd'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Intersection control offered by a `NodeOption`. */
export const NODE_CONTROLS = [
  'signal',
  'signalProtectedLeft',
  'allStop',
  'roundabout',
  'yield',
  'none',
] as const;
export type NodeControl = (typeof NODE_CONTROLS)[number];

export const ROAD_CLASSES = [
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'frontage',
  'ramp',
  'uturn',
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

/** `current` is always the first option on an element. The rest are the catalog (PRD §7.3). */
export const EDGE_OPTION_KINDS = [
  'current',
  'widen',
  'roadDiet',
  'bikeLane',
  'transitLane',
  'twoWay',
  'oneWay',
  'leftTurnLane',
  'carFree',
] as const;
export type EdgeOptionKind = (typeof EDGE_OPTION_KINDS)[number];

export const LANE_TYPES = ['car', 'bike', 'transit'] as const;
export type LaneType = (typeof LANE_TYPES)[number];

export const TURNS = ['left', 'through', 'right'] as const;
export type Turn = (typeof TURNS)[number];

export const POINT_TYPES = [
  'edgeSpawn',
  'edgeSink',
  'rampSpawn',
  'rampSink',
  'parking',
  'lunchZone',
] as const;
export type PointType = (typeof POINT_TYPES)[number];

/** Which side of the main road a ramp sits on. Texas ramps are usually `left`. */
export const BRANCH_SIDES = ['left', 'right'] as const;
export type BranchSide = (typeof BRANCH_SIDES)[number];

/** Default lane widths in meters, used when a lane has no explicit `width`. */
export const LANE_WIDTHS: Readonly<Record<LaneType, number>> = {
  car: 3.5,
  transit: 3.5,
  bike: 1.8,
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Merge/diverge only: which edge is the ramp, and which side of the main road. */
export interface Branch {
  edge: string;
  side: BranchSide;
}

/** A banned movement through a node, from an OSM turn relation. */
export interface Restriction {
  fromEdge: string;
  toEdge: string;
  type: 'noTurn';
}

/**
 * Control-specific parameters. `roundabout` carries `radius`; `yield` carries
 * `majorEdges` (approaches that do *not* stop). Other controls use `{}`.
 */
export interface NodeOptionParams {
  radius?: number;
  majorEdges?: string[];
}

export interface NodeOption {
  id: string;
  label: string;
  control: NodeControl;
  params: NodeOptionParams;
}

export interface Node {
  id: string;
  name: string;
  /** Position in local meters; `z` is below grade for ramp ends. */
  x: number;
  y: number;
  z: number;
  kind: NodeKind;
  branch: Branch | null;
  restrictions: Restriction[];
  /** First entry is always the `current` option. */
  options: NodeOption[];
  /** ID of the chosen option. */
  selected: string;
  /** True when there is nothing to edit (every non-intersection node). */
  locked: boolean;
  osmIds: string[];
  tags: Tags;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * One lane. `turns` pins the lane to specific movements (a left-turn-only lane);
 * omit it for a normal lane that takes whatever the compile step assigns.
 */
export interface Lane {
  type: LaneType;
  turns?: Turn[];
  /** Overrides `LANE_WIDTHS[type]`. */
  width?: number;
}

/**
 * One layout alternative for an edge. `forward` lanes travel `from`->`to`,
 * `backward` travels `to`->`from`; a one-way street has an empty `backward`.
 * Lanes are ordered left to right in the direction of travel, index 0 = leftmost.
 */
export interface EdgeOption {
  id: string;
  label: string;
  kind: EdgeOptionKind;
  forward: Lane[];
  backward: Lane[];
}

/** One road section between two nodes, both directions, edited independently. */
export interface Edge {
  id: string;
  name: string;
  /** Reference direction: `from` -> `to`. */
  from: string;
  to: string;
  roadClass: RoadClass;
  /** Starts and ends exactly at the two node positions. */
  centerline: Polyline;
  /** One z per centerline point (ramps, bridges), or null for flat at 0. */
  elevation: number[] | null;
  /** Meters per second. */
  speedLimit: number;
  estimated: Estimated;
  /** First entry is always the `current` option. */
  options: EdgeOption[];
  selected: string;
  /** Ramps are locked. */
  locked: boolean;
  osmWayIds: string[];
  tags: Tags;
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/** Position of a point that sits mid-edge: fraction `t` (0-1) along the centerline from `from`. */
export interface PointAt {
  edge: string;
  t: number;
}

/**
 * A spawn, sink, parking garage or lunch zone.
 *
 * Spawns and sinks sit on a `boundary` or `rampEnd` node (`node` is set);
 * parking and lunch zones sit on an edge (`at` is set). A two-way boundary
 * street produces both an `edgeSpawn` and an `edgeSink` on the same node.
 */
export interface Point {
  id: string;
  type: PointType;
  name: string;
  node?: string;
  at?: PointAt;
  /** Relative pull; default 1. Off-ramps default to 3. */
  weight: number;
  /** Parking only, in cars. */
  capacity?: number;
  estimated: Estimated;
  osmIds: string[];
  tags: Tags;
}

// ---------------------------------------------------------------------------
// Scenery (front end only; the engine never receives it)
// ---------------------------------------------------------------------------

export interface Freeway {
  id: string;
  name: string;
  centerline: Polyline;
  width: number;
  z: number;
}

export interface Building {
  id: string;
  name?: string;
  footprint: Polygon;
  height: number;
  levels: number;
  use: string;
  estimated: Estimated;
}

export interface Park {
  id: string;
  name: string;
  polygon: Polygon;
}

export interface Scenery {
  freeways: Freeway[];
  buildings: Building[];
  parks: Park[];
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

export interface ScenarioMeta {
  id: string;
  name: string;
  source: ScenarioSource;
  units: Units;
  /** Latitude/longitude the local meter grid is measured from. */
  origin: { lat: number; lon: number };
  bounds: Bounds;
  attribution: string;
}

export interface Scenario {
  format: typeof SCENARIO_FORMAT;
  version: number;
  meta: ScenarioMeta;
  nodes: Node[];
  edges: Edge[];
  points: Point[];
  scenery: Scenery;
}

/** The selected option on an element, or its `current` option as a fallback. */
export function selectedEdgeOption(edge: Edge): EdgeOption {
  const found = edge.options.find((o) => o.id === edge.selected);
  if (found) return found;
  const first = edge.options[0];
  if (!first) throw new Error(`edge ${edge.id} has no options`);
  return first;
}

export function selectedNodeOption(node: Node): NodeOption {
  const found = node.options.find((o) => o.id === node.selected);
  if (found) return found;
  const first = node.options[0];
  if (!first) throw new Error(`node ${node.id} has no options`);
  return first;
}

/** Lane width in meters, honoring a per-lane override. */
export function laneWidth(lane: Lane): number {
  return lane.width ?? LANE_WIDTHS[lane.type];
}
