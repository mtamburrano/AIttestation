const token = location.hash.slice(1); history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
const dimensions = [['Structure', 'structure'], ['Integrity', 'integrity'], ['Key attribution', 'keyAttribution'],
  ['Evidence availability', 'evidenceAvailability'], ['Anchor assurance', 'anchor'], ['Timestamp assurance', 'timestamp'], ['Release control', 'releaseControl']];
async function api(path, data = {}) {
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
}
async function file(id, maximum, required) {
  const chosen = $(id).files[0]; if (!chosen) { if (required) throw Error('Select an evidence export'); return null; }
  if (chosen.size > maximum) throw Error('Selected file exceeds the size limit');
  return new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer());
}
$('verify').onclick = async () => {
  $('verify').disabled = true; $('status').textContent = 'Checking locally…'; $('results').replaceChildren(); $('report').textContent = '';
  try {
    const report = await api('/verify', { bundle: await file('bundle', 16 * 2 ** 20, true), trust: await file('trust', 64 * 1024, false) });
    for (const record of report.records) {
      const section = document.createElement('section'), title = document.createElement('h2'), table = document.createElement('table');
      title.textContent = `${record.derivative ? 'Redacted derivative' : 'Selected record'} · ${record.eventId ?? 'Unavailable identity'}`;
      section.append(title);
      for (const [label, key] of dimensions) {
        const row = document.createElement('tr'), name = document.createElement('th'), value = document.createElement('td');
        name.textContent = label; value.textContent = record[key]; row.append(name, value); table.append(row);
      }
      section.append(table);
      for (const assertion of record.localAssertions.filter(value => value.kind === 'release-cancelled')) {
        const note = document.createElement('p');
        note.textContent = `${assertion.association === 'UNASSOCIATED'
          ? 'Unassociated cancellation: no verified link to a selected frozen prompt.'
          : 'The client asserts that it cancelled this frozen prompt.'} ${assertion.claim}`;
        section.append(note);
      }
      $('results').append(section);
    }
    $('report').textContent = JSON.stringify(report, null, 2);
    $('status').textContent = `Local verification finished. ${report.records.length} selected records; trust ${report.trust.toLowerCase().replaceAll('_', ' ')}.`;
  } catch (error) { $('status').textContent = `Verification unavailable: ${error.message}`; }
  finally { $('verify').disabled = false; }
};
$('close').onclick = async () => { await api('/close'); $('status').textContent = 'Verifier closed.'; $('verify').disabled = true; };
