/**
 * The DOM overlay: current selection, its options, Run/Pause, Revert all,
 * the preset picker, speed/skip/reset, the sim clock, the heatmap toggle,
 * metrics, and the OSM attribution (plan step 10). Plain DOM, no framework —
 * `lil-gui` is a dependency but a hand-rolled list gives better control over
 * per-option disabled/available/reason states than it does.
 *
 * This module only renders what it's told via `render(state)`; all the
 * decisions (what's available, what Run should do) live in the pure
 * `layoutState.ts` / `options.ts` / `runController.ts` modules. `main.ts`
 * wires DOM events to callbacks and calls `render` again after each change.
 */

import type { PlaybackSpeed } from '@shared/messages.js';

import { formatSimClock } from './clock.js';

export interface PanelOption {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  selected: boolean;
}

export interface PanelSelectionInfo {
  kind: 'edge' | 'node';
  id: string;
  name: string;
}

export interface PanelPreset {
  id: string;
  label: string;
}

/** Rolled-up view of `shared/messages.ts`'s `Metrics`, enough for a HUD readout. */
export interface PanelMetrics {
  carsActive: number;
  carsWaitingToEnter: number;
  parkingFailed: number;
  gridlockRemovals: number;
  completedTrips: number;
  /** Mean trip time over every completed trip seen so far, or null before any has finished. */
  meanTripTimeSec: number | null;
}

export interface PanelState {
  selection: PanelSelectionInfo | null;
  options: PanelOption[];
  running: boolean;
  dirty: boolean;
  simTime: number;
  carCount: number;
  /** An error (from a failed edit/compile) or informational note to show, or null for none. */
  message: string | null;

  presets: PanelPreset[];
  /** The preset the next Run will use, or null before any preset has loaded. */
  presetId: string | null;
  speed: PlaybackSpeed;
  heatmapOn: boolean;
  /** `scenario.meta.attribution`, or null if the scenario doesn't carry one. */
  attribution: string | null;
  metrics: PanelMetrics | null;
}

export interface PanelCallbacks {
  onSelectOption(optionId: string): void;
  onRunPause(): void;
  onRevertAll(): void;
  onSelectPreset(presetId: string): void;
  onSetSpeed(speed: PlaybackSpeed): void;
  onSkip(): void;
  onReset(): void;
  onToggleHeatmap(): void;
}

