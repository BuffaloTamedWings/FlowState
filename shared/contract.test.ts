/**
 * Checks the contract types against the starter files (PRD §16).
 *
 * The point is not that the files parse — it is that every enum value in the
 * data appears in the unions declared here, and every ID reference resolves.
 * A plain `as` cast would compile happily while hiding both kinds of mistake,
 * so each enum is declared as a `const` array and asserted at runtime.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CONFLICT_TYPES,
  COMPILED_CONTROLS,
  CONNECTOR_TURNS,
  LANE_DIRS,
  NETWORK_FORMAT,
  NETWORK_VERSION,
  PATH_KINDS,
  isConnectorPath,
  isLanePath,
  pathsById,
  type CompiledNetwork,
} from './network.js';
import {
  BRANCH_SIDES,
  EDGE_OPTION_KINDS,
  LANE_TYPES,
  NODE_CONTROLS,
  NODE_KINDS,
  POINT_TYPES,
  ROAD_CLASSES,
  SCENARIO_FORMAT,
  SCENARIO_SOURCES,
  SCENARIO_VERSION,
  LANE_WIDTHS,
  TURNS,
  laneWidth,
  selectedEdgeOption,
  selectedNodeOption,
  type Scenario,
} from './scenario.js';
import {
  LIGHTINGS,
  PRESET_FORMAT,
  PRESET_VERSION,
  SPAWN_RATE_UNITS,
  spawnRateAt,
  validateVehicleMix,
  vehicleMixOf,
  type Preset,
} from './preset.js';
import {
  PLAYBACK_SPEEDS,
  SIM_DT,
  STATS_STRIDE,
  TICK_FLAG_BRAKING,
  TICK_FLAG_STOPPED,
  TICK_FLAG_VEHICLE_MASK,
  TICK_FLAG_YIELDING,
  TICK_STRIDE,
  hasFlag,
  readTickCar,
  vehicleCodeOf,
  withVehicleCode,
  writeTickCar,
} from './messages.js';
import {
  DEFAULT_VEHICLE_TYPE,
  VEHICLE_CODE_BITS,
  VEHICLE_TYPES,
  vehicleTypeByCode,
  vehicleTypeById,
  type VehicleTypeId,
} from './vehicles.js';

const dataDir = resolve(import.meta.dirname, '../data');

function load<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, relPath), 'utf8')) as T;
}

const scenario = load<Scenario>('scenarios/test-grid.scenario.json');
const network = load<CompiledNetwork>('compiled/test-grid.compiled.json');
const presets = (['morning', 'afternoon', 'night'] as const).map((id) => load<Preset>(`presets/${id}.json`));

/** Asserts a data value is one of the declared union members. */
function oneOf<T extends string>(value: string, allowed: readonly T[], where: string): void {
  expect(allowed as readonly string[], `${where}: unexpected value ${JSON.stringify(value)}`).toContain(value);
}

