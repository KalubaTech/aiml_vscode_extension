// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const fields = ['endpoint', 'apiKey', 'projectId', 'defaultModel'];

  function readSettings() {
    return {
      endpoint: $('endpoint').value.trim(),
      apiKey: $('apiKey').value.trim(),
      projectId: $('projectId').value.trim(),
      defaultModel: $('defaultModel').value.trim(),
    };
  }
  function writeSettings(s) {
    for (const f of fields) {
      const el = $(f);
      if (el) el.value = s[f] || '';
    }
  }
  function setStatus(html) { $('status').innerHTML = html; }
  function setBusy(busy) {
    document.querySelectorAll('button').forEach((b) => (b.disabled = !!busy));
  }

  function escape(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── handlers ────────────────────────────────────────────────────────
  $('save').addEventListener('click', () => {
    const s = readSettings();
    if (!s.endpoint) { setStatus('<div class="alert err">Endpoint is required.</div>'); return; }
    if (!s.apiKey)   { setStatus('<div class="alert err">API key is required.</div>'); return; }
    setBusy(true);
    vscode.postMessage({ kind: 'save', settings: s });
  });
  $('test').addEventListener('click', () => {
    setStatus('<em>Testing connection…</em>');
    setBusy(true);
    vscode.postMessage({ kind: 'test', settings: readSettings() });
  });
  $('reveal').addEventListener('click', (e) => {
    e.preventDefault();
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('open-keys').addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ kind: 'openDashboard', settings: readSettings(), field: 'apiKey' });
  });
  $('open-projects').addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ kind: 'openDashboard', settings: readSettings(), field: 'projectId' });
  });
  $('get-started').addEventListener('click', () => {
    vscode.postMessage({ kind: 'getStarted', settings: readSettings() });
  });
  $('projectPicker').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id) $('projectId').value = id;
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.kind === 'current') {
      writeSettings(m.settings);
      setStatus('');
    } else if (m.kind === 'saved') {
      setBusy(false);
      setStatus('<div class="alert ok">✓ Saved. You can close this tab — the chat is in the AIML sidebar (activity bar).</div>');
    } else if (m.kind === 'test_result') {
      setBusy(false);
      const cls = m.ok ? 'ok' : 'err';
      const tag = m.ok ? '✓' : '×';
      let html = `<div class="alert ${cls}">${tag} ${escape(m.message).replace(/\n/g, '<br>')}</div>`;
      const picker = $('projectPicker');
      if (Array.isArray(m.projects) && m.projects.length) {
        picker.innerHTML = '<option value="">— pick a project to use —</option>' +
          m.projects.map((p) => `<option value="${escape(p.id)}"${p.id === $('projectId').value ? ' selected' : ''}>${escape(p.name)} (${escape(p.slug)})</option>`).join('');
        picker.style.display = '';
        html += `<p class="hint">Pick one from the dropdown below to autofill.</p>`;
      } else {
        picker.style.display = 'none';
      }
      setStatus(html);
    }
  });

  vscode.postMessage({ kind: 'ready' });
}());