const SPEEDS: readonly PlaybackSpeed[] = [1, 2, 4];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export class Panel {
  readonly root: HTMLElement;

  private readonly callbacks: PanelCallbacks;
  private readonly titleEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly optionsEl: HTMLElement;
  private readonly messageEl: HTMLElement;
  private readonly runButton: HTMLButtonElement;
  private readonly revertButton: HTMLButtonElement;
  private readonly clockEl: HTMLElement;
  private readonly lockNoticeEl: HTMLElement;

  private readonly presetEl: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly heatmapButton: HTMLButtonElement;
  private readonly metricsEl: HTMLElement;
  private readonly attributionEl: HTMLElement;

  constructor(container: HTMLElement, callbacks: PanelCallbacks) {
    this.callbacks = callbacks;

    this.root = el('div', 'panel');

    const header = el('div', 'panel-header');
    this.titleEl = el('div', 'panel-title');
    this.hintEl = el('div', 'panel-hint');
    header.append(this.titleEl, this.hintEl);

    this.lockNoticeEl = el('div', 'panel-lock-notice');
    this.lockNoticeEl.textContent = 'Editing is disabled while the simulation is running. Pause to make changes.';

    this.presetEl = el('div', 'panel-presets');
    this.speedEl = el('div', 'panel-speeds');

    this.optionsEl = el('div', 'panel-options');
    this.messageEl = el('div', 'panel-message');

    const controls = el('div', 'panel-controls');
    this.runButton = el('button', 'panel-button panel-run');
    this.runButton.type = 'button';
    this.runButton.addEventListener('click', () => this.callbacks.onRunPause());

    this.revertButton = el('button', 'panel-button panel-revert');
    this.revertButton.type = 'button';
    this.revertButton.textContent = 'Revert all';
    this.revertButton.addEventListener('click', () => this.callbacks.onRevertAll());

    this.skipButton = el('button', 'panel-button');
    this.skipButton.type = 'button';
    this.skipButton.textContent = 'Skip 5 min';
    this.skipButton.addEventListener('click', () => this.callbacks.onSkip());

    this.resetButton = el('button', 'panel-button');
    this.resetButton.type = 'button';
    this.resetButton.textContent = 'Reset';
    this.resetButton.addEventListener('click', () => this.callbacks.onReset());

    controls.append(this.runButton, this.revertButton, this.skipButton, this.resetButton);

    const secondRow = el('div', 'panel-controls');
    this.heatmapButton = el('button', 'panel-button panel-heatmap');
    this.heatmapButton.type = 'button';
    this.heatmapButton.addEventListener('click', () => this.callbacks.onToggleHeatmap());

    this.clockEl = el('div', 'panel-clock');
    secondRow.append(this.heatmapButton, this.clockEl);

    this.metricsEl = el('div', 'panel-metrics');
    this.attributionEl = el('div', 'panel-attribution');

    this.root.append(
      header,
      this.lockNoticeEl,
      this.presetEl,
      this.optionsEl,
      this.messageEl,
      controls,
      this.speedEl,
      secondRow,
      this.metricsEl,
      this.attributionEl,
    );
    container.appendChild(this.root);
  }

  render(state: PanelState): void {
    if (state.selection) {
      this.titleEl.textContent = `${state.selection.name} (${state.selection.kind})`;
      this.hintEl.textContent = '';
    } else {
      this.titleEl.textContent = 'Nothing selected';
      this.hintEl.textContent = 'Click a road or intersection to edit it.';
    }

    this.lockNoticeEl.style.display = state.running ? 'block' : 'none';

    // --- Preset picker ----------------------------------------------------
    this.presetEl.replaceChildren();
    if (state.presets.length > 0) {
      const label = el('div', 'panel-section-label');
      label.textContent = 'Time of day';
      this.presetEl.appendChild(label);
      const row = el('div', 'panel-preset-row');
      for (const preset of state.presets) {
        const button = el('button', 'panel-option panel-preset-option');
        button.type = 'button';
        button.textContent = preset.label;
        if (preset.id === state.presetId) button.classList.add('panel-option-selected');
        button.disabled = state.running;
        if (state.running) button.title = 'Pause to change the time of day';
        button.addEventListener('click', () => this.callbacks.onSelectPreset(preset.id));
        row.appendChild(button);
      }
      this.presetEl.appendChild(row);
    }

    // --- Edit options ------------------------------------------------------
    this.optionsEl.replaceChildren();
    if (state.selection) {
      for (const option of state.options) {
        const button = el('button', 'panel-option');
        button.type = 'button';
        button.textContent = option.label;
        if (option.selected) button.classList.add('panel-option-selected');
        const disabled = !option.available || state.running;
        button.disabled = disabled;
        if (!option.available && option.reason) {
          button.title = option.reason;
          button.classList.add('panel-option-unavailable');
          const reasonEl = el('span', 'panel-option-reason');
          reasonEl.textContent = option.reason;
          button.append(reasonEl);
        } else if (state.running) {
          button.title = 'Pause to edit';
        }
        button.addEventListener('click', () => this.callbacks.onSelectOption(option.id));
        this.optionsEl.appendChild(button);
      }
    }

    this.messageEl.textContent = state.message ?? '';
    this.messageEl.style.display = state.message ? 'block' : 'none';

    this.runButton.textContent = state.running ? 'Pause' : state.dirty ? 'Run (restart)' : 'Run';
    this.revertButton.disabled = state.running;
    this.skipButton.disabled = false;
    this.resetButton.disabled = false;

    // --- Speed ---------------------------------------------------------
    this.speedEl.replaceChildren();
    const speedLabel = el('div', 'panel-section-label');
    speedLabel.textContent = 'Speed';
    this.speedEl.appendChild(speedLabel);
    const speedRow = el('div', 'panel-speed-row');
    for (const speed of SPEEDS) {
      const button = el('button', 'panel-option panel-speed-option');
      button.type = 'button';
      button.textContent = `${speed}x`;
      if (speed === state.speed) button.classList.add('panel-option-selected');
      button.addEventListener('click', () => this.callbacks.onSetSpeed(speed));
      speedRow.appendChild(button);
    }
    this.speedEl.appendChild(speedRow);

    // --- Heatmap toggle + clock -----------------------------------------
    this.heatmapButton.textContent = state.heatmapOn ? 'Heatmap: on' : 'Heatmap: off';
    this.heatmapButton.classList.toggle('panel-option-selected', state.heatmapOn);
    this.clockEl.textContent = `t = ${formatSimClock(state.simTime)}  cars = ${state.carCount}`;

    // --- Metrics ----------------------------------------------------------
    this.metricsEl.replaceChildren();
    if (state.metrics) {
      const m = state.metrics;
      const lines = [
        `active ${m.carsActive}  waiting ${m.carsWaitingToEnter}`,
        `parking failed ${m.parkingFailed}  gridlock removed ${m.gridlockRemovals}`,
        `trips done ${m.completedTrips}  mean time ${m.meanTripTimeSec !== null ? `${m.meanTripTimeSec.toFixed(0)}s` : '-'}`,
      ];
      for (const line of lines) {
        const row = el('div', 'panel-metrics-row');
        row.textContent = line;
        this.metricsEl.appendChild(row);
      }
    }

    // --- Attribution --------------------------------------------------
    this.attributionEl.textContent = state.attribution ?? '';
    this.attributionEl.style.display = state.attribution ? 'block' : 'none';
  }
}
