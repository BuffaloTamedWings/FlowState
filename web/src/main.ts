import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { PlaybackSpeed } from '@shared/messages.js';
import { isConnectorPath, isLanePath, type CompiledNetwork } from '@shared/network.js';
import type { Preset } from '@shared/preset.js';
import type { Edge, Node, Scenario } from '@shared/scenario.js';
import { compileScenario } from '@web/compile/index.js';
import { buildNetworkView, buildPathLookup, createCarsView, frameBounds, SCENE_BACKGROUND, type CarsView, type NetworkView } from '@web/render/index.js';
import { createTransport, EngineClient, type TickFrame } from '@web/sim/index.js';

import { LayoutState } from './ui/layoutState.js';
import { edgeOptionsFor, nodeOptionsFor } from './ui/options.js';
import { decideRunAction } from './ui/runController.js';
import { findSubgroup, setGroupHighlighted } from './ui/highlight.js';
import { isClick, pick, toNdc, type PointerPos } from './ui/picking.js';
import { Panel, type PanelSelectionInfo, type PanelState } from './ui/panel.js';

const SCENARIO_URL = '/data/scenarios/test-grid.scenario.json';
const PRESET_URL = '/data/presets/morning.json';
const FALLBACK_GROUND_SIZE = 1200; // meters, used only if a scenario fails to load

// Swap point for step 6: ?engine=stub forces the fallback stub engine; the
// real engine (finished and the primary target, see docs/frontend-plan.md
// step 6) is the default otherwise.
const engineKind = new URLSearchParams(window.location.search).get('engine') === 'stub' ? 'stub' : 'worker';

const app = document.getElementById('app');
if (!app) throw new Error('#app container is missing from index.html');

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(SCENE_BACKGROUND);

const camera = new PerspectiveCamera(55, 1, 0.5, 8000);
// Local meters are x = east, y = north, z = up; Three.js gets (x, y, z) -> (x, z, -y).
camera.position.set(0, 320, 420);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 0, 0);

scene.add(new AmbientLight(0xffffff, 1.1));
const sun = new DirectionalLight(0xffffff, 1.6);
sun.position.set(220, 400, 160);
scene.add(sun);

