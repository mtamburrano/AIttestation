export function promptHistory(receipts, operations) {
  const rows = receipts.filter(value => value.prompt).map(receipt => {
    const operation = operations.find(value => value.result?.descriptorId === receipt.id);
    const prompt = receipt.prompt, destination = prompt.destination ?? null;
    return { id: receipt.id, receiptId: receipt.id, savedAt: prompt.savedAt, mode: prompt.mode,
      conversation: destination?.startsWith('conversation:') ? destination : null,
      state: operation?.state ?? (prompt.outcome || (prompt.cancelled ? 'CANCELLED' : 'PROMPT_SAVED')),
      localSave: 'SAVED', anchor: prompt.anchor };
  });
  return { counts: { prompts: rows.length, conversations: new Set(rows.map(value => value.conversation).filter(Boolean)).size,
    unassigned: rows.filter(value => !value.conversation).length,
    pendingAnchors: rows.filter(value => value.anchor === 'PENDING').length,
    needsAttention: rows.filter(value => ['OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS'].includes(value.state)).length },
    prompts: rows.slice(-200).reverse(), truncated: rows.length > 200,
    otherReceipts: receipts.filter(value => !value.prompt).map(({ id, title }) => ({ id, title })) };
}

export function integrationStatus(state, installation, connected) {
  const configured = installation.integration === 'ENABLED';
  const active = state.scopes.filter(scope => scope.effectiveRecording === 'ON');
  const unavailable = state.scopes.some(scope => scope.effectiveRecording === 'UNAVAILABLE');
  const code = !state.available ? 'ENGINE_UNAVAILABLE' : !configured ? installation.integration === 'CONFLICT'
    ? 'CONFIGURATION_CONFLICT' : 'DISABLED' : !state.recording ? 'OFF' : !connected ? 'DISCONNECTED'
      : unavailable ? 'COVERAGE_UNAVAILABLE' : active.length ? 'SOURCES_READY' : 'WAITING_FOR_TABS';
  return { id: 'chrome-chatgpt', installation: connected ? 'DETECTED' : 'NOT_VERIFIED',
    supported: 'Mac + Chrome Stable + ChatGPT text', configured,
    configuration: installation.integration, connected, code,
    healthy: code === 'SOURCES_READY', readySources: active.length,
    capabilities: { observation: connected && state.capabilities.observation === true },
    releaseClass: installation.releaseClass, manageable: installation.integration !== 'NOT_CONFIGURED',
    storeAvailable: Boolean(installation.storeURL), updatesAvailable: installation.releaseChannel === 'production' };
}

export async function dashboardState(runtime) {
  const installation = await runtime.maintenance?.status() ?? { integration: 'NOT_CONFIGURED', releaseClass: 'DEVELOPMENT' };
  const state = runtime.engine.state();
  return { profile: 'pap-dashboard/2', runtimeEpoch: state.runtimeEpoch, revision: state.revision,
    adapterProfile: state.adapterProfile, available: state.available, recording: state.recording,
    ...(runtime.debugSession ? { debugSession: runtime.debugSession.status() } : {}),
    integration: integrationStatus(state, installation, runtime.browserState() !== null),
    history: promptHistory(runtime.session.receipts.list(), state.operations) };
}
