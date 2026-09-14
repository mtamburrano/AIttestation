import { SidePanelModel, targetKey, targetLabel, operationMessage } from './sidepanel-model.js';
const $ = id => document.getElementById(id);
const model = new SidePanelModel(message => chrome.runtime.sendMessage(message), render);
let optionSignature = '', refreshPending = false;
function render() {
  const state = model.state, target = model.target, scope = model.scope, draft = model.draft;
  $('connection').textContent = state?.available ? state.paused ? 'All protection paused' : 'Connected to Attestamp' : 'Attestamp unavailable';
  const targets = state?.targets ?? [], signature = JSON.stringify(targets.map(value => [targetKey(value), value.eligible]));
  if (signature !== optionSignature) {
    optionSignature = signature;
    $('target').replaceChildren(new Option('Choose a ChatGPT tab', ''), ...targets.map(value => new Option(targetLabel(value), targetKey(value))));
  }
  $('target').value = target ? targetKey(target) : '';
  $('target').disabled = model.busy || !state?.available;
  $('draft').disabled = !target || !scope;
  if ($('draft').value !== (draft?.text ?? '')) $('draft').value = draft?.text ?? '';
  $('target-note').textContent = !target ? 'Choose the current ChatGPT conversation. Navigation requires a new selection.'
    : target.attachmentsPresent ? 'Attachments are unsupported. Remove them in ChatGPT before protecting a text prompt.'
    : !target.composerEmpty ? 'ChatGPT already has a visible draft. Clear it there before starting another protected prompt. Text entered directly there bypasses Sealed admission.'
    : !target.surfaceSupported ? 'This ChatGPT surface is unsupported. No protected send is available.'
    : !target.active ? 'Activate this selected tab before submitting. Pending sends never move to another tab.'
    : `Pinned destination: ${targetLabel(target)}.`;
  $('mode').disabled = model.busy || !scope || !state?.available;
  $('mode').value = scope?.requestedMode ?? '';
  $('effective').textContent = scope ? `Requested: ${scope.requestedMode}. Effective now: ${scope.effectiveMode}.`
    + (target?.destination === 'new-chat' ? ' New-chat preferences last only for this current tab.' : '')
    : 'Select a conversation to see its effective mode.';
  $('pause').textContent = state?.paused ? 'Resume protection for new prompts' : 'Pause all protection';
  $('pause').disabled = model.busy || !state?.available;
  $('send').disabled = !model.canSend;
  $('new-draft').disabled = model.busy || !draft || model.pending;
  $('dashboard').disabled = model.busy;
  $('error').textContent = model.error;
  $('draft-note').textContent = draft?.submission ? 'The submitted version is fixed. Edits here do not change it. Start a new prompt for another explicit send.'
    : 'Drafts stay in this panel until you choose Protect and send. Closing the panel discards unsent drafts.';
  const operations = state?.operations.slice().reverse() ?? [];
  $('operations').replaceChildren(...operations.map(operation => {
    const card = document.createElement('article'); card.className = 'operation';
    const label = document.createElement('p'); label.className = 'hint';
    label.textContent = `${targetLabel(operation)} · version ${operation.editRevision}`;
    const status = document.createElement('p'); status.textContent = operationMessage(operation);
    card.append(label, status);
    if (operation.cancellable) {
      const cancel = document.createElement('button'); cancel.className = 'link'; cancel.textContent = 'Cancel this operation';
      cancel.disabled = model.busy || !state.available; cancel.addEventListener('click', () => model.cancel(operation.id)); card.append(cancel);
    }
    return card;
  }));
  if (!operations.length) $('operations').textContent = 'No recent protected prompts.';
}
$('target').addEventListener('change', () => model.select($('target').value));
$('draft').addEventListener('input', () => model.edit($('draft').value));
$('mode').addEventListener('change', () => model.mode($('mode').value || null));
$('pause').addEventListener('click', () => model.pause());
$('send').addEventListener('click', () => model.send());
$('new-draft').addEventListener('click', () => model.newDraft());
$('dashboard').addEventListener('click', () => model.dashboard());
async function refresh() {
  if (refreshPending || model.busy) return;
  refreshPending = true;
  try { await model.refresh(); } finally { refreshPending = false; }
}
$('refresh').addEventListener('click', refresh);
await refresh();
setInterval(refresh, 1000);