// Ground plane: PlaneGeometry is in the XY plane, so rotate it flat onto Three's XZ.
const groundMaterial = new MeshLambertMaterial({ color: 0x2a3138 });
const ground = new Mesh(new PlaneGeometry(FALLBACK_GROUND_SIZE, FALLBACK_GROUND_SIZE), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02; // just under the road meshes
scene.add(ground);

let grid = new GridHelper(FALLBACK_GROUND_SIZE, FALLBACK_GROUND_SIZE / 50, 0x3c454e, 0x333b42);
scene.add(grid);

let networkGroup: Group | null = null;
let networkView: NetworkView | null = null;

// --- Sim + editing state (step 7) ---------------------------------------
let client: EngineClient | null = null;
let carsView: CarsView | null = null;
let layoutState: LayoutState | null = null;
let currentPreset: Preset | null = null;
let lastRunHash: string | null = null;
let runInFlight = false;

// Current selection, or null for "nothing picked".
let selection: { kind: 'edge' | 'node'; id: string } | null = null;
let panelMessage: string | null = null;

// Real wall-clock timestamps (performance.now(), ms) of the two most recent
// ticks, so the render loop can compute how far between them "now" sits,
// independent of playback speed or frame rate.
let latestTickAt = 0;
let previousTickAt = 0;

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener('resize', resize);

renderer.setAnimationLoop(() => {
  controls.update();
  if (client && carsView) {
    const latest = client.latestTick();
    const previous = client.previousTick();
    if (latest) {
      const span = latestTickAt - previousTickAt;
      const alpha = span > 0 ? Math.min(Math.max((performance.now() - latestTickAt) / span, 0), 1) : 1;
      carsView.update(latest, previous, alpha);
    }
  }
  renderer.render(scene, camera);
});

// --- Panel ----------------------------------------------------------------

const panel = new Panel(document.body, {
  onSelectOption: (optionId) => applySelection(optionId),
  onRunPause: () => {
    void runOrPause();
  },
  onRevertAll: () => revertAll(),
});

function findEdge(id: string): Edge | undefined {
  return layoutState?.scenario.edges.find((e) => e.id === id);
}

function findNode(id: string): Node | undefined {
  return layoutState?.scenario.nodes.find((n) => n.id === id);
}

function renderPanel(): void {
  let selectionInfo: PanelSelectionInfo | null = null;
  let options: PanelState['options'] = [];

  if (selection && layoutState) {
    if (selection.kind === 'edge') {
      const edge = findEdge(selection.id);
      if (edge) {
        selectionInfo = { kind: 'edge', id: edge.id, name: edge.name };
        options = edgeOptionsFor(edge).map((o) => ({ ...o, selected: o.id === edge.selected }));
      }
    } else {
      const node = findNode(selection.id);
      if (node) {
        selectionInfo = { kind: 'node', id: node.id, name: node.name };
        options = nodeOptionsFor(node).map((o) => ({ ...o, selected: o.id === node.selected }));
      }
    }
  }

  const state: PanelState = {
    selection: selectionInfo,
    options,
    running: client?.running ?? false,
    dirty: layoutState?.isDirty() ?? false,
    simTime: client?.simTime ?? 0,
    carCount: client?.carCount ?? 0,
    message: panelMessage,
  };
  panel.render(state);
}

/** Applies the picked option to the current selection, recompiles, rebuilds just the touched geometry, and re-renders the panel. Reverts and reports on a compile failure instead of leaving the app broken. */
function applySelection(optionId: string): void {
  if (!layoutState || !networkView || !selection) return;
  if (client?.running) return; // editing is only allowed while paused

  panelMessage = null;

  if (selection.kind === 'edge') {
    const edge = findEdge(selection.id);
    if (!edge) return;
    const previous = edge.selected;
    if (previous === optionId) return;
    try {
      layoutState.selectEdgeOption(edge.id, optionId);
      const network = compileScenario(layoutState.scenario);
      networkView.rebuild(layoutState.scenario, network, { edges: [edge.id], nodes: [edge.from, edge.to] });
    } catch (err: unknown) {
      layoutState.selectEdgeOption(edge.id, previous);
      panelMessage = err instanceof Error ? err.message : String(err);
    }
  } else {
    const node = findNode(selection.id);
    if (!node) return;
    const previous = node.selected;
    if (previous === optionId) return;
    try {
      layoutState.selectNodeOption(node.id, optionId);
      const network = compileScenario(layoutState.scenario);
      networkView.rebuild(layoutState.scenario, network, { edges: [], nodes: [node.id] });
    } catch (err: unknown) {
      layoutState.selectNodeOption(node.id, previous);
      panelMessage = err instanceof Error ? err.message : String(err);
    }
  }

  renderPanel();
}

function revertAll(): void {
  if (!layoutState || !networkView) return;
  if (client?.running) return;
  panelMessage = null;
  layoutState.revertAll();
  const network = compileScenario(layoutState.scenario);
  networkView.rebuild(layoutState.scenario, network, {
    edges: layoutState.scenario.edges.map((e) => e.id),
    nodes: layoutState.scenario.nodes.map((n) => n.id),
  });
  renderPanel();
}

/** Rebuilds the car renderer + arc-length lookup to match a freshly-loaded network's path indices. */
function swapSimNetwork(network: CompiledNetwork): void {
  const lookup = buildPathLookup(network);
  if (carsView) {
    scene.remove(carsView.object);
    carsView.dispose();
  }
  carsView = createCarsView(lookup);
  scene.add(carsView.object);
}

async function runOrPause(): Promise<void> {
  if (!client || !layoutState || runInFlight) return;

  if (client.running) {
    client.pause();
    renderPanel();
    return;
  }

  const action = decideRunAction(layoutState.hash(), lastRunHash);
  if (action === 'resume') {
    client.run();
    renderPanel();
    return;
  }

  // 'compile-load-run': layout or preset changed since the last run (or
  // there was no last run) -> compile, load, run, restart from empty on the
  // same seed. See CLAUDE.md's "Run semantics" paragraph.
  if (!currentPreset) return;
  runInFlight = true;
  try {
    const network = compileScenario(layoutState.scenario);
    swapSimNetwork(network);
    await client.load(network, currentPreset, currentPreset.seed);
    client.run();
    layoutState.markRunBaseline();
    lastRunHash = layoutState.hash();
  } catch (err: unknown) {
    panelMessage = err instanceof Error ? err.message : String(err);
  } finally {
    runInFlight = false;
    renderPanel();
  }
}

// --- Picking ----------------------------------------------------------------

let pointerDownPos: PointerPos | null = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  const down = pointerDownPos;
  pointerDownPos = null;
  if (!down || !networkGroup) return;
  const up = { x: e.clientX, y: e.clientY };
  if (!isClick(down, up)) return; // was a camera drag, not a click

  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = toNdc(e.clientX, e.clientY, rect);
  const result = pick(ndc, camera, networkGroup);

  const previous = selection;
  selection = result ? { kind: result.kind, id: result.id } : null;
  panelMessage = null;

  if (previous && networkGroup) {
    const prevGroup = findSubgroup(networkGroup, previous.kind, previous.id);
    if (prevGroup) setGroupHighlighted(prevGroup, false);
  }
  if (selection && networkGroup) {
    const group = findSubgroup(networkGroup, selection.kind, selection.id);
    if (group) setGroupHighlighted(group, true);
  }

  renderPanel();
});

// --- Keyboard shortcuts (kept from step 6) ---------------------------------

