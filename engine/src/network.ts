/**
 * S2: load a compiled network (`flowstate-network` v2, `shared/network.ts`) into
 * flat, index-based arrays the simulation loop can use without string lookups.
 *
 * The loader validates every cross-reference up front and throws a descriptive
 * error on the first problem, so a bad file fails at `load` rather than as a
 * confusing glitch mid-run. Unknown fields and `debugPolyline` are ignored.
 */
import {
  NETWORK_FORMAT,
  NETWORK_VERSION,
  isConnectorPath,
  type CompiledNetwork,
  type CompiledNode,
  type CompiledPath,
  type CompiledPoint,
} from '@shared/network.js';

export interface Network {
  /** The original paths, by index. For IDs and fields the hot loop doesn't need. */
  readonly paths: readonly CompiledPath[];
  readonly count: number;
  /** Meters, by path index. */
  readonly length: Float64Array;
  /** m/s, by path index. */
  readonly speedLimit: Float64Array;
  /** 1 for lane paths, 0 for connectors. */
  readonly isLane: Uint8Array;
  /** Path indices reachable from the end of each path. */
  readonly next: readonly Int32Array[];
  /** Path indices whose end leads into the start of each path. */
  readonly prev: readonly Int32Array[];
  readonly byId: ReadonlyMap<string, number>;
  readonly nodes: ReadonlyMap<string, CompiledNode>;
  readonly points: ReadonlyMap<string, CompiledPoint>;
  /** Source scenario ID, for messages and logs. */
  readonly scenario: string;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(`Invalid compiled network: ${message}`);
    this.name = 'NetworkError';
  }
}

function fail(message: string): never {
  throw new NetworkError(message);
}

export function loadNetwork(raw: CompiledNetwork): Network {
  if (raw === null || typeof raw !== 'object') fail('not an object');
  if (raw.format !== NETWORK_FORMAT) fail(`format is "${String(raw.format)}", expected "${NETWORK_FORMAT}"`);
  if (raw.version !== NETWORK_VERSION) {
    fail(`version is ${String(raw.version)}, this engine reads version ${NETWORK_VERSION}. Recompile the scenario.`);
  }
  if (!Array.isArray(raw.paths) || raw.paths.length === 0) fail('no paths');

  const paths = raw.paths;
  const count = paths.length;
  const byId = new Map<string, number>();

  paths.forEach((p, i) => {
    if (p.index !== i) fail(`path ${p.id} has index ${p.index} but sits at position ${i} in paths`);
    if (byId.has(p.id)) fail(`duplicate path id ${p.id}`);
    if (!(p.length > 0)) fail(`path ${p.id} has length ${p.length}`);
    if (!(p.speedLimit > 0)) fail(`path ${p.id} has speedLimit ${p.speedLimit}`);
    byId.set(p.id, i);
  });

  const resolve = (id: string, where: string): number => {
    const i = byId.get(id);
    if (i === undefined) fail(`${where} refers to unknown path ${id}`);
    return i;
  };

  const length = new Float64Array(count);
  const speedLimit = new Float64Array(count);
  const isLane = new Uint8Array(count);
  const next: Int32Array[] = [];
  const prevLists: number[][] = paths.map(() => []);

  paths.forEach((p, i) => {
    length[i] = p.length;
    speedLimit[i] = p.speedLimit;
    isLane[i] = p.kind === 'lane' ? 1 : 0;
    const out = Int32Array.from(p.next.map((id) => resolve(id, `${p.id}.next`)));
    next.push(out);
    for (const j of out) prevLists[j]!.push(i);

    if (isConnectorPath(p)) {
      const from = resolve(p.from, `${p.id}.from`);
      resolve(p.to, `${p.id}.to`);
      if (!paths[from]!.next.includes(p.id)) fail(`${p.id}.from is ${p.from}, but that path's next doesn't list it`);
      if (p.next.length !== 1 || p.next[0] !== p.to) fail(`${p.id}.next must be exactly [${p.to}]`);
      for (const c of p.conflicts) resolve(c.path, `${p.id}.conflicts`);
      for (const y of p.yieldTo) resolve(y, `${p.id}.yieldTo`);
      if (typeof p.stop !== 'boolean') fail(`${p.id}.stop must be true or false`);
    }
  });

  const nodes = new Map<string, CompiledNode>();
  for (const n of raw.nodes ?? []) {
    if (nodes.has(n.id)) fail(`duplicate node id ${n.id}`);
    for (const id of n.inPaths) resolve(id, `node ${n.id}.inPaths`);
    for (const id of n.connectors) resolve(id, `node ${n.id}.connectors`);
    for (const ph of n.phases ?? []) for (const id of ph.paths) resolve(id, `node ${n.id} phase ${ph.id}`);
    nodes.set(n.id, n);
  }

  const points = new Map<string, CompiledPoint>();
  for (const pt of raw.points ?? []) {
    if (points.has(pt.id)) fail(`duplicate point id ${pt.id}`);
    for (const a of pt.access) {
      const i = resolve(a.path, `point ${pt.id}.access`);
      if (!(a.s >= 0 && a.s <= length[i]! + 1e-6)) {
        fail(`point ${pt.id} access s=${a.s} is outside ${a.path} (length ${length[i]})`);
      }
    }
    points.set(pt.id, pt);
  }

  return {
    paths,
    count,
    length,
    speedLimit,
    isLane,
    next,
    prev: prevLists.map((l) => Int32Array.from(l)),
    byId,
    nodes,
    points,
    scenario: raw.scenario,
  };
}

export interface NetworkSummary {
  scenario: string;
  paths: number;
  lanes: number;
  connectors: number;
  nodes: number;
  nodesByControl: Record<string, number>;
  points: number;
  pointsByType: Record<string, number>;
}

export function describeNetwork(net: Network): NetworkSummary {
  const tally = (values: Iterable<string>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const v of values) out[v] = (out[v] ?? 0) + 1;
    return out;
  };
  const lanes = net.isLane.reduce((a, b) => a + b, 0);
  return {
    scenario: net.scenario,
    paths: net.count,
    lanes,
    connectors: net.count - lanes,
    nodes: net.nodes.size,
    nodesByControl: tally([...net.nodes.values()].map((n) => n.control)),
    points: net.points.size,
    pointsByType: tally([...net.points.values()].map((p) => p.type)),
  };
}
