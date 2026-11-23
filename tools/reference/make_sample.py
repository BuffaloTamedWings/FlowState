"""
FlowState reference generator for the starter files.

Builds a small hand-made sample map ("test-grid") in the scenario format, then
compiles its current layout into the compiled-network format the engine runs on,
and writes the three preset files.

This is a REFERENCE for the TypeScript compile step (web/src/compile/), not
production code. The rules here (lane offsets, setbacks, turn mapping,
conflicts, yields, signal phases, option catalog) are the ones described in the
PRD. Port them; don't import this.

Usage: python make_sample.py <output_dir>
"""
import hashlib
import json
import math
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
MPH = 0.44704
LANE_W = {"car": 3.5, "transit": 3.5, "bike": 1.8}
TURN_SPEED = 6.7  # m/s (~15 mph) for left/right turn connectors
SETBACK = {"intersection": 12.0, "merge": 8.0, "diverge": 8.0, "boundary": 0.0, "rampEnd": 0.0}
CLASS_RANK = {"primary": 4, "secondary": 3, "frontage": 3, "tertiary": 2, "residential": 1, "ramp": 0}


def r2(v):
    return round(v, 2)


# --------------------------------------------------------------------------
# 1. Source map (what the import script would produce)
# --------------------------------------------------------------------------
nodes = {}
edges = {}
points = []

COLS = {0: 0.0, 1: 120.0, 2: 240.0}
ROWS = {0: 0.0, 1: 100.0, 2: 200.0}
COL_NAMES = {0: "1st Ave", 1: "2nd Ave", 2: "3rd Ave"}
ROW_NAMES = {0: "Frontage Rd", 1: "B St", 2: "A St"}
XW, XE, YN = -150.0, 420.0, 300.0


def add_node(nid, x, y, kind, control=None, name=None, z=0.0, branch=None):
    nodes[nid] = {
        "id": nid, "x": x, "y": y, "z": z, "kind": kind, "name": name,
        "control": control, "branch": branch, "restrictions": [],
    }


ctrl = {(0, 0): "signal", (1, 0): "signal", (2, 0): "signal",
        (0, 1): "signal", (1, 1): "signal", (2, 1): "signal",
        (0, 2): "allStop", (1, 2): "signal", (2, 2): "signal"}
for c in COLS:
    for r in ROWS:
        add_node(f"n{c}{r}", COLS[c], ROWS[r], "intersection", ctrl[(c, r)],
                 f"{COL_NAMES[c]} & {ROW_NAMES[r]}")

add_node("bFE", XE, 0.0, "boundary", name="Frontage Rd (east edge)")
add_node("bFW", XW, 0.0, "boundary", name="Frontage Rd (west edge)")
add_node("bW1", XW, 100.0, "boundary", name="B St (west edge)")
add_node("bE1", XE, 100.0, "boundary", name="B St (east edge)")
add_node("bW2", XW, 200.0, "boundary", name="A St (west edge)")
add_node("bE2", XE, 200.0, "boundary", name="A St (east edge)")
add_node("bN0", 0.0, YN, "boundary", name="1st Ave (north edge)")
add_node("bN1", 120.0, YN, "boundary", name="2nd Ave (north edge)")
add_node("bN2", 240.0, YN, "boundary", name="3rd Ave (north edge)")
add_node("M", 330.0, 0.0, "merge", name="Exit ramp merge", branch={"edge": "eROff", "side": "left"})
add_node("D", -60.0, 0.0, "diverge", name="Entrance ramp split", branch={"edge": "eROn", "side": "left"})
add_node("rOff", 420.0, -28.0, "rampEnd", name="Freeway exit ramp (top)", z=-7.0)
add_node("rOn", -150.0, -28.0, "rampEnd", name="Freeway entrance ramp (end)", z=-7.0)


def L(n, t="car"):
    return [{"type": t} for _ in range(n)]


def add_edge(eid, a, b, name, cls, fwd, bwd, mph, mid=None, elev=None):
    pts = [[nodes[a]["x"], nodes[a]["y"]]] + (mid or []) + [[nodes[b]["x"], nodes[b]["y"]]]
    edges[eid] = {
        "id": eid, "from": a, "to": b, "name": name, "roadClass": cls,
        "centerline": pts, "elevation": elev,
        "speedLimit": r2(mph * MPH),
        "base": {"forward": L(fwd), "backward": L(bwd)},
    }


