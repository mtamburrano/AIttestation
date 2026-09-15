import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ENGINE_COMMAND_PROFILE } from './engine.mjs';
import { integrationStatus } from './dashboard.mjs';

const commandProfile = 'pap-desktop-command/2', eventProfile = 'pap-desktop-event/2';
const limit = 16 * 1024;
const fields = { REFRESH: [], OPEN: ['section'], RECORDING: ['runtimeEpoch', 'revision', 'enabled'], QUIT: [] };

// These pipes are inherited only by the fixed signed runtime. No bearer, URL,
// prompt, raw digest or key crosses the resident menu's control/status channel.
export function startDesktopChannel(runtime, { requestFD, responseFD, input, output, onExit }) {
  input ??= new Socket({ fd: requestFD, readable: true, writable: false });
  output ??= new Socket({ fd: responseFD, readable: false, writable: true });
  let bytes = Buffer.alloc(0), closed = false, refreshing = false, pending = 0, tail = Promise.resolve();
  const close = () => { if (closed) return; closed = true; clearInterval(timer); input.destroy(); output.destroy(); };
  const fail = () => { close(); void onExit(); };
  async function refresh(actionFailed = false) {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const installation = await runtime.maintenance?.status() ?? { integration: 'NOT_CONFIGURED' };
      const state = runtime.engine.state(), integration = integrationStatus(state, installation, runtime.browserState() !== null);
      const event = { profile: eventProfile, runtimeEpoch: state.runtimeEpoch, revision: state.revision,
        recording: state.recording,
        available: state.available, code: actionFailed ? 'ACTION_FAILED' : integration.code,
        readySources: state.scopes.filter(value => value.effectiveRecording === 'ON').length,
        unavailableSources: state.scopes.filter(value => value.effectiveRecording === 'UNAVAILABLE').length };
      const body = Buffer.from(JSON.stringify(event)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
      if (body.length > limit || output.writableLength > limit) throw Error('DESKTOP_CHANNEL_LIMIT');
      if (!closed) output.write(Buffer.concat([prefix, body]));
    } finally { refreshing = false; }
  }
  async function command(value) {
    if (!value || value.profile !== commandProfile || !Object.hasOwn(fields, value.kind)
        || Object.keys(value).sort().join(',') !== ['profile', 'kind', ...fields[value.kind]].sort().join(',')) {
      throw Error('INVALID_DESKTOP_COMMAND');
    }
    if (value.kind === 'QUIT') { close(); await onExit(); return; }
    if (value.kind === 'OPEN') {
      if (!['history', 'integrations', 'settings', 'verifier'].includes(value.section)) throw Error('INVALID_DESKTOP_SECTION');
      if (value.section === 'verifier') await runtime.openVerifier();
      else await runtime.openDashboard(value.section);
    }
    if (value.kind === 'RECORDING') {
      const state = runtime.engine.state();
      await runtime.engine.command({ profile: ENGINE_COMMAND_PROFILE, adapterProfile: state.adapterProfile,
        runtimeEpoch: value.runtimeEpoch, expectedRevision: value.revision, commandId: randomUUID(),
        kind: 'SET_RECORDING', enabled: value.enabled }, { surface: 'desktop' });
    }
    await refresh();
  }
  input.on('data', chunk => {
    try {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > limit + 4) throw Error('DESKTOP_CHANNEL_LIMIT');
      while (bytes.length >= 4) {
        const size = bytes.readUInt32BE(0);
        if (size === 0 || size > limit) throw Error('DESKTOP_CHANNEL_LIMIT');
        if (bytes.length < size + 4) break;
        if (++pending > 8) throw Error('DESKTOP_CHANNEL_LIMIT');
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, size + 4)));
        bytes = bytes.subarray(size + 4);
        tail = tail.then(() => { if (!closed) return command(value); })
          .catch(() => refresh(true)).catch(fail).finally(() => { pending--; });
      }
    } catch { fail(); }
  });
  input.once('end', fail); input.on('error', fail); output.on('error', fail);
  const timer = setInterval(() => { void refresh().catch(fail); }, 2000);
  void refresh().catch(fail);
  return { close };
}
