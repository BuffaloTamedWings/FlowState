/**
 * The DOM overlay: current selection, its options, Run/Pause, Revert all,
 * the sim clock and car count. Plain DOM, no framework — `lil-gui` is a
 * dependency but a hand-rolled list gives better control over per-option
 * disabled/available/reason states than it does.
 *
 * This module only renders what it's told via `render(state)`; all the
 * decisions (what's available, what Run should do) live in the pure
 * `layoutState.ts` / `options.ts` / `runController.ts` modules. `main.ts`
 * wires DOM events to callbacks and calls `render` again after each change.
 */

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

export interface PanelState {
  selection: PanelSelectionInfo | null;
  options: PanelOption[];
  running: boolean;
  dirty: boolean;
  simTime: number;
  carCount: number;
  /** An error (from a failed edit/compile) or informational note to show, or null for none. */
  message: string | null;
}

export interface PanelCallbacks {
  onSelectOption(optionId: string): void;
  onRunPause(): void;
  onRevertAll(): void;
}

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

  constructor(container: HTMLElement, callbacks: PanelCallbacks) {
    this.callbacks = callbacks;

    this.root = el('div', 'panel');

    const header = el('div', 'panel-header');
    this.titleEl = el('div', 'panel-title');
    this.hintEl = el('div', 'panel-hint');
    header.append(this.titleEl, this.hintEl);

    this.lockNoticeEl = el('div', 'panel-lock-notice');
    this.lockNoticeEl.textContent = 'Editing is disabled while the simulation is running. Pause to make changes.';

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

    this.clockEl = el('div', 'panel-clock');

    controls.append(this.runButton, this.revertButton, this.clockEl);

    this.root.append(header, this.lockNoticeEl, this.optionsEl, this.messageEl, controls);
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

    this.clockEl.textContent = `t = ${state.simTime.toFixed(1)}s  cars = ${state.carCount}`;
  }
}
