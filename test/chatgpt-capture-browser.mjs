import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { runNativeHost, NativeFrameDecoder, encodeNativeFrame } from '../spikes/browser/chatgpt/native-host.mjs';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';

// Real Chrome document identity, trusted input events and navigation; all page
// responses are intercepted fixtures. Native ancestry and keys are synthetic.
const root = await mkdtemp('/private/tmp/attestamp-capture-browser-test-');
const reportDirectory = await mkdtemp('/private/tmp/attestamp-capture-browser-report-');
let runtime, browser, socket, native, pump, failure;
const input = new PassThrough(), output = new PassThrough(), decoder = new NativeFrameDecoder(), incoming = [];
const pending = new Map(), report = { evidence: 'REAL_CHROME_WITH_SYNTHETIC_PAGE_AND_NATIVE_PEER', checks: [] };
let sequence = 0;
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(session, expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw Error('CAPTURE_BROWSER_EVALUATION_FAILED');
  return result.result.value;
}
async function wait(check) {
  for (let index = 0; index < 300; index++) {
    if (failure) throw failure;
    if (await check()) return;
    await delay(40);
  }
  throw Error('CAPTURE_BROWSER_CONDITION_TIMEOUT');
}
const html = `<!doctype html><meta charset="utf-8"><title>Synthetic capture test</title>
<textarea id="prompt-textarea" style="width:400px;height:120px"></textarea><button data-testid="send-button">Send</button>
<script>globalThis.providerSends=0;document.querySelector('button').onclick=()=>{
providerSends++;document.querySelector('textarea').value='';
if(location.pathname==='/')history.pushState(null,'','/c/synthetic-conversation');
};</script>`;
try {
  const extension = join(root, 'extension');
  await cp(new URL('../spikes/browser/chatgpt/extension/', import.meta.url), extension, { recursive: true });
  const worker = await readFile(join(extension, 'service-worker.js'), 'utf8');
  report.workerSHA256 = createHash('sha256').update(worker).digest('hex');
  report.contentSHA256 = createHash('sha256').update(await readFile(join(extension, 'content-script.js'))).digest('hex');
  await writeFile(join(extension, 'service-worker.js'), `
    globalThis.__writes=[];globalThis.__gate=null;globalThis.__captureProbes=[];globalThis.__routes=[];globalThis.__proofs=[];
    const event=()=>({listeners:[],addListener(f){this.listeners.push(f)},emit(v){this.listeners.forEach(f=>f(v))}});
    chrome.runtime.connectNative=()=>globalThis.__native={onMessage:event(),onDisconnect:event(),postMessage:m=>__writes.push(m),disconnect(){}};
    const add=chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener=listener=>add((message,sender,respond)=>{
      if(message.kind==='PAP_CAPTURE'&&__gate&&!__gate.entered)__gate.armed=true;
      return listener(message,sender,respond);
    });
    const query=chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query=async(...args)=>{
      const gate=__gate, hold=gate?.armed&&!gate.entered;
      if(hold)gate.entered=true;
      const result=await query(...args);
      if(hold)await new Promise(resolve=>{gate.release=resolve});
      return result;
    };
    chrome.tabs.onUpdated.addListener((id,change)=>__routes.push({urlChanged:!!change.url,status:change.status??null,hasCandidate:newChats.has(id)}));
    const send=chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage=async(...args)=>{
      const result=await send(...args);
      if(args[1].kind==='PAP_CONFIRM_NEW_CHAT')__proofs.push({confirmed:result?.confirmed===true});
      return result;
    };
  ` + worker + `
    const capture=captureMessage;
    captureMessage=async(message,sender)=>{
      if(message.kind!=='PAP_CAPTURE')return capture(message,sender);
      const candidate=newChats.get(sender.tab?.id), probe={candidate:!!candidate,senderRoot:sender.url==='https://chatgpt.com/',
        documentMatches:candidate?.documentId===sender.documentId,tokenMatches:candidate?.policy.token===message.token,
        epochMatches:candidate?.policy.tabEpoch===tabEpochs.get(sender.tab?.id)};
      __captureProbes.push(probe);
      try{const result=await capture(message,sender);probe.state=result?.state;return result;}
      catch(error){probe.failed=true;throw error;}
    };
  `);
  runtime = await startPackagedChatGPT({ supportDirectory: join(root, 'engine'), keyStore: new MemoryKeyStore(),
    managed: null, fastTrust: { profile: 'PAP_ALGORAND_FAST_CONFIRM_V1' }, openBrowser: false,
    collectFast: async () => { throw Error('EXTERNAL_ANCHOR_FORBIDDEN'); },
    attestPeer: async () => ({ browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
      platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } }) });
  browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--user-data-dir=${join(root, 'profile')}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--disable-crashpad-for-testing', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-updater-scheduler',
    '--use-mock-keychain', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  browser.on('error', error => { failure = error; });
  let active;
  await wait(async () => { try { active = (await readFile(join(root, 'profile/DevToolsActivePort'), 'utf8')).split('\n'); return true; } catch { return false; } });
  socket = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Fetch.requestPaused') {
      const isPage = value.params.request.url === 'https://chatgpt.com/' && value.params.resourceType === 'Document';
      void call('Fetch.fulfillRequest', { requestId: value.params.requestId, responseCode: isPage ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(isPage ? html : '').toString('base64') }, value.sessionId).catch(error => { failure = error; });
    }
    if (!value.id) return;
    const operation = pending.get(value.id); if (!operation) return;
    pending.delete(value.id); clearTimeout(operation.timer);
    value.error ? operation.reject(Error('CAPTURE_CDP_REJECTED')) : operation.resolve(value.result);
  };
  report.browser = (await call('Browser.getVersion')).product; assert.match(report.browser, /^Chrome\/153\./);
  const loaded = await call('Extensions.loadUnpacked', { path: extension }); assert.equal(loaded.id, CHATGPT_EXTENSION_ID);
  let target;
  await wait(async () => { target = (await call('Target.getTargets')).targetInfos.find(value => value.type === 'service_worker'
    && value.url === `chrome-extension://${CHATGPT_EXTENSION_ID}/service-worker.js`); return target; });
  const workerSession = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await call('Runtime.enable', {}, workerSession);
  try { await wait(() => evaluate(workerSession, 'typeof __native !== "undefined"')); }
  catch (error) {
    console.error(await evaluate(workerSession, `({shim:typeof __writes,sidePanel:typeof chrome.sidePanel,native:typeof chrome.runtime.connectNative,worker:typeof connect})`));
    throw error;
  }
  output.on('data', bytes => incoming.push(...decoder.push(bytes)));
  native = await runNativeHost({ extensionOrigin: `chrome-extension://${CHATGPT_EXTENSION_ID}/`, rendezvousPath: runtime.rendezvousPath, input, output });
  native.on('error', error => { failure = error; });
  let pumping = false;
  pump = setInterval(async () => {
    if (pumping) return; pumping = true;
    try {
      const writes = await evaluate(workerSession, `(()=>{for(const m of ${JSON.stringify(incoming.splice(0))})__native.onMessage.emit(m);return __writes.splice(0)})()`);
      for (const value of writes) input.write(encodeNativeFrame(value));
    } catch (error) { failure = error; }
    finally { pumping = false; }
  }, 20);
  await wait(() => runtime.browserState());
  const setRecording = enabled => {
    const state = runtime.engine.state();
    return runtime.engine.command({ profile: 'pap-resident-command/2', kind: 'SET_RECORDING', enabled,
      commandId: randomUUID(), adapterProfile: state.adapterProfile, runtimeEpoch: state.runtimeEpoch,
      expectedRevision: state.revision }, { surface: 'desktop' });
  };
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const page = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, page);
  await call('Page.navigate', { url: 'https://chatgpt.com/' }, page);
  await wait(() => runtime.adapter.scopes().some(source => source.destination === 'new-chat'));
  await setRecording(true);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · ON'`));
  const text = 'SYNTHETIC_BROWSER_e\u0301\n☕  ';
  const send = async () => {
    await evaluate(page, 'document.querySelector("textarea").focus()');
    await call('Input.insertText', { text }, page);
    const rect = await evaluate(page, `(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 }, page);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 }, page);
  };
  await evaluate(workerSession, '__gate={armed:false,entered:false}');
  await send();
  await wait(() => runtime.adapter.scopes().some(source => source.destination === 'conversation:synthetic-conversation'));
  await wait(() => evaluate(workerSession, 'typeof __gate.release === "function"'));
  await evaluate(workerSession, '__gate.release();__gate=null');
  try { await wait(() => runtime.session.receipts.list().length === 1); }
  catch (error) {
    report.captureTrace = await evaluate(workerSession, '({captures:__captureProbes,routes:__routes,proofs:__proofs})');
    report.pageFeedback = await evaluate(page, 'document.getElementById("attestamp-recording-status")?.textContent');
    console.error(JSON.stringify({ trace: report.captureTrace, feedback: report.pageFeedback }));
    throw error;
  }
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · Prompt saved'`));
  const receipt = runtime.session.receipts.list()[0], preview = runtime.session.receipts.prepare({ ids: [receipt.id] });
  assert.equal(preview.texts[0].preview, text);
  assert.equal(runtime.session.status().versions[0].source.destination, 'new-chat');
  assert.equal(await evaluate(page, 'providerSends'), 1);
  report.checks.push('FIRST_GENUINE_SEND_DURABLE_ONCE_AFTER_REAL_SAME_DOCUMENT_NAVIGATION_WITH_HELD_BROWSER_CHECK');
  await send(); await wait(() => runtime.session.receipts.list().length === 2);
  assert.equal(await evaluate(page, 'providerSends'), 2);
  report.checks.push('LATER_EQUAL_TEXT_SEND_HAS_DISTINCT_RECEIPT_ON_CURRENT_CONVERSATION');
  await setRecording(false);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status').hidden`));
  await send(); await delay(250);
  assert.equal(runtime.session.receipts.list().length, 2); assert.equal(await evaluate(page, 'providerSends'), 3);
  report.checks.push('OFF_CONTINUES_PROVIDER_ACTION_WITHOUT_NEW_CAPTURE');
  report.result = 'PASS';
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportDirectory }));
} catch (error) {
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify({ ...report, result: 'FAIL', error: error.message }, null, 2));
  console.error(reportDirectory); throw error;
} finally {
  clearInterval(pump);
  try { if (socket?.readyState === WebSocket.OPEN) await call('Browser.close'); } catch {}
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited;
  }
  native?.destroy(); input.destroy(); output.destroy(); await runtime?.close();
  for (const operation of pending.values()) clearTimeout(operation.timer);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
