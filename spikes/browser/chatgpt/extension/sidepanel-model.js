export const PANEL_PROFILE = 'pap-chatgpt-panel/1';
const targetFields = ['adapterId', 'adapterEpoch', 'tabId', 'windowId', 'tabEpoch', 'destination'];
export const targetKey = target => targetFields.map(key => target[key]).join('|');
export const targetLabel = target => `Window ${target.windowId} · Tab ${target.tabId} · ${target.destination === 'new-chat'
  ? 'New chat' : target.destination.replace(/^conversation:/, '')}`;
export function operationMessage(operation) {
  if (operation.state === 'OUTCOME_UNKNOWN') return 'Send outcome unknown. Check ChatGPT; do not retry this prompt automatically.';
  if (operation.state === 'SUBMISSION_OBSERVED') return 'Send click observed. Provider receipt is unknown. Evidence is saved locally.';
  if (operation.state === 'CANCELLED') return 'Cancelled. Evidence remains available; published anchors or provider copies are not erased.';
  if (operation.restored || operation.stopped) return 'Interrupted. Old send authority has ended. Evidence remains available.';
  if (operation.state === 'FAILED_BEFORE_EGRESS') return 'Not sent. Restore the selected tab, then start a new prompt explicitly.';
  if (operation.service) return ({
    NOT_CONFIGURED: 'Not sent. Anchoring is not configured. Open the dashboard for setup.',
    ACCOUNT_REQUIRED: 'Not sent. Connect your anchoring account in the dashboard.',
    UNPAID: 'Not sent. Check your anchoring account in the dashboard.',
    QUOTA_EXHAUSTED: 'Not sent. Your anchoring allowance is used up. Cancel and wait for the allowance to reset.',
    RATE_LIMITED: 'Not sent. Anchoring is busy. Cancel and try a new prompt later.',
    SERVICE_UNAVAILABLE: 'Not sent. Anchoring is unavailable. Cancel and try a new prompt later.',
    SUBMISSION_INTERRUPTED: 'Not sent. Anchoring was interrupted. Cancel before starting a new prompt.',
  })[operation.service];
  if (operation.settled) return 'Not sent. Confirmation did not finish. Cancel this operation before starting a new prompt.';
  return 'Protecting the submitted version. Waiting for validated confirmation before sending.';
}
const errorMessages = {
  STALE_ENGINE_REVISION: 'State changed. Refresh and choose your action again.',
  STALE_RUNTIME_EPOCH: 'Attestamp restarted. Select the current conversation again; old sends cannot resume.',
  OPERATION_IN_PROGRESS: 'This conversation already has a pending protected prompt.',
  PROTECTION_PAUSED: 'Protection is paused or Off. Change the setting before submitting a new prompt.',
  UNTRUSTED_PANEL: 'Open Attestamp using its Chrome toolbar button.',
  PANEL_UNAVAILABLE: 'Open Attestamp on your Mac and check the Chrome integration in its dashboard.',
  PANEL_DISCONNECTED: 'Connection lost. Refresh operation status before taking another action.',
  PANEL_REQUEST_UNCONFIRMED: 'Delivery unconfirmed. Refresh operation status; do not submit the same prompt again.',
};

