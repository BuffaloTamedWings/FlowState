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

import type { Scenario } from '@shared/scenario.js';
import { isConnectorPath, isLanePath } from '@shared/network.js';
import { compileScenario } from '@web/compile/index.js';
import { buildNetworkView, frameBounds, SCENE_BACKGROUND } from '@web/render/index.js';

const SCENARIO_URL = '/data/scenarios/test-grid.scenario.json';
const FALLBACK_GROUND_SIZE = 1200; // meters, used only if a scenario fails to load

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
  renderer.render(scene, camera);
});

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

  try {
    const network = compileScenario(scenario);
    const lanePaths = network.paths.filter(isLanePath).length;
    const connectorPaths = network.paths.filter(isConnectorPath).length;

    if (networkGroup) {
      scene.remove(networkGroup);
    }
    const view = buildNetworkView(scenario, network);
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
  } catch (err: unknown) {
    console.error('Failed to compile/render the network:', err);
  }
}

loadScenario().catch((err: unknown) => {
  console.error('Failed to load scenario:', err);
});