describe('scenario contract', () => {
  it('matches the declared format and version', () => {
    expect(scenario.format).toBe(SCENARIO_FORMAT);
    expect(scenario.version).toBe(SCENARIO_VERSION);
    oneOf(scenario.meta.source, SCENARIO_SOURCES, 'meta.source');
    expect(scenario.meta.units).toEqual({ length: 'm', speed: 'm/s', time: 's' });
    expect(scenario.meta.bounds.maxX).toBeGreaterThan(scenario.meta.bounds.minX);
    expect(scenario.meta.bounds.maxY).toBeGreaterThan(scenario.meta.bounds.minY);
  });

  it('uses only declared node kinds, controls and branch sides', () => {
    for (const node of scenario.nodes) {
      oneOf(node.kind, NODE_KINDS, `node ${node.id}.kind`);
      expect(node.options.length, `node ${node.id} has no options`).toBeGreaterThan(0);
      for (const option of node.options) {
        oneOf(option.control, NODE_CONTROLS, `node ${node.id} option ${option.id}.control`);
      }
      if (node.branch) oneOf(node.branch.side, BRANCH_SIDES, `node ${node.id}.branch.side`);
      // The selected option must exist, and `current` must come first (PRD §7.2).
      expect(selectedNodeOption(node).id).toBe(node.selected);
      expect(node.options[0]?.id).toContain('current');
    }
  });

  it('uses only declared road classes, option kinds, lane types and turns', () => {
    for (const edge of scenario.edges) {
      oneOf(edge.roadClass, ROAD_CLASSES, `edge ${edge.id}.roadClass`);
      expect(selectedEdgeOption(edge).id).toBe(edge.selected);
      expect(edge.options[0]?.kind).toBe('current');
      for (const option of edge.options) {
        oneOf(option.kind, EDGE_OPTION_KINDS, `edge ${edge.id} option ${option.id}.kind`);
        for (const lane of [...option.forward, ...option.backward]) {
          oneOf(lane.type, LANE_TYPES, `edge ${edge.id} option ${option.id} lane.type`);
          for (const turn of lane.turns ?? []) oneOf(turn, TURNS, `edge ${edge.id} lane.turns`);
          expect(laneWidth(lane)).toBeGreaterThan(0);
        }
      }
      if (edge.elevation) expect(edge.elevation).toHaveLength(edge.centerline.length);
    }
  });

  it('resolves every node and edge reference', () => {
    const nodeIds = new Set(scenario.nodes.map((n) => n.id));
    const edgeIds = new Set(scenario.edges.map((e) => e.id));

    for (const edge of scenario.edges) {
      expect(nodeIds, `edge ${edge.id}.from`).toContain(edge.from);
      expect(nodeIds, `edge ${edge.id}.to`).toContain(edge.to);
    }
    for (const node of scenario.nodes) {
      for (const r of node.restrictions) {
        expect(edgeIds, `node ${node.id} restriction.fromEdge`).toContain(r.fromEdge);
        expect(edgeIds, `node ${node.id} restriction.toEdge`).toContain(r.toEdge);
        expect(r.type).toBe('noTurn');
      }
      if (node.branch) expect(edgeIds, `node ${node.id}.branch.edge`).toContain(node.branch.edge);
      for (const option of node.options) {
        for (const majorEdge of option.params.majorEdges ?? []) {
          expect(edgeIds, `node ${node.id} option ${option.id}.params.majorEdges`).toContain(majorEdge);
        }
      }
    }
  });

  it('anchors every point to either a node or an edge', () => {
    const nodeIds = new Set(scenario.nodes.map((n) => n.id));
    const edgeIds = new Set(scenario.edges.map((e) => e.id));

    for (const point of scenario.points) {
      oneOf(point.type, POINT_TYPES, `point ${point.id}.type`);
      const anchors = [point.node !== undefined, point.at !== undefined].filter(Boolean).length;
      expect(anchors, `point ${point.id} must have exactly one of node/at`).toBe(1);
      if (point.node !== undefined) expect(nodeIds, `point ${point.id}.node`).toContain(point.node);
      if (point.at !== undefined) {
        expect(edgeIds, `point ${point.id}.at.edge`).toContain(point.at.edge);
        expect(point.at.t).toBeGreaterThanOrEqual(0);
        expect(point.at.t).toBeLessThanOrEqual(1);
      }
      // Capacity is parking-only per PRD §7.2.
      if (point.capacity !== undefined) expect(point.type).toBe('parking');
    }
  });

  it('has the scenery buckets the renderer expects', () => {
    expect(Array.isArray(scenario.scenery.freeways)).toBe(true);
    expect(Array.isArray(scenario.scenery.buildings)).toBe(true);
    expect(Array.isArray(scenario.scenery.parks)).toBe(true);
    for (const b of scenario.scenery.buildings) expect(b.footprint.length).toBeGreaterThanOrEqual(3);
    for (const p of scenario.scenery.parks) expect(p.polygon.length).toBeGreaterThanOrEqual(3);
  });
});

