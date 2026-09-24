const attention = {
  OUTCOME_UNKNOWN: { reason: 'This historical send has no confirmed delivery outcome.',
    nextAction: 'Check the conversation in ChatGPT and review the retained evidence. Do not resend automatically.' },
  FAILED_BEFORE_EGRESS: { reason: 'This historical attempt stopped before sending.',
    nextAction: 'Review the retained evidence and check the conversation before deciding whether to send a new prompt yourself.' },
};
export function promptHistory(receipts, operations, { attentionOnly = false, offset = 0 } = {}) {
  if (typeof attentionOnly !== 'boolean' || !Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid history filter');
  const rows = receipts.filter(value => value.prompt).map(receipt => {
    const operation = operations.find(value => value.result?.descriptorId === receipt.id);
    const prompt = receipt.prompt, destination = prompt.destination ?? null;
    const state = operation?.state ?? (prompt.outcome || (prompt.cancelled ? 'CANCELLED' : 'PROMPT_SAVED'));
    return { id: receipt.id, receiptId: receipt.id, savedAt: prompt.savedAt, mode: prompt.mode,
      conversation: destination?.startsWith('conversation:') ? destination : null,
      state, attention: Object.hasOwn(attention, state) ? attention[state] : null,
      localSave: 'SAVED', anchor: prompt.anchor };
  });
  const filtered = rows.filter(value => !attentionOnly || value.attention).reverse();
  offset = Math.min(offset, Math.max(0, Math.ceil(filtered.length / 200) - 1) * 200);
  return { counts: { prompts: rows.length, conversations: new Set(rows.map(value => value.conversation).filter(Boolean)).size,
    unassigned: rows.filter(value => !value.conversation).length,
    pendingAnchors: rows.filter(value => value.anchor === 'PENDING').length,
    needsAttention: rows.filter(value => value.attention).length },
    prompts: filtered.slice(offset, offset + 200), truncated: filtered.length > 200,
    page: { attentionOnly, offset, total: filtered.length },
    otherReceipts: receipts.filter(value => !value.prompt).map(({ id, title }) => ({ id, title })) };
}

export function integrationStatus(state, installation, connected) {
  const configured = installation.integration === 'ENABLED';
  const active = state.scopes.filter(scope => scope.effectiveRecording === 'ON');
  const unavailable = state.scopes.some(scope => scope.effectiveRecording === 'UNAVAILABLE');
  const code = !state.available ? 'ENGINE_UNAVAILABLE' : state.captureUnavailableReason === 'VAULT_CAPACITY_EXHAUSTED'
    ? 'VAULT_CAPACITY_EXHAUSTED' : !configured ? installation.integration === 'CONFLICT'
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

export async function dashboardState(runtime, filter = {}) {
  const installation = await runtime.maintenance?.status() ?? { integration: 'NOT_CONFIGURED', releaseClass: 'DEVELOPMENT' };
  const state = runtime.engine.state();
  const { attentionOnly = false, before = Number.MAX_SAFE_INTEGER, search = '' } = filter;
  if (typeof attentionOnly !== 'boolean') throw Error('Invalid history filter');
  const page = runtime.session.receipts.page({ attentionOnly, before, search, limit: 5 });
  const history = promptHistory(page.receipts, state.operations);
  history.counts = page.counts;
  history.page = { attentionOnly, before, next: page.next, search, total: attentionOnly ? page.counts.needsAttention : page.counts.prompts };
  history.truncated = page.next !== null;
  return { profile: 'pap-dashboard/2', runtimeEpoch: state.runtimeEpoch, revision: state.revision,
    adapterProfile: state.adapterProfile, available: state.available, recording: state.recording,
    captureUnavailableReason: state.captureUnavailableReason,
    ...(runtime.debugSession ? { debugSession: runtime.debugSession.status() } : {}),
    integration: integrationStatus(state, installation, runtime.browserState() !== null),
    history };
}
