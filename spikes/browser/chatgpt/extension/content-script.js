const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-10';
const MAX_TEXT_BYTES = 256 * 1024;

function destination() {
  if (location.origin !== 'https://chatgpt.com') return null;
  if (location.pathname === '/') return 'new-chat';
  const match = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  return match ? `conversation:${match[1]}` : null;
}

function composers() {
  return [...document.querySelectorAll('#prompt-textarea')]
    .filter(node => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true');
}

function textOf(node) {
  return node instanceof HTMLTextAreaElement ? node.value : node.textContent;
}

function attachmentsPresent() {
  if ([...document.querySelectorAll('input[type=file]')].some(input => input.files?.length)) return true;
  return document.querySelector('[data-testid="composer-file-chip"], [data-testid="attachment-preview"]') !== null;
}

function surface() {
  const editor = composers();
  const send = document.querySelectorAll('button[data-testid="send-button"]');
  const target = destination();
  return {
    destination: target ?? '',
    surfaceSupported: target !== null && editor.length === 1 && send.length === 1,
    composerEmpty: editor.length === 1 && textOf(editor[0]) === '',
    attachmentsPresent: attachmentsPresent(),
  };
}

function injectExactText(node, text) {
  if (node instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw Error('textarea setter unavailable');
    setter.call(node, text);
  } else {
    node.replaceChildren(document.createTextNode(text));
  }
  node.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  if (textOf(node) !== text) throw Error('provider composer changed exact text');
}

function decodeExactText(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 349528
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw Error('invalid text encoding');
  }
  const binary = atob(encoded), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (btoa(binary) !== encoded || bytes.length > MAX_TEXT_BYTES) throw Error('invalid text encoding');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function sha256Hex(bytes) {
  const value = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.pageContract !== PAGE_CONTRACT) {
    respond({ surfaceSupported: false, destination: '', composerEmpty: false, attachmentsPresent: false });
    return;
  }
  if (message.kind === 'PAP_INSPECT') { respond(surface()); return; }
  if (message.kind !== 'PAP_RELEASE') return;
  const result = { attemptId: message.attemptId, textDigest: message.textDigest, exposure: 'NONE', submitted: false };
  Promise.resolve().then(async () => {
    const initial = surface();
    if (message.expectedUrl !== location.href || message.destination !== initial.destination
        || !initial.surfaceSupported || !initial.composerEmpty || initial.attachmentsPresent) return result;
    const text = decodeExactText(message.textBytes), bytes = new TextEncoder().encode(text);
    if (!text.isWellFormed() || bytes.length > MAX_TEXT_BYTES || !/^[a-f0-9]{64}$/.test(message.textDigest ?? '')
        || await sha256Hex(bytes) !== message.textDigest) return result;
    const before = surface();
    if (message.expectedUrl !== location.href || message.destination !== before.destination
        || !before.surfaceSupported || !before.composerEmpty || before.attachmentsPresent) return result;
    const editor = composers()[0];
    injectExactText(editor, text); result.exposure = 'DOM_INJECTED';
    const send = document.querySelectorAll('button[data-testid="send-button"]');
    if (send.length !== 1 || send[0].disabled || textOf(editor) !== text || attachmentsPresent()) return result;
    send[0].click(); result.submitted = true; result.observation = 'LOCAL_CLICK_DISPATCHED'; return result;
  }).then(respond).catch(() => respond(result));
  return true;
});