describe('compiled network contract', () => {
  it('matches the declared format and version', () => {
    expect(network.format).toBe(NETWORK_FORMAT);
    expect(network.version).toBe(NETWORK_VERSION);
    expect(network.scenario).toBe(scenario.meta.id);
    expect(network.units).toEqual({ length: 'm', speed: 'm/s', time: 's' });
  });

  it("gives every path an index equal to its position, which is what ticks carry", () => {
    network.paths.forEach((path, i) => {
      expect(path.index, `path ${path.id} index`).toBe(i);
      oneOf(path.kind, PATH_KINDS, `path ${path.id}.kind`);
      expect(path.length, `path ${path.id} length`).toBeGreaterThan(0);
      expect(path.speedLimit, `path ${path.id} speedLimit`).toBeGreaterThan(0);
    });
  });

  it('holds the lane and connector counts from PRD §16', () => {
    expect(network.paths.filter(isLanePath)).toHaveLength(54);
    expect(network.paths.filter(isConnectorPath)).toHaveLength(93);
  });

  it('marks a stop exactly where PRD §8.4 requires one', () => {
    const controlOf = new Map(network.nodes.map((n) => [n.id, n.control]));

    for (const path of network.paths) {
      if (!isConnectorPath(path)) continue;
      expect(typeof path.stop, `connector ${path.id}.stop`).toBe('boolean');

      const control = controlOf.get(path.node);
      // The test grid selects allStop at n02 and nothing else that stops.
      if (control === 'allStop') expect(path.stop, `connector ${path.id} at an allStop node`).toBe(true);
      else expect(path.stop, `connector ${path.id} at a ${control} node`).toBe(false);
    }

    const stopping = network.paths.filter((p) => isConnectorPath(p) && p.stop);
    expect(stopping).toHaveLength(12);
    expect(new Set(stopping.map((p) => (isConnectorPath(p) ? p.node : '')))).toEqual(new Set(['n02']));
  });

  it('agrees on stop across every connector leaving the same lane', () => {
    // A car stops at the stop line, before it has committed to a connector, so
    // a lane whose connectors disagree would be unsimulatable. The compile rule
    // keys off the incoming lane's edge, which guarantees this — nothing else does.
    const byLane = new Map<string, Set<boolean>>();
    for (const path of network.paths) {
      if (!isConnectorPath(path)) continue;
      const seen = byLane.get(path.from) ?? new Set<boolean>();
      seen.add(path.stop);
      byLane.set(path.from, seen);
    }
    for (const [lane, values] of byLane) {
      expect([...values], `lane ${lane} has connectors that disagree about stop`).toHaveLength(1);
    }
  });

  it('uses only declared lane dirs, turns and conflict types', () => {
    for (const path of network.paths) {
      if (isLanePath(path)) {
        oneOf(path.dir, LANE_DIRS, `lane ${path.id}.dir`);
        expect(path.laneIndex).toBeGreaterThanOrEqual(0);
        for (const turn of path.turns ?? []) oneOf(turn, TURNS, `lane ${path.id}.turns`);
      } else {
        oneOf(path.turn, CONNECTOR_TURNS, `connector ${path.id}.turn`);
        for (const c of path.conflicts) oneOf(c.type, CONFLICT_TYPES, `connector ${path.id} conflict.type`);
      }
    }
  });

  it('resolves every path reference in next, conflicts and yieldTo', () => {
    const byId = pathsById(network);
    expect(byId.size).toBe(network.paths.length);

    for (const path of network.paths) {
      for (const n of path.next) expect(byId.has(n), `path ${path.id} next -> ${n}`).toBe(true);
      if (isConnectorPath(path)) {
        expect(byId.has(path.from), `connector ${path.id}.from`).toBe(true);
        expect(byId.has(path.to), `connector ${path.id}.to`).toBe(true);
        // PRD §7.4: a connector's `next` is always exactly `[to]`.
        expect(path.next).toEqual([path.to]);
        for (const c of path.conflicts) expect(byId.has(c.path), `connector ${path.id} conflict`).toBe(true);
        for (const y of path.yieldTo) expect(byId.has(y), `connector ${path.id} yieldTo`).toBe(true);
      }
    }
  });

  it('ties nodes, phases and controls together', () => {
    const byId = pathsById(network);
    const nodeIds = new Set(network.nodes.map((n) => n.id));

    for (const node of network.nodes) {
      oneOf(node.control, COMPILED_CONTROLS, `node ${node.id}.control`);
      for (const p of node.inPaths) expect(byId.has(p), `node ${node.id} inPath ${p}`).toBe(true);
      for (const c of node.connectors) expect(byId.has(c), `node ${node.id} connector ${c}`).toBe(true);

      // Phases exist for signals and are null otherwise (PRD §7.4).
      const signalized = node.control === 'signal' || node.control === 'signalProtectedLeft';
      expect(node.phases === null, `node ${node.id} phases vs control ${node.control}`).toBe(!signalized);

      const phaseIds = new Set((node.phases ?? []).map((p) => p.id));
      for (const phase of node.phases ?? []) {
        for (const p of phase.paths) expect(node.connectors, `phase ${node.id}/${phase.id}`).toContain(p);
      }
      // Every connector at a signal names one of that node's phases; unsignalized ones name none.
      for (const id of node.connectors) {
        const connector = byId.get(id);
        if (!connector || !isConnectorPath(connector)) continue;
        expect(connector.node).toBe(node.id);
        if (signalized) expect(phaseIds, `connector ${id}.phase`).toContain(connector.phase);
        else expect(connector.phase, `connector ${id}.phase`).toBeNull();
      }
    }

    for (const path of network.paths) {
      if (isConnectorPath(path)) expect(nodeIds, `connector ${path.id}.node`).toContain(path.node);
    }
  });

  it('compiles only the nodes that have connectors', () => {
    // `network.nodes` covers intersection/merge/diverge nodes. Boundary and
    // rampEnd nodes have nothing to drive through, so they are absent — a lane's
    // `fromNode`/`toNode` therefore names a *scenario* node, not necessarily a
    // compiled one. The engine must not assume it can look every one of them up.
    const scenarioKinds = new Map(scenario.nodes.map((n) => [n.id, n.kind]));
    const compiledIds = new Set(network.nodes.map((n) => n.id));

    for (const node of network.nodes) {
      expect(scenarioKinds.has(node.id), `compiled node ${node.id} is not in the scenario`).toBe(true);
      expect(['intersection', 'merge', 'diverge']).toContain(scenarioKinds.get(node.id));
    }
    for (const node of scenario.nodes) {
      if (node.kind === 'boundary' || node.kind === 'rampEnd') {
        expect(compiledIds, `${node.kind} node ${node.id} should not be compiled`).not.toContain(node.id);
      }
    }
    for (const path of network.paths) {
      if (isLanePath(path)) {
        expect(scenarioKinds.has(path.fromNode), `lane ${path.id}.fromNode`).toBe(true);
        expect(scenarioKinds.has(path.toNode), `lane ${path.id}.toNode`).toBe(true);
        // A lane ending at the map edge has nowhere to go.
        if (scenarioKinds.get(path.toNode) === 'boundary' || scenarioKinds.get(path.toNode) === 'rampEnd') {
          expect(path.next, `lane ${path.id} ends at the map edge`).toEqual([]);
        }
      }
    }
  });

  it('records the layout it was compiled from', () => {
    for (const edge of scenario.edges) {
      expect(network.layout.edges[edge.id], `layout.edges.${edge.id}`).toBeDefined();
    }
    for (const node of scenario.nodes.filter((n) => n.kind === 'intersection')) {
      expect(network.layout.nodes[node.id], `layout.nodes.${node.id}`).toBeDefined();
    }
  });

  it('gives every surviving point access on a real lane', () => {
    const byId = pathsById(network);
    for (const point of network.points) {
      oneOf(point.type, POINT_TYPES, `compiled point ${point.id}.type`);
      expect(point.access.length, `point ${point.id} has no access`).toBeGreaterThan(0);
      for (const access of point.access) {
        const path = byId.get(access.path);
        expect(path, `point ${point.id} access path ${access.path}`).toBeDefined();
        if (!path) continue;
        expect(isLanePath(path), `point ${point.id} must attach to a lane`).toBe(true);
        expect(access.s).toBeGreaterThanOrEqual(0);
        expect(access.s).toBeLessThanOrEqual(path.length + 1e-6);
      }
    }
  });
});

