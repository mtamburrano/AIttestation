// One request per document-owned Port. No retry: a lost command reply does not
// establish whether the engine applied it. The model can explicitly refresh.
export function requestPanel(message, runtime = chrome.runtime) {
  return new Promise(resolve => {
    let port, timer, settled = false, confirmed = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { port?.disconnect(); } catch {}
      resolve(result);
    };
    try {
      port = runtime.connect({ name: 'pap-chatgpt-panel-channel/1' });
      timer = setTimeout(() => finish({ error: 'PANEL_REQUEST_UNCONFIRMED' }), 20_000);
      port.onDisconnect.addListener(() => {
        void runtime.lastError; finish({ error: 'UNTRUSTED_PANEL' });
      });
      port.onMessage.addListener(reply => {
        if (reply?.kind === 'PAP_PANEL_CHALLENGE' && !confirmed
            && typeof reply.nonce === 'string' && /^[a-f0-9-]{36}$/.test(reply.nonce)
            && Object.keys(reply).sort().join(',') === 'kind,nonce') {
          confirmed = true;
          try { port.postMessage({ kind: 'PAP_PANEL_CONFIRM', nonce: reply.nonce }); }
          catch { finish({ error: 'UNTRUSTED_PANEL' }); }
        } else if (reply?.kind === 'PAP_PANEL_REPLY') finish(reply.result);
        else finish({ error: 'PANEL_REQUEST_UNCONFIRMED' });
      });
      port.postMessage(message);
    } catch { finish({ error: 'UNTRUSTED_PANEL' }); }
  });
}
