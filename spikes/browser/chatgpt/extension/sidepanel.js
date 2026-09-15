import { SidePanelModel, recordingStatus } from './sidepanel-model.js';
const $ = id => document.getElementById(id);
const model = new SidePanelModel(message => chrome.runtime.sendMessage(message), render);
function render() {
  const state = model.state;
  $('recording').textContent = state?.recording ? 'Turn OFF' : 'Turn ON';
  $('recording').disabled = model.busy || !state?.available;
  $('connection').textContent = recordingStatus(state);
  $('error').textContent = model.error;
}
// A full navigation (not replaceState/hash) makes Chrome's sender URL and live
// runtime context share one fresh document identity. The transient marker avoids
// a redirect loop and is consumed, so reload/restore also gets a new identity.
function identifyDocument() {
  const key = 'attestamp-panel-navigation';
  try {
    const expected = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (/^[a-f0-9-]{36}$/.test(expected ?? '')
        && location.href === chrome.runtime.getURL(`sidepanel.html?view=${expected}`)) return true;
    const next = crypto.randomUUID();
    sessionStorage.setItem(key, next);
    location.replace(chrome.runtime.getURL(`sidepanel.html?view=${next}`));
  } catch {
    model.error = 'Recording control could not be verified. Close and reopen this sidebar.';
    render();
  }
  return false;
}
if (identifyDocument()) {
  $('recording').addEventListener('click', () => model.toggle());
  $('dashboard').addEventListener('click', () => model.dashboard());
  $('refresh').addEventListener('click', () => model.refresh());
  await model.refresh();
  setInterval(() => model.refresh(), 1000);
}
