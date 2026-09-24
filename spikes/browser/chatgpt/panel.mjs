import { keys } from '../../vault/format.mjs';

export const CHATGPT_PANEL_PROFILE = 'pap-chatgpt-panel/2';
export const CHATGPT_PANEL_DIAGNOSTIC_PROFILE = 'pap-chatgpt-panel-diagnostic/1';
export const PANEL_REJECTION_CODES = Object.freeze(['PANEL_SENDER_REJECTED', 'PANEL_URL_REJECTED', 'PANEL_MESSAGE_REJECTED',
  'PANEL_CONTEXT_REJECTED', 'PANEL_CONTEXT_UNAVAILABLE', 'PANEL_PERMISSION_REJECTED', 'PANEL_CONNECTION_UNAVAILABLE']);
const errors = new Set(['STALE_RUNTIME_EPOCH', 'STALE_ENGINE_REVISION', 'ENGINE_UNAVAILABLE',
  'VAULT_CAPACITY_EXHAUSTED',
  'COMMAND_REPLAY_CONFLICT', 'COMMAND_LIMIT']);
export const panelError = error => errors.has(error?.code ?? error?.message) ? error.code ?? error.message : 'PANEL_REQUEST_REJECTED';

// Fixed status only: no prompt bytes, URLs, conversation IDs, vault IDs or keys.
export function panelState(engine) {
  const state = engine.state();
  return { profile: CHATGPT_PANEL_PROFILE, runtimeEpoch: state.runtimeEpoch, revision: state.revision,
    adapterProfile: state.adapterProfile, available: state.available, recording: state.recording,
    captureUnavailableReason: state.captureUnavailableReason,
    readySources: state.scopes.filter(value => value.effectiveRecording === 'ON').length,
    unavailableSources: state.scopes.filter(value => value.effectiveRecording === 'UNAVAILABLE').length };
}

export async function panelRequest(message, engine, openDashboard) {
  keys(message, ['kind', 'profile', 'requestId', 'action', ...(message.action === 'COMMAND' ? ['command'] : [])]);
  if (message.profile !== CHATGPT_PANEL_PROFILE || !/^[a-f0-9-]{36}$/.test(message.requestId ?? '')) throw Error('Invalid panel request');
  if (message.action === 'STATE') return { state: panelState(engine) };
  if (message.action === 'OPEN_DASHBOARD') {
    if (!openDashboard) throw Error('Dashboard unavailable');
    await openDashboard(); return { opened: true };
  }
  if (message.action !== 'COMMAND' || message.command?.kind !== 'SET_RECORDING') throw Error('Invalid panel action');
  const ack = await engine.command(message.command, { surface: 'extension_panel' });
  return { ack, state: panelState(engine) };
}