describe('preset contract', () => {
  it.each(presets.map((p) => [p.id, p] as const))('%s matches the declared shape', (_id, preset) => {
    expect(preset.format).toBe(PRESET_FORMAT);
    expect(preset.version).toBe(PRESET_VERSION);
    oneOf(preset.lighting, LIGHTINGS, `preset ${preset.id}.lighting`);
    oneOf(preset.spawnRate.unit, SPAWN_RATE_UNITS, `preset ${preset.id}.spawnRate.unit`);
    expect(preset.durationSec).toBeGreaterThan(0);
    expect(Number.isFinite(preset.seed)).toBe(true);
    expect(preset.warmup.realSeconds).toBeGreaterThanOrEqual(0);
    expect(preset.spawnRate.curve.length).toBeGreaterThan(1);
    expect(preset.parking.initialOccupancy).toBeGreaterThanOrEqual(0);
    expect(preset.parking.initialOccupancy).toBeLessThanOrEqual(1);
  });

  it('has trip shares summing to 1 over point types that exist in the scenario', () => {
    const scenarioPointTypes = new Set(scenario.points.map((p) => p.type));
    for (const preset of presets) {
      const total = preset.trips.reduce((sum, t) => sum + t.share, 0);
      expect(total, `preset ${preset.id} trip shares`).toBeCloseTo(1, 6);
      for (const trip of preset.trips) {
        for (const type of [...trip.from, ...trip.to]) {
          oneOf(type, POINT_TYPES, `preset ${preset.id} trip endpoint`);
          expect(scenarioPointTypes, `preset ${preset.id} wants ${type}`).toContain(type);
        }
      }
    }
  });

  it('interpolates the spawn-rate curve between and beyond its points', () => {
    const rate = { unit: 'vehiclesPerMinute' as const, curve: [[0, 10], [100, 20]] as [number, number][] };
    expect(spawnRateAt(rate, -10)).toBe(10); // clamped before the first point
    expect(spawnRateAt(rate, 0)).toBe(10);
    expect(spawnRateAt(rate, 50)).toBeCloseTo(15, 6);
    expect(spawnRateAt(rate, 100)).toBe(20);
    expect(spawnRateAt(rate, 999)).toBe(20); // clamped after the last point
  });
});

