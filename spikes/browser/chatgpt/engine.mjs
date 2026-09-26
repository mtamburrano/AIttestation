import { RecordingEngine } from '../../core/recording-engine.mjs';
import { SourceRegistry } from '../../core/source-registry.mjs';
import { EngineStateStore } from './engine-store.mjs';
import { ChatGPTCaptureAdmission } from './admission.mjs';
import { browserControlState, browserControlCommand, ENGINE_EVENT_PROFILE } from './control.mjs';

export { ENGINE_COMMAND_PROFILE, ENGINE_EVENT_PROFILE } from './control.mjs';

export class ResidentEngine extends RecordingEngine {
  #adapter;
  constructor(directory, session, adapter, runtimeEpoch, diagnostics = null, sources = null) {
    sources ??= new SourceRegistry(new ChatGPTCaptureAdmission(adapter, runtimeEpoch));
    super({ session, sources, runtimeEpoch, diagnostics, stateStore: new EngineStateStore(directory, session.vault) });
    this.#adapter = adapter;
  }
  state() { return browserControlState(super.state(), this.#adapter); }
  async command(input, options) {
    return { ...await super.command(browserControlCommand(input, this.#adapter), options), profile: ENGINE_EVENT_PROFILE };
  }
}
