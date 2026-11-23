/**
 * Compiled network (`flowstate-network`, v1) — PRD §7.4.
 *
 * The same map as a scenario, but after the player's choices are flattened into
 * pure numbers: every lane and turn path with its length, what it leads to, what
 * it conflicts with, and which signal phase releases it.
 *
 * **This is the entire interface between the front end and the engine.** The
 * front end builds it on Run (and `tools/compile-cli.ts` writes it to
 * `data/compiled/` for headless tests); the engine consumes it and nothing else.
 *
 * The engine moves cars by distance along these paths and reports
 * `(pathIndex, s, speed, flags)`. It never computes a coordinate — the front end
 * converts to x/y with its own curves, so both sides always agree on lengths.
 */

import type { Polyline, Units } from './common.js';
import type { NodeControl, Turn } from './scenario.js';

export const NETWORK_FORMAT = 'flowstate-network';
export const NETWORK_VERSION = 1;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const PATH_KINDS = ['lane', 'connector'] as const;
export type PathKind = (typeof PATH_KINDS)[number];

/** `f` = lanes travelling `from`->`to` on their edge, `b` = the reverse. */
export const LANE_DIRS = ['f', 'b'] as const;
export type LaneDir = (typeof LANE_DIRS)[number];

/**
 * How a connector relates to its two lanes. U-turns are dropped at compile time
 * and never appear here.
 */
export const CONNECTOR_TURNS = ['through', 'left', 'right'] as const;
export type ConnectorTurn = (typeof CONNECTOR_TURNS)[number];

/**
 * `cross` — the two curves intersect. `merge` — they end in the same lane.
 * Connectors starting from the same lane are never listed as conflicting: cars
 * on them are already queued behind each other.
 */
export const CONFLICT_TYPES = ['cross', 'merge'] as const;
export type ConflictType = (typeof CONFLICT_TYPES)[number];

/**
 * A compiled node's control: whatever option the player selected, plus `merge`
 * and `none` for the merge/diverge nodes that have no control to select.
 */
export const COMPILED_CONTROLS = ['signal', 'signalProtectedLeft', 'allStop', 'roundabout', 'yield', 'none', 'merge'] as const;
export type CompiledControl = (typeof COMPILED_CONTROLS)[number];

/** Phase IDs a plain `signal` produces, split by the approach's heading. */
export const SIGNAL_PHASE_IDS = ['NS', 'EW'] as const;
/** Phase IDs `signalProtectedLeft` produces; lefts run only in their own phase. */
export const PROTECTED_LEFT_PHASE_IDS = ['NS-left', 'NS', 'EW-left', 'EW'] as const;

/** Turns take 15 mph; a through movement takes the lower of its two lanes' limits. */
export const TURN_SPEED_LIMIT = 6.7;

/** Trim applied to each lane end, by the kind of node it meets (PRD §7.4 rule 1). */
export const NODE_SETBACKS = {
  intersection: 12,
  merge: 8,
  diverge: 8,
  boundary: 0,
  rampEnd: 0,
  /** Roundabouts use `radius + ROUNDABOUT_SETBACK_MARGIN`. */
  roundaboutMargin: 6,
} as const;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** A connector at the same node that this one cannot be driven through at once. */
export interface Conflict {
  path: string;
  type: ConflictType;
}

interface PathBase {
  /** Position in `CompiledNetwork.paths`. This is what ticks carry. */
  index: number;
  length: number;
  /** Meters per second. */
  speedLimit: number;
  /** Paths reachable from the end of this one. */
  next: string[];
  /**
   * Sampled geometry, for debugging and for the front end's own lookup tables.
   * **The engine must not use it for simulation** — it drives on `length` alone.
   * Stripped from the in-memory handoff; present in files under `data/compiled/`.
   */
  debugPolyline?: Polyline;
}

/**
 * One car lane of one edge. Bike and transit lanes are *not* compiled — they
 * exist in the scenario and are drawn, but no car drives them.
 */