describe('vehicle types', () => {
  it('has unique ids and codes, with car as code 0', () => {
    const ids = VEHICLE_TYPES.map((v) => v.id);
    const codes = VEHICLE_TYPES.map((v) => v.code);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(codes).size).toBe(codes.length);
    // Code 0 must be `car` so a sender that knows nothing about vehicle types
    // (today's engine, the stub) decodes as a car rather than a semi.
    expect(vehicleTypeByCode(0).id).toBe('car');
    expect(DEFAULT_VEHICLE_TYPE.id).toBe('car');
  });

  it('keeps every code inside the bits reserved in the tick flags', () => {
    const maxCode = (1 << VEHICLE_CODE_BITS) - 1;
    for (const v of VEHICLE_TYPES) {
      expect(v.code, `${v.id} code`).toBeGreaterThanOrEqual(0);
      expect(v.code, `${v.id} code must fit in ${VEHICLE_CODE_BITS} bits`).toBeLessThanOrEqual(maxCode);
      expect(Number.isInteger(v.code), `${v.id} code`).toBe(true);
    }
    // Room for one more type before this needs a contract change.
    expect(VEHICLE_TYPES.length).toBeLessThanOrEqual(maxCode + 1);
  });

  it('gives every type a positive length and width, ordered car < truck < semi', () => {
    for (const v of VEHICLE_TYPES) {
      expect(v.length, `${v.id} length`).toBeGreaterThan(0);
      expect(v.width, `${v.id} width`).toBeGreaterThan(0);
      // A vehicle wider than a lane would clip neighbours once drawn.
      expect(v.width, `${v.id} width vs lane width`).toBeLessThan(LANE_WIDTHS.car);
    }
    expect(vehicleTypeById('car').length).toBeLessThan(vehicleTypeById('truck').length);
    expect(vehicleTypeById('truck').length).toBeLessThan(vehicleTypeById('semi').length);
  });

  it('falls back to car for unknown ids and codes instead of throwing', () => {
    expect(vehicleTypeById('tractor').id).toBe('car');
    expect(vehicleTypeByCode(3).id).toBe('car');
    expect(vehicleTypeByCode(-1).id).toBe('car');
  });
});

