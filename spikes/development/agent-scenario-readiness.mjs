// Passive readiness evidence only: no response bodies, cookie values, challenge
// tokens, dynamic paths or provider requests originate from this observer.
function category(value, mainFrameId) {
  try {
    const url = new URL(value.request?.url);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (value.type === 'Document' && value.frameId === mainFrameId) return 'document';
    if (url.origin === 'https://challenges.cloudflare.com'
        || url.origin === 'https://chatgpt.com' && url.pathname.startsWith('/cdn-cgi/challenge-platform/')) return 'challenge';
    if (url.origin !== 'https://chatgpt.com') return null;
    if (url.pathname === '/api/auth/session') return 'session';
    if (/^\/backend-api\/sentinel\/chat-requirements(?:\/(?:prepare|finalize))?$/.test(url.pathname)) return 'admission';
    if (/^\/backend-api\/(?:f\/)?conversation\/prepare$/.test(url.pathname)) return 'conversation-prepare';
    if (value.request.method === 'GET' && url.pathname.startsWith('/backend-api/')) return 'bootstrap';
  } catch {}
  return null;
}

const contentKinds = new Map([['application/json', 'json'], ['text/html', 'html'], ['text/event-stream', 'event-stream']]);
export function scenarioResponse(response) {
  return {
    status: Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
    challenge: Object.entries(response?.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'cf-mitigated' && value === 'challenge'),
    contentKind: contentKinds.get(response?.mimeType) ?? 'other',
  };
}

export function scenarioUI(value) {
  return Object.fromEntries([
    ...['provider', 'composer', 'empty', 'active', 'send', 'visible', 'focused', 'challenge'].map(key => [key, value?.[key] === true]),
    ['route', ['new', 'conversation'].includes(value?.route) ? value.route : 'other'],
    ['document', ['loading', 'interactive', 'complete'].includes(value?.document) ? value.document : 'unknown'],
    ['controls', Array.isArray(value?.controls) ? value.controls.slice(0, 16).map(control => ({
      kind: ['send', 'queue', 'stop', 'steer'].includes(control?.kind) ? control.kind : 'other',
      type: ['button', 'submit'].includes(control?.type) ? control.type : 'other',
      ...Object.fromEntries(['disabled', 'labeled', 'sendId', 'stopId', 'submitId'].map(key => [key, control?.[key] === true])),
    })) : []],
  ]);
}

export function scenarioReadiness({ add, now, mainFrameId }) {
  const requests = new Map(), pending = new Set(), latest = new Map();
  let sequence = 0, lastActivity = now(), stableSince = null, lastUI, interstitial = false, dialog = false;
  const touch = () => { lastActivity = now(); stableSince = null; };
  return {
    event({ method, params: value }) {
      if (method === 'Network.requestWillBeSent') {
        const kind = category(value, mainFrameId());
        if (!kind) return;
        if (requests.size >= 96 && !requests.has(value.requestId)) throw Error('AGENT_SCENARIO_TRACE_LIMIT');
        const entry = { networkSequence: ++sequence, category: kind, state: 'pending', status: null, challenge: false };
        requests.set(value.requestId, entry); latest.set(kind, entry); pending.add(value.requestId); touch();
        add({ event: 'readiness-request', networkSequence: entry.networkSequence, category: kind,
          method: ['GET', 'POST', 'OPTIONS'].includes(value.request.method) ? value.request.method : 'OTHER' });
        if (value.redirectResponse) add({ event: 'readiness-redirect', category: kind, ...scenarioResponse(value.redirectResponse) });
      } else if (method === 'Network.responseReceived' && requests.has(value?.requestId)) {
        const entry = requests.get(value.requestId);
        Object.assign(entry, scenarioResponse(value.response)); touch();
        add({ event: 'readiness-response', networkSequence: entry.networkSequence, category: entry.category,
          status: entry.status, challenge: entry.challenge, contentKind: entry.contentKind });
      } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(method) && requests.has(value?.requestId)) {
        const entry = requests.get(value.requestId);
        entry.state = method === 'Network.loadingFinished' && entry.status >= 200 && entry.status < 400 && !entry.challenge ? 'settled' : 'failed';
        pending.delete(value.requestId); touch();
        add({ event: 'readiness-complete', networkSequence: entry.networkSequence, category: entry.category, state: entry.state });
      } else if (['Page.interstitialShown', 'Page.interstitialHidden', 'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed'].includes(method)) {
        if (method.startsWith('Page.interstitial')) interstitial = method === 'Page.interstitialShown';
        else dialog = method === 'Page.javascriptDialogOpening';
        touch(); add({ event: 'page-admission', interstitial, dialog });
      }
    },
    observe(ui) {
      const serialized = JSON.stringify(ui);
      if (serialized !== lastUI) { touch(); lastUI = serialized; add({ event: 'page-state', ...ui }); }
    },
    settled(ui) {
      this.observe(ui);
      const normal = ui.provider && ui.route === 'new' && ui.composer && !ui.active
        && ui.document === 'complete' && ui.visible && ui.focused && !ui.challenge && !interstitial && !dialog;
      const networkReady = latest.get('document')?.state === 'settled' && !pending.size
        && [...latest.values()].every(entry => entry.state === 'settled');
      if (!normal || !networkReady) { stableSince = null; return false; }
      stableSince ??= now();
      return now() - Math.max(stableSince, lastActivity) >= 5000;
    },
    snapshot() {
      return { pending: pending.size, interstitial, dialog,
        states: Object.fromEntries(['document', 'session', 'bootstrap', 'challenge', 'admission', 'conversation-prepare']
          .map(kind => [kind, latest.get(kind)?.state ?? 'not-observed'])) };
    },
  };
}
