/**
 * Validation for an already-compiled network (PRD §7.4). Takes a
 * `CompiledNetwork` only — never the compile step — so this module has no
 * dependency on how the network was produced. Used by the compile CLI after
 * compiling, and by tests to check the golden file and hand-built fixtures.
 *
 * Every check reports distinct, stable `code`s rather than throwing, so a
 * caller can decide what to do with partial failures. `assertValid` is the
 * convenience wrapper for callers that just want a thrown `Error`.
 */

import {
  NETWORK_FORMAT,
  NETWORK_VERSION,
  isConnectorPath,
  isLanePath,
  type CompiledNetwork,
  type CompiledPath,
} from '@shared/network.js';

export interface ValidationProblem {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  node?: string;
  point?: string;
}

const SPAWN_TYPES = new Set(['edgeSpawn', 'rampSpawn']);
const SINK_TYPES = new Set(['edgeSink', 'rampSink', 'parking', 'lunchZone']);
const SIGNAL_CONTROLS = new Set(['signal', 'signalProtectedLeft']);
/** Controls where `ConnectorPath.stop` is pinned to a single value (rule 6). */
const STOP_ALWAYS_FALSE = new Set(['signal', 'signalProtectedLeft', 'merge', 'none']);

export function validateNetwork(network: CompiledNetwork): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const report = (p: ValidationProblem): void => {
    problems.push(p);
  };

  // ---------------------------------------------------------------------
  // 1. Index integrity
  // ---------------------------------------------------------------------
  const seenIds = new Set<string>();
  for (let i = 0; i < network.paths.length; i++) {
    const path = network.paths[i];
    if (!path) continue;
    if (path.index !== i) {
      report({
        severity: 'error',
        code: 'path-index-mismatch',
        message: `path ${path.id} has index ${path.index} but sits at position ${i}`,
        path: path.id,
      });
    }
    if (seenIds.has(path.id)) {
      report({
        severity: 'error',
        code: 'duplicate-path-id',
        message: `path id ${path.id} appears more than once`,
        path: path.id,
      });
    }
    seenIds.add(path.id);
  }

  const pathIds = new Set(network.paths.map((p) => p.id));
  const pathById = new Map<string, CompiledPath>();
  for (const p of network.paths) pathById.set(p.id, p);
  const nodeIds = new Set(network.nodes.map((n) => n.id));

  const resolvesToPath = (id: string, code: string, message: string, extra?: Partial<ValidationProblem>): boolean => {
    if (pathIds.has(id)) return true;
    report({ severity: 'error', code, message, ...extra });
    return false;
  };

  // ---------------------------------------------------------------------
  // 2. Reference integrity
  // ---------------------------------------------------------------------
  for (const path of network.paths) {
    for (const nextId of path.next) {
      resolvesToPath(nextId, 'dangling-next', `${path.id}: next ${nextId} does not resolve to a path`, {
        path: path.id,
      });
    }
    if (isConnectorPath(path)) {
      const fromOk = resolvesToPath(path.from, 'dangling-connector-endpoint', `${path.id}: from ${path.from} does not resolve to a path`, { path: path.id });
      const toOk = resolvesToPath(path.to, 'dangling-connector-endpoint', `${path.id}: to ${path.to} does not resolve to a path`, { path: path.id });
      if (fromOk) {
        const fromPath = pathById.get(path.from);
        if (fromPath && !isLanePath(fromPath)) {
          report({
            severity: 'error',
            code: 'connector-endpoint-not-lane',
            message: `${path.id}: from ${path.from} is not a lane path`,
            path: path.id,
          });
        }
      }
      if (toOk) {
        const toPath = pathById.get(path.to);
        if (toPath && !isLanePath(toPath)) {
          report({
            severity: 'error',
            code: 'connector-endpoint-not-lane',
            message: `${path.id}: to ${path.to} is not a lane path`,
            path: path.id,
          });
        }
      }
      if (path.next.length !== 1 || path.next[0] !== path.to) {
        report({
          severity: 'error',
          code: 'connector-next-invalid',
          message: `${path.id}: next must be exactly [to] (${JSON.stringify([path.to])}), got ${JSON.stringify(path.next)}`,
          path: path.id,
        });
      }
      for (const conflict of path.conflicts) {
        resolvesToPath(
          conflict.path,
          'dangling-conflict',
          `${path.id}: conflict ${conflict.path} does not resolve to a path`,
          { path: path.id },
        );
      }
      for (const yieldId of path.yieldTo) {
        resolvesToPath(yieldId, 'dangling-yield-to', `${path.id}: yieldTo ${yieldId} does not resolve to a path`, {
          path: path.id,
        });
      }
    }
  }

  for (const node of network.nodes) {
    for (const id of node.inPaths) {
      resolvesToPath(id, 'dangling-node-inpath', `${node.id}: inPaths ${id} does not resolve to a path`, {
        node: node.id,
      });
    }
    for (const id of node.connectors) {
      resolvesToPath(id, 'dangling-node-connector', `${node.id}: connectors ${id} does not resolve to a path`, {
        node: node.id,
      });
    }
    if (node.phases) {
      for (const phase of node.phases) {
        for (const id of phase.paths) {
          resolvesToPath(id, 'dangling-phase-path', `${node.id} phase ${phase.id}: path ${id} does not resolve`, {
            node: node.id,
          });
        }
      }
    }
  }

  for (const point of network.points) {
    for (const access of point.access) {
      resolvesToPath(access.path, 'dangling-point-access', `${point.id}: access path ${access.path} does not resolve`, {
        point: point.id,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 3/4. Dead-end and unreachable lanes
  // ---------------------------------------------------------------------
  const reachedByNext = new Set<string>();
  for (const path of network.paths) {
    for (const id of path.next) reachedByNext.add(id);
  }

  for (const path of network.paths) {
    if (!isLanePath(path)) continue;
    if (path.next.length === 0 && nodeIds.has(path.toNode)) {
      report({
        severity: 'error',
        code: 'dead-end-lane',
        message: `${path.id}: no outgoing connector, but toNode ${path.toNode} is a compiled node`,
        path: path.id,
        node: path.toNode,
      });
    }
    if (!reachedByNext.has(path.id) && nodeIds.has(path.fromNode)) {
      report({
        severity: 'error',
        code: 'unreachable-lane',
        message: `${path.id}: no connector leads into it, but fromNode ${path.fromNode} is a compiled node`,
        path: path.id,
        node: path.fromNode,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 5. Spawn reachability (BFS over next edges)
  // ---------------------------------------------------------------------
  const sinkAccessPaths = new Set<string>();
  for (const point of network.points) {
    if (!SINK_TYPES.has(point.type)) continue;
    for (const access of point.access) sinkAccessPaths.add(access.path);
  }

  for (const point of network.points) {
    if (!SPAWN_TYPES.has(point.type) && !SINK_TYPES.has(point.type)) continue;
    if (point.access.length === 0) {
      // No lane a car could use. Nothing in the test grid hits this, but a
      // one-way edge at the map boundary would: a spawn anchored to the node
      // it flows *into* has no outgoing lane to appear on, so the point is
      // dead weight the preset's trip shares would still be spending on it.
      report({
        severity: 'error',
        code: 'point-no-access',
        message: `point ${point.id} (${point.type}) resolved to no access lane`,
        point: point.id,
      });
    }
  }

  for (const point of network.points) {
    if (!SPAWN_TYPES.has(point.type)) continue;
    const start = point.access.map((a) => a.path).filter((id) => pathIds.has(id));
    if (start.length === 0) continue;

    const visited = new Set<string>(start);
    const queue: string[] = [...start];
    let foundSink = start.some((id) => sinkAccessPaths.has(id));

    while (!foundSink && queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const currentPath = pathById.get(current);
      if (!currentPath) continue;
      for (const nextId of currentPath.next) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        if (sinkAccessPaths.has(nextId)) {
          foundSink = true;
          break;
        }
        queue.push(nextId);
      }
    }

    if (!foundSink) {
      report({
        severity: 'error',
        code: 'spawn-unreachable',
        message: `${point.id}: no sink/parking/lunchZone point is reachable from its access lanes`,
        point: point.id,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 6. Control consistency
  // ---------------------------------------------------------------------
  const laneStopByLane = new Map<string, Set<boolean>>();

  for (const node of network.nodes) {
    const isSignal = SIGNAL_CONTROLS.has(node.control);
    if (isSignal !== (node.phases !== null)) {
      report({
        severity: 'error',
        code: 'phases-presence-mismatch',
        message: `${node.id}: control ${node.control} ${isSignal ? 'requires' : 'must not have'} phases, phases is ${
          node.phases === null ? 'null' : 'present'
        }`,
        node: node.id,
      });
    }

    const phaseIds = new Set((node.phases ?? []).map((ph) => ph.id));

    for (const connId of node.connectors) {
      const conn = pathById.get(connId);
      if (!conn || !isConnectorPath(conn)) continue;

      if (isSignal) {
        if (conn.phase === null || !phaseIds.has(conn.phase)) {
          report({
            severity: 'error',
            code: 'connector-phase-unknown',
            message: `${conn.id}: phase ${String(conn.phase)} does not name a phase of node ${node.id}`,
            path: conn.id,
            node: node.id,
          });
        }
      } else if (conn.phase !== null) {
        report({
          severity: 'error',
          code: 'connector-phase-should-be-null',
          message: `${conn.id}: node ${node.id} (${node.control}) is unsignalized but phase is ${conn.phase}`,
          path: conn.id,
          node: node.id,
        });
      }

      if (node.control === 'allStop' && !conn.stop) {
        report({
          severity: 'error',
          code: 'connector-stop-mismatch',
          message: `${conn.id}: node ${node.id} is allStop but stop is false`,
          path: conn.id,
          node: node.id,
        });
      } else if (STOP_ALWAYS_FALSE.has(node.control) && conn.stop) {
        report({
          severity: 'error',
          code: 'connector-stop-mismatch',
          message: `${conn.id}: node ${node.id} (${node.control}) must never stop, but stop is true`,
          path: conn.id,
          node: node.id,
        });
      }

      let seen = laneStopByLane.get(conn.from);
      if (!seen) {
        seen = new Set<boolean>();
        laneStopByLane.set(conn.from, seen);
      }
      seen.add(conn.stop);
    }
  }

  for (const [laneId, stops] of laneStopByLane) {
    if (stops.size > 1) {
      report({
        severity: 'error',
        code: 'lane-stop-inconsistent',
        message: `lane ${laneId}: connectors leaving it disagree on stop (${[...stops].join(', ')})`,
        path: laneId,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 7. Sanity
  // ---------------------------------------------------------------------
  if (network.format !== NETWORK_FORMAT) {
    report({
      severity: 'error',
      code: 'format-mismatch',
      message: `format ${network.format} !== ${NETWORK_FORMAT}`,
    });
  }
  if (network.version !== NETWORK_VERSION) {
    report({
      severity: 'error',
      code: 'version-mismatch',
      message: `version ${network.version} !== ${NETWORK_VERSION}`,
    });
  }

  for (const path of network.paths) {
    if (!Number.isFinite(path.length) || path.length < 0) {
      report({
        severity: 'error',
        code: 'invalid-length',
        message: `${path.id}: length ${path.length} is not a non-negative finite number`,
        path: path.id,
      });
    }
    if (!Number.isFinite(path.speedLimit) || path.speedLimit <= 0) {
      report({
        severity: 'error',
        code: 'invalid-speed-limit',
        message: `${path.id}: speedLimit ${path.speedLimit} is not a positive finite number`,
        path: path.id,
      });
    }
  }

  for (const point of network.points) {
    for (const access of point.access) {
      const accessPath = pathById.get(access.path);
      if (!accessPath) continue;
      if (access.s < 0 || access.s > accessPath.length) {
        report({
          severity: 'error',
          code: 'access-s-out-of-range',
          message: `${point.id}: access s=${access.s} out of [0, ${accessPath.length}] on ${access.path}`,
          point: point.id,
          path: access.path,
        });
      }
    }
  }

  return problems;
}

/** Throws with every error-severity problem listed, or does nothing if there are none. */
export function assertValid(network: CompiledNetwork): void {
  const problems = validateNetwork(network).filter((p) => p.severity === 'error');
  if (problems.length === 0) return;
  const lines = problems.map((p) => `[${p.code}] ${p.message}`);
  throw new Error(`network validation failed with ${problems.length} error(s):\n${lines.join('\n')}`);
}
