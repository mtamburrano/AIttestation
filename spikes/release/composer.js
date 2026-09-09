const key = location.hash.slice(1);
history.replaceState(null, '', '/');
const scope = crypto.randomUUID();
let seal, generation = 0;
const $ = id => document.getElementById(id);
async function api(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
async function payload() {
  const text = $('draft').value;
  const attachments = await Promise.all([...$('files').files].map(async f => {
    if (f.size > 100000) throw Error('Synthetic attachment limit: 100000 bytes');
    const bytes = new Uint8Array(await f.arrayBuffer());
    return { name: f.name, bytes: btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')) };
  }));
  return { text, attachments };
}
function invalidate() {
  generation++; seal = null; $('confirm').disabled = $('release').disabled = true;
  $('status').textContent = 'Draft changed locally. Freeze a new version before release.';
}
$('draft').addEventListener('input', invalidate);
$('files').addEventListener('change', invalidate);
function action(id, fn) {
  $(id).onclick = async () => { try { await fn(); } catch (e) { $('status').textContent = e.message; } };
}
action('seal', async () => {
  const version = generation;
  const result = await api('/seal', { scope, payload: await payload() });
  if (version !== generation) return;
  seal = result; $('confirm').disabled = false; $('release').disabled = true;
  $('status').textContent = 'Frozen locally. Waiting for test confirmation; nothing released.';
});
action('confirm', async () => {
  const selected = seal;
  await api('/confirm', { id: selected.id, scope, expectedDigest: selected.digest });
  if (seal !== selected) return;
  $('confirm').disabled = true; $('release').disabled = false;
  $('status').textContent = 'Test confirmation accepted. Frozen version may be released once.';
});
action('release', async () => {
  const selected = seal;
  const currentPayload = await payload();
  if (seal !== selected) throw Error('Draft changed');
  $('release').disabled = true;
  const result = await api('/release', { id: selected.id, scope, expectedDigest: selected.digest, currentPayload });
  $('status').textContent = `${result.state}. Provider receipt: UNKNOWN.`;
});
try {
  const info = await api('/scope', { scope });
  $('capabilities').textContent = JSON.stringify(info.capabilities, null, 2);
  $('provider').href = info.providerOrigin;
  $('status').textContent = 'Ready for synthetic local input.';
} catch (e) { $('status').textContent = e.message; $('seal').disabled = true; }
