import { RecordingSession } from '../../core/recording-session.mjs';

// Preserve the accepted browser entrypoint while composition moves to the core.
export class ChatGPTRecordingSession extends RecordingSession {
  constructor(directory, adapter, options = {}) {
    if (!adapter) throw Error('ChatGPT adapter required');
    super(directory, options);
  }
}
