import { SidePanelModel } from './sidepanel-model.js';
const $ = id => document.getElementById(id);
const model = new SidePanelModel(message => chrome.runtime.sendMessage(message), render);
function render() {
  const state = model.state;
  $('recording').textContent = state?.recording ? 'Turn OFF' : 'Turn ON';
  $('recording').disabled = model.busy || !state?.available;
  $('connection').textContent = !state?.available ? 'Recording unavailable' : !state.recording ? 'Attestamp is OFF'
    : state.unavailableSources ? 'ON · Some supported tabs are unavailable'
      : state.readySources ? `ON · Ready in ${state.readySources} supported tabs` : 'ON · Waiting for supported ChatGPT tabs';
  $('error').textContent = model.error;
}
$('recording').addEventListener('click', () => model.toggle());
$('dashboard').addEventListener('click', () => model.dashboard());
$('refresh').addEventListener('click', () => model.refresh());
await model.refresh();
setInterval(() => model.refresh(), 1000);
