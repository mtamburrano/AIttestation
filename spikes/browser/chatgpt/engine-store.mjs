import { EngineStateStore as RecordingStateStore } from '../../core/recording-state.mjs';
import { RecordingFiles } from '../../platform/recording-files.mjs';

export { migrateRecordingState } from '../../core/recording-state.mjs';
export { lockResidentEngine } from '../../platform/resident-lock.mjs';

export class EngineStateStore extends RecordingStateStore {
  constructor(directory, vault) { super(new RecordingFiles(directory), vault); }
}
