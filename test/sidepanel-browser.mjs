import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { runNativeHost, NativeFrameDecoder, encodeNativeFrame } from '../spikes/browser/chatgpt/native-host.mjs';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { startDesktopChannel } from '../spikes/browser/chatgpt/desktop-channel.mjs';

// Real Chrome contexts/UI, synthetic native process identity and memory keys.
// The shim exists ONLY in a disposable extension copy. Product trust checks,
// permissions, context enumeration, controls, native framing/auth and engine run
// unchanged. No native host registration or OS key store is opened.
const args = process.argv.slice(2), manual = args.includes('--manual-toolbar'), baseline = args.includes('--expect-rejection');
const workerIndex = args.indexOf('--worker'), workerPath = workerIndex < 0 ? null : resolve(args[workerIndex + 1]);
assert.ok(args.every((arg, index) => ['--manual-toolbar', '--expect-rejection', '--worker'].includes(arg) || index === workerIndex + 1 && workerIndex >= 0));
assert.equal(baseline, Boolean(workerPath), 'A rejection baseline requires an explicit worker snapshot');
const root = await mkdtemp('/private/tmp/attestamp-sidebar-browser-test-');
const reportDirectory = await mkdtemp('/private/tmp/attestamp-sidebar-browser-report-');
const extension = join(root, 'extension'), application = join(root, 'Google Chrome.app');
const origin = `chrome-extension://${CHATGPT_EXTENSION_ID}`;
const diagnostics = new LocalDiagnostics({ mode: 'SYNTHETIC_FIXTURE' });
const report = { evidence: 'REAL_CHROME_CONTEXT_WITH_SYNTHETIC_NATIVE_PEER', toolbar: manual ? 'MANUAL_TOOLBAR' : 'TEST_PAGE_GESTURE',
  baseline, providerOperations: 0, sponsorOperations: 0, checks: [] };
