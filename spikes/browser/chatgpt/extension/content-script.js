const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-14';
const MAX_TEXT_BYTES = 256 * 1024;
const RELEASE_WINDOW_MS = 1500, SEND_SETTLE_MS = 1000, POLL_MS = 25;
const attempts = new Set();
let activeRelease;

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
  const target = destination();
  return {
    destination: target ?? '',
    surfaceSupported: target !== null && editor.length === 1,
    composerEmpty: editor.length === 1 && textOf(editor[0]) === '',
    attachmentsPresent: attachmentsPresent(),
  };
}

// Only fixed capability bits leave the page on drift; no DOM text, selectors,
// conversation identifiers or evidence bytes are included in this notification.
if (typeof MutationObserver === 'function') {
  let lastSurface = JSON.stringify(surface());
  const changed = () => {
    activeRelease?.validate?.();
    const next = JSON.stringify(surface());
    if (next === lastSurface) return;
    lastSurface = next;
    chrome.runtime.sendMessage({ kind: 'PAP_SURFACE_CHANGED' }).catch(() => {});
  };
  new MutationObserver(changed).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  document.addEventListener('input', changed, true);
  document.addEventListener('change', changed, true);
}
addEventListener('pagehide', () => { if (activeRelease) activeRelease.invalid = true; });
document.addEventListener('visibilitychange', () => {
  if (activeRelease && document.visibilityState !== 'visible') activeRelease.invalid = true;
});

function exactSurface(message, editor, text) {
  const current = composers();
  return message.expectedUrl === location.href && message.destination === destination()
    && document.visibilityState === 'visible' && current.length === 1 && current[0] === editor
    && editor.isConnected && !editor.disabled && !editor.readOnly && textOf(editor) === text && !attachmentsPresent();
}

function sendControl() {
  const controls = document.querySelectorAll('button[data-testid="send-button"]');
  if (controls.length > 1) throw Error('ambiguous Send controls');
  const button = controls[0];
  if (!button || !button.isConnected || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true'
      || !button.getClientRects().length || getComputedStyle(button).visibility !== 'visible') return null;
  return button;
}

async function authorized(message, phase, expires) {
  let timer;
  try {
    const remaining = expires - performance.now();
    if (remaining <= 0) return false;
    return await Promise.race([
      chrome.runtime.sendMessage({ kind: 'PAP_CHECK_RELEASE', pageContract: PAGE_CONTRACT, attemptId: message.attemptId, phase }),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
    ]) === true && performance.now() < expires;
  } catch { return false; }
  finally { clearTimeout(timer); }
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.pageContract !== PAGE_CONTRACT) {
    respond({ surfaceSupported: false, destination: '', composerEmpty: false, attachmentsPresent: false });
    return;
  }
  if (message.kind === 'PAP_INSPECT') { respond(surface()); return; }
  if (message.kind !== 'PAP_RELEASE') return;
  const result = { attemptId: message.attemptId, textDigest: message.textDigest, exposure: 'NONE', submitted: false };
  if (attempts.has(message.attemptId)) { respond({ ...result, exposure: 'UNKNOWN' }); return; }
  if (activeRelease || typeof message.attemptId !== 'string' || !message.attemptId.length
      || message.attemptId.length > 128 || attempts.size >= 4096) { respond(result); return; }
  attempts.add(message.attemptId);
  const release = { invalid: false, expires: performance.now() + RELEASE_WINDOW_MS };
  activeRelease = release;
  Promise.resolve().then(async () => {
    const initial = surface();
    if (message.expectedUrl !== location.href || message.destination !== initial.destination
        || !initial.surfaceSupported || !initial.composerEmpty || initial.attachmentsPresent) return result;
    sendControl();
    const text = decodeExactText(message.textBytes), bytes = new TextEncoder().encode(text);
    if (!text.isWellFormed() || bytes.length > MAX_TEXT_BYTES || !/^[a-f0-9]{64}$/.test(message.textDigest ?? '')
        || await sha256Hex(bytes) !== message.textDigest) return result;
    if (!await authorized(message, 'inject', release.expires) || release.invalid) return result;
    const before = surface();
    if (message.expectedUrl !== location.href || message.destination !== before.destination
        || !before.surfaceSupported || !before.composerEmpty || before.attachmentsPresent) return result;
    const editor = composers()[0];
    if (!exactSurface(message, editor, '')) return result;
    sendControl();
    // Insertion may partially succeed before provider normalization or an input
    // handler fails. From this point, never report a safe no-exposure retry.
    result.exposure = 'DOM_INJECTED'; injectExactText(editor, text);
    const expires = Math.min(release.expires, performance.now() + SEND_SETTLE_MS);
    release.validate = () => {
      try { if (!exactSurface(message, editor, text)) release.invalid = true; sendControl(); }
      catch { release.invalid = true; }
    };
    while (performance.now() < expires) {
      release.validate();
      if (release.invalid) return result;
      const send = sendControl();
      if (send) {
        if (!await authorized(message, 'click', expires)) return result;
        release.validate();
        // No await separates these fresh checks from the one local click.
        if (release.invalid || performance.now() >= expires || sendControl() !== send) return result;
        send.click(); result.submitted = true; result.observation = 'LOCAL_CLICK_DISPATCHED'; return result;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, expires - performance.now())));
    }
    return result;
  }).catch(() => result).then(value => {
    if (activeRelease === release) activeRelease = undefined;
    respond(value);
  });
  return true;
});