describe('vehicle type in tick flags', () => {
  it('round-trips every type without disturbing the other flags', () => {
    const others = [
      0,
      TICK_FLAG_BRAKING,
      TICK_FLAG_STOPPED,
      TICK_FLAG_YIELDING,
      TICK_FLAG_BRAKING | TICK_FLAG_STOPPED | TICK_FLAG_YIELDING,
    ];
    for (const v of VEHICLE_TYPES) {
      for (const base of others) {
        const flags = withVehicleCode(base, v.code);
        expect(vehicleCodeOf(flags), `${v.id} over base ${base}`).toBe(v.code);
        expect(vehicleTypeByCode(vehicleCodeOf(flags)).id).toBe(v.id);
        // The three behavior bits must survive untouched.
        expect(hasFlag(flags, TICK_FLAG_BRAKING)).toBe(hasFlag(base, TICK_FLAG_BRAKING));
        expect(hasFlag(flags, TICK_FLAG_STOPPED)).toBe(hasFlag(base, TICK_FLAG_STOPPED));
        expect(hasFlag(flags, TICK_FLAG_YIELDING)).toBe(hasFlag(base, TICK_FLAG_YIELDING));
      }
    }
  });

  it('reads a sender that knows nothing about vehicle types as car', () => {
    const legacy = TICK_FLAG_BRAKING | TICK_FLAG_YIELDING;
    expect(vehicleCodeOf(legacy)).toBe(0);
    expect(vehicleTypeByCode(vehicleCodeOf(legacy)).id).toBe('car');
  });

  it('replaces rather than ORs the previous code', () => {
    const asSemi = withVehicleCode(TICK_FLAG_STOPPED, 2);
    const backToCar = withVehicleCode(asSemi, 0);
    expect(vehicleCodeOf(backToCar)).toBe(0);
    expect(hasFlag(backToCar, TICK_FLAG_STOPPED)).toBe(true);
  });

  it('survives a round trip through a Float32Array tick buffer', () => {
    // Flags share the buffer with floats; the packed value must stay exact.
    const buf = new Float32Array(TICK_STRIDE);
    const flags = withVehicleCode(TICK_FLAG_BRAKING | TICK_FLAG_YIELDING, 2);
    writeTickCar(buf, 0, { vehicleId: 7, pathIndex: 1, s: 12.5, speed: 9, flags });
    const read = readTickCar(buf, 0);
    expect(read.flags).toBe(flags);
    expect(vehicleTypeByCode(vehicleCodeOf(read.flags)).id).toBe('semi');
  });

  it('does not collide with the behavior bits', () => {
    const behavior = TICK_FLAG_BRAKING | TICK_FLAG_STOPPED | TICK_FLAG_YIELDING;
    expect(TICK_FLAG_VEHICLE_MASK & behavior).toBe(0);
  });
});

describe('preset vehicle mix', () => {
  it('leaves the starter presets valid with no vehicleMix', () => {
    for (const preset of presets) {
      expect(preset.vehicleMix, `preset ${preset.id}`).toBeUndefined();
      expect(validateVehicleMix(preset.vehicleMix), `preset ${preset.id}`).toEqual([]);
      // An absent mix means all cars.
      expect(vehicleMixOf(preset)).toEqual([{ type: 'car', share: 1 }]);
    }
  });

  it('accepts a well-formed mix', () => {
    expect(
      validateVehicleMix([
        { type: 'car', share: 0.9 },
        { type: 'truck', share: 0.08 },
        { type: 'semi', share: 0.02 },
      ]),
    ).toEqual([]);
  });

  it('rejects unknown types and shares that do not sum to 1', () => {
    const unknown = validateVehicleMix([{ type: 'tractor' as VehicleTypeId, share: 1 }]);
    expect(unknown.join(' ')).toContain('unknown vehicle type');

    const badSum = validateVehicleMix([
      { type: 'car', share: 0.5 },
      { type: 'truck', share: 0.2 },
    ]);
    expect(badSum.join(' ')).toContain('sum to');

    expect(validateVehicleMix([]).join(' ')).toContain('empty');
    expect(
      validateVehicleMix([
        { type: 'car', share: 0.5 },
        { type: 'car', share: 0.5 },
      ]).join(' '),
    ).toContain('duplicate');
  });
});

describe('message buffer layout', () => {
  it('round-trips a car through a tick buffer', () => {
    const buf = new Float32Array(3 * TICK_STRIDE);
    const car = { vehicleId: 42, pathIndex: 418, s: 37.25, speed: 12.5, flags: TICK_FLAG_BRAKING };
    writeTickCar(buf, 1, car);

    expect(readTickCar(buf, 1)).toEqual(car);
    // Neighboring slots are untouched, i.e. the stride is right.
    expect(readTickCar(buf, 0).vehicleId).toBe(0);
    expect(readTickCar(buf, 2).vehicleId).toBe(0);
  });

  it('keeps the three tick flags independent', () => {
    const flags = TICK_FLAG_BRAKING | TICK_FLAG_YIELDING;
    expect(hasFlag(flags, TICK_FLAG_BRAKING)).toBe(true);
    expect(hasFlag(flags, TICK_FLAG_YIELDING)).toBe(true);
    expect(hasFlag(flags, TICK_FLAG_STOPPED)).toBe(false);
    expect(new Set([TICK_FLAG_BRAKING, TICK_FLAG_STOPPED, TICK_FLAG_YIELDING]).size).toBe(3);
  });

  it('sizes a stats buffer to the compiled network', () => {
    const buf = new Float32Array(network.paths.length * STATS_STRIDE);
    expect(buf.length).toBe(network.paths.length * STATS_STRIDE);
    expect(SIM_DT).toBeCloseTo(0.1, 10);
    expect(PLAYBACK_SPEEDS).toContain(1);
  });
});