let browser, socket, runtime, native, desktop, pump, workerSession, pumpFailure;
const sessions = new Map(), incoming = [], dashboards = [];
const input = new PassThrough(), output = new PassThrough(), decoder = new NativeFrameDecoder();
const menuInput = new PassThrough(), menuOutput = new PassThrough(), menuEvents = [];
async function wait(check, label, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (pumpFailure) throw pumpFailure;
    const value = await check(); if (value) return value;
    await delay(50);
  }
  throw Error(`Browser test timed out: ${label}`);
}
let next = 0; const pending = new Map();
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(session, expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
  if (result.exceptionDetails) throw Error(`Browser fixture evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
}
async function attach(target) {
  if (!sessions.has(target.targetId)) sessions.set(target.targetId, (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId);
  return sessions.get(target.targetId);
}
const targets = async () => (await call('Target.getTargets')).targetInfos;
const panelTargets = async () => (await targets()).filter(t => t.type === 'page' && t.url.startsWith(`${origin}/sidepanel.html`));
async function page(url) {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const session = await attach({ targetId }); await call('Page.enable', {}, session);
  await call('Page.navigate', { url }, session);
  await wait(() => evaluate(session, 'document.readyState === "complete"'), 'page scripts loaded');
  return { targetId, session };
}
const control = { kind: 'PAP_PANEL_REQUEST', profile: 'pap-chatgpt-panel/2', action: 'STATE' };
const sendControl = (session, message) => evaluate(session, baseline ? `chrome.runtime.sendMessage(${JSON.stringify(message)})`
  : `import('./sidepanel-channel.js').then(m => m.requestPanel(${JSON.stringify(message)}))`);
const readState = session => sendControl(session, control);
const click = (session, id) => evaluate(session, `document.getElementById(${JSON.stringify(id)}).click()`);
async function visible(session) {
  return evaluate(session, `({ status: document.getElementById('connection')?.textContent,
    disabled: document.getElementById('recording')?.disabled, error: document.getElementById('error')?.textContent })`);
}
async function screenshot(session, name) {
  const result = await call('Page.captureScreenshot', { format: 'png' }, session);
  await writeFile(join(reportDirectory, name), Buffer.from(result.data, 'base64'));
}
async function departedPopup(panel, departure) {
  const sameDocument = departure === 'same-document navigation';
  const url = await evaluate(panel, 'location.href');
  const original = await evaluate(workerSession, `__actualContexts({documentUrls:[${JSON.stringify(url)}]})`);
  assert.equal(original.length, 1); assert.equal(original[0].contextType, 'SIDE_PANEL');
  await evaluate(workerSession, `chrome.action.setPopup({popup:'context-test.html'})`);
  await evaluate(workerSession, 'chrome.action.openPopup()');
  const popupContext = await wait(() => evaluate(workerSession, `(async()=> (await __actualContexts({contextTypes:['POPUP']}))[0])()`), 'copied-URL popup opens');
  const popupTarget = await wait(async () => (await targets()).find(target => target.type === 'page'
    && target.url === popupContext.documentUrl && !sessions.has(target.targetId)), 'new popup target');
  const popup = await attach(popupTarget);
  await evaluate(popup, `window.name = 'attestamp-copied-url-test'; location.replace(${JSON.stringify(url)});`);
  await wait(() => evaluate(popup, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`), 'popup full navigation to copied URL');
  const inventory = await evaluate(workerSession, `__actualContexts({documentUrls:[${JSON.stringify(url)}]})`);
  assert.deepEqual(inventory.map(value => value.contextType).sort(), ['POPUP', 'SIDE_PANEL']);
  const before = runtime.engine.state(), forwarded = await evaluate(workerSession, '__forwardedCommands');
  const command = { profile: 'pap-resident-command/2', kind: 'SET_RECORDING', enabled: !before.recording,
    adapterProfile: before.adapterProfile, runtimeEpoch: before.runtimeEpoch,
    expectedRevision: before.revision, commandId: randomUUID() };
  await evaluate(workerSession, `__contextGate = ${JSON.stringify({ url, commandId: command.commandId, armed: false, entered: false })}`);
  await evaluate(popup, `void import('./sidepanel-channel.js').then(m => m.requestPanel(${JSON.stringify({ ...control, action: 'COMMAND', command })}));`);
  await wait(() => evaluate(workerSession, '__contextGate.entered'), 'request held before actual context inventory');
  if (sameDocument) await evaluate(popup, `history.replaceState(null, '', 'context-test.html');`);
  else if (departure === 'navigation') await call('Page.navigate', { url: origin + '/context-test.html' }, popup);
  else await call('Target.closeTarget', { targetId: popupTarget.targetId });
  const probeExpression = `__panelProbes.find(p => p.commandId === ${JSON.stringify(command.commandId)})`;
  if (!sameDocument) await wait(() => evaluate(workerSession, `${probeExpression}?.disconnected`), 'real requesting Port disconnects');
  const surviving = await evaluate(workerSession, `__actualContexts({documentUrls:[${JSON.stringify(url)}]})`);
  if (!sameDocument) { assert.equal(surviving.length, 1); assert.equal(surviving[0].contextType, 'SIDE_PANEL'); }
  const survivor = surviving.find(value => value.contextType === 'SIDE_PANEL');
  assert.equal(survivor.documentId, original[0].documentId);
  assert.equal(survivor.contextId, original[0].contextId);
  await evaluate(workerSession, '__contextGate.release();');
  await wait(() => evaluate(workerSession, `${probeExpression}?.settled`), 'departed request authorization finishes');
  const probe = await evaluate(workerSession, `(()=>{const p=${probeExpression}; return {
    senderKeys:Object.keys(p.sender).sort(), copiedURL:p.sender.url===__contextGate.url,
    disconnected:p.disconnected, error:p.error, stage:p.stage, challenges:p.challenges};})()`);
  assert.deepEqual(probe.senderKeys, ['id', 'origin', 'url']); assert.equal(probe.copiedURL, true);
  console.log(JSON.stringify({ departure, matchingContextsAfter: surviving.map(value => value.contextType), probe }));
  assert.equal(probe.error, 'UNTRUSTED_PANEL'); assert.equal(probe.stage, 'PANEL_CONTEXT_REJECTED');
  assert.equal(await evaluate(workerSession, '__forwardedCommands'), forwarded);
  assert.equal(runtime.engine.state().recording, before.recording);
  assert.equal(runtime.engine.state().revision, before.revision);
  assert.equal(runtime.session.receipts.list().length, 0);
  report.departedSenders ??= [];
  report.departedSenders.push({ departure, evidence: 'REAL_CHROME_CONTEXT_AND_PORT_WITH_TEST_CONTROLLED_SCHEDULING',
    instrumentation: ['Copied-URL popup bootstrap suppressed in disposable extension copy',
      sameDocument ? 'First context lookup held until history.replaceState, without document departure' : 'First context lookup held until real document departure and Port.onDisconnect',
      'Actual getContexts inventory and authorization completion observed without replacing their results'],
    initialContextTypes: inventory.map(value => value.contextType).sort(), survivingContextTypes: surviving.map(value => value.contextType).sort(),
    survivingIdentityUnchanged: true, probe, forwardedCommands: 0, engineRevisionUnchanged: true,
    recordingUnchanged: true, receipts: 0 });
  await evaluate(workerSession, '__contextGate = null;');
  if (departure !== 'closure') await call('Target.closeTarget', { targetId: popupTarget.targetId });
  await evaluate(workerSession, `chrome.action.setPopup({popup:''})`);
  assert.equal((await readState(panel)).state.recording, before.recording);
}
try {
  await cp(new URL('../spikes/browser/chatgpt/extension', import.meta.url), extension, { recursive: true });
  const productionWorker = workerPath ? await readFile(workerPath, 'utf8') : await readFile(join(extension, 'service-worker.js'), 'utf8');
  report.workerSHA256 = createHash('sha256').update(productionWorker).digest('hex');
  await writeFile(join(extension, 'service-worker.js'), `
  globalThis.__nativeWrites = []; globalThis.__panelProbes = []; globalThis.__forwardedCommands = 0;
  globalThis.__probeByPort = new WeakMap(); globalThis.__contextGate = null;
  globalThis.__actualContexts = chrome.runtime.getContexts.bind(chrome.runtime);
  chrome.runtime.getContexts = async filter => {
    const gate = __contextGate;
    if (gate?.armed && !gate.entered) {
      gate.entered = true; await new Promise(resolve => { gate.release = resolve; });
    }
    return __actualContexts(filter);
  };
  const event = () => { const listeners = []; return { addListener: f => listeners.push(f), emit: m => listeners.forEach(f => f(m)) }; };
  chrome.runtime.connectNative = () => {
    const port = { onMessage: event(), onDisconnect: event(), postMessage: m => {
      if (m.kind === 'PAP_PANEL_REQUEST' && m.action === 'COMMAND') __forwardedCommands++;
      __nativeWrites.push(m);
    }, disconnect() {} };
    globalThis.__testNativePort = port; return port;
  };
  const addMessage = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
  chrome.runtime.onMessage.addListener = listener => addMessage((message, sender, respond) => listener(message, sender, result => {
    if (message?.kind === 'PAP_PANEL_REQUEST') {
      __panelProbes.push({ sender, action: message.action, error: result?.error, stage: result?.stage });
      if (__panelProbes.length > 32) __panelProbes.shift();
    }
    respond(result);
  }));
  const addConnect = chrome.runtime.onConnect.addListener.bind(chrome.runtime.onConnect);
  chrome.runtime.onConnect.addListener = listener => addConnect(port => {
    const probe = { sender: port.sender, disconnected: false, settled: false, challenges: 0 };
    __probeByPort.set(port, probe);
    port.onMessage.addListener(message => {
      if (message.kind !== 'PAP_PANEL_REQUEST') return;
      probe.action = message.action; probe.commandId = message.command?.commandId;
      __panelProbes.push(probe); if (__panelProbes.length > 128) __panelProbes.shift();
      if (__contextGate?.commandId === probe.commandId && probe.action === 'COMMAND') __contextGate.armed = true;
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; probe.disconnected = true; });
    const post = port.postMessage.bind(port);
    port.postMessage = message => {
      if (message.kind === 'PAP_PANEL_CHALLENGE') probe.challenges++;
      return post(message);
    };
    listener(port);
  });
  ` + productionWorker + (baseline ? '' : `
  const authorizePanel = panelMessage;
  panelMessage = async (...args) => {
    const result = await authorizePanel(...args), probe = __probeByPort.get(args[2].port);
    if (probe) Object.assign(probe, { settled: true, error: result?.error, stage: result?.stage });
    return result;
  };
  `));
  // The baseline gate expects the historical fixed URL, so keep the baseline UI
  // module too. This is a private known-baseline fixture, never a shipping file.
  if (baseline) {
    const ui = await readFile(join(extension, 'sidepanel.js'), 'utf8');
    await writeFile(join(extension, 'sidepanel.js'), ui.slice(0, ui.indexOf('// A full navigation')).replace('new SidePanelModel(requestPanel, render)', 'new SidePanelModel(message => chrome.runtime.sendMessage(message), render)') + `
      document.getElementById('recording').addEventListener('click', () => model.toggle());
      await model.refresh(); setInterval(() => model.refresh(), 1000);`);
  } else {
    // Only the adversarial popup uses this name. It suppresses the normal fresh
    // URL bootstrap so actual Chrome can supply the copied-URL sender under test.
    const ui = await readFile(join(extension, 'sidepanel.js'), 'utf8');
    await writeFile(join(extension, 'sidepanel.js'), ui.replace('if (identifyDocument())',
      "if (window.name !== 'attestamp-copied-url-test' && identifyDocument())"));
  }
  await writeFile(join(extension, 'context-test.html'), '<!doctype html><title>Attestamp isolated context test</title><h1>Isolated sidebar context test</h1><p>No provider or sponsor connection.</p><button id="open">Open test sidebar</button><script src="context-test.js"></script>');
  await writeFile(join(extension, 'context-test.js'), `document.getElementById('open').onclick = async () => chrome.sidePanel.open({windowId:(await chrome.windows.getCurrent()).id});`);
  // An unmodified APFS clone gives computer-use tools an exact disposable app
  // path, avoiding the owner's other running Chrome processes.
  execFileSync('/bin/cp', ['-cR', '/Applications/Google Chrome.app', application]);
  runtime = await startPackagedChatGPT({ supportDirectory: join(root, 'runtime'), installation: null,
    keyStore: new MemoryKeyStore(), managed: null, fastTrust: { profile: 'PAP_ALGORAND_FAST_CONFIRM_V1' }, openBrowser: false, diagnostics,
    collectFast: async () => { throw Error('EXTERNAL_ANCHOR_FORBIDDEN'); },
    attestPeer: async () => ({ browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
      platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } }),
    openDashboard: async url => { dashboards.push(url); } });
  output.on('data', bytes => incoming.push(...decoder.push(bytes)));
  menuOutput.on('data', bytes => menuEvents.push(JSON.parse(bytes.subarray(4))));
  desktop = startDesktopChannel(runtime, { input: menuInput, output: menuOutput, onExit() {} });
  browser = spawn(join(application, 'Contents/MacOS/Google Chrome'), [
    `--user-data-dir=${join(root, 'profile')}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--disable-crashpad-for-testing', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-updater-scheduler',
    '--use-mock-keychain', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  const active = await wait(async () => { try { return (await readFile(join(root, 'profile/DevToolsActivePort'), 'utf8')).split('\n'); } catch { return null; } }, 'isolated Chrome startup');
  socket = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    if (!value.id) return;
    const operation = pending.get(value.id); if (!operation) return;
    clearTimeout(operation.timer); pending.delete(value.id);
    value.error ? operation.reject(Error(`CDP rejected operation: ${value.error.message}`)) : operation.resolve(value.result);
  };
  report.browser = (await call('Browser.getVersion')).product;
  assert.match(report.browser, /^Chrome\/153\./);
  const loaded = await call('Extensions.loadUnpacked', { path: extension }); assert.equal(loaded.id, CHATGPT_EXTENSION_ID);
  workerSession = await attach(await wait(async () => (await targets()).find(t => t.type === 'service_worker' && t.url.startsWith(origin)), 'worker'));
  await call('Runtime.enable', {}, workerSession);
  await wait(() => evaluate(workerSession, 'typeof __testNativePort !== "undefined"'), 'worker initialized');
  native = await runNativeHost({ extensionOrigin: origin + '/', rendezvousPath: runtime.rendezvousPath, input, output });
  native.on('error', () => { pumpFailure = Error('ISOLATED_NATIVE_SOCKET_FAILED'); });
  let pumping = false;
  pump = setInterval(async () => {
    if (pumping) return; pumping = true;
    try {
      const messages = await evaluate(workerSession, `(()=>{for(const m of ${JSON.stringify(incoming.splice(0))}) __testNativePort.onMessage.emit(m); return __nativeWrites.splice(0);})()`);
      for (const message of messages) input.write(encodeNativeFrame(message));
    } catch (error) { pumpFailure = error; }
    finally { pumping = false; }
  }, 25);
  await wait(() => runtime.browserState(), 'authenticated bridge pairing');
  const testPage = await page(`${origin}/context-test.html`);
  console.log(JSON.stringify({ step: manual ? 'OPEN_TOOLBAR_SIDEBAR' : 'AUTOMATED_TEST_PAGE', application, reportDirectory }));
  if (!manual) await evaluate(testPage.session, 'document.getElementById("open").click()');
  const panelTarget = await wait(async () => (await panelTargets())[0], 'toolbar-opened panel', manual ? 6000 : 300);
  // A full redirect replaces the execution context; attach after its final URL.
  if (!baseline) await wait(async () => (await panelTargets()).some(t => /\?view=/.test(t.url)), 'unique panel document');
  const panel = await attach(panelTarget);
  await wait(async () => (await visible(panel)).status !== 'Connecting to Attestamp…', 'panel state');
  const state = await readState(panel);
  report.initialControl = { error: state.error ?? null, stage: state.stage ?? null, hasState: Boolean(state.state) };
  const shape = await evaluate(workerSession, `(async()=>{const s=__panelProbes.at(-1).sender, cs=await chrome.runtime.getContexts({documentUrls:[s.url]});
    return {senderKeys:Object.keys(s).sort(),senderOriginMatches:s.origin===${JSON.stringify(origin)},
      contexts:cs.map(c=>({type:c.contextType,urlMatches:c.documentUrl===s.url,originMatches:c.documentOrigin===${JSON.stringify(origin)},
        frameId:c.frameId,tabId:c.tabId,windowId:c.windowId,incognito:c.incognito,hasDocumentId:typeof c.documentId==='string',
        documentIdLength:c.documentId?.length,documentIdUUID:/^[a-f0-9-]{36}$/.test(c.documentId)}))};})()`);
  report.metadata = shape;
  console.log(JSON.stringify({ initialControl: report.initialControl, metadata: shape }));
  assert.deepEqual(shape.senderKeys, ['id', 'origin', 'url']); assert.equal(shape.contexts[0].type, 'SIDE_PANEL');
  if (baseline) {
    assert.equal(state.error, 'UNTRUSTED_PANEL'); assert.equal((await visible(panel)).disabled, true);
    report.checks.push('AUTHENTICATED_BRIDGE_WITH_REAL_SIDEBAR_FALSE_REJECTION');
    await screenshot(panel, 'baseline-rejection.png');
  } else {
    assert.equal(state.state.recording, false); assert.equal((await visible(panel)).disabled, false);
    await evaluate(panel, `globalThis.__stableControl = document.getElementById('recording'); globalThis.__controlChanges = [];
      globalThis.__controlObserver = new MutationObserver(records => __controlChanges.push(...records.map(record => record.type)));
      __controlObserver.observe(__stableControl, {attributes:true,childList:true,subtree:true,characterData:true});`);
    await delay(3200);
    assert.equal(await evaluate(panel, 'document.getElementById("recording") === __stableControl && !__stableControl.disabled'), true);
    assert.deepEqual(await evaluate(panel, '__controlChanges'), []);
    await evaluate(panel, '__controlObserver.disconnect()');
    report.checks.push('STABLE_PERIODIC_REFRESH_PRESERVES_ENABLED_CONTROL_WITHOUT_DOM_MUTATIONS');
    await click(panel, 'recording'); await wait(() => runtime.engine.state().recording, 'sidebar ON');
    await wait(async () => (await visible(panel)).status.startsWith('ON'), 'ON status');
    await screenshot(panel, 'sidebar-on.png');
    assert.equal(runtime.session.receipts.list().length, 0);
    await click(panel, 'dashboard'); await wait(() => dashboards.length, 'dashboard link');
    const dashboard = await page(dashboards[0]);
    await wait(async () => await evaluate(dashboard.session, 'document.getElementById("recording")?.textContent === "Turn OFF"'), 'dashboard ON');
    await click(dashboard.session, 'recording'); await wait(() => !runtime.engine.state().recording, 'dashboard OFF');
    await wait(async () => (await visible(panel)).status === 'Attestamp is OFF', 'sidebar reflects dashboard OFF');
    const menuState = runtime.engine.state(), body = Buffer.from(JSON.stringify({ profile: 'pap-desktop-command/2', kind: 'RECORDING',
      runtimeEpoch: menuState.runtimeEpoch, revision: menuState.revision, enabled: true }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); menuInput.write(Buffer.concat([prefix, body]));
    await wait(async () => (await visible(panel)).status.startsWith('ON'), 'sidebar reflects resident pipe ON');
    const secondWindow = await evaluate(workerSession, `chrome.windows.create({url:${JSON.stringify(origin + '/context-test.html')}})`);
    const secondPage = await attach(await wait(async () => (await targets()).find(t => t.type === 'page' && t.targetId !== testPage.targetId && t.url === origin + '/context-test.html'), 'second window test page'));
    await wait(() => evaluate(secondPage, 'typeof document.getElementById("open")?.onclick === "function"'), 'second page scripts loaded');
    await evaluate(secondPage, 'document.getElementById("open").click()');
    const secondPanelTarget = await wait(async () => (await panelTargets()).find(t => t.targetId !== panelTarget.targetId && /\?view=/.test(t.url)), 'second sidebar');
    const secondPanel = await attach(secondPanelTarget);
    await wait(async () => (await readState(secondPanel)).state?.recording, 'second sidebar global ON');
    await click(secondPanel, 'recording'); await wait(() => !runtime.engine.state().recording, 'second sidebar OFF');
    await wait(async () => (await visible(panel)).status === 'Attestamp is OFF', 'first sidebar global OFF');
    report.checks.push('SIDEBAR_DASHBOARD_RESIDENT_PIPE_AND_TWO_WINDOWS_SHARE_ON_OFF');
    // Real regular extension tab and real action popup run the same panel file.
    const ordinary = await page(origin + '/sidepanel.html');
    await wait(async () => (await readState(ordinary.session)).error === 'UNTRUSTED_PANEL', 'regular tab rejected');
    assert.equal((await visible(ordinary.session)).disabled, true);
    await call('Target.closeTarget', { targetId: ordinary.targetId });
    const tabRejection = await readState(testPage.session); assert.equal(tabRejection.error, 'UNTRUSTED_PANEL');
    await evaluate(workerSession, `chrome.action.setPopup({popup:'sidepanel.html'})`);
    await evaluate(workerSession, 'chrome.action.openPopup()');
    const popup = await wait(async () => (await panelTargets()).find(t => ![panelTarget.targetId, secondPanelTarget.targetId].includes(t.targetId) && /\?view=/.test(t.url)), 'action popup');
    const popupSession = await attach(popup);
    assert.equal((await readState(popupSession)).error, 'UNTRUSTED_PANEL');
    assert.equal((await visible(popupSession)).disabled, true);
    await call('Target.closeTarget', { targetId: popup.targetId });
    await evaluate(workerSession, `chrome.action.setPopup({popup:''})`);
    report.checks.push('REAL_EXTENSION_TAB_TEST_PAGE_AND_ACTION_POPUP_REJECTED');
    assert.equal(await evaluate(workerSession, 'chrome.extension.isAllowedIncognitoAccess()'), false);
    const frameURL = await evaluate(panel, 'location.href');
    await evaluate(testPage.session, `globalThis.frameLoaded = false;
      const frame = document.createElement('iframe'); frame.onload = () => { frameLoaded = true; };
      frame.src = ${JSON.stringify(frameURL)}; document.body.append(frame);`);
    await wait(() => evaluate(testPage.session, 'frameLoaded'), 'iframe navigation finishes');
    const framed = await evaluate(testPage.session, `(async()=>{let frame;
      try { frame = document.querySelector('iframe').contentWindow; if (!frame.chrome?.runtime?.sendMessage) return {runtimeAccessible:false}; }
      catch { return {runtimeAccessible:false}; }
      const result = await frame.chrome.runtime.sendMessage(${JSON.stringify(control)});
      return {runtimeAccessible:true,error:result?.error,stage:result?.stage}; })()`);
    if (framed.runtimeAccessible) assert.equal(framed.error, 'UNTRUSTED_PANEL');
    report.framedControl = framed;
    assert.equal((await readState(panel)).state.recording, false);
    report.checks.push('REAL_IFRAME_HAS_NO_CONTROL_AUTHORITY_AND_INCOGNITO_ACCESS_IS_DISABLED');
    await departedPopup(panel, 'navigation');
    await departedPopup(panel, 'closure');
    await departedPopup(panel, 'same-document navigation');
    report.checks.push('REAL_COPIED_URL_POPUP_NAVIGATION_AND_CLOSURE_CANCEL_PENDING_COMMANDS');
    // Reload rotates the URL and creates fresh document-owned request channels.
    const before = await evaluate(panel, 'location.href');
    await call('Page.reload', {}, panel);
    await wait(async () => (await targets()).some(t => t.targetId === panelTarget.targetId && t.url !== before && /\?view=/.test(t.url)), 'fresh reload identity');
    await wait(async () => (await readState(panel)).state?.recording === false, 'reload preserves OFF');
    assert.equal(runtime.session.receipts.list().length, 0);
    assert.equal(menuEvents.at(-1).recording, runtime.engine.state().recording);
    report.checks.push('RELOAD_PRESERVES_CONSENT_AND_ROTATES_DOCUMENT_WITHOUT_CAPTURE');
    await evaluate(workerSession, `chrome.windows.remove(${secondWindow.id})`);
    await screenshot(panel, 'sidebar-off.png');
  }
  report.diagnostics = diagnostics.preview().report;
  const encoded = JSON.stringify(report.diagnostics);
  assert.doesNotMatch(encoded, /chrome-extension|sidepanel.html|documentId|contextId|"url"|"token"/);
  assert.ok(report.diagnostics.events.some(e => e.code === 'BRIDGE_AUTHENTICATED'));
  report.result = 'PASS';
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: 'PASS', reportDirectory, checks: report.checks }));
} catch (error) {
  report.result = 'FAIL'; report.failure = error.message; report.diagnostics = diagnostics.preview().report;
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ result: 'FAIL', reportDirectory, failure: error.message }));
  throw error;
} finally {
  clearInterval(pump); desktop?.close();
  const exited = browser && new Promise(resolve => browser.exitCode !== null || browser.signalCode !== null ? resolve() : browser.once('exit', resolve));
  try { if (socket?.readyState === WebSocket.OPEN) await call('Browser.close'); } catch {}
  socket?.close(); browser?.kill('SIGTERM');
  if (exited) await exited;
  native?.destroy(); input.destroy(); output.destroy(); await runtime?.close();
  for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(Error('TEST_CLOSED')); }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
