import { RecordingEngine } from './recording-engine.mjs';
import { RecordingSession } from './recording-session.mjs';
import { IntegrationRegistry } from './integration-registry.mjs';

// Platform ownership is acquired before opening state. Browser and coding
// transports share this lifetime and can never close it by disconnecting.
export async function startRecordingCore({ directory, sources, runtimeEpoch, platform, diagnostics, integrations, ...sessionOptions }) {
  if (!platform || typeof platform.lock !== 'function' || typeof platform.stateStore !== 'function') {
    throw Error('EXPLICIT_PLATFORM_SERVICES_REQUIRED');
  }
  const unlock = platform.lock(directory);
  let session, engine, closing;
  try {
    session = await new RecordingSession(directory, { ...sessionOptions, diagnostics }).init();
    if (integrations) sources.configureIntegrations(new IntegrationRegistry(session.vault, integrations));
    engine = await new RecordingEngine({ session, sources, runtimeEpoch, diagnostics,
      stateStore: platform.stateStore(directory, session.vault) }).init();
    return { session, engine, close: () => closing ??= (async () => {
      engine.stop();
      try { await engine.drain(); await session.drain(); }
      finally { try { session.close(); } finally { unlock(); } }
    })() };
  } catch (error) {
    engine?.stop();
    try { session?.close(); } finally { unlock(); }
    throw error;
  }
}
