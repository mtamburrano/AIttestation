import { RecordingEngine } from '../../core/recording-engine.mjs';
import { SourceRegistry } from '../../core/source-registry.mjs';
import { EngineStateStore } from './engine-store.mjs';
import { ChatGPTCaptureAdmission } from './admission.mjs';

export { ENGINE_COMMAND_PROFILE, ENGINE_EVENT_PROFILE } from '../../core/recording-engine.mjs';

export class ResidentEngine extends RecordingEngine {
  constructor(directory, session, adapter, runtimeEpoch, diagnostics = null, sources = null) {
    sources ??= new SourceRegistry(new ChatGPTCaptureAdmission(adapter, runtimeEpoch));
    super({ session, sources, runtimeEpoch, diagnostics, stateStore: new EngineStateStore(directory, session.vault) });
  }
}
