import { describe, expect, it } from 'vitest';

import { laneCenterlines, nodeSetback } from '@web/geometry/laneLayout.js';
import type { Edge, EdgeOption, Node, NodeOption } from '@shared/scenario.js';

function makeEdge(option: EdgeOption): Edge {
  return {
    id: 'eTest',
    name: 'Test',
    from: 'n0',
    to: 'n1',
    roadClass: 'residential',
    centerline: [
      [0, 0],
      [100, 0],
    ],
    elevation: null,
    speedLimit: 13.4,
    estimated: {},
    options: [option],
    selected: option.id,
    locked: false,
    osmWayIds: [],
    tags: {},
  };
}

describe('laneCenterlines', () => {
  it('centers lanes on a one-way street (empty opposite direction)', () => {
    const option: EdgeOption = {
      id: 'current',
      label: 'Current',
      kind: 'current',
      forward: [{ type: 'car' }, { type: 'car' }],
      backward: [],
    };
    const edge = makeEdge(option);
    const lanes = laneCenterlines(edge, option, 'f');
    expect(lanes).toHaveLength(2);
    // Two car lanes (3.5 wide each), centered on the centerline: offsets of
    // -1.75 and +1.75, which for an eastbound (right = south) centerline puts
    // lane 0 (leftmost) to the north (+y) and lane 1 to the south (-y).
    expect(lanes[0]?.centerline[0]?.[1]).toBeCloseTo(1.75, 10);
    expect(lanes[1]?.centerline[0]?.[1]).toBeCloseTo(-1.75, 10);
  });

  it('places lanes entirely right of center on a two-way street', () => {
    const option: EdgeOption = {
      id: 'current',
      label: 'Current',
      kind: 'current',
      forward: [{ type: 'car' }],
      backward: [{ type: 'car' }],
    };
    const edge = makeEdge(option);
    const forward = laneCenterlines(edge, option, 'f');
    // Single forward lane: offset = 0 + 3.5/2 = 1.75 to the right of travel,
    // which for an eastbound centerline (heading east) is south, i.e. y = -1.75.
    expect(forward[0]?.centerline[0]?.[1]).toBeCloseTo(-1.75, 10);
  });

  it('reverses the centerline for the backward direction', () => {
    const option: EdgeOption = {
      id: 'current',
      label: 'Current',
      kind: 'current',
      forward: [{ type: 'car' }],
      backward: [{ type: 'car' }],
    };
    const edge = makeEdge(option);
    const backward = laneCenterlines(edge, option, 'b');
    expect(backward[0]?.centerline[0]?.[0]).toBeCloseTo(100, 10);
    expect(backward[0]?.centerline[backward[0]!.centerline.length - 1]?.[0]).toBeCloseTo(0, 10);
  });

  it('includes bike and transit lanes in the index and offsets', () => {
    const option: EdgeOption = {
      id: 'current',
      label: 'Current',
      kind: 'current',
      forward: [{ type: 'bike' }, { type: 'car' }],
      backward: [],
    };
    const edge = makeEdge(option);
    const lanes = laneCenterlines(edge, option, 'f');
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.lane.type).toBe('bike');
    expect(lanes[1]?.lane.type).toBe('car');
    expect(lanes[0]?.laneIndex).toBe(0);
    expect(lanes[1]?.laneIndex).toBe(1);
  });
});

describe('nodeSetback', () => {
  const node: Node = {
    id: 'n0',
    name: '',
    x: 0,
    y: 0,
    z: 0,
    kind: 'intersection',
    branch: null,
    restrictions: [],
    options: [],
    selected: 'current',
    locked: false,
    osmIds: [],
    tags: {},
  };

  it('uses the fixed per-kind setback for non-roundabout controls', () => {
    const opt: NodeOption = { id: 'current', label: '', control: 'signal', params: {} };
    expect(nodeSetback(node, opt)).toBe(12);
    expect(nodeSetback({ ...node, kind: 'merge' }, opt)).toBe(8);
    expect(nodeSetback({ ...node, kind: 'diverge' }, opt)).toBe(8);
    expect(nodeSetback({ ...node, kind: 'boundary' }, opt)).toBe(0);
    expect(nodeSetback({ ...node, kind: 'rampEnd' }, opt)).toBe(0);
  });

  it('adds the roundabout margin to the ring radius', () => {
    const opt: NodeOption = { id: 'roundabout', label: '', control: 'roundabout', params: { radius: 16 } };
    expect(nodeSetback(node, opt)).toBe(22);
  });
});
