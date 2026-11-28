import { Color, Group, Mesh, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Metrics, PlaybackSpeed } from '@shared/messages.js';
import { isConnectorPath, isLanePath, type CompiledNetwork } from '@shared/network.js';
import { PRESET_IDS, type Preset } from '@shared/preset.js';
import type { Edge, Node, Scenario } from '@shared/scenario.js';
import { compileScenario } from '@web/compile/index.js';
import {
  applyLighting,
  buildGround,
  buildNetworkView,
  buildPathLookup,
  buildScenery,
  configureShadowCamera,
  createCarsView,
  createHeatmapView,
  createLightingRig,
  enableShadows,
  frameBounds,
  refreshLighting,
  SCENE_BACKGROUND,
  subscribeTheme,
  type CarsView,
  type GroundView,
  type HeatmapView,
  type LightingRig,
  type NetworkView,
  type SceneryView,
} from '@web/render/index.js';
import { createTransport, EngineClient, type TickFrame } from '@web/sim/index.js';

import { LayoutState } from './ui/layoutState.js';
import { edgeOptionsFor, nodeOptionsFor } from './ui/options.js';
import { decideRunAction } from './ui/runController.js';
import { findSubgroup, setGroupHighlighted } from './ui/highlight.js';
import { isClick, pick, toNdc, type PointerPos } from './ui/picking.js';
import { Panel, type PanelMetrics, type PanelPreset, type PanelSelectionInfo, type PanelState } from './ui/panel.js';
import { createTuningPanel } from './ui/tuningPanel.js';

const SCENARIO_URL = '/data/scenarios/test-grid.scenario.json';
const presetUrl = (id: string): string => `/data/presets/${id}.json`;

// Swap point for step 6: ?engine=stub forces the fallback stub engine; the
// real engine (finished and the primary target, see docs/frontend-plan.md
// step 6) is the default otherwise.
const engineKind = new URLSearchParams(window.location.search).get('engine') === 'stub' ? 'stub' : 'worker';

const app = document.getElementById('app');
if (!app) throw new Error('#app container is missing from index.html');

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
enableShadows(renderer); // all three times of day cast (see render/lighting.ts)
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

// Lighting (step 11): one reused ambient + directional pair, driven by
// `preset.lighting` through `render/lighting.ts`. Starts on morning.
const lightingRig: LightingRig = createLightingRig(scene);

// The ground (with the freeway trench cut into it) and the static scenery are
// both derived from the scenario, so they are built in `rebuildStaticScene`
// once it has loaded.
let groundView: GroundView | null = null;
let sceneryView: SceneryView | null = null;
let loadedScenario: Scenario | null = null;

let networkGroup: Group | null = null;
let networkView: NetworkView | null = null;

// --- Sim + editing state (step 7) ---------------------------------------
let client: EngineClient | null = null;
let carsView: CarsView | null = null;
let layoutState: LayoutState | null = null;
let currentPreset: Preset | null = null;
let lastRunHash: string | null = null;
let lastRunPresetId: string | null = null;
let runInFlight = false;
/** The compiled network currently loaded into the engine; `stats` path indices are only meaningful against this one. */
let currentNetwork: CompiledNetwork | null = null;

// --- HUD state (step 10) -------------------------------------------------
const presetsById = new Map<string, Preset>();
let attribution: string | null = null;
let speed: PlaybackSpeed = 1;
let heatmapView: HeatmapView | null = null;
let heatmapOn = false;
let latestMetrics: Metrics | null = null;
let completedTripCount = 0;
let completedTripTimeSum = 0;

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
  onSelectPreset: (presetId) => selectPreset(presetId),
  onSetSpeed: (next) => setSpeed(next),
  onSkip: () => client?.skip(300),
  onReset: () => {
    completedTripCount = 0;
    completedTripTimeSum = 0;
    latestMetrics = null;
    client?.reset();
  },
  onToggleHeatmap: () => toggleHeatmap(),
});

function selectPreset(presetId: string): void {
  if (client?.running) return; // editing/preset changes only allowed while paused
  const preset = presetsById.get(presetId);
  if (!preset) return;
  currentPreset = preset;
  // Lighting is a look change, not a sim change: switch it immediately rather
  // than waiting for the next Run (plan step 11).
  applyLighting(scene, lightingRig, preset.lighting);
  carsView?.setHeadlights(lightingRig.headlights);
  renderPanel();
}

function setSpeed(next: PlaybackSpeed): void {
  speed = next;
  client?.setSpeed(next);
  renderPanel();
}

function toggleHeatmap(): void {
  heatmapOn = !heatmapOn;
  heatmapView?.setEnabled(heatmapOn);
  renderPanel();
}

