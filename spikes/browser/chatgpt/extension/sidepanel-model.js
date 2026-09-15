const PROFILE = 'pap-chatgpt-panel/2';
export class SidePanelModel {
  state = null; busy = false; error = '';
  constructor(send, render = () => {}) { this.transport = send; this.render = render; }
  async request(action, command) {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.render();
    try {
      const result = await this.transport({ kind: 'PAP_PANEL_REQUEST', profile: PROFILE, action, ...(command ? { command } : {}) });
      if (result?.error || action !== 'OPEN_DASHBOARD' && result?.state?.profile !== PROFILE) throw Error('unavailable');
      if (result.state) this.state = result.state;
    } catch { this.state = null; this.error = 'Recording control is unavailable. Open Attestamp and refresh.'; }
    finally { this.busy = false; this.render(); }
  }
  refresh() { return this.request('STATE'); }
  toggle() {
    if (!this.state?.available || this.busy) return;
    return this.request('COMMAND', { profile: 'pap-resident-command/2', kind: 'SET_RECORDING',
      adapterProfile: this.state.adapterProfile, runtimeEpoch: this.state.runtimeEpoch,
      commandId: crypto.randomUUID(), expectedRevision: this.state.revision, enabled: !this.state.recording });
  }
  dashboard() { return this.request('OPEN_DASHBOARD'); }
}