window.addEventListener('keydown', (e) => {
  if (!client) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      void runOrPause();
      break;
    case '1':
      client.setSpeed(1);
      break;
    case '2':
      client.setSpeed(2 as PlaybackSpeed);
      break;
    case '4':
      client.setSpeed(4 as PlaybackSpeed);
      break;
    case 's':
      client.skip(300);
      break;
    case 'r':
      client.reset();
      break;
    default:
      break;
  }
});
console.log('keyboard: space = run/pause, 1/2/4 = speed, s = skip 300s, r = reset');

let lastLogAt = 0;
function maybeLogSimStatus(): void {
  if (!client) return;
  const now = performance.now();
  if (now - lastLogAt < 1000) return;
  lastLogAt = now;
  console.log(`sim: t=${client.simTime.toFixed(1)}s cars=${client.carCount} running=${client.running}`);
  renderPanel();
}
setInterval(maybeLogSimStatus, 1000);

/** Resizes the ground plane and grid to fit the scenario's bounds, centered on them. */
function fitGroundToBounds(bounds: Scenario['meta']['bounds'], padding = 1.5): void {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const size = Math.max(width, height) * padding;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  ground.geometry.dispose();
  ground.geometry = new PlaneGeometry(size, size);
  // PlaneGeometry's local XY maps onto Three's XZ after the -90deg X rotation
  // above: plane-local x -> world x, plane-local y -> world -z. Center it on
  // the scenario's centroid (local meters, mapped the same way main's other
  // coordinates are: world x = local x, world z = -local y).
  ground.position.set(centerX, -0.02, -centerY);

  scene.remove(grid);
  grid.geometry.dispose();
  (grid.material as { dispose?: () => void }).dispose?.();
  grid = new GridHelper(size, Math.max(1, Math.round(size / 25)), 0x3c454e, 0x333b42);
  grid.position.set(centerX, -0.01, -centerY);
  scene.add(grid);
}

async function loadScenario(): Promise<void> {
  const res = await fetch(SCENARIO_URL);
  if (!res.ok) throw new Error(`${SCENARIO_URL} -> HTTP ${res.status}`);
  const scenario = (await res.json()) as Scenario;

  console.log(
    `${scenario.meta.name} (${scenario.format} v${scenario.version}): ${scenario.nodes.length} nodes, ${scenario.edges.length} edges`,
  );

  fitGroundToBounds(scenario.meta.bounds);
  layoutState = new LayoutState(scenario);

  try {
    const network = compileScenario(layoutState.scenario);
    const lanePaths = network.paths.filter(isLanePath).length;
    const connectorPaths = network.paths.filter(isConnectorPath).length;

    if (networkGroup) {
      scene.remove(networkGroup);
      networkView?.dispose();
    }
    const view = buildNetworkView(layoutState.scenario, network);
    networkView = view;
    networkGroup = view.group;
    scene.add(networkGroup);

    let meshCount = 0;
    let lineCount = 0;
    networkGroup.traverse((obj) => {
      if ((obj as Mesh).isMesh) meshCount++;
      if ((obj as { isLineSegments?: boolean }).isLineSegments) lineCount++;
    });

    console.log(
      `compiled: ${lanePaths} lanes, ${connectorPaths} connectors, ${network.nodes.length} nodes` +
        ` -> drawn: ${meshCount} meshes, ${lineCount} line sets`,
    );

    frameBounds(camera, controls, scenario.meta.bounds);

    await startSim(network);
    renderPanel();
  } catch (err: unknown) {
    console.error('Failed to compile/render the network:', err);
  }
}

/**
 * Sets up the engine transport + client and loads the compiled network, but
 * does not auto-run: the player presses Run (step 7). Isolated from
 * `loadScenario`'s render setup so a sim failure (e.g. the real engine
 * worker failing to start) doesn't also take down the static network view.
 */
async function startSim(network: CompiledNetwork): Promise<void> {
  const res = await fetch(PRESET_URL);
  if (!res.ok) throw new Error(`${PRESET_URL} -> HTTP ${res.status}`);
  const preset = (await res.json()) as Preset;
  currentPreset = preset;

  const transport = createTransport(engineKind);
  swapSimNetwork(network);

  if (client) client.dispose();
  client = new EngineClient({
    transport,
    onTick: (_frame: TickFrame) => {
      previousTickAt = latestTickAt;
      latestTickAt = performance.now();
    },
    onError: (message) => {
      console.error(`engine (${engineKind}) error:`, message);
      panelMessage = message;
      renderPanel();
    },
  });

  console.log(`sim: starting ${engineKind} engine, loading network (${network.paths.length} paths)`);
  await client.load(network, preset, preset.seed);
  layoutState?.markRunBaseline();
  lastRunHash = layoutState?.hash() ?? null;
  console.log(`sim: ready, ${client.carCount} cars after warm-up`);
}

loadScenario().catch((err: unknown) => {
  console.error('Failed to load scenario:', err);
});
