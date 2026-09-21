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
let sequence = 0, interceptedSends = 0;
const heldSteering = [];
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
<script>
const delegate=window.fetch;
globalThis.observerInstalled=delegate.name==='fetchObserved';
globalThis.wrapperEffects=0;
window.fetch=function o(){wrapperEffects++;return delegate.apply(this,arguments)};
globalThis.lateFetch=window.fetch;globalThis.documentToken=crypto.randomUUID();
globalThis.providerSends=0;document.querySelector('button').onclick=()=>{
providerSends++;
const payload={action:'next',parent_message_id:crypto.randomUUID(),
  conversation_id:location.pathname==='/'?null:location.pathname.split('/')[2],
  messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:[document.querySelector('textarea').value]}}]};
fetch(new Request('https://chatgpt.com/backend-api/f/conversation',{method:'POST',body:JSON.stringify(payload)}))
  .then(response=>response.text()).then(()=>globalThis.providerResponses=(globalThis.providerResponses??0)+1);
document.querySelector('textarea').value='';
if(location.pathname==='/')setTimeout(()=>history.pushState(null,'','/c/synthetic-conversation'),25);
};</script>`;
try {
  const extension = join(root, 'extension');
  await cp(new URL('../spikes/browser/chatgpt/extension/', import.meta.url), extension, { recursive: true });
  const worker = await readFile(join(extension, 'service-worker.js'), 'utf8');
  report.workerSHA256 = createHash('sha256').update(worker).digest('hex');
  report.observerSHA256 = createHash('sha256').update(await readFile(join(extension, 'fetch-observer.js'))).digest('hex');
  report.contentSHA256 = createHash('sha256').update(await readFile(join(extension, 'content-script.js'))).digest('hex');
  await writeFile(join(extension, 'service-worker.js'), `
    globalThis.__writes=[];globalThis.__gate=null;globalThis.__captureProbes=[];globalThis.__routes=[];globalThis.__proofs=[];globalThis.__policies=[];
    globalThis.__holdReplies=false;globalThis.__lateReplies=[];
    globalThis.__updateListeners=[];
    const updated=chrome.tabs.onUpdated.addListener.bind(chrome.tabs.onUpdated);
    chrome.tabs.onUpdated.addListener=listener=>{__updateListeners.push(listener);updated(listener)};
    globalThis.__update=(id,change)=>{for(const listener of __updateListeners)listener(id,change)};
    const event=()=>({listeners:[],addListener(f){this.listeners.push(f)},emit(v){this.listeners.forEach(f=>f(v))}});
    chrome.runtime.connectNative=()=>globalThis.__native={onMessage:event(),onDisconnect:event(),postMessage:m=>__writes.push(m),disconnect(){}};
    const add=chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener=listener=>add((message,sender,respond)=>{
      if(message.kind==='PAP_CAPTURE'&&__gate&&!__gate.entered)__gate.armed=true;
      const reply=message.kind==='PAP_CAPTURE'&&__holdReplies?value=>__lateReplies.push(()=>respond(value)):respond;
      return listener(message,sender,reply);
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
      if(args[1].kind==='PAP_CAPTURE_POLICY'&&result===true)__policies.push({url:args[1].policy?.expectedUrl,state:args[1].state});
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
      const isSteering = value.params.request.url === 'https://chatgpt.com/backend-api/f/steer_turn' && value.params.request.method === 'POST';
      const isSend = isSteering || value.params.request.url === 'https://chatgpt.com/backend-api/f/conversation' && value.params.request.method === 'POST';
      if (isSend) interceptedSends++;
      if (isSteering) { heldSteering.push(value); return; }
      const responseBody = isPage ? html : isSend ? 'data: ' + JSON.stringify({ type: 'stream_handoff',
        conversation_id: 'synthetic-conversation', turn_exchange_id: 'synthetic-' + randomUUID() }) + '\n\n' : '';
      void call('Fetch.fulfillRequest', { requestId: value.params.requestId, responseCode: isPage || isSend ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: isSend ? 'text/event-stream' : 'text/html; charset=utf-8' }],
        body: Buffer.from(responseBody).toString('base64') }, value.sessionId).catch(error => { failure = error; });
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
  assert.equal(await evaluate(page, 'observerInstalled&&fetch===lateFetch&&providerSends===0'), true);
  const documentToken = await evaluate(page, 'documentToken');
  await call('Page.reload', {}, page);
  await wait(() => evaluate(page, `globalThis.documentToken!==${JSON.stringify(documentToken)}&&globalThis.observerInstalled
    &&document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · ON'`));
  assert.equal(interceptedSends, 0);
  report.checks.push('LATE_FORWARDING_WRAPPER_READY_WITH_EMPTY_COMPOSER_AFTER_FULL_RELOAD_WITHOUT_SEND');
  await evaluate(page, `globalThis.savedSendButton=document.querySelector('button');savedSendButton.remove();document.querySelector('textarea').value='temporary';document.querySelector('textarea').value=''`);
  await delay(2200);
  const tabId = runtime.adapter.scopes().find(source => source.destination === 'new-chat').tabId;
  for (let index = 0; index < 10; index++) await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},
    {kind:'PAP_INSPECT',pageContract:'chatgpt-web-text/2026-09-21.1'},{frameId:0})`);
  assert.equal(await evaluate(page, 'wrapperEffects'), 1);
  assert.equal(await evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent`), 'Attestamp · ON');
  await evaluate(page, 'document.body.append(savedSendButton)');
  report.checks.push('EMPTY_TYPE_CLEAR_WITHOUT_SEND_BUTTON_STAYS_ARMED');
  await evaluate(page, `globalThis.bypassEffects=0;window.fetch=function bypass(){bypassEffects++;return Promise.reject(new Error('SYNTHETIC_BYPASS'))}`);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · Recording unavailable'`));
  await delay(2200);
  assert.equal(await evaluate(page, 'bypassEffects'), 1);
  assert.equal(interceptedSends, 0); assert.equal(runtime.session.receipts.list().length, 0);
  await evaluate(page, 'window.fetch=lateFetch');
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · ON'`));
  assert.equal(await evaluate(page, 'fetch===lateFetch'), true);
  assert.equal(await evaluate(page, 'wrapperEffects'), 1);
  report.healthWrapperEffects = await evaluate(page, '({forwarding:wrapperEffects,bypass:bypassEffects})');
  report.checks.push('IDLE_HEARTBEATS_AND_INSPECTIONS_VALIDATE_EACH_FETCH_IDENTITY_ONCE');
  report.checks.push('GENUINE_OBSERVER_BYPASS_UNAVAILABLE_AND_FORWARDING_WRAPPER_RECOVERS_WITHOUT_SEND');
  const text = 'SYNTHETIC_BROWSER_e\u0301\n☕  ';
  const send = async (prompt = text) => {
    await evaluate(page, 'document.querySelector("textarea").focus()');
    await call('Input.insertText', { text: prompt }, page);
    const rect = await evaluate(page, `(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 }, page);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 }, page);
  };
  await evaluate(workerSession, '__gate={armed:false,entered:false}');
  await send();
  await wait(() => runtime.adapter.scopes().some(source => source.destination === 'conversation:synthetic-conversation'));
  await wait(() => evaluate(workerSession, 'typeof __gate.release === "function"'));
  await evaluate(workerSession, `__update(${tabId},{status:'loading'});__update(${tabId},{status:'loading'})`);
  await delay(100);
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
  report.checks.push('FRESH_TAB_FIRST_SEND_SURVIVES_INJECTED_REPEATED_LOADING_WITH_REAL_DOCUMENT_PROOFS');
  await send(); await wait(() => runtime.session.receipts.list().length === 2);
  assert.equal(await evaluate(page, 'providerSends'), 2);
  report.checks.push('LATER_EQUAL_TEXT_SEND_HAS_DISTINCT_RECEIPT_ON_CURRENT_CONVERSATION');
  await wait(() => runtime.session.status().versions.every(version => version.acknowledgement?.kind === 'stream-handoff'));
  report.checks.push('EARLY_HANDOFF_BINDS_TO_BOTH_DURABLE_EVENTS');
  await evaluate(page, `history.pushState(null,'','/')`);
  await wait(() => runtime.adapter.scopes().some(source => source.destination === 'new-chat'));
  await delay(1100);
  assert.equal(await evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent`), 'Attestamp · ON');
  // Hold only fixture page-message delivery. The genuine Send, original fetch,
  // provider response, route and authenticated policy all continue independently.
  const policyStart = await evaluate(workerSession, '__policies.length');
  await evaluate(page, `globalThis.heldTransport=[];globalThis.originalPostMessage=window.postMessage;
    window.postMessage=function(message,...args){
      if(message?.channel==='pap-chatgpt-transport/2'&&['request','ack'].includes(message.kind))heldTransport.push([message,...args]);
      else return Reflect.apply(originalPostMessage,this,[message,...args]);
    }`);
  await send();
  await wait(() => evaluate(page, `heldTransport.some(message=>message[0].kind==='request')&&providerResponses===3`));
  await wait(() => evaluate(workerSession, `__policies.slice(${policyStart}).some(value=>value.state==='READY'&&value.url==='https://chatgpt.com/c/synthetic-conversation')`));
  await evaluate(workerSession, `__update(${tabId},{status:'loading'});__update(${tabId},{status:'loading'});
    __update(${tabId},{url:'https://chatgpt.com/c/synthetic-conversation',status:'loading'});__update(${tabId},{status:'complete'})`);
  await delay(100);
  assert.equal(runtime.session.receipts.list().length, 2);
  assert.equal(await evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent`), 'Attestamp · ON');
  await evaluate(page, `window.postMessage=originalPostMessage;for(const args of heldTransport)Reflect.apply(originalPostMessage,window,args);heldTransport=[]`);
  await wait(() => runtime.session.receipts.list().length === 3);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · Prompt saved'`));
  assert.equal(runtime.session.status().versions[2].source.destination, 'new-chat');
  assert.equal(await evaluate(page, 'providerSends'), 3);
  report.checks.push('FIRST_SEND_ROUTE_POLICY_PRECEDES_MAIN_TO_ISOLATED_REQUEST_DELIVERY');
  report.checks.push('CONVERSATION_TO_NEW_CHAT_AND_NEXT_SEND_WITHOUT_RELOAD');
  report.checks.push('HELD_NEW_CHAT_RELAY_SURVIVES_INJECTED_REPEATED_LOADING_AND_ROUTE_UPDATES');
  assert.equal(await evaluate(page, 'fetch===lateFetch'), true);
  assert.equal(await evaluate(page, 'wrapperEffects'), 4, 'one health validation plus three synthetic Sends');
  report.checks.push('PAGE_WRAPPER_REFERENCE_UNCHANGED_ACROSS_HEARTBEATS_AND_SPA_NAVIGATION');
  await setRecording(false);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status').hidden`));
  await send(); await delay(250);
  assert.equal(runtime.session.receipts.list().length, 3); assert.equal(await evaluate(page, 'providerSends'), 4);
  assert.equal(interceptedSends, 4);
  assert.equal(await evaluate(page, 'wrapperEffects'), 5, 'OFF adds only the fourth synthetic Send');
  report.totalWrapperEffects = await evaluate(page, 'wrapperEffects');
  report.checks.push('OFF_CONTINUES_PROVIDER_ACTION_WITHOUT_NEW_CAPTURE');
  await setRecording(true);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · ON'`));
  await evaluate(page, `document.querySelector('textarea').remove();document.querySelector('button').remove();
    globalThis.requestOnlyPayload={action:'next',parent_message_id:'synthetic-parent',conversation_id:'synthetic-conversation',
      messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:['  REQUEST_ONLY_e\\u0301\\r\\n☕  ']}}]};
    globalThis.requestOnly=()=>fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(requestOnlyPayload)}).then(response=>response.text());
    requestOnly()`);
  await wait(() => runtime.session.receipts.list().length === 4);
  assert.equal(runtime.session.status().versions[3].inputMethod, 'provider-request');
  const probesBeforeRetry = await evaluate(workerSession, '__captureProbes.length');
  await evaluate(page, 'requestOnly()');
  await wait(() => evaluate(workerSession, `__captureProbes.slice(${probesBeforeRetry}).some(value=>value.state==='PROMPT_SAVED')`));
  assert.equal(runtime.session.receipts.list().length, 4);
  await evaluate(page, 'requestOnlyPayload.messages[0].id=crypto.randomUUID();requestOnly()');
  await wait(() => runtime.session.receipts.list().length === 5);
  assert.equal(await evaluate(page, 'providerSends'), 4, 'request-only captures have no button or Enter event');
  report.checks.push('REQUEST_WITHOUT_DOM_CONTROLS_SAVES_AND_STABLE_ID_RETRY_DEDUPLICATES');
  const routePolicyStart = await evaluate(workerSession, '__policies.length');
  await evaluate(page, `globalThis.heldTransport=[];globalThis.originalPostMessage=window.postMessage;
    window.postMessage=function(message,...args){
      if(message?.channel==='pap-chatgpt-transport/2'&&['request','ack'].includes(message.kind))heldTransport.push([message,...args]);
      else return Reflect.apply(originalPostMessage,this,[message,...args]);
    };requestOnlyPayload.messages[0].id=crypto.randomUUID();requestOnly()`);
  await wait(() => evaluate(page, `heldTransport.some(message=>message[0].kind==='request')
    &&document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · ON'`));
  await evaluate(page, `history.pushState(null,'','/c/next-conversation')`);
  await wait(() => evaluate(workerSession, `__policies.slice(${routePolicyStart}).some(value=>value.state==='READY'&&value.url==='https://chatgpt.com/c/next-conversation')`));
  assert.equal(runtime.session.receipts.list().length, 5);
  await evaluate(page, `window.postMessage=originalPostMessage;for(const args of heldTransport)Reflect.apply(originalPostMessage,window,args);heldTransport=[]`);
  await wait(() => runtime.session.receipts.list().length === 6);
  await wait(() => runtime.session.status().versions[5].acknowledgement?.conversationId === 'synthetic-conversation');
  assert.equal(runtime.session.status().versions[5].source.destination, 'conversation:synthetic-conversation');
  await evaluate(page, `requestOnlyPayload.conversation_id='next-conversation';requestOnlyPayload.messages[0].id=crypto.randomUUID();requestOnly()`);
  await wait(() => runtime.session.receipts.list().length === 7);
  assert.equal(runtime.session.status().versions[6].source.destination, 'conversation:next-conversation');
  report.checks.push('ADMITTED_CONVERSATION_REQUEST_AND_ACK_RETAIN_ORIGINAL_SOURCE_ACROSS_SAME_DOCUMENT_NAVIGATION');
  report.checks.push('SUBSEQUENT_REQUEST_USES_NEW_CONVERSATION_POLICY');
  await evaluate(page, `delete requestOnlyPayload.conversation_id;requestOnlyPayload.messages[0].id=crypto.randomUUID();
    requestOnlyPayload.feature_config={future:{image:{edit:true},attachment:['unattested'],voice:true}};requestOnly()`);
  await wait(() => runtime.session.receipts.list().length === 8);
  assert.equal(runtime.session.status().versions[7].request.conversationId, null);
  assert.equal(runtime.session.status().versions[7].source.destination, 'conversation:next-conversation');
  report.checks.push('MISSING_PROVIDER_CONVERSATION_AND_UNKNOWN_METADATA_PRESERVE_CAPTURE');
  const mixedText = '\uFEFF  MIXED_e\u0301\r\n☕\t';
  await evaluate(page, `requestOnlyPayload.conversation_id='different-provider-conversation';
    requestOnlyPayload.messages[0].id=crypto.randomUUID();
    requestOnlyPayload.messages[0].content={content_type:'future-multimodal',parts:${JSON.stringify([
      '\uFEFF  ', { text: 'MIXED_e\u0301\r\n' }, { content_type: 'image_asset_pointer', asset_pointer: 'SYNTHETIC_UNATTESTED_IMAGE' }, '☕\t'])}};requestOnly()`);
  await wait(() => runtime.session.receipts.list().length === 9);
  const mixed = runtime.session.status().versions[8];
  assert.equal(mixed.request.conversationId, 'different-provider-conversation');
  assert.equal(mixed.source.destination, 'conversation:next-conversation');
  const mixedPreview = runtime.session.receipts.prepare({ ids: [mixed.descriptorId] });
  assert.equal(mixedPreview.texts[0].preview, mixedText);
  report.checks.push('MIXED_TEXT_PARTS_SAVE_EXACTLY_WITH_SEPARATE_PROVIDER_AND_ROUTE_IDENTITIES');
  await evaluate(page, `requestOnlyPayload.messages[0].id=crypto.randomUUID();
    requestOnlyPayload.messages[0].content.parts=[{content_type:'image_asset_pointer',asset_pointer:'SYNTHETIC_MEDIA_ONLY'}];requestOnly()`);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · Recording gap'`));
  assert.equal(runtime.session.receipts.list().length, 9);
  report.checks.push('MEDIA_ONLY_REPORTS_GAP_WITHOUT_NEW_EVIDENCE_OR_PROVIDER_INTERFERENCE');
  for (const [index, name] of ['new-chat-text', 'existing-chat-text', 'new-chat-image', 'new-chat-file'].entries()) {
    const wire = await readFile(new URL(`./fixtures/chatgpt-wire/${name}.json`, import.meta.url), 'utf8');
    const body = JSON.parse(wire);
    await evaluate(page, `fetch('/backend-api/f/conversation',{method:'POST',body:${JSON.stringify(wire)}}).then(response=>response.text())`);
    await wait(() => runtime.session.receipts.list().length === 10 + index);
    const captured = runtime.session.status().versions.find(value => value.request.messageId === body.messages[0].id);
    assert.equal(captured.source.destination, 'conversation:next-conversation');
    assert.equal(captured.request.conversationId, body.conversation_id ?? null);
    const preview = runtime.session.receipts.prepare({ ids: [captured.descriptorId] });
    assert.equal(preview.texts[0].preview, `Wire fixture: ${name}.`);
  }
  report.checks.push('FOUR_SANITIZED_OWNER_REQUEST_SHAPES_SAVE_EXACT_TEXT_UNDER_AUTHENTICATED_CHROME_ROUTE');
  await setRecording(false);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status').hidden`));
  await evaluate(page, 'requestOnlyPayload.messages[0].id=crypto.randomUUID();requestOnly()');
  await delay(250);
  assert.equal(runtime.session.receipts.list().length, 13); assert.equal(interceptedSends, 17);
  report.checks.push('OFF_CUTOFF_ALSO_APPLIES_WITHOUT_DOM_CONTROLS');
  await setRecording(true);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · ON'`));
  await evaluate(workerSession, '__holdReplies=true');
  await evaluate(page, `requestOnlyPayload.messages[0].id=crypto.randomUUID();
    requestOnlyPayload.messages[0].content={content_type:'text',parts:['SYNTHETIC_DELAYED_SAVE_REPLY']};requestOnly()`);
  await wait(() => runtime.session.receipts.list().length === 14);
  await wait(() => evaluate(workerSession, '__lateReplies.length===2'));
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · Save not confirmed · Check History'`));
  assert.equal(interceptedSends, 18, 'local retries cannot repeat the provider request');
  await evaluate(workerSession, '__holdReplies=false;for(const reply of __lateReplies.splice(0))reply()');
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · Prompt saved'`));
  assert.equal(runtime.session.receipts.list().length, 14);
  report.checks.push('DURABLE_SAVE_REPLY_AFTER_BOTH_LOCAL_DEADLINES_STAYS_UNCONFIRMED_THEN_SAVED');
  const steeringWire = await readFile(new URL('./fixtures/chatgpt-wire/steer-turn.json', import.meta.url), 'utf8');
  const steeringBody = JSON.parse(steeringWire), steeringText = steeringBody.messages[1].content.parts[0];
  report.steeringFixtureSHA256 = createHash('sha256').update(steeringWire).digest('hex');
  await evaluate(page, `globalThis.steeringPayload=${steeringWire};globalThis.steeringResponse=false;
    document.body.insertAdjacentHTML('beforeend','<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>');
    document.querySelector('button').onclick=()=>{
      steeringPayload.messages[1].content.parts=[document.querySelector('textarea').value];
      fetch('/backend-api/f/steer_turn',{method:'POST',body:JSON.stringify(steeringPayload)})
        .then(response=>response.text()).then(()=>steeringResponse=true);
      document.querySelector('textarea').value='';
    }`);
  await send(steeringText);
  await wait(() => runtime.session.receipts.list().length === 15 && heldSteering.length === 1);
  await wait(() => evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent==='Attestamp · Prompt saved'`));
  await delay(1600);
  assert.equal(await evaluate(page, 'steeringResponse'), false);
  assert.equal(await evaluate(page, `document.getElementById('attestamp-recording-status')?.textContent`), 'Attestamp · Prompt saved');
  const steering = runtime.session.status().versions[14];
  assert.equal(steering.request.path, '/backend-api/f/steer_turn');
  assert.equal(steering.request.messageId, steeringBody.messages[1].id);
  assert.equal(steering.request.conversationId, steeringBody.conversation_id);
  assert.equal(steering.source.destination, 'conversation:next-conversation');
  const steeringPreview = runtime.session.receipts.prepare({ ids: [steering.descriptorId] });
  assert.equal(steeringPreview.texts[0].preview, steeringText);
  const held = heldSteering.shift();
  await call('Fetch.fulfillRequest', { requestId: held.params.requestId, responseCode: 200,
    body: Buffer.from('SYNTHETIC_STEERING_RESPONSE').toString('base64') }, held.sessionId);
  await wait(() => evaluate(page, 'steeringResponse'));
  assert.equal(runtime.session.receipts.list().length, 15); assert.equal(interceptedSends, 19);
  report.checks.push('OWNER_DERIVED_STEERING_SEND_SAVES_EXACTLY_BEFORE_RESPONSE_WITHOUT_ADVISORY_GAP');
  await setRecording(false);
  report.totalWrapperEffects = await evaluate(page, 'wrapperEffects');
  report.syntheticSends = interceptedSends;
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
