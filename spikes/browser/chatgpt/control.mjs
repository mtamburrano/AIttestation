import { keys } from '../../vault/format.mjs';
import { ENGINE_COMMAND_PROFILE as CORE_COMMAND_PROFILE, RECORDING_CONTROL_PROFILE } from '../../core/recording-engine.mjs';
import { CHATGPT_ADAPTER_PROFILE } from './adapter.mjs';

export const ENGINE_COMMAND_PROFILE = 'pap-resident-command/2';
export const ENGINE_EVENT_PROFILE = 'pap-resident-event/2';

export function browserControlState(state, adapter) {
  const { controlProfile: _profile, ...rest } = state;
  return { ...rest, profile: ENGINE_EVENT_PROFILE, adapterProfile: adapter.controlProfile ?? CHATGPT_ADAPTER_PROFILE,
    capabilities: adapter.capabilities };
}

export function browserControlCommand(input, adapter) {
  keys(input, ['profile', 'runtimeEpoch', 'adapterProfile', 'commandId', 'expectedRevision', 'kind', 'enabled']);
  if (input.profile !== ENGINE_COMMAND_PROFILE || input.adapterProfile !== (adapter.controlProfile ?? CHATGPT_ADAPTER_PROFILE)) {
    throw Object.assign(Error('ENGINE_CONTRACT_MISMATCH'), { code: 'ENGINE_CONTRACT_MISMATCH' });
  }
  const { adapterProfile: _profile, ...rest } = input;
  return { ...rest, profile: CORE_COMMAND_PROFILE, controlProfile: RECORDING_CONTROL_PROFILE };
}

// The old browser/dashboard wire contract is translated at the client edge.
// Neither the common control API nor its capabilities depend on a primary peer.
export function browserControl(engine, adapter) {
  return Object.freeze({
    state: () => browserControlState(engine.state(), adapter),
    subscribe: listener => engine.subscribe(state => listener(browserControlState(state, adapter))),
    command: async (input, options) => ({ ...await engine.command(browserControlCommand(input, adapter), options), profile: ENGINE_EVENT_PROFILE }),
    captureChannel: peer => engine.captureChannel(peer),
    capturePolicy: (...args) => engine.capturePolicy(...args),
    captureStates: (...args) => engine.captureStates(...args),
    observe: (...args) => engine.observe(...args),
    captureReceipt: (...args) => engine.captureReceipt(...args),
    drain: () => engine.drain(), stop: () => engine.stop(),
  });
}