# Frontage road: one-way westbound, 2 lanes. Reference direction = westbound.
chain = ["bFE", "M", "n20", "n10", "n00", "D", "bFW"]
for i in range(len(chain) - 1):
    add_edge(f"eF{len(chain) - 2 - i}", chain[i], chain[i + 1], "Frontage Rd", "frontage", 2, 0, 40)
# B St: one-way eastbound, 2 lanes
chain = ["bW1", "n01", "n11", "n21", "bE1"]
for i in range(4):
    add_edge(f"eB{i}", chain[i], chain[i + 1], "B St", "secondary", 2, 0, 30)
# A St: two-way 1+1
chain = ["bW2", "n02", "n12", "n22", "bE2"]
for i in range(4):
    add_edge(f"eA{i}", chain[i], chain[i + 1], "A St", "tertiary", 1, 1, 30)
# 1st Ave: two-way 1+1, northbound reference
for i, (a, b) in enumerate([("n00", "n01"), ("n01", "n02"), ("n02", "bN0")]):
    add_edge(f"e1{'abc'[i]}", a, b, "1st Ave", "tertiary", 1, 1, 30)
# 2nd Ave: one-way northbound, 2 lanes
for i, (a, b) in enumerate([("n10", "n11"), ("n11", "n12"), ("n12", "bN1")]):
    add_edge(f"e2{'abc'[i]}", a, b, "2nd Ave", "secondary", 2, 0, 30)
# 3rd Ave: two-way 2+2
for i, (a, b) in enumerate([("n20", "n21"), ("n21", "n22"), ("n22", "bN2")]):
    add_edge(f"e3{'abc'[i]}", a, b, "3rd Ave", "primary", 2, 2, 35)
# Ramps (1 lane, descend to the depressed freeway)
add_edge("eROff", "rOff", "M", "Freeway exit ramp", "ramp", 1, 0, 35, mid=[[380.0, -14.0]], elev=[-7.0, -3.5, 0.0])
add_edge("eROn", "D", "rOn", "Freeway entrance ramp", "ramp", 1, 0, 35, mid=[[-105.0, -14.0]], elev=[0.0, -3.5, -7.0])

# Turn restriction example: no left from eastbound B St onto northbound 1st Ave
nodes["n01"]["restrictions"].append({"fromEdge": "eB0", "toEdge": "e1b", "type": "noTurn"})


# --------------------------------------------------------------------------
# 2. Option catalog
# --------------------------------------------------------------------------
def car_count(lanes):
    return sum(1 for l in lanes if l["type"] == "car")


def h(s):
    return int(hashlib.md5(s.encode()).hexdigest(), 16)


def pick3(eid, cands):
    """Deterministic rotation so neighbours tend to get different sets."""
    if len(cands) <= 3:
        return cands
    k = h(eid) % len(cands)
    rot = cands[k:] + cands[:k]
    return rot[:3]


def replace_rightmost_car(lanes, new_type):
    out = [dict(l) for l in lanes]
    for i in range(len(out) - 1, -1, -1):
        if out[i]["type"] == "car":
            out[i] = {"type": new_type}
            return out
    return out


