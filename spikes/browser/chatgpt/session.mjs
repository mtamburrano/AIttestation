import { CHATGPT_CAPTURE_PROFILE } from './capture.mjs';
import { RecordingSession } from '../../core/recording-session.mjs';

// Preserve the accepted browser entrypoint while composition moves to the core.
export class ChatGPTRecordingSession extends RecordingSession {
  captureReceipt(...args) { const receipt = super.captureReceipt(...args); return { ...receipt, profile: receipt.profile ?? CHATGPT_CAPTURE_PROFILE }; }
  observeNormal(input) { return this.observe({ ...input, profile: CHATGPT_CAPTURE_PROFILE }); }
  constructor(directory, adapter, options = {}) {
    if (!adapter) throw Error('ChatGPT adapter required');
    super(directory, options);
  }
}
