import { dashboardProductFixture } from './dashboard-fixtures.mjs';
import { recordingProductFixture } from './recording-fixtures.mjs';
import { sidePanelProductFixture } from './sidepanel-fixtures.mjs';
export const SYNTHETIC_CANARY = 'SYNTHETIC_RECORDING_e\u0301\r\n☕  ';
export const PRODUCT_SCENARIOS = Object.freeze(['recording-normal-send', 'recording-storage-gap',
  'recording-key-gap', 'recording-connection-gap', 'panel-recording', 'dashboard-recording']);
export function invariant(value, code = 'SCENARIO_ASSERTION_FAILED') {
  if (!value) throw Object.assign(Error(code), { code });
}
export function productFixture(directory, scenario, diagnostics, network) {
  invariant(PRODUCT_SCENARIOS.includes(scenario));
  if (scenario === 'dashboard-recording') return dashboardProductFixture(directory, scenario, diagnostics, network);
  return scenario === 'panel-recording' ? sidePanelProductFixture(directory, scenario, diagnostics, network)
    : recordingProductFixture(directory, scenario, diagnostics, network);
}