/** Builds the HUD's rolled-up metrics view from the latest `Metrics` message, if any. */
function metricsSummary(): PanelMetrics | null {
  if (!latestMetrics) return null;
  const { counts } = latestMetrics;
  return {
    carsActive: counts.carsActive,
    carsWaitingToEnter: counts.carsWaitingToEnter,
    parkingFailed: counts.parkingFailed,
    gridlockRemovals: counts.gridlockRemovals,
    completedTrips: completedTripCount,
    meanTripTimeSec: completedTripCount > 0 ? completedTripTimeSum / completedTripCount : null,
  };
}

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

  const presets: PanelPreset[] = PRESET_IDS.map((id) => {
    const preset = presetsById.get(id);
    return { id, label: preset?.label ?? id };
  }).filter((p) => presetsById.has(p.id));

  const state: PanelState = {
    selection: selectionInfo,
    options,
    running: client?.running ?? false,
    dirty: layoutState?.isDirty() ?? false,
    simTime: client?.simTime ?? 0,
    carCount: client?.carCount ?? 0,
    message: panelMessage,
    presets,
    presetId: currentPreset?.id ?? null,
    speed,
    heatmapOn,
    attribution,
    metrics: metricsSummary(),
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
      heatmapView?.rebind();
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
      heatmapView?.rebind();
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
  heatmapView?.rebind();
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
  carsView.setHeadlights(lightingRig.headlights);
  scene.add(carsView.object);
}

async function runOrPause(): Promise<void> {
  if (runInFlight) return;
  if (!client || !layoutState) {
    // Startup failed (see `loadScenario`'s catch). Say so rather than
    // swallowing the click.
    panelMessage ??= 'The simulation failed to start -- see the browser console.';
    renderPanel();
    return;
  }

  if (client.running) {
    client.pause();
    renderPanel();
    return;
  }

  const action = decideRunAction(layoutState.hash(), lastRunHash, currentPreset?.id ?? null, lastRunPresetId);
  if (action === 'resume') {
    client.run();
    renderPanel();
    return;
  }

  // 'compile-load-run': the layout or the preset changed since the last run
  // (or there was no last run) -> compile, load, run, restart from empty on
  // the same seed. See CLAUDE.md's "Run semantics" paragraph.
  if (!currentPreset) return;
  runInFlight = true;
  try {
    // Re-running after an *edit* should pick the day back up where it was, not
    // throw the player back to the preset's warm-up target: the whole point is
    // comparing the new layout against the old one at the same moment of the
    // day. A *preset* change is different -- the new time of day has its own
    // demand curve, so it warms up to its own peak (null = preset default).
    const samePreset = lastRunPresetId !== null && lastRunPresetId === currentPreset.id;
    client.setWarmupTarget(samePreset && client.simTime > 0 ? client.simTime : null);

    const network = compileScenario(layoutState.scenario);
    currentNetwork = network;
    swapSimNetwork(network);
    completedTripCount = 0;
    completedTripTimeSum = 0;
    latestMetrics = null;
    client.setSpeed(speed);
    await client.load(network, currentPreset, currentPreset.seed);
    client.run();
    layoutState.markRunBaseline();
    lastRunHash = layoutState.hash();
    lastRunPresetId = currentPreset.id;
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
      setSpeed(1);
      break;
    case '2':
      setSpeed(2 as PlaybackSpeed);
      break;
    case '4':
      setSpeed(4 as PlaybackSpeed);
      break;
    case 's':
      client.skip(300);
      break;
    case 'r':
      completedTripCount = 0;
      completedTripTimeSum = 0;
      latestMetrics = null;
      client.reset();
      break;
    case 'h':
      toggleHeatmap();
      break;
    default:
      break;
  }
});
// The look-tuning panel (step 11). Hidden until `g`; top-left so it never
// overlaps the HUD. Development tool only -- nothing in the demo needs it.
const tuningPanel = createTuningPanel();
console.log(
  'keyboard: space = run/pause, 1/2/4 = speed, s = skip 300s, r = reset, h = heatmap toggle, g = look tuning panel',
);
void tuningPanel;

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

/**
 * (Re)builds everything static about the scene that is derived from the
 * scenario: the ground with the freeway trench cut into it, and the scenery
 * (buildings, parks, freeway surfaces). Called once on load, and again whenever
 * the tuning panel moves a number that is baked into that geometry.
 */
function rebuildStaticScene(scenario: Scenario): void {
  if (groundView) {
    scene.remove(groundView.group);
    groundView.dispose();
  }
  groundView = buildGround(scenario);
  scene.add(groundView.group);

  if (sceneryView) {
    scene.remove(sceneryView.group);
    sceneryView.dispose();
  }
  sceneryView = buildScenery(scenario);
  scene.add(sceneryView.group);
}

