const attention = new Set(['OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS', 'INTERRUPTED', 'NEEDS_ATTENTION']);

export function promptHistory(receipts, operations) {
  const rows = receipts.filter(value => value.prompt).map(receipt => {
    const operation = operations.find(value => value.result?.descriptorId === receipt.id);
    const prompt = receipt.prompt;
    const destination = prompt.destination ?? operation?.target.destination ?? null;
    return { id: receipt.id, receiptId: receipt.id, savedAt: prompt.savedAt, mode: prompt.mode,
      conversation: destination?.startsWith('conversation:') ? destination : null,
      state: operation?.state ?? (prompt.outcome || (prompt.cancelled ? 'CANCELLED' : 'PROMPT_SAVED')),
      localSave: 'SAVED', anchor: prompt.anchor,
      operationId: operation?.id ?? null,
      cancellable: Boolean(operation && !operation.stopped && !operation.restored && !operation.observation
        && operation.result?.actions.cancel),
    };
  });
  for (const operation of operations.filter(value => !value.result?.descriptorId)) rows.push({
    id: operation.id, receiptId: null, savedAt: null, mode: operation.mode,
    conversation: operation.target?.destination?.startsWith('conversation:') ? operation.target.destination : null,
    state: operation.state, localSave: 'NOT_SAVED', anchor: 'PENDING', operationId: operation.id,
    cancellable: !operation.stopped && !operation.restored && !operation.settled,
  });
  return { counts: { prompts: rows.length, conversations: new Set(rows.map(value => value.conversation).filter(Boolean)).size,
    unassigned: rows.filter(value => !value.conversation).length,
    pendingAnchors: rows.filter(value => value.localSave === 'SAVED' && value.anchor === 'PENDING').length,
    needsAttention: rows.filter(value => attention.has(value.state)).length },
  prompts: rows.slice(-200).reverse(), truncated: rows.length > 200,
  otherReceipts: receipts.filter(value => !value.prompt).map(({ id, title }) => ({ id, title })) };
}

// Installation is a configuration observation, never evidence of capture health.
// Only this adapter's negotiated connection and current scopes establish readiness.
export function integrationStatus(state, installation, connected) {
  const configured = installation.integration === 'ENABLED';
  const supported = scope => scope.effectiveMode === 'Continuous' ? state.capabilities.observation === true
    : scope.effectiveMode === 'Sealed' && state.capabilities.privilegedPanel === true;
  const active = state.scopes.filter(supported);
  const unavailable = state.scopes.some(scope => scope.effectiveMode === 'Unavailable'
    || ['Continuous', 'Sealed'].includes(scope.effectiveMode) && !supported(scope));
  const code = !state.available ? 'ENGINE_UNAVAILABLE' : !configured ? installation.integration === 'CONFLICT'
    ? 'CONFIGURATION_CONFLICT' : 'DISABLED' : state.preferences.paused ? 'PAUSED'
      : !connected ? 'DISCONNECTED' : unavailable ? 'COVERAGE_UNAVAILABLE'
        : active.length ? 'SCOPES_READY' : state.scopes.length ? 'OFF' : 'SELECT_CONVERSATION';
  return { id: 'chrome-chatgpt', installation: connected ? 'DETECTED' : 'NOT_VERIFIED',
    supported: 'Mac + Chrome Stable + ChatGPT text', configured,
    configuration: installation.integration, connected, code,
    healthy: code === 'SCOPES_READY', readyScopes: active.length,
    capabilities: { continuous: connected && state.capabilities.observation === true,
      sealedPanel: connected && state.capabilities.privilegedPanel === true },
    releaseClass: installation.releaseClass, manageable: installation.integration !== 'NOT_CONFIGURED',
    storeAvailable: Boolean(installation.storeURL), updatesAvailable: installation.releaseChannel === 'production' };
}

export async function dashboardState(runtime) {
  const installation = await runtime.maintenance?.status() ?? { integration: 'NOT_CONFIGURED', releaseClass: 'DEVELOPMENT' };
  const state = runtime.engine.state();
  return { profile: 'pap-dashboard/1', runtimeEpoch: state.runtimeEpoch, revision: state.revision,
    adapterProfile: state.adapterProfile, available: state.available, preferences: state.preferences,
    ...(runtime.debugSession ? { debugSession: runtime.debugSession.status() } : {}),
    integration: integrationStatus(state, installation, runtime.browserState() !== null),
    scopes: state.scopes.map(({ scope, tabId, windowId, destination, requestedMode, effectiveMode, reason }) =>
      ({ scope, tabId, windowId, destination, requestedMode, effectiveMode, reason })),
    history: promptHistory(runtime.session.receipts.list(), state.operations) };
}
