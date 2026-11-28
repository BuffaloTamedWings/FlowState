/**
 * The look-tuning panel (plan step 11): a `lil-gui` bound straight to
 * `render/theme.ts`, so every colour, size and lighting number in the renderer
 * can be dragged live in the browser.
 *
 * This is a development tool, not demo UI. It is hidden on load, toggles with
 * `g`, and sits in the top-*left* corner so it never overlaps the HUD (which is
 * fixed top-right). Nothing in the demo path depends on it.
 *
 * Two kinds of knob:
 *
 * - **Live** (most of them): colours, intensities, opacities. The controller
 *   writes into `theme`, fires `notifyThemeChanged({ structural: false })`, and
 *   the views re-tint their existing materials on the next frame.
 * - **Structural**: numbers baked into geometry or vertex data — building
 *   jitter, the estimated-height dim, trench width/drop, ground padding, the
 *   grid. Those fire `{ structural: true }`, and `main.ts` responds by
 *   rebuilding the scenery and ground groups.
 *
 * "Copy theme source" dumps `themeToSource()` (hex colours, pasteable
 * TypeScript) to the clipboard and the console, so a look Dev likes can replace
 * the defaults in `theme.ts` verbatim.
 */

import GUI from 'lil-gui';

import { notifyThemeChanged, theme, themeToSource, type LightingModeTheme } from '@web/render/theme.js';

export interface TuningPanel {
  gui: GUI;
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  dispose(): void;
}

interface Numeric {
  [key: string]: unknown;
}

/** Adds a slider that reports a theme change (structural or not) on every drag. */
function num(
  folder: GUI,
  target: Numeric,
  key: string,
  min: number,
  max: number,
  step: number,
  structural = false,
  label?: string,
): void {
  const controller = folder.add(target, key, min, max, step).onChange(() => {
    notifyThemeChanged({ structural });
  });
  if (label) controller.name(label);
}

/** Adds a colour picker that reports a (non-structural) theme change on every drag. */
function col(folder: GUI, target: Numeric, key: string, label?: string): void {
  const controller = folder.addColor(target, key).onChange(() => {
    notifyThemeChanged({ structural: false });
  });
  if (label) controller.name(label);
}

function bool(folder: GUI, target: Numeric, key: string, structural = false, label?: string): void {
  const controller = folder.add(target, key).onChange(() => {
    notifyThemeChanged({ structural });
  });
  if (label) controller.name(label);
}

function lightingFolder(parent: GUI, name: string, mode: LightingModeTheme): void {
  const folder = parent.addFolder(name);
  const target = mode as unknown as Numeric;

  col(folder, target, 'sunColor', 'sun colour');
  num(folder, target, 'sunIntensity', 0, 6, 0.01, false, 'sun intensity');
  num(folder, target, 'sunElevationDeg', 0, 90, 0.5, false, 'sun elevation°');
  num(folder, target, 'sunAzimuthDeg', 0, 360, 1, false, 'sun azimuth° (0=N, 90=E)');
  num(folder, target, 'sunDistance', 100, 4000, 10, false, 'sun distance (m)');

  col(folder, target, 'ambientColor', 'ambient colour');
  num(folder, target, 'ambientIntensity', 0, 3, 0.01, false, 'ambient intensity');

  col(folder, target, 'backgroundColor', 'background');
  bool(folder, target, 'fogEnabled', false, 'fog');
  col(folder, target, 'fogColor', 'fog colour');
  num(folder, target, 'fogNear', 0, 3000, 10, false, 'fog near (m)');
  num(folder, target, 'fogFar', 100, 8000, 10, false, 'fog far (m)');

  bool(folder, target, 'headlights', false, 'car headlights');
  bool(folder, target, 'shadows', false, 'cast shadows');
  folder.close();
}

/**
 * Builds the panel. `onStructuralChange` is wired by `main.ts` to rebuild the
 * scenery and ground groups; the panel itself knows nothing about the scene.
 */
