import { keys } from '../../vault/format.mjs';

export const CHATGPT_PANEL_PROFILE = 'pap-chatgpt-panel/1';
const commands = ['ENROLL_SCOPE', 'SET_PAUSE', 'SET_CONVERSATION_MODE', 'PROTECT_AND_SEND', 'CANCEL_OPERATION'];
const errors = new Set(['STALE_RUNTIME_EPOCH', 'STALE_ENGINE_REVISION', 'SCOPE_REVOKED', 'ADAPTER_TARGET_MISMATCH',
  'PROTECTION_PAUSED', 'OPERATION_IN_PROGRESS', 'OPERATION_UNAVAILABLE', 'ENGINE_UNAVAILABLE',
  'COMMAND_REPLAY_CONFLICT', 'COMMAND_INTERRUPTED', 'OPERATION_ALREADY_EXISTS', 'UNSUPPORTED_PATH', 'CAPABILITY_UNAVAILABLE']);
export const panelError = error => errors.has(error?.code ?? error?.message) ? error.code ?? error.message : 'PANEL_REQUEST_REJECTED';

// Send only view data. Vault records, text, digests, access tokens and general
// product API authority never travel back through this panel protocol.
export function panelState(engine) {
  const state = engine.state({ surfaceDetails: true });
  return { profile: CHATGPT_PANEL_PROFILE, runtimeEpoch: state.runtimeEpoch, revision: state.revision,
    adapterProfile: state.adapterProfile, available: state.available,
    paused: state.preferences.paused, defaultMode: state.preferences.defaultMode,
    targets: state.targets,
    scopes: state.scopes.map(({ scope, tabId, windowId, tabEpoch, adapterEpoch, destination,
      requestedMode, effectiveMode, editRevision }) => ({ scope, tabId, windowId, tabEpoch, adapterEpoch,
      destination, requestedMode, effectiveMode, editRevision })),
    operations: state.operations.filter(value => !value.observation).filter((value, index, values) =>
      index >= values.length - 64 || !value.settled && !value.stopped && !value.restored
      || !value.stopped && !value.restored && value.result?.actions?.cancel).map(operation => ({
      id: operation.id, scope: operation.scope, tabId: operation.target.tabId, windowId: operation.target.windowId,
      destination: operation.target.destination, editRevision: operation.editRevision, state: operation.state,
      stopped: operation.stopped, restored: operation.restored, settled: operation.settled,
      service: ['NOT_CONFIGURED', 'ACCOUNT_REQUIRED', 'UNPAID', 'QUOTA_EXHAUSTED', 'RATE_LIMITED',
        'SERVICE_UNAVAILABLE', 'SUBMISSION_INTERRUPTED'].includes(operation.result?.managed?.state)
        ? operation.result.managed.state : null,
      cancellable: !operation.stopped && !operation.restored && !operation.result?.attempt
        && (!operation.settled || operation.result?.actions?.cancel === true),
    })),
  };
}

export async function panelRequest(message, engine, openDashboard) {
  keys(message, ['kind', 'profile', 'requestId', 'action', ...(message.action === 'COMMAND' ? ['command'] : [])]);
  if (message.profile !== CHATGPT_PANEL_PROFILE || !/^[a-f0-9-]{36}$/.test(message.requestId ?? '')) throw Error('Invalid panel request');
  if (message.action === 'STATE') return { state: panelState(engine) };
  if (message.action === 'OPEN_DASHBOARD') {
    if (!openDashboard) throw Error('Dashboard unavailable');
    await openDashboard(); return { opened: true };
  }
  if (message.action !== 'COMMAND' || !commands.includes(message.command?.kind)) throw Error('Invalid panel action');
  const command = structuredClone(message.command);
  if (command.kind === 'PROTECT_AND_SEND') {
    const { textBytes } = command;
    if (Object.hasOwn(command, 'text') || typeof textBytes !== 'string' || textBytes.length > 349528
        || Buffer.from(textBytes, 'base64').toString('base64') !== textBytes) throw Error('Invalid panel encoding');
    command.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(textBytes, 'base64'));
    delete command.textBytes;
  }
  const ack = await engine.command(command, { surface: 'extension_panel' });
  return { ack, state: panelState(engine) };
}
