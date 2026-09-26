export const CHROME_SOURCE = Object.freeze({ integrationId: 'chrome-chatgpt', adapterProfile: 'pap-chatgpt-chrome/9',
  captureProfile: 'pap-chatgpt-capture/5', pageContract: 'chatgpt-web-text/2026-09-21.1',
  product: 'Google Chrome', major: 153, extensionPattern: /^[a-p]{32}$/ });
export const FIREFOX_EXTENSION_ID = 'attestamp-chatgpt@attestamp.app';
export const FIREFOX_PRIVATE_EXTENSION_ID = 'attestamp-chatgpt-private@attestamp.app';
export const FIREFOX_SOURCE = Object.freeze({ integrationId: 'firefox-chatgpt', adapterProfile: 'pap-chatgpt-firefox/1',
  captureProfile: 'pap-firefox-chatgpt-capture/1', pageContract: 'chatgpt-web-text/2026-09-21.1',
  product: 'Firefox', major: 153, extensionPattern: /^attestamp-chatgpt(?:-private)?@attestamp\.app$/ });
