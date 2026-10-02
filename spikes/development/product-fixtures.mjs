import { dashboardProductFixture } from './dashboard-fixtures.mjs';
import { recordingProductFixture } from './recording-fixtures.mjs';
import { sidePanelProductFixture } from './sidepanel-fixtures.mjs';
import { codingProductFixture, nativeCodingFixture } from './coding-fixtures.mjs';
export const SYNTHETIC_CANARY = 'SYNTHETIC_RECORDING_e\u0301\r\n☕  ';
export const PRODUCT_SCENARIOS = Object.freeze(['recording-normal-send', 'recording-storage-gap',
  'recording-key-gap', 'recording-connection-gap', 'panel-recording', 'dashboard-recording']);
export const CODING_SCENARIOS = Object.freeze(['coding-lifecycle', 'coding-native']);
export function invariant(value, code = 'SCENARIO_ASSERTION_FAILED') {
  if (!value) throw Object.assign(Error(code), { code });
}
export function productFixture(directory, scenario, diagnostics, network) {
  invariant([...PRODUCT_SCENARIOS, ...CODING_SCENARIOS].includes(scenario));
  if (scenario === 'coding-lifecycle') return codingProductFixture(directory, scenario, diagnostics, network);
  if (scenario === 'coding-native') return nativeCodingFixture(directory, scenario);
  if (scenario === 'dashboard-recording') return dashboardProductFixture(directory, scenario, diagnostics, network);
  return scenario === 'panel-recording' ? sidePanelProductFixture(directory, scenario, diagnostics, network)
    : recordingProductFixture(directory, scenario, diagnostics, network);
}
