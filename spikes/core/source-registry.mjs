const reject = code => { throw Object.assign(Error(code), { code }); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);

// Handles are local capabilities, never deserialized peer IDs. A replacement
// connection cannot inherit an old channel or its queued admissions.
export class SourceRegistry {
  #peers = new Set(); #listeners = new Set(); #primary; #controlProfile; #integrations;
  constructor(primary = null) {
    if (primary) this.#primary = this.attach({ integrationId: primary.integrationId, installationId: primary.installationId, boundary: primary });
  }
  get controlProfile() { return this.#controlProfile; }
  get capabilities() { return this.#primary?.boundary.capabilities ?? {}; }
  get primary() { return this.#primary; }
  configureIntegrations(integrations) {
    if (this.#integrations) reject('INTEGRATIONS_ALREADY_CONFIGURED');
    this.#integrations = integrations;
  }
  integrationStatus() { return this.#integrations?.status() ?? []; }
  setIntegrationEnabled(id, enabled) {
    if (!this.#integrations) reject('INTEGRATIONS_UNAVAILABLE');
    try { this.#integrations.setEnabled(id, enabled); }
    finally {
      for (const peer of this.#peers) if (peer.integrationId === id) peer.boundary.revoke();
    }
  }
  #available(peer) { return !this.#integrations || this.#integrations.available(peer.integrationId); }
  attach({ integrationId, installationId, boundary }) {
    if (!identifier(integrationId) || !identifier(installationId) || !boundary) reject('INVALID_SOURCE_REGISTRATION');
    if (this.#peers.size >= 8) reject('SOURCE_PEER_LIMIT');
    const peer = Object.freeze({ integrationId, installationId, boundary });
    this.#peers.add(peer);
    const unsubscribe = boundary.onChange(() => this.#changed());
    this.#subscriptions.set(peer, unsubscribe);
    this.#primary ??= peer;
    this.#controlProfile ??= boundary.controlProfile;
    this.#changed();
    return peer;
  }
  #subscriptions = new Map();
  detach(peer) {
    if (!this.#peers.delete(peer)) return;
    peer.boundary.revoke(); this.#subscriptions.get(peer)?.(); this.#subscriptions.delete(peer);
    if (this.#primary === peer) this.#primary = this.#peers.values().next().value;
    this.#changed();
  }
  #selected(peer) {
    const selected = peer ?? this.#primary;
    if (!this.#peers.has(selected)) reject('CAPTURE_NOT_ENABLED');
    return selected;
  }
  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #changed() { for (const listener of this.#listeners) listener(); }
  scopes(recording, unavailable) {
    return [...this.#peers].flatMap(peer => peer.boundary.scopes().map(source => ({ ...source,
      effectiveRecording: !recording || !this.#available(peer) ? 'OFF'
        : unavailable || !peer.boundary.offersCapture(source.scope) ? 'UNAVAILABLE' : 'ON' })));
  }
  policies(enabled, peer) {
    const peers = peer === undefined ? [...this.#peers] : [this.#selected(peer)];
    return peers.flatMap(selected => selected.boundary.policies(enabled && this.#available(selected)));
  }
  states(state, peer) {
    const peers = peer === undefined ? [...this.#peers] : [this.#selected(peer)];
    return peers.flatMap(selected => selected.boundary.states(this.#available(selected) ? state : 'OFF'));
  }
  prepare(input, options, peer) {
    const selected = this.#selected(peer), prepared = selected.boundary.prepare(input, options);
    if (!this.#available(selected)) reject('CAPTURE_NOT_ENABLED');
    return { ...prepared, peer: selected, boundary: selected.boundary,
      generation: this.#integrations?.generation(selected.integrationId) };
  }
  accept(admission) {
    this.#selected(admission.peer);
    if (!this.#available(admission.peer)
        || admission.generation !== this.#integrations?.generation(admission.peer.integrationId)) reject('CAPTURE_NOT_ENABLED');
    admission.boundary.accept(admission);
  }
  receipt(input, session, peer) { return this.#selected(peer).boundary.receipt(input, session); }
  revoke() { this.#integrations?.revoke(); for (const { boundary } of this.#peers) boundary.revoke(); }
}