export function createTuningPanel(options: { toggleKey?: string } = {}): TuningPanel {
  const toggleKey = options.toggleKey ?? 'g';

  const gui = new GUI({ title: `FlowState look (${toggleKey})`, width: 320 });
  // Top-left: the HUD owns the top-right corner.
  const el = gui.domElement;
  el.style.position = 'fixed';
  el.style.top = '16px';
  el.style.left = '16px';
  el.style.right = 'auto';
  el.style.zIndex = '20';
  el.style.maxHeight = 'calc(100vh - 32px)';
  el.style.overflowY = 'auto';

  // --- Roads ---------------------------------------------------------------
  const roads = gui.addFolder('Roads');
  const roadTarget = theme.roads as unknown as Numeric;
  col(roads, roadTarget, 'carColor', 'car lane');
  col(roads, roadTarget, 'bikeColor', 'bike lane');
  col(roads, roadTarget, 'transitColor', 'transit lane');
  col(roads, roadTarget, 'nodeFillColor', 'intersection fill');
  col(roads, roadTarget, 'connectorColor', 'connector');
  col(roads, roadTarget, 'edgeLineColor', 'edge line');
  col(roads, roadTarget, 'dividerLineColor', 'divider line');
  col(roads, roadTarget, 'centerlineColor', 'centerline');
  col(roads, roadTarget, 'highlightEmissiveColor', 'selection glow');
  num(roads, roadTarget, 'highlightIntensity', 0, 2, 0.01, false, 'selection glow strength');
  num(roads, roadTarget, 'connectorWidth', 1, 8, 0.1, true, 'connector width (m) [rebuild]');
  roads.close();

  // --- Cars ----------------------------------------------------------------
  const cars = gui.addFolder('Cars');
  const carTarget = theme.cars as unknown as Numeric;
  col(cars, carTarget, 'bodyColor', 'body');
  col(cars, carTarget, 'brakeColor', 'braking');
  num(cars, carTarget, 'height', 0.5, 4, 0.05, false, 'body height (m)');
  const lamps = cars.addFolder('Night lamps');
  col(lamps, carTarget, 'headlightColor', 'headlight');
  num(lamps, carTarget, 'headlightOpacity', 0, 1, 0.01, false, 'headlight opacity');
  num(lamps, carTarget, 'headlightRadius', 0.2, 8, 0.1, false, 'headlight radius (m)');
  num(lamps, carTarget, 'headlightStretch', 0.5, 8, 0.1, false, 'headlight stretch');
  num(lamps, carTarget, 'headlightForwardOffset', 0, 12, 0.1, false, 'headlight ahead (m)');
  col(lamps, carTarget, 'taillightColor', 'taillight');
  num(lamps, carTarget, 'taillightOpacity', 0, 1, 0.01, false, 'taillight opacity');
  num(lamps, carTarget, 'taillightRadius', 0.2, 6, 0.1, false, 'taillight radius (m)');
  num(lamps, carTarget, 'taillightStretch', 0.5, 6, 0.1, false, 'taillight stretch');
  num(lamps, carTarget, 'taillightBackwardOffset', 0, 8, 0.1, false, 'taillight behind (m)');
  num(lamps, carTarget, 'lampSideOffset', 0, 2, 0.05, false, 'lamp side offset (m)');
  num(lamps, carTarget, 'lampHeight', 0, 2, 0.01, false, 'lamp height (m)');
  lamps.close();
  cars.close();

  // --- Scenery -------------------------------------------------------------
  const scenery = gui.addFolder('Scenery');
  const sceneryTarget = theme.scenery as unknown as Numeric;
  col(scenery, sceneryTarget, 'officeColor', 'office');
  col(scenery, sceneryTarget, 'residentialColor', 'residential');
  col(scenery, sceneryTarget, 'retailColor', 'retail');
  col(scenery, sceneryTarget, 'otherColor', 'other use');
  num(scenery, sceneryTarget, 'buildingJitter', 0, 0.6, 0.01, true, 'per-building jitter [rebuild]');
  num(scenery, sceneryTarget, 'estimatedDim', 0.4, 1.2, 0.01, true, 'guessed-height dim [rebuild]');
  col(scenery, sceneryTarget, 'parkColor', 'park');
  col(scenery, sceneryTarget, 'freewayColor', 'freeway');
  col(scenery, sceneryTarget, 'groundColor', 'ground');
  col(scenery, sceneryTarget, 'trenchBankColor', 'trench bank');
  num(scenery, sceneryTarget, 'trenchFloorMargin', 0, 60, 0.5, true, 'trench floor margin (m) [rebuild]');
  num(scenery, sceneryTarget, 'trenchBankWidth', 1, 60, 0.5, true, 'trench bank width (m) [rebuild]');
  num(scenery, sceneryTarget, 'trenchFloorDrop', 0, 3, 0.05, true, 'trench floor drop (m) [rebuild]');
  num(scenery, sceneryTarget, 'groundPadding', 20, 1200, 10, true, 'ground padding (m) [rebuild]');
  bool(scenery, sceneryTarget, 'gridVisible', false, 'reference grid');
  col(scenery, sceneryTarget, 'gridMajorColor', 'grid major');
  col(scenery, sceneryTarget, 'gridMinorColor', 'grid minor');
  scenery.close();

  // --- Lighting ------------------------------------------------------------
  const lighting = gui.addFolder('Lighting');
  lightingFolder(lighting, 'Morning', theme.lighting.morning);
  lightingFolder(lighting, 'Afternoon', theme.lighting.afternoon);
  lightingFolder(lighting, 'Night', theme.lighting.night);

  const shadows = lighting.addFolder('Shadows (shared)');
  const shadowTarget = theme.shadows as unknown as Numeric;
  bool(shadows, shadowTarget, 'enabled', false, 'shadows on');
  num(shadows, shadowTarget, 'mapSize', 512, 4096, 512, false, 'shadow map size');
  num(shadows, shadowTarget, 'bias', -0.01, 0.01, 0.0001, false, 'depth bias');
  num(shadows, shadowTarget, 'normalBias', 0, 5, 0.05, false, 'normal bias');
  num(shadows, shadowTarget, 'padding', 0, 600, 10, false, 'shadow camera padding (m)');
  shadows.close();

  // --- Heatmap -------------------------------------------------------------
  const heatmap = gui.addFolder('Heatmap');
  const heatTarget = theme.heatmap as unknown as Numeric;
  // The three stops are `{ r, g, b }` in 0-1 (what `speedRatioColor` returns),
  // which lil-gui handles natively at its default rgbScale of 1.
  col(heatmap, heatTarget, 'red', 'stopped (ratio 0)');
  col(heatmap, heatTarget, 'yellow', 'slow');
  col(heatmap, heatTarget, 'green', 'free flowing');
  num(heatmap, heatTarget, 'yellowAt', 0, 1, 0.01, false, 'slow threshold');
  num(heatmap, heatTarget, 'greenAt', 0, 1, 0.01, false, 'free-flow threshold');
  heatmap.close();

  // --- Export --------------------------------------------------------------
  const actions = {
    'Copy theme source': (): void => {
      const source = themeToSource();
      console.log('--- theme.ts defaults (paste over `export const theme: Theme =`) ---');
      console.log(source);
      void navigator.clipboard?.writeText(source).catch(() => {
        console.warn('clipboard write refused; the source is logged above');
      });
    },
  };
  gui.add(actions, 'Copy theme source');

  let open = false;
  gui.hide();

  function show(): void {
    open = true;
    gui.show();
  }
  function hide(): void {
    open = false;
    gui.hide();
  }
  function toggle(): void {
    if (open) hide();
    else show();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== toggleKey) return;
    const target = event.target as HTMLElement | null;
    // Don't steal the key from a text field (lil-gui's own number inputs).
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    toggle();
  }
  window.addEventListener('keydown', onKeyDown);

  return {
    gui,
    show,
    hide,
    toggle,
    isOpen: () => open,
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      gui.destroy();
    },
  };
}