// Theme edits from the tuning panel: colours and intensities re-tint themselves
// (every view subscribes to the theme), but the lighting rig has to be
// re-applied by hand, and structural numbers need their geometry rebuilt.
subscribeTheme((change) => {
  refreshLighting(scene, lightingRig);
  if (loadedScenario) configureShadowCamera(lightingRig, loadedScenario.meta.bounds);
  carsView?.setHeadlights(lightingRig.headlights);
  if (change.structural && loadedScenario) {
    rebuildStaticScene(loadedScenario);
    // The network view bakes `theme.roads.connectorWidth` into its connector
    // ribbons, so a structural change has to rebuild it too.
    if (networkView && layoutState) {
      try {
        const network = compileScenario(layoutState.scenario);
        networkView.rebuild(layoutState.scenario, network, {
          edges: layoutState.scenario.edges.map((e) => e.id),
          nodes: layoutState.scenario.nodes.map((n) => n.id),
        });
        heatmapView?.rebind();
      } catch (err: unknown) {
        console.error('theme rebuild failed:', err);
      }
    }
  }
});

async function loadScenario(): Promise<void> {
  const res = await fetch(SCENARIO_URL);
  if (!res.ok) throw new Error(`${SCENARIO_URL} -> HTTP ${res.status}`);
  const scenario = (await res.json()) as Scenario;

  console.log(
    `${scenario.meta.name} (${scenario.format} v${scenario.version}): ${scenario.nodes.length} nodes, ${scenario.edges.length} edges`,
  );

  loadedScenario = scenario;
  configureShadowCamera(lightingRig, scenario.meta.bounds);
  rebuildStaticScene(scenario);
  layoutState = new LayoutState(scenario);
  attribution = scenario.meta.attribution;

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

    heatmapView?.dispose();
    heatmapView = createHeatmapView(networkGroup);
    heatmapView.setEnabled(heatmapOn);

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
    // Make the failure *visible*. A throw in here (the headlights TDZ bug,
    // 2026-11-28) leaves `client` null, which silently turns every button in
    // the HUD into a no-op -- the UI looks intact and simply ignores clicks,
    // which is the worst possible way for this to fail. Surfacing it in the
    // panel, and still rendering the panel at all, turns that into something
    // diagnosable from the screen instead of only from the console.
    console.error('Failed to compile/render the network:', err);
    panelMessage = `Startup failed: ${err instanceof Error ? err.message : String(err)}`;
    renderPanel();
  }
}

/**
 * Sets up the engine transport + client and loads the compiled network, but
 * does not auto-run: the player presses Run (step 7). Isolated from
 * `loadScenario`'s render setup so a sim failure (e.g. the real engine
 * worker failing to start) doesn't also take down the static network view.
 */
async function startSim(network: CompiledNetwork): Promise<void> {
  currentNetwork = network;
  presetsById.clear();
  for (const id of PRESET_IDS) {
    const res = await fetch(presetUrl(id));
    if (!res.ok) throw new Error(`${presetUrl(id)} -> HTTP ${res.status}`);
    presetsById.set(id, (await res.json()) as Preset);
  }
  // Morning is the default time of day; fall back to whatever loaded first
  // if a future scenario ever omits it.
  currentPreset = presetsById.get('morning') ?? presetsById.values().next().value ?? null;
  if (!currentPreset) throw new Error('no presets loaded');
  applyLighting(scene, lightingRig, currentPreset.lighting);

  const transport = createTransport(engineKind);
  swapSimNetwork(network);

  if (client) client.dispose();
  client = new EngineClient({
    transport,
    onTick: (_frame: TickFrame) => {
      previousTickAt = latestTickAt;
      latestTickAt = performance.now();
    },
    onStats: (_simTime, buf) => {
      if (heatmapView && currentNetwork) heatmapView.update(buf, currentNetwork);
    },
    onMetrics: (_simTime, metrics) => {
      latestMetrics = metrics;
      for (const trip of metrics.completedTrips) {
        completedTripCount++;
        completedTripTimeSum += trip.tripTimeSec;
      }
      renderPanel();
    },
    onError: (message) => {
      console.error(`engine (${engineKind}) error:`, message);
      panelMessage = message;
      renderPanel();
    },
  });

  console.log(`sim: starting ${engineKind} engine, loading network (${network.paths.length} paths)`);
  await client.load(network, currentPreset, currentPreset.seed);
  layoutState?.markRunBaseline();
  lastRunHash = layoutState?.hash() ?? null;
  lastRunPresetId = currentPreset.id;
  console.log(`sim: ready, ${client.carCount} cars after warm-up`);
}

loadScenario().catch((err: unknown) => {
  console.error('Failed to load scenario:', err);
});
