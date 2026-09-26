import { ChatGPTBrowserAdapter } from '../shared/chatgpt-adapter.mjs';
import { FIREFOX_SOURCE } from '../shared/profiles.mjs';
export class ChatGPTFirefoxAdapter extends ChatGPTBrowserAdapter {
  constructor(options) { super({ ...options, browserProfile: FIREFOX_SOURCE }); }
}
