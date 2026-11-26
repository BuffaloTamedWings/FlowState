// Public entry points of the engine. Sashank owns this folder — see ../README.md and ../CONTEXT.md.
// The front end normally talks to the engine through the Web Worker in `worker.ts`;
// these exports are for headless use (tests, tools) and debugging.
export { EngineHost, type HostIO } from './host.js';
export { loadNetwork, describeNetwork, NetworkError, type Network } from './network.js';
export { Sim, type SimOptions } from './sim.js';
