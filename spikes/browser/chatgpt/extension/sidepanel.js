import { SidePanelModel, recordingStatus } from './sidepanel-model.js';
import { requestPanel } from './sidepanel-channel.js';
const $ = id => document.getElementById(id);
const model = new SidePanelModel(requestPanel, render);
function render() {
  const state = model.state;
  const update = (id, key, value) => { if ($(id)[key] !== value) $(id)[key] = value; };
  update('recording', 'textContent', state?.recording ? 'Turn OFF' : 'Turn ON');
  update('recording', 'disabled', model.busy || !state?.available || Boolean(state?.captureUnavailableReason && !state.recording));
  update('connection', 'textContent', recordingStatus(state));
  update('error', 'textContent', model.error);
}
// A full navigation (not replaceState/hash) makes Chrome's sender URL and live
// runtime context share a fresh URL discriminator. The Port binds the requester.
// The transient marker prevents redirect loops and is consumed, so reload and
// restore also get a new URL.
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
  await model.refresh();
  setInterval(() => model.refresh(), 1000);
}