export interface LanePath extends PathBase {
  /** `L/{edge}/{f|b}/{laneIndex}`, e.g. `L/eB1/f/0`. */
  id: string;
  kind: 'lane';
  edge: string;
  dir: LaneDir;
  /**
   * Index within that direction, counting every lane including bike and transit,
   * so it still matches the scenario's lane array. Left to right, 0 = leftmost.
   */
  laneIndex: number;
  fromNode: string;
  toNode: string;
  /** Movements this lane is pinned to, or null for an unpinned lane. */
  turns: Turn[] | null;
  /** Connectors leaving the end of this lane. Empty at a boundary or ramp end. */
  next: string[];
}

/**
 * A turn path through a node — or a ring section of a roundabout (PRD §7.4
 * rule 10), where cars follow each other as they would on any lane.
 */
export interface ConnectorPath extends PathBase {
  /** `C/{node}/{fromLane}>{toLane}`, with the lanes' `L/` prefixes dropped. */
  id: string;
  kind: 'connector';
  node: string;
  /** Lane path IDs this connector runs between. */
  from: string;
  to: string;
  turn: ConnectorTurn;
  /** Signal phase that releases this connector, or null when unsignalized. */
  phase: string | null;
  conflicts: Conflict[];
  /** Connectors this one must give way to (PRD §8.4). */
  yieldTo: string[];
  /** Always exactly `[to]`. */
  next: string[];
}

export type CompiledPath = LanePath | ConnectorPath;

export function isLanePath(path: CompiledPath): path is LanePath {
  return path.kind === 'lane';
}

export function isConnectorPath(path: CompiledPath): path is ConnectorPath {
  return path.kind === 'connector';
}

// ---------------------------------------------------------------------------
// Nodes and points
// ---------------------------------------------------------------------------

/** One signal stage: the connectors that may run together. */
export interface Phase {
  id: string;
  paths: string[];
}

/**
 * One node that cars actually drive through: intersections, merges and diverges.
 *
 * Boundary and rampEnd nodes are **not** compiled — nothing turns there — so a
 * `LanePath.fromNode`/`toNode` may name a scenario node that has no entry here.
 * Don't assume every lane endpoint can be looked up in `CompiledNetwork.nodes`.
 */
export interface CompiledNode {
  id: string;
  control: CompiledControl;
  /** Signals only; null for every other control. */
  phases: Phase[] | null;
  /** Lane paths arriving at this node. */
  inPaths: string[];
  /** Every connector through this node. */
  connectors: string[];
}

/** Where a point touches the road network. */
export interface PointAccess {
  /** Lane path ID. */
  path: string;
  /** Distance along that path, in meters. */
  s: number;
}

/**
 * A spawn, sink, garage or lunch zone with its access resolved to lanes.
 *
 * Spawns at a node use every lane leaving it (`s` = 0); sinks every lane
 * arriving (`s` = length); parking and lunch zones use the rightmost car lane of
 * each direction of their edge. Points left with no access are dropped at
 * compile time — a `carFree` street can cut a garage off entirely.
 */
export interface CompiledPoint {
  id: string;
  type: string;
  weight: number;
  capacity?: number;
  access: PointAccess[];
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

/**
 * Which option was selected on every element, keyed by element ID. Lets a
 * compiled file be traced back to the layout that produced it, and lets the
 * front end tell whether the layout changed since the last run.
 */
export interface Layout {
  edges: Record<string, string>;
  nodes: Record<string, string>;
}

export interface CompiledNetwork {
  format: typeof NETWORK_FORMAT;
  version: number;
  /** `Scenario.meta.id` this was compiled from. */
  scenario: string;
  layout: Layout;
  units: Units;
  /** A path's position here is its `index`. */
  paths: CompiledPath[];
  nodes: CompiledNode[];
  points: CompiledPoint[];
}

/** Index paths by ID. The engine resolves `next` and `conflicts` through this. */
export function pathsById(network: CompiledNetwork): Map<string, CompiledPath> {
  return new Map(network.paths.map((p) => [p.id, p]));
}

export type { NodeControl };
