import { readFile } from 'node:fs/promises';
import { webcrypto, createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { CHATGPT_EXTENSION_ID, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';

const source = await readFile(new URL('../spikes/browser/chatgpt/extension/content-script.js', import.meta.url), 'utf8');
const observerSource = await readFile(new URL('../spikes/browser/chatgpt/extension/fetch-observer.js', import.meta.url), 'utf8');
export const pageCommand = (text = 'SYNTHETIC_EXACT_e\u0301\r\n☕', overrides = {}) => ({
  kind: 'PAP_RELEASE', pageContract: CHATGPT_PAGE_CONTRACT, expectedUrl: 'https://chatgpt.com/c/test-conversation',
  destination: 'conversation:test-conversation', attemptId: webcrypto.randomUUID(),
  textDigest: createHash('sha256').update(text).digest('hex'), textBytes: Buffer.from(text).toString('base64'), ...overrides,
});

// Synthetic DOM and Chrome APIs only: no browser profile, network or native identity.
export function pageFixture({ draft = '', textarea = false, supported = true, sendState = 'enabled',
  attachments = false, onInput = () => {}, authorize = async () => true, notify = () => {},
  capture = async () => ({ kind: 'PAP_CAPTURE_POLICY', browserSessionId: 'synthetic-unpaired', revision: 0, policy: null, state: 'OFF' }),
  url = 'https://chatgpt.com/c/test-conversation', fetchResponse = null, transport = true,
  clock = { setTimeout, clearTimeout, performance } } = {}) {
  let listener, clicks = 0, injections = 0;
  const timers = new Set(), transportHolds = new Map();
  const observers = [], events = {}, windowEvents = {}, notifications = [], checks = [];
  const changed = () => { for (const observer of observers) observer(); };
  class Textarea {
    #value = draft;
    get value() { return this.#value; }
    set value(value) { this.#value = value; }
  }
  class Element {
    nodeType = 1; childNodes = []; attributes = {}; style = {}; hidden = false; visible = true;
    constructor(tagName = 'DIV', text = '') { this.tagName = tagName; this.textContent = text; }
    get textContent() { return this.childNodes.map(node => node.data ?? node.textContent).join(''); }
    set textContent(value) { this.childNodes = [{ nodeType: 3, data: value }]; }
    get firstChild() { return this.childNodes[0]; }
    replaceChildren(...nodes) { this.childNodes = nodes; }
    append(...nodes) { this.childNodes.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    contains(node) { return node === this || this.childNodes.some(value => value === node || value.contains?.(node)); }
  }
  const editor = textarea ? new Textarea() : new Element('DIV', draft);
  Object.assign(editor, { isConnected: true, disabled: false, readOnly: false,
    visible: true,
    getAttribute: name => name === 'contenteditable' ? 'true' : null,
    dispatchEvent() { injections++; onInput(page); changed(); },
  });
  const button = { disabled: sendState === 'disabled', isConnected: true, visible: sendState !== 'hidden', ariaDisabled: false,
    matches: selector => selector === ':disabled' && button.disabled,
    getAttribute: name => name === 'aria-disabled' && button.ariaDisabled ? 'true' : null,
    contains: node => node === button,
    getClientRects: () => button.visible ? [{}] : [], click() { clicks++; page.onClick?.(); },
  };
  const document = { documentElement: new Element(), visibilityState: 'visible',
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea') return page.editors;
      if (selector === 'button[data-testid="send-button"]') return page.buttons;
      if (selector === 'input[type=file]') return page.files;
      if (selector === '[data-message-author-role="user"][data-message-id]') return page.messages;
      return [];
    },
    querySelector: () => page.attachments ? {} : null,
    createTextNode: value => ({ nodeType: 3, data: value }),
    createElement: name => new Element(name.toUpperCase()),
    addEventListener: (name, callback) => { (events[name] ??= []).push(callback); },
  };
  const page = { editor, button, document, location: new URL(url), editors: supported ? [editor] : [],
    buttons: sendState === 'absent' ? [] : sendState === 'ambiguous' ? [button, button] : [button],
    files: [], messages: [], attachments, changed, notifications, checks, Element,
    clicks: () => clicks, injections: () => injections,
    get text() { return textarea ? editor.value : editor.textContent; },
    set text(value) { if (textarea) editor.value = value; else editor.textContent = value; changed(); },
    event(name, event = {}) { for (const callback of events[name] ?? windowEvents[name] ?? []) callback({ type: name, target: editor, ...event }); },
    get feedback() { return document.documentElement.childNodes.find(node => node.id === 'attestamp-recording-status')?.textContent ?? ''; },
    close() { page.event('pagehide'); for (const timer of timers) clock.clearTimeout(timer); timers.clear(); },
    sender(overrides = {}) { return { id: CHATGPT_EXTENSION_ID, frameId: 0, tab: { id: 17, windowId: 1, url: page.location.href },
      url: page.location.href, origin: page.location.origin, documentId: 'synthetic-document', documentLifecycle: 'active', ...overrides }; },
    send(message, sender = { id: CHATGPT_EXTENSION_ID }) {
      return new Promise(resolve => listener(message, sender, value => resolve(structuredClone(value))));
    },
    inspect() { return page.send({ kind: 'PAP_INSPECT', pageContract: CHATGPT_PAGE_CONTRACT }); },
  };
  const sandbox = { document, location: page.location, HTMLTextAreaElement: Textarea, InputEvent: class {},
    URL, Request, Response, Blob, AbortController, queueMicrotask,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: event => { for (const callback of windowEvents[event.type] ?? []) callback(event); },
    TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto, performance: clock.performance,
    setTimeout(callback, delay) {
      const timer = clock.setTimeout(() => { timers.delete(timer); callback(); }, delay);
      if (callback.name === 'refreshCapturePolicy') timer?.unref?.();
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clock.clearTimeout(timer); },
    getComputedStyle: node => ({ visibility: node.visible ? 'visible' : 'hidden', display: node.style?.display ?? 'block' }),
    addEventListener: (name, callback) => { (windowEvents[name] ??= []).push(callback); },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    chrome: { runtime: { id: CHATGPT_EXTENSION_ID, onMessage: { addListener: callback => { listener = callback; } },
      sendMessage: async message => {
        if (message.kind === 'PAP_SURFACE_CHANGED') { notifications.push(structuredClone(message)); notify(message, page); return; }
        if (['PAP_CAPTURE_STATUS', 'PAP_CAPTURE'].includes(message.kind)) return capture(message, page);
        checks.push(structuredClone(message)); return authorize(message, page);
      } } },
  };
  sandbox.window = sandbox; sandbox.top = sandbox;
  const deliverTransport = ({ data, origin }) => queueMicrotask(() => {
    for (const callback of windowEvents.message ?? []) callback({ source: runInContext('window', context), origin, data });
  });
  page.holdTransport = kind => {
    if (transportHolds.has(kind)) throw Error('TRANSPORT_ALREADY_HELD');
    const messages = [];
    transportHolds.set(kind, messages);
    return { messages, release() {
      if (transportHolds.get(kind) !== messages) return;
      transportHolds.delete(kind);
      for (const message of messages) deliverTransport(message);
    } };
  };
  sandbox.postMessage = (message, origin) => {
    const event = { data: structuredClone(message), origin };
    const held = transportHolds.get(message.kind);
    if (held) held.push(event); else deliverTransport(event);
  };
  page.requests = [];
  sandbox.fetch = (...args) => {
    if (args[0] instanceof Request && args[0].signal.aborted) return Promise.reject(args[0].signal.reason);
    page.requests.push(args);
    return page.fetchResponse ? page.fetchResponse(...args) : Promise.resolve(new Response('', { status: 200 }));
  };
  page.fetchResponse = fetchResponse;
  const originalFetch = sandbox.fetch;
  page.wrapFetch = wrapper => { sandbox.fetch = wrapper(sandbox.fetch); };
  page.bypassObserver = () => { sandbox.fetch = originalFetch; };
  const context = createContext(sandbox);
  runInContext(source, context); if (transport) runInContext(observerSource, context);
  page.fetch = (...args) => sandbox.fetch(...args);
  page.request = (text, overrides = {}) => page.fetch('/backend-api/f/conversation', { method: 'POST',
    body: JSON.stringify({ action: 'next', messages: [{ id: webcrypto.randomUUID(), author: { role: 'user' },
      content: { content_type: 'text', parts: [text] } }], parent_message_id: webcrypto.randomUUID(),
    conversation_id: page.location.pathname === '/' ? null : page.location.pathname.split('/')[2], ...overrides }) });
  page.transportMessage = data => sandbox.postMessage({ channel: 'pap-chatgpt-transport/2', ...data }, 'https://chatgpt.com');
  return page;
}
