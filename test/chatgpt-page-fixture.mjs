import { readFile } from 'node:fs/promises';
import { webcrypto, createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { CHATGPT_EXTENSION_ID, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';

const source = await readFile(new URL('../spikes/browser/chatgpt/extension/content-script.js', import.meta.url), 'utf8');
export const pageCommand = (text = 'SYNTHETIC_EXACT_e\u0301\r\n☕', overrides = {}) => ({
  kind: 'PAP_RELEASE', pageContract: CHATGPT_PAGE_CONTRACT, expectedUrl: 'https://chatgpt.com/c/test-conversation',
  destination: 'conversation:test-conversation', attemptId: webcrypto.randomUUID(),
  textDigest: createHash('sha256').update(text).digest('hex'), textBytes: Buffer.from(text).toString('base64'), ...overrides,
});

// Synthetic DOM and Chrome APIs only: no browser profile, network or native identity.
export function pageFixture({ draft = '', textarea = false, supported = true, sendState = 'enabled',
  attachments = false, onInput = () => {}, authorize = async () => true, notify = () => {},
  url = 'https://chatgpt.com/c/test-conversation', clock = { setTimeout, clearTimeout, performance } } = {}) {
  let listener, clicks = 0, injections = 0;
  const observers = [], events = {}, windowEvents = {}, notifications = [], checks = [];
  const changed = () => { for (const observer of observers) observer(); };
  class Textarea {
    #value = draft;
    get value() { return this.#value; }
    set value(value) { this.#value = value; }
  }
  class Editor {
    textContent = draft;
    replaceChildren(node) { this.textContent = node.value; }
  }
  const editor = textarea ? new Textarea() : new Editor();
  Object.assign(editor, { isConnected: true, disabled: false, readOnly: false,
    getAttribute: name => name === 'contenteditable' ? 'true' : null,
    dispatchEvent() { injections++; onInput(page); changed(); },
  });
  const button = { disabled: sendState === 'disabled', isConnected: true, visible: sendState !== 'hidden', ariaDisabled: false,
    matches: selector => selector === ':disabled' && button.disabled,
    getAttribute: name => name === 'aria-disabled' && button.ariaDisabled ? 'true' : null,
    getClientRects: () => button.visible ? [{}] : [], click() { clicks++; page.onClick?.(); },
  };
  const document = { documentElement: {}, visibilityState: 'visible',
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea') return page.editors;
      if (selector === 'button[data-testid="send-button"]') return page.buttons;
      if (selector === 'input[type=file]') return page.files;
      return [];
    },
    querySelector: () => page.attachments ? {} : null,
    createTextNode: value => ({ value }),
    addEventListener: (name, callback) => { (events[name] ??= []).push(callback); },
  };
  const page = { editor, button, document, location: new URL(url), editors: supported ? [editor] : [],
    buttons: sendState === 'absent' ? [] : sendState === 'ambiguous' ? [button, button] : [button],
    files: [], attachments, changed, notifications, checks,
    clicks: () => clicks, injections: () => injections,
    get text() { return textarea ? editor.value : editor.textContent; },
    set text(value) { if (textarea) editor.value = value; else editor.textContent = value; changed(); },
    event(name) { for (const callback of events[name] ?? windowEvents[name] ?? []) callback(); },
    sender(overrides = {}) { return { id: CHATGPT_EXTENSION_ID, frameId: 0, tab: { id: 17, url: page.location.href },
      url: page.location.href, origin: page.location.origin, documentId: 'synthetic-document', ...overrides }; },
    send(message, sender = { id: CHATGPT_EXTENSION_ID }) {
      return new Promise(resolve => listener(message, sender, value => resolve(structuredClone(value))));
    },
    inspect() { return page.send({ kind: 'PAP_INSPECT', pageContract: CHATGPT_PAGE_CONTRACT }); },
  };
  runInNewContext(source, { document, location: page.location, HTMLTextAreaElement: Textarea, InputEvent: class {},
    TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto, ...clock,
    getComputedStyle: node => ({ visibility: node.visible ? 'visible' : 'hidden' }),
    addEventListener: (name, callback) => { (windowEvents[name] ??= []).push(callback); },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    chrome: { runtime: { id: CHATGPT_EXTENSION_ID, onMessage: { addListener: callback => { listener = callback; } },
      sendMessage: async message => {
        if (message.kind === 'PAP_SURFACE_CHANGED') { notifications.push(structuredClone(message)); notify(message, page); return; }
        checks.push(structuredClone(message)); return authorize(message, page);
      } } },
  });
  return page;
}