// Drafts and selections live only in this view. Commands are immutable; only
// the resident engine stores preferences and advances admitted operations.
export class SidePanelModel {
  state = null; selected = null; busy = false; error = ''; drafts = new Map();
  constructor(transport, changed = () => {}) { this.transport = transport; this.changed = changed; }
  get target() { return this.state?.targets.find(value => this.selected && targetKey(value) === targetKey(this.selected)); }
  get scope() { return this.state?.scopes.find(value => this.target && value.tabId === this.target.tabId
    && value.tabEpoch === this.target.tabEpoch && value.adapterEpoch === this.target.adapterEpoch
    && value.windowId === this.target.windowId && value.destination === this.target.destination); }
  get draft() { return this.selected ? this.drafts.get(targetKey(this.selected)) : null; }
  get pending() { return this.state?.operations.some(value => value.scope === this.scope?.scope
    && !value.stopped && !value.restored && (!value.settled || value.cancellable)); }
  get canSend() {
    const text = this.draft?.text;
    return Boolean(!this.busy && this.state?.available && !this.state.paused && this.scope
      && this.scope.requestedMode !== 'Off' && this.target?.sealedEligible && !this.pending && !this.draft.submission
      && text?.length && text.isWellFormed() && new TextEncoder().encode(text).length <= 256 * 1024);
  }
  accept(state) {
    if (!state || state.profile !== PANEL_PROFILE) return;
    if (this.state?.runtimeEpoch === state.runtimeEpoch && state.revision < this.state.revision) return;
    if (this.state && this.state.runtimeEpoch !== state.runtimeEpoch) this.selected = null;
    this.state = state;
  }
  async request(action, command) {
    const result = await this.transport({ kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, action, ...(command ? { command } : {}) });
    if (!result || result.error) throw Object.assign(Error('Panel request failed'), { code: result?.error ?? 'PANEL_REQUEST_UNCONFIRMED' });
    this.accept(result.state); return result;
  }
  envelope(kind, data) {
    return { profile: 'pap-resident-command/1', runtimeEpoch: this.state.runtimeEpoch, adapterProfile: this.state.adapterProfile,
      commandId: crypto.randomUUID(), expectedRevision: this.state.revision, kind, ...data };
  }
  async act(work) {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.changed();
    try { return await work(); }
    catch (error) { this.error = errorMessages[error.code] ?? 'Action unavailable. Refresh, check the selected conversation and review its operation status.'; }
    finally { this.busy = false; this.changed(); }
  }
  async refresh() {
    try { await this.request('STATE'); }
    catch (error) { if (this.state) this.state.available = false;
      this.error = errorMessages[error.code] ?? 'Attestamp is unavailable. Check the Mac app and refresh.'; }
    this.changed();
  }
  async select(key) {
    return this.act(async () => {
      await this.request('STATE');
      const target = this.state?.targets.find(value => targetKey(value) === key);
      this.selected = target ? Object.fromEntries(targetFields.map(field => [field, target[field]])) : null;
      if (!target) return;
      if (!this.drafts.has(key)) this.drafts.set(key, { text: '', revision: this.scope?.editRevision ?? 0, submission: null });
      if (!this.scope) {
        try { await this.request('COMMAND', this.envelope('ENROLL_SCOPE', { target: this.selected })); }
        catch (error) { this.selected = null; throw error; }
      }
    });
  }
  edit(text) { if (!this.draft) return; this.draft.text = text; this.draft.revision++; this.changed(); }
  newDraft() { if (!this.draft) return; this.draft.text = ''; this.draft.revision++; this.draft.submission = null; this.error = ''; this.changed(); }
  async send() {
    if (!this.canSend) return;
    return this.act(async () => {
      const draft = this.draft;
      const command = this.envelope('PROTECT_AND_SEND', { scope: this.scope.scope, operationId: crypto.randomUUID(),
        text: draft.text, editRevision: Math.max(draft.revision, this.scope.editRevision + 1) });
      // Retain the attempted identity even on a lost acknowledgment. Neither
      // polling, reopening nor reconnecting may manufacture another command.
      draft.submission = { id: command.operationId, editRevision: command.editRevision };
      await this.request('COMMAND', command);
    });
  }
  async mode(mode) { if (!this.scope) return; return this.act(() => this.request('COMMAND',
    this.envelope('SET_CONVERSATION_MODE', { scope: this.scope.scope, mode }))); }
  async pause() { return this.act(() => this.request('COMMAND', this.envelope('SET_PAUSE', { paused: !this.state.paused }))); }
  async cancel(operationId) { return this.act(() => this.request('COMMAND', this.envelope('CANCEL_OPERATION', { operationId }))); }
  async dashboard() { return this.act(() => this.request('OPEN_DASHBOARD')); }
}
