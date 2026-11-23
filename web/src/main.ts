import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const SCENARIO_URL = '/data/scenarios/test-grid.scenario.json';
const GROUND_SIZE = 1200; // meters

const app = document.getElementById('app');
if (!app) throw new Error('#app container is missing from index.html');

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x11161c);

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
const ground = new Mesh(
  new PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
  new MeshLambertMaterial({ color: 0x2a3138 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02; // just under the future road meshes
scene.add(ground);

const grid = new GridHelper(GROUND_SIZE, GROUND_SIZE / 50, 0x3c454e, 0x333b42);
scene.add(grid);

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

async function loadScenario(): Promise<void> {
  const res = await fetch(SCENARIO_URL);
  if (!res.ok) throw new Error(`${SCENARIO_URL} -> HTTP ${res.status}`);
  const scenario: unknown = await res.json();
  const { format, version, meta, nodes, edges } = scenario as {
    format?: string;
    version?: number;
    meta?: { name?: string };
    nodes?: unknown[];
    edges?: unknown[];
  };
  console.log(
    `${meta?.name ?? 'scenario'} (${format} v${version}): ${nodes?.length ?? 0} nodes, ${edges?.length ?? 0} edges`,
  );
}

loadScenario().catch((err: unknown) => {
  console.error('Failed to load scenario:', err);
});
