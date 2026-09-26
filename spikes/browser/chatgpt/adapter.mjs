import { ChatGPTBrowserAdapter } from '../shared/chatgpt-adapter.mjs';
import { CHROME_SOURCE } from '../shared/profiles.mjs';

export const CHATGPT_ADAPTER_PROFILE = 'pap-chatgpt-chrome/9';
export const CHATGPT_PAGE_CONTRACT = 'chatgpt-web-text/2026-09-21.1';
export const CHATGPT_ADAPTER_ID = 'chrome-chatgpt';
export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_EXTENSION_ID = 'medilhopfckldjgdnchfkpmfmfnkadca';
export const CHROME_BASELINE_MAJOR = 153;

export class ChatGPTChromeAdapter extends ChatGPTBrowserAdapter {
  constructor(options) { super({ ...options, browserProfile: CHROME_SOURCE }); }
}