def edge_options(e):
    f, b = e["base"]["forward"], e["base"]["backward"]
    cf, cb = car_count(f), car_count(b)
    two_way = cf > 0 and cb > 0
    cls = e["roadClass"]
    ends = (nodes[e["from"]]["kind"], nodes[e["to"]]["kind"])
    current = {"id": "current", "label": "Current layout", "kind": "current", "forward": f, "backward": b}
    if cls == "ramp":
        return [current], True

    cands = []
    if max(cf, cb) < 4:
        cands.append({"kind": "widen", "label": "Add a lane",
                      "forward": f + L(1) if cf else f, "backward": b + L(1) if cb else b})
    if (two_way and cf >= 2 and cb >= 2) or (not two_way and max(cf, cb) >= 3):
        cands.append({"kind": "roadDiet", "label": "Remove a lane",
                      "forward": f[:-1] if cf >= 2 else f, "backward": b[:-1] if cb >= 2 else b})
    def bike(lanes):
        if not lanes:
            return lanes
        return replace_rightmost_car(lanes, "bike") if car_count(lanes) >= 2 else lanes + L(1, "bike")
    cands.append({"kind": "bikeLane", "label": "Protected bike lane", "forward": bike(f), "backward": bike(b)})
    if cf >= 2 or cb >= 2:
        cands.append({"kind": "transitLane", "label": "Bus/transit lane",
                      "forward": replace_rightmost_car(f, "transit") if cf >= 2 else f,
                      "backward": replace_rightmost_car(b, "transit") if cb >= 2 else b})
    if not two_way and max(cf, cb) >= 2 and cls != "frontage":
        n = max(cf, cb)
        cands.append({"kind": "twoWay", "label": "Convert to two-way",
                      "forward": L(math.ceil(n / 2)), "backward": L(n // 2)})
    if two_way and cls != "frontage":
        cands.append({"kind": "oneWay", "label": "Convert to one-way",
                      "forward": L(cf + cb), "backward": []})
    lt_f = f and nodes[e["to"]]["kind"] == "intersection"
    lt_b = b and nodes[e["from"]]["kind"] == "intersection"
    if lt_f or lt_b:
        cands.append({"kind": "leftTurnLane", "label": "Add left-turn lane",
                      "forward": ([{"type": "car", "turns": ["left"]}] + f) if lt_f else f,
                      "backward": ([{"type": "car", "turns": ["left"]}] + b) if lt_b else b})
    if cls in ("tertiary", "residential") and "boundary" not in ends:
        cands.append({"kind": "carFree", "label": "Car-free street", "forward": [], "backward": []})

    chosen = pick3(e["id"], cands)
    opts = [current]
    for c in chosen:
        o = {"id": c["kind"], **c}
        opts.append(o)
    return opts, False


def incident(nid):
    return [e for e in edges.values() if nid in (e["from"], e["to"])]


def node_options(n):
    current = {"id": "current", "label": "Current layout", "control": n["control"] or "none", "params": {}}
    if n["kind"] != "intersection":
        return [current], True
    inc = incident(n["id"])
    max_dir = max(max(car_count(e["base"]["forward"]), car_count(e["base"]["backward"])) for e in inc)
    has_frontage = any(e["roadClass"] == "frontage" for e in inc)
    ranks = sorted({CLASS_RANK[e["roadClass"]] for e in inc}, reverse=True)
    elig = [
        {"control": "signal", "label": "Traffic signal", "params": {}},
        {"control": "signalProtectedLeft", "label": "Signal with protected left turns", "params": {}},
    ]
    if max_dir <= 2:
        elig.append({"control": "allStop", "label": "All-way stop", "params": {}})
    if not has_frontage and max_dir <= 2 and len(inc) <= 4:
        elig.append({"control": "roundabout", "label": "Roundabout", "params": {"radius": 16}})
    if len(ranks) > 1:
        major = [e["id"] for e in inc if CLASS_RANK[e["roadClass"]] == ranks[0]]
        elig.append({"control": "yield", "label": "Stop signs on side street", "params": {"majorEdges": major}})
    alts = [o for o in elig if o["control"] != n["control"]]
    chosen = pick3(n["id"], alts)
    return [current] + [{"id": o["control"], **o} for o in chosen], False


# --------------------------------------------------------------------------
# 3. Points (spawns, sinks, parking, lunch zones)
# --------------------------------------------------------------------------
def node_dir_lanes(nid):
    """(has inbound car lanes, has outbound car lanes) at a boundary/rampEnd node."""
    inb = outb = False
    for e in incident(nid):
        f, b = car_count(e["base"]["forward"]), car_count(e["base"]["backward"])
        if e["from"] == nid:
            outb |= f > 0
            inb |= b > 0
        if e["to"] == nid:
            inb |= f > 0
            outb |= b > 0
    return inb, outb


for nid, n in nodes.items():
    if n["kind"] == "boundary":
        inb, outb = node_dir_lanes(nid)
        # A node with outbound lanes INTO the map spawns cars; inbound lanes reaching it sink them.
        if outb:
            points.append({"id": f"spawn-{nid}", "type": "edgeSpawn", "name": n["name"], "node": nid, "weight": 1})
        if inb:
            points.append({"id": f"sink-{nid}", "type": "edgeSink", "name": n["name"], "node": nid, "weight": 1})
points.append({"id": "spawn-rOff", "type": "rampSpawn", "name": "Freeway exit ramp", "node": "rOff", "weight": 3})
points.append({"id": "sink-rOn", "type": "rampSink", "name": "Freeway entrance ramp", "node": "rOn", "weight": 3})
points += [
    {"id": "park-g1", "type": "parking", "name": "Garage 1", "at": {"edge": "eB1", "t": 0.5},
     "capacity": 400, "estimated": {"capacity": False}, "osmIds": [], "tags": {"amenity": "parking", "parking": "multi-storey"}},
    {"id": "park-g2", "type": "parking", "name": "Garage 2", "at": {"edge": "e3b", "t": 0.4},
     "capacity": 250, "estimated": {"capacity": True}, "osmIds": [], "tags": {"amenity": "parking", "parking": "multi-storey"}},
    {"id": "park-l1", "type": "parking", "name": "Surface lot", "at": {"edge": "eA2", "t": 0.5},
     "capacity": 80, "estimated": {"capacity": True}, "osmIds": [], "tags": {"amenity": "parking", "parking": "surface"}},
    {"id": "lunch-1", "type": "lunchZone", "name": "Lunch zone 1", "at": {"edge": "eA1", "t": 0.5}, "weight": 2},
    {"id": "lunch-2", "type": "lunchZone", "name": "Lunch zone 2", "at": {"edge": "e1b", "t": 0.5}, "weight": 1},
    {"id": "lunch-3", "type": "lunchZone", "name": "Lunch zone 3", "at": {"edge": "e3a", "t": 0.6}, "weight": 1},
]

# --------------------------------------------------------------------------
# 4. Write scenario JSON
# --------------------------------------------------------------------------
scenario = {
    "format": "flowstate-scenario",
    "version": 1,
    "meta": {
        "id": "test-grid",
        "name": "Test grid (hand-made sample, not real data)",
        "source": "hand",
        "units": {"length": "m", "speed": "m/s", "time": "s"},
        "origin": {"lat": 32.7790, "lon": -96.8000, "note": "sample value; real file uses the downtown origin"},
        "bounds": {"minX": XW, "minY": -60.0, "maxX": XE, "maxY": YN},
        "attribution": "© OpenStreetMap contributors",
    },
    "nodes": [],
    "edges": [],
    "points": points,
    "scenery": {
        "freeways": [{"id": "fw-1", "name": "Freeway mainline (static)", "centerline": [[XW - 50, -45.0], [XE + 50, -45.0]],
                      "width": 30.0, "z": -7.0}],
        "buildings": [
            {"id": "bld-1", "footprint": [[15, 15], [105, 15], [105, 85], [15, 85]], "height": 45.0, "levels": 12,
             "use": "office", "estimated": {"height": False}, "name": "Sample Office Tower"},
            {"id": "bld-2", "footprint": [[135, 115], [225, 115], [225, 185], [135, 185]], "height": 24.0, "levels": 6,
             "use": "residential", "estimated": {"height": True}},
            {"id": "bld-3", "footprint": [[15, 115], [105, 115], [105, 185], [15, 185]], "height": 12.0, "levels": 3,
             "use": "retail", "estimated": {"height": True}},
            {"id": "bld-4", "footprint": [[135, 15], [225, 15], [225, 85], [135, 85]], "height": 90.0, "levels": 24,
             "use": "office", "estimated": {"height": False}},
        ],
        "parks": [{"id": "park-a", "name": "Sample Plaza", "polygon": [[255, 115], [400, 115], [400, 185], [255, 185]]}],
    },
}

for n in nodes.values():
    opts, locked = node_options(n)
    scenario["nodes"].append({
        "id": n["id"], "x": n["x"], "y": n["y"], "z": n["z"], "kind": n["kind"], "name": n["name"],
        "branch": n["branch"], "restrictions": n["restrictions"],
        "options": opts, "selected": "current", "locked": locked,
        "osmIds": [], "tags": {"highway": "traffic_signals"} if n["control"] == "signal" else {},
    })
for e in edges.values():
    opts, locked = edge_options(e)
    scenario["edges"].append({
        "id": e["id"], "from": e["from"], "to": e["to"], "name": e["name"], "roadClass": e["roadClass"],
        "centerline": e["centerline"], "elevation": e["elevation"],
        "speedLimit": e["speedLimit"],
        "estimated": {"speedLimit": e["roadClass"] in ("tertiary",), "lanes": False},
        "options": opts, "selected": "current", "locked": locked,
        "osmWayIds": [], "tags": {"oneway": "yes"} if not e["base"]["backward"] else {},
    })

# --------------------------------------------------------------------------
# 5. Compile the current layout (reference for web/src/compile)
# --------------------------------------------------------------------------
def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def add(a, b): return (a[0] + b[0], a[1] + b[1])
def mul(a, k): return (a[0] * k, a[1] * k)
def norm(a):
    l = math.hypot(*a)
    return (a[0] / l, a[1] / l)
def right_of(d): return (d[1], -d[0])


def offset_polyline(pts, off):
    out = []
    for i, p in enumerate(pts):
        ns = []
        if i > 0:
            ns.append(right_of(norm(sub(p, pts[i - 1]))))
        if i < len(pts) - 1:
            ns.append(right_of(norm(sub(pts[i + 1], p))))
        n = norm((sum(v[0] for v in ns), sum(v[1] for v in ns)))
        out.append(add(p, mul(n, off)))
    return out


def poly_len(pts):
    return sum(math.hypot(*sub(pts[i + 1], pts[i])) for i in range(len(pts) - 1))


def trim(pts, a, b):
    """Cut a metres off the start and b metres off the end."""
    def cut_start(ps, d):
        acc = 0.0
        for i in range(len(ps) - 1):
            seg = math.hypot(*sub(ps[i + 1], ps[i]))
            if acc + seg >= d:
                t = (d - acc) / seg
                return [add(ps[i], mul(sub(ps[i + 1], ps[i]), t))] + ps[i + 1:]
            acc += seg
        return ps[-1:]
    p = cut_start(pts, a) if a > 0 else pts
    p = list(reversed(cut_start(list(reversed(p)), b))) if b > 0 else p
    return p


def lane_geometry(e, opt, direction):
    lanes = opt["forward"] if direction == "f" else opt["backward"]
    other = opt["backward"] if direction == "f" else opt["forward"]
    cl = [tuple(p) for p in e["centerline"]]
    if direction == "b":
        cl = list(reversed(cl))
    widths = [LANE_W[l["type"]] for l in lanes]
    start = 0.0 if other else -sum(widths) / 2.0
    res = []
    acc = start
    for i, l in enumerate(lanes):
        off = acc + widths[i] / 2.0
        acc += widths[i]
        res.append((i, l, offset_polyline(cl, off)))
    return res


sel_node = {n["id"]: next(o for o in n["options"] if o["id"] == n["selected"]) for n in scenario["nodes"]}
sel_edge = {e["id"]: next(o for o in e["options"] if o["id"] == e["selected"]) for e in scenario["edges"]}
node_by_id = {n["id"]: n for n in scenario["nodes"]}


def setback(nid):
    n = node_by_id[nid]
    if sel_node[nid]["control"] == "roundabout":
        return sel_node[nid]["params"]["radius"] + 6.0
    return SETBACK[n["kind"]]


paths = []
lanes_by_node_in = {}
lanes_by_node_out = {}

for e in scenario["edges"]:
    opt = sel_edge[e["id"]]
    for d in ("f", "b"):
        start_n, end_n = (e["from"], e["to"]) if d == "f" else (e["to"], e["from"])
        for i, lane, pl in lane_geometry(e, opt, d):
            if lane["type"] != "car":
                continue  # engine only simulates cars; bike/transit lanes are front-end + scoring only
            pts = trim(pl, setback(start_n), setback(end_n))
            p = {
                "id": f"L/{e['id']}/{d}/{i}", "kind": "lane", "edge": e["id"], "dir": d, "laneIndex": i,
                "fromNode": start_n, "toNode": end_n, "length": r2(poly_len(pts)),
                "speedLimit": e["speedLimit"], "turns": lane.get("turns"), "next": [],
                "debugPolyline": [[r2(x), r2(y)] for x, y in pts],
            }
            paths.append(p)
            lanes_by_node_out.setdefault(start_n, []).append(p)
            lanes_by_node_in.setdefault(end_n, []).append(p)


def heading_end(p):
    a, b = p["debugPolyline"][-2], p["debugPolyline"][-1]
    return norm(sub(b, a))


def heading_start(p):
    a, b = p["debugPolyline"][0], p["debugPolyline"][1]
    return norm(sub(b, a))


def ang(v): return math.degrees(math.atan2(v[1], v[0]))


def turn_of(h_in, h_out):
    d = (ang(h_out) - ang(h_in) + 540) % 360 - 180
    if abs(d) <= 35: return "through"
    if abs(d) >= 150: return "uturn"
    return "left" if d > 0 else "right"


def bezier(p0, h0, p2, h1, n=16):
    cr = h0[0] * h1[1] - h0[1] * h1[0]
    ctrl = None
    if abs(cr) > 1e-3:
        w = sub(p2, p0)
        t = (w[0] * h1[1] - w[1] * h1[0]) / cr
        c = add(p0, mul(h0, t))
        if t > 0 and math.hypot(*sub(c, p2)) > 0 and \
                ((p2[0] - c[0]) * h1[0] + (p2[1] - c[1]) * h1[1]) > 0:
            ctrl = c
    if ctrl is None:
        ctrl = mul(add(p0, p2), 0.5)
    pts = []
    for k in range(n + 1):
        t = k / n
        a = mul(p0, (1 - t) ** 2)
        b = mul(ctrl, 2 * (1 - t) * t)
        c = mul(p2, t * t)
        pts.append(add(add(a, b), c))
    return pts


def group(lanes):
    g = {}
    for p in lanes:
        g.setdefault((p["edge"], p["dir"]), []).append(p)
    for k in g:
        g[k].sort(key=lambda p: p["laneIndex"])
    return g


def assign_turns(lanes, avail):
    """Which movements each lane of an approach may make, given the movements
    that actually exist at this node. Explicit lane `turns` win; the remaining
    lanes split what's left: leftmost lane takes the leftmost movement,
    rightmost lane the rightmost, every lane takes 'through' if it exists."""
    res = {}
    covered = set()
    for p in lanes:
        if p["turns"]:
            res[p["id"]] = set(p["turns"]) & avail
            covered |= res[p["id"]]
    free = [p for p in lanes if not p["turns"]]
    avail_free = (avail - covered) or avail
    order = [t for t in ("left", "through", "right") if t in avail_free]
    if not order:
        return res
    if len(free) == 1:
        res[free[0]["id"]] = set(order)
        return res
    for k, p in enumerate(free):
        s = set()
        if "through" in avail_free:
            s.add("through")
        if k == 0:
            s.add(order[0])
        if k == len(free) - 1:
            s.add(order[-1])
        if not s:
            s.add(order[0] if k < len(free) / 2 else order[-1])
        res[p["id"]] = s
    return res


connectors = []


def make_conn(node, a, b, turn, kind="turn"):
    p0 = tuple(a["debugPolyline"][-1])
    p2 = tuple(b["debugPolyline"][0])
    pts = bezier(p0, heading_end(a), p2, heading_start(b))
    spd = min(a["speedLimit"], b["speedLimit"]) if turn == "through" else TURN_SPEED
    c = {
        "id": f"C/{node}/{a['id'][2:]}>{b['id'][2:]}", "kind": "connector", "node": node,
        "from": a["id"], "to": b["id"], "turn": turn, "length": r2(poly_len(pts)), "speedLimit": spd,
        "phase": None, "yieldTo": [], "conflicts": [], "isBranch": kind == "branch",
        "debugPolyline": [[r2(x), r2(y)] for x, y in pts],
    }
    connectors.append(c)
    a["next"].append(c["id"])
    c["next"] = [b["id"]]
    return c


for nid, n in node_by_id.items():
    if n["kind"] in ("boundary", "rampEnd"):
        continue
    ins = group(lanes_by_node_in.get(nid, []))
    outs = group(lanes_by_node_out.get(nid, []))
    if n["kind"] in ("merge", "diverge"):
        br = n["branch"]["edge"]
        main_in = [v for k, v in ins.items() if k[0] != br]
        main_out = [v for k, v in outs.items() if k[0] != br]
        for li in main_in:
            for lo in main_out:
                for i, a in enumerate(li):
                    make_conn(nid, a, lo[min(i, len(lo) - 1)], "through")
        side_left = n["branch"]["side"] == "left"
        if n["kind"] == "merge":
            for (k, li) in ins.items():
                if k[0] == br:
                    for lo in main_out:
                        # Ramp traffic may merge into any main lane (it picks the one its route needs).
                        for a in li:
                            for tgt in (lo if side_left else list(reversed(lo))):
                                make_conn(nid, a, tgt, "through", "branch")
        else:
            for (k, lo) in outs.items():
                if k[0] == br:
                    for li in main_in:
                        src = li[0] if side_left else li[-1]
                        make_conn(nid, src, lo[0], "through", "branch")
        continue
    banned = {(r["fromEdge"], r["toEdge"]) for r in n["restrictions"]}
    for (ke, kd), li in ins.items():
        moves = []
        for (oe, od), lo in outs.items():
            if oe == ke or (ke, oe) in banned:
                continue
            t = turn_of(heading_end(li[0]), heading_start(lo[0]))
            if t != "uturn":
                moves.append((t, lo))
        allowed = assign_turns(li, {t for t, _ in moves})
        for t, lo in moves:
            srcs = [p for p in li if t in allowed.get(p["id"], set())]
            if not srcs:
                continue
            outs_ord = list(reversed(lo)) if t == "right" else list(lo)
            if t == "right":
                srcs = list(reversed(srcs))
            if len(srcs) == 1:
                # One lane makes this movement: it may enter ANY outgoing lane
                # (this is where a car "picks its lane" for its next turn).
                for b in outs_ord:
                    make_conn(nid, srcs[0], b, t)
            else:
                for j, a in enumerate(srcs):
                    make_conn(nid, a, outs_ord[min(j, len(outs_ord) - 1)], t)
                for b in outs_ord[len(srcs):]:  # extra outgoing lanes fed by the outermost source lane
                    make_conn(nid, srcs[-1], b, t)


def seg_cross(p1, p2, p3, p4):
    def o(a, b, c): return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2, d3, d4 = o(p3, p4, p1), o(p3, p4, p2), o(p1, p2, p3), o(p1, p2, p4)
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def crosses(a, b):
    pa, pb = a["debugPolyline"], b["debugPolyline"]
    for i in range(len(pa) - 1):
        for j in range(len(pb) - 1):
            if seg_cross(pa[i], pa[i + 1], pb[j], pb[j + 1]):
                return True
    return False


by_node = {}
for c in connectors:
    by_node.setdefault(c["node"], []).append(c)

compiled_nodes = []
for nid, cs in by_node.items():
    n = node_by_id[nid]
    control = sel_node[nid]["control"]
    if n["kind"] == "merge":
        control = "merge"
    elif n["kind"] == "diverge":
        control = "none"
    for i, a in enumerate(cs):
        for b in cs[i + 1:]:
            if a["from"] == b["from"]:
                continue
            typ = "merge" if a["to"] == b["to"] else ("cross" if crosses(a, b) else None)
            if typ:
                a["conflicts"].append({"path": b["id"], "type": typ})
                b["conflicts"].append({"path": a["id"], "type": typ})
    phases = None
    if control == "signal":
        groups = {"NS": [], "EW": []}
        for c in cs:
            src = next(p for p in paths if p["id"] == c["from"])
            hx, hy = heading_end(src)
            c["phase"] = "EW" if abs(hx) >= abs(hy) else "NS"
            groups[c["phase"]].append(c["id"])
        phases = [{"id": k, "paths": v} for k, v in groups.items() if v]
        for c in cs:
            for cf in c["conflicts"]:
                o = next(x for x in cs if x["id"] == cf["path"])
                if o["phase"] != c["phase"]:
                    continue
                if c["turn"] == "left" and o["turn"] in ("through", "right"):
                    c["yieldTo"].append(o["id"])
                elif c["turn"] == "right" and o["turn"] == "through" and cf["type"] == "merge":
                    c["yieldTo"].append(o["id"])
    elif control == "merge":
        for c in cs:
            if c["isBranch"]:
                c["yieldTo"] = [cf["path"] for cf in c["conflicts"]]
    compiled_nodes.append({
        "id": nid, "control": control, "phases": phases,
        "inPaths": sorted({c["from"] for c in cs}), "connectors": [c["id"] for c in cs],
    })

all_paths = paths + connectors
index = {p["id"]: i for i, p in enumerate(all_paths)}


def access_for(pt):
    acc = []
    if "node" in pt:
        if pt["type"] in ("edgeSpawn", "rampSpawn"):
            for p in lanes_by_node_out.get(pt["node"], []):
                acc.append({"path": p["id"], "s": 0.0})
        else:
            for p in lanes_by_node_in.get(pt["node"], []):
                acc.append({"path": p["id"], "s": p["length"]})
    else:
        eid, t = pt["at"]["edge"], pt["at"]["t"]
        for d in ("f", "b"):
            ls = [p for p in paths if p["edge"] == eid and p["dir"] == d]
            if not ls:
                continue
            p = max(ls, key=lambda q: q["laneIndex"])  # rightmost car lane
            s = t if d == "f" else 1 - t
            acc.append({"path": p["id"], "s": r2(s * p["length"])})
    return acc


compiled_points = []
for pt in points:
    cp = {"id": pt["id"], "type": pt["type"], "weight": pt.get("weight", 1), "access": access_for(pt)}
    if pt["type"] == "parking":
        cp["capacity"] = pt["capacity"]
    compiled_points.append(cp)

for p in all_paths:
    p["index"] = index[p["id"]]
    p.pop("isBranch", None)

compiled = {
    "format": "flowstate-network",
    "version": 1,
    "scenario": "test-grid",
    "layout": {
        "edges": {e["id"]: e["selected"] for e in scenario["edges"]},
        "nodes": {n["id"]: n["selected"] for n in scenario["nodes"]},
    },
    "units": {"length": "m", "speed": "m/s", "time": "s"},
    "paths": all_paths,
    "nodes": compiled_nodes,
    "points": compiled_points,
}

# --------------------------------------------------------------------------
# 6. Presets
# --------------------------------------------------------------------------
presets = {
    "morning": {
        "format": "flowstate-preset", "version": 1, "id": "morning", "label": "Morning",
        "durationSec": 1800, "seed": 20261201, "lighting": "morning",
        "warmup": {"realSeconds": 5, "playbackSpeed": 2},
        "spawnRate": {"unit": "vehiclesPerMinute", "curve": [[0, 15], [300, 45], [900, 60], [1500, 30], [1800, 15]]},
        "trips": [
            {"share": 0.8, "from": ["rampSpawn", "edgeSpawn"], "to": ["parking"]},
            {"share": 0.2, "from": ["rampSpawn", "edgeSpawn"], "to": ["rampSink", "edgeSink"]},
        ],
        "parking": {"initialOccupancy": 0.1},
    },
    "afternoon": {
        "format": "flowstate-preset", "version": 1, "id": "afternoon", "label": "Afternoon",
        "durationSec": 1800, "seed": 20261201, "lighting": "afternoon",
        "warmup": {"realSeconds": 5, "playbackSpeed": 2},
        "spawnRate": {"unit": "vehiclesPerMinute", "curve": [[0, 10], [600, 25], [1200, 25], [1800, 10]]},
        "trips": [
            {"share": 0.4, "from": ["parking"], "to": ["lunchZone"]},
            {"share": 0.4, "from": ["lunchZone"], "to": ["parking"]},
            {"share": 0.2, "from": ["rampSpawn", "edgeSpawn"], "to": ["rampSink", "edgeSink"]},
        ],
        "parking": {"initialOccupancy": 0.8},
    },
    "night": {
        "format": "flowstate-preset", "version": 1, "id": "night", "label": "Night",
        "durationSec": 1800, "seed": 20261201, "lighting": "night",
        "warmup": {"realSeconds": 5, "playbackSpeed": 2},
        "spawnRate": {"unit": "vehiclesPerMinute", "curve": [[0, 15], [300, 45], [900, 60], [1500, 30], [1800, 15]]},
        "trips": [
            {"share": 0.8, "from": ["parking"], "to": ["rampSink", "edgeSink"]},
            {"share": 0.2, "from": ["rampSpawn", "edgeSpawn"], "to": ["rampSink", "edgeSink"]},
        ],
        "parking": {"initialOccupancy": 0.9},
    },
}

# --------------------------------------------------------------------------
# 7. Write
# --------------------------------------------------------------------------
os.makedirs(f"{OUT}/data/scenarios", exist_ok=True)
os.makedirs(f"{OUT}/data/compiled", exist_ok=True)
os.makedirs(f"{OUT}/data/presets", exist_ok=True)
with open(f"{OUT}/data/scenarios/test-grid.scenario.json", "w") as f:
    json.dump(scenario, f, indent=1, ensure_ascii=False)
with open(f"{OUT}/data/compiled/test-grid.compiled.json", "w") as f:
    json.dump(compiled, f, indent=1, ensure_ascii=False)
for k, v in presets.items():
    with open(f"{OUT}/data/presets/{k}.json", "w") as f:
        json.dump(v, f, indent=1)

print("nodes", len(scenario["nodes"]), "edges", len(scenario["edges"]), "points", len(points))
print("paths", len(paths), "connectors", len(connectors), "compiled nodes", len(compiled_nodes))
