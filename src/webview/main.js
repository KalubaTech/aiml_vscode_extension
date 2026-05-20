// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const $messages    = $('messages');
  const $warnings    = $('warnings');
  const $status      = $('status');
  const $form        = $('composer');
  const $input       = $('input');
  const $send        = $('send');
  const $chips       = $('chips');

  const $btnAdd       = $('btn-add');
  const $btnModel     = $('btn-model');
  const $btnProfile   = $('btn-profile');
  const $btnSave      = $('btn-save');
  const $btnReset     = $('btn-reset');
  const $btnConfigure = $('btn-configure');
  const $btnOverflow  = $('btn-overflow');

  const $attachPop   = $('attach-popover');
  const $attUpload   = $('att-upload');
  const $attSearch   = $('att-search');
  const $attResults  = $('att-results');
  const $overflowPop = $('overflow-popover');
  const $footer      = document.querySelector('.composer-footer');

  const $sessionTitle = $('session-title');
  const $btnHistory   = $('btn-history');
  const $btnNewSession= $('btn-new-session');
  const $sessionsPop  = $('sessions-popover');
  const $sessionsList = $('sessions-list');
  const $progress     = $('progress');
  const $inputWrap    = $('input-wrap');

  /* ───── utils ───────────────────────────────────────────────────── */
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function md(src) {
    const text = String(src ?? '');
    const out = [];
    let i = 0;
    const lines = text.split('\n');
    const inlines = (s) => {
      let t = esc(s);
      t = t.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');
      t = t.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
        const safe = /^(https?:|mailto:)/.test(url) ? url : '#';
        return `<a href="${safe}" target="_blank" rel="noopener">${txt}</a>`;
      });
      return t;
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const buf = []; i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push(`<div class="code-block">
          <button class="copy-code"><span class="copy-text">Copy</span></button>
          <pre><code>${esc(buf.join('\n'))}</code></pre>
        </div>`); continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push(`<h${h[1].length}>${inlines(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^>\s/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push(`<blockquote>${inlines(buf.join('<br>'))}</blockquote>`); continue;
      }
      if (/^[-*+]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
          buf.push(`<li>${inlines(lines[i].replace(/^[-*+]\s+/, ''))}</li>`); i++;
        }
        out.push(`<ul>${buf.join('')}</ul>`); continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          buf.push(`<li>${inlines(lines[i].replace(/^\d+\.\s+/, ''))}</li>`); i++;
        }
        out.push(`<ol>${buf.join('')}</ol>`); continue;
      }
      if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (line.trim() === '') { i++; continue; }
      const para = [line]; i++;
      while (i < lines.length && lines[i].trim() !== '' &&
             !/^```|^#{1,6}\s|^>\s|^[-*+]\s|^\d+\.\s/.test(lines[i])) { para.push(lines[i]); i++; }
      out.push(`<p>${inlines(para.join(' '))}</p>`);
    }
    return out.join('');
  }

  function summarizeInput(input) {
    if (input == null) return '';
    if (typeof input !== 'object') return String(input);
    try { const s = JSON.stringify(input); return s.length > 220 ? s.slice(0, 220) + '…' : s; }
    catch { return String(input); }
  }
  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
  function scroll() { $messages.scrollTop = $messages.scrollHeight; }
  function basename(p) { return String(p).split(/[/\\]/).pop() || p; }

  /* ───── State ───────────────────────────────────────────────────── */
  let configured = false;
  let modelLabel = 'project default';
  let profileLabel = 'sign in';
  let attachments = [];
  let workspaceFiles = [];
  let attachOpen = false;
  let overflowOpen = false;
  let activeContext = null;     // { path, language, selection } | null
  let activeContextOn = true;
  let sessionsOpen = false;

  function shortenModel(m) {
    if (!m) return 'project default';
    const x = m.match(/claude-(opus|sonnet|haiku)-([\d-]+)/);
    if (x) return x[1].charAt(0).toUpperCase() + x[1].slice(1) + ' ' + x[2].replace(/-/g, '.').replace(/\.20\d{6}$/, '');
    return m.length > 22 ? m.slice(0, 20) + '…' : m;
  }

  /* ───── Footer rendering ───────────────────────────────────────── */
  function renderFooter() {
    $btnModel.textContent   = '✦ ' + shortenModel(modelLabel);
    $btnProfile.textContent = (configured ? '👤 ' : '⚠ ') + profileLabel;
    $btnModel.disabled = !configured;
    $btnSave.disabled = !configured;
    $btnAdd.disabled = !configured;
    $send.disabled = !configured;
    applyResponsive();
  }

  /** Hide pills/icons one by one when the composer is too narrow. */
  function applyResponsive() {
    if (!$footer) return;
    const width = $footer.clientWidth;
    // Reset all
    $btnProfile.classList.remove('hide');
    $btnSave.classList.remove('hide');
    $btnReset.classList.remove('hide');
    $btnConfigure.classList.remove('hide');
    $btnOverflow.classList.remove('show');

    // Tiered hiding — order: profile pill → save → configure → reset → (overflow visible)
    let hidden = false;
    if (width < 460) { $btnProfile.classList.add('hide');   hidden = true; }
    if (width < 400) { $btnSave.classList.add('hide');      hidden = true; }
    if (width < 360) { $btnConfigure.classList.add('hide'); hidden = true; }
    if (width < 320) { $btnReset.classList.add('hide');     hidden = true; }
    if (hidden) $btnOverflow.classList.add('show');
  }
  if (typeof ResizeObserver !== 'undefined' && $footer) {
    new ResizeObserver(applyResponsive).observe($footer);
  }

  function renderChips() {
    const parts = [];

    // Active editor (auto-managed). Toggle-only, no remove button.
    if (activeContextOn && activeContext) {
      const a = activeContext;
      const range = a.selection ? `:${a.selection.startLine}-${a.selection.endLine}` : '';
      parts.push(`
        <span class="chip chip-active" title="Currently open file — sent automatically as context">
          <span class="dot"></span>
          <span class="chip-name">${esc(basename(a.path))}${esc(range)}</span>
          <button class="chip-x" data-toggle-active title="Hide from context">×</button>
        </span>`);
    } else if (!activeContextOn) {
      parts.push(`
        <button class="chip chip-active chip-disabled" data-toggle-active type="button"
                title="Active-file context is hidden. Click to re-enable.">
          <span class="dot dot-off"></span>
          <span class="chip-name">active file: off</span>
        </button>`);
    }

    // Manual attachments
    for (const p of attachments) {
      parts.push(`
        <span class="chip" data-path="${esc(p)}" title="${esc(p)}">
          ${/^[A-Za-z]:\\|^\//.test(p) ? '⬆' : '📄'}
          <span class="chip-name">${esc(basename(p))}</span>
          <button class="chip-x" data-remove="${esc(p)}" title="Remove">×</button>
        </span>`);
    }

    if (parts.length === 0) {
      $chips.innerHTML = '';
      $chips.style.display = 'none';
      return;
    }
    $chips.style.display = '';
    $chips.innerHTML = parts.join('');
    $chips.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', () =>
        vscode.postMessage({ kind: 'removeAttachment', path: b.dataset.remove }),
      );
    });
    $chips.querySelectorAll('[data-toggle-active]').forEach((b) => {
      b.addEventListener('click', () => {
        activeContextOn = !activeContextOn;
        renderChips();
        vscode.postMessage({ kind: 'toggleActiveContext', enabled: activeContextOn });
      });
    });
  }

  /* ───── Popovers ───────────────────────────────────────────────── */
  function openAttachPopover() {
    if (!configured) { vscode.postMessage({ kind: 'signin' }); return; }
    attachOpen = true;
    $attachPop.hidden = false;
    $attSearch.value = '';
    vscode.postMessage({ kind: 'getWorkspaceFiles' });
    setTimeout(() => $attSearch.focus(), 30);
  }
  function closeAttachPopover() { attachOpen = false; $attachPop.hidden = true; }
  function toggleOverflow() {
    overflowOpen = !overflowOpen;
    $overflowPop.hidden = !overflowOpen;
  }
  function closeOverflow() { overflowOpen = false; $overflowPop.hidden = true; }

  // Click-outside to close popovers
  document.addEventListener('click', (e) => {
    if (attachOpen && !$attachPop.contains(e.target) && e.target !== $btnAdd) closeAttachPopover();
    if (overflowOpen && !$overflowPop.contains(e.target) && e.target !== $btnOverflow) closeOverflow();
    if (sessionsOpen && !$sessionsPop.contains(e.target) && e.target !== $btnHistory) closeSessionsPopover();
  });

  function closeSessionsPopover() { sessionsOpen = false; $sessionsPop.hidden = true; }
  function openSessionsPopover() {
    sessionsOpen = true;
    $sessionsPop.hidden = false;
    $sessionsList.innerHTML = '<div class="popover-empty">Loading…</div>';
    vscode.postMessage({ kind: 'listSessions' });
  }

  function renderSessions(list) {
    if (!list || !list.length) {
      $sessionsList.innerHTML = '<div class="popover-empty">No sessions yet.</div>';
      return;
    }
    $sessionsList.innerHTML = list.map((s) => {
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
      return `<div class="session-row ${s.active ? 'is-active' : ''}" data-id="${esc(s.id)}">
        <button type="button" class="session-pick" data-pick="${esc(s.id)}">
          <div class="session-row-title">${esc(s.title || 'Untitled')}</div>
          <div class="session-row-meta">${esc(String(s.messageCount || 0))} msg · ${esc(when)}${s.active ? ' · active' : ''}</div>
        </button>
        <button type="button" class="session-del" data-del="${esc(s.id)}" title="Delete session">🗑</button>
      </div>`;
    }).join('');
    $sessionsList.querySelectorAll('[data-pick]').forEach((b) => {
      b.addEventListener('click', () => {
        closeSessionsPopover();
        vscode.postMessage({ kind: 'switchSession', id: b.dataset.pick });
      });
    });
    $sessionsList.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ kind: 'deleteSession', id: b.dataset.del });
      });
    });
  }

  function setProgress(step, stepMax, label) {
    if (!step) { $progress.hidden = true; $progress.innerHTML = ''; return; }
    const pct = Math.max(4, Math.min(100, Math.round((step / Math.max(1, stepMax)) * 100)));
    $progress.hidden = false;
    $progress.innerHTML = `
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-label">step ${esc(String(step))}${stepMax ? ' / ' + esc(String(stepMax)) : ''}${label ? ' · ' + esc(label) : ''}</div>`;
  }

  function frameFor(toolUseId) {
    const frames = $messages.querySelectorAll('.tool-frame');
    for (const f of frames) if (f.dataset.toolId === toolUseId) return f;
    return null;
  }

  function renderApproval(payload) {
    // Used for terminal approvals only — edits auto-apply.
    const target = frameFor(payload.toolUseId);
    if (!target) return;
    try { target.open = true; } catch {}
    const body = target.querySelector('.tool-body');
    if (!body) return;
    const prior = body.querySelector('.approval-card'); if (prior) prior.remove();

    const card = el(`
      <div class="approval-card approval-terminal">
        <div class="approval-head">
          <span class="approval-icon">▶</span>
          <span class="approval-title">Approve terminal command${payload.cwd ? ` in <code>${esc(payload.cwd)}</code>` : ''}</span>
        </div>
        <pre class="approval-diff"><code>${esc(payload.command || '')}</code></pre>
        <div class="approval-actions">
          <button class="btn-primary" data-decision="run">Run</button>
          <button class="btn-danger" data-decision="reject">Cancel</button>
        </div>
      </div>`);
    card.querySelectorAll('[data-decision]').forEach((b) => {
      b.addEventListener('click', () => {
        vscode.postMessage({ kind: 'approveTool', toolUseId: payload.toolUseId, decision: b.dataset.decision });
        card.classList.add('is-decided');
        card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      });
    });
    body.appendChild(card);
    scroll();
  }

  function renderApplied(payload) {
    const target = frameFor(payload.toolUseId);
    if (!target) return;
    try { target.open = true; } catch {}
    const body = target.querySelector('.tool-body');
    if (!body) return;
    const prior = body.querySelector('.applied-card'); if (prior) prior.remove();

    const verb = payload.wasCreated ? 'Created' : 'Edited';
    const card = el(`
      <div class="applied-card" data-tool-id="${esc(payload.toolUseId)}">
        <div class="applied-head">
          <span class="applied-icon">✓</span>
          <span class="applied-title">${esc(verb)} <code>${esc(payload.path || '')}</code></span>
          <button class="btn-revert" data-revert title="Restore the previous content">↶ Revert</button>
        </div>
        <div class="applied-sub">${esc(payload.summary || '')}</div>
        <details class="applied-diff-wrap">
          <summary>Show diff</summary>
          <pre class="approval-diff"><code>${esc(payload.diffPreview || '(no preview)')}</code></pre>
        </details>
      </div>`);
    card.querySelector('[data-revert]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '… reverting';
      vscode.postMessage({ kind: 'revertEdit', toolUseId: payload.toolUseId });
    });
    body.appendChild(card);
    scroll();
  }

  function markReverted(payload) {
    const target = frameFor(payload.toolUseId);
    if (!target) return;
    const card = target.querySelector('.applied-card');
    if (!card) return;
    const btn = card.querySelector('[data-revert]');
    if (btn) { btn.disabled = true; btn.textContent = '✓ Reverted'; }
    card.classList.add('is-reverted');
    const note = el(`<div class="applied-note">Reverted to previous content.</div>`);
    card.appendChild(note);
  }

  function markRevertFailed(payload) {
    const target = frameFor(payload.toolUseId);
    if (!target) return;
    const card = target.querySelector('.applied-card');
    if (!card) return;
    const btn = card.querySelector('[data-revert]');
    if (btn) { btn.disabled = false; btn.textContent = '↶ Revert'; }
    const note = el(`<div class="applied-note applied-error">Revert failed: ${esc(payload.error || 'unknown')}</div>`);
    card.appendChild(note);
  }

  function renderWorkspaceFiles() {
    const q = $attSearch.value.trim().toLowerCase();
    const filtered = q
      ? workspaceFiles.filter((p) => p.toLowerCase().includes(q)).slice(0, 200)
      : workspaceFiles.slice(0, 200);
    if (!filtered.length) {
      $attResults.innerHTML = '<div class="popover-empty">No matching files.</div>';
      return;
    }
    $attResults.innerHTML = filtered.map((p) => {
      const segs = p.split(/[/\\]/);
      const name = segs.pop();
      const dir = segs.join('/');
      return `<button type="button" class="popover-item file-item" data-path="${esc(p)}">
        <span class="popover-icon">📄</span>
        <div class="file-info">
          <div class="file-name">${esc(name)}</div>
          ${dir ? `<div class="file-dir">${esc(dir)}</div>` : ''}
        </div>
      </button>`;
    }).join('');
    $attResults.querySelectorAll('[data-path]').forEach((b) => {
      b.addEventListener('click', () => {
        vscode.postMessage({ kind: 'attachWorkspaceFile', path: b.dataset.path });
        closeAttachPopover();
      });
    });
  }

  /* ───── Messages ───────────────────────────────────────────────── */
  function addUser(text) {
    // Only the most recent user message is sticky. Demote any prior one.
    $messages.querySelectorAll('.msg.user.sticky-latest').forEach((n) =>
      n.classList.remove('sticky-latest'),
    );
    const node = el(`
      <div class="msg user sticky-latest">
        <div class="row-head"><span class="who">You</span>
          <div class="actions"><button class="action-btn" data-edit title="Edit & resend">✎</button></div>
        </div>
        <div class="body">${esc(text)}</div>
      </div>`);
    node.querySelector('[data-edit]').addEventListener('click', () => {
      $input.value = text; $input.focus(); $input.setSelectionRange(text.length, text.length);
    });
    $messages.appendChild(node); scroll();
  }
  function addAssistant(text, meta) {
    const sources = meta && meta.ragSources && meta.ragSources.length
      ? ` · sources: ${meta.ragSources.map(esc).join(', ')}` : '';
    const warningsHtml = meta && meta.warnings && meta.warnings.length
      ? `<div class="inline-warning">⚠ ${meta.warnings.map(esc).join(' · ')}</div>` : '';
    const metaHtml = meta
      ? `<div class="meta">handler: <code>${esc(meta.handler)}</code> · ${meta.tokensIn ?? 0}/${meta.tokensOut ?? 0} tok · ${meta.latencyMs ?? 0}ms${
          meta.model ? ` · <code>${esc(meta.model)}</code>` : ''
        }${sources}</div>` : '';
    const node = el(`
      <div class="msg assistant${meta && meta.blocked ? ' blocked' : ''}">
        <div class="row-head"><span class="who">AIML</span></div>
        <div class="body">${md(text || '_(no reply)_')}</div>
        ${warningsHtml}${metaHtml}
      </div>`);
    wireCodeCopy(node);
    $messages.appendChild(node); scroll();
  }
  function addError(text) {
    const node = el(`<div class="msg error"><div class="row-head"><span class="who">Error</span></div><div class="body">${esc(text)}</div></div>`);
    $messages.appendChild(node);
    if (/api key not configured|project id not configured|not_authenticated/i.test(String(text || ''))) {
      const banner = el(`
        <div class="config-banner">
          <strong>You're not signed in.</strong> Authorize this editor.
          <div class="banner-actions">
            <button data-cmd="signin">Sign in to AIML</button>
            <button data-cmd="configure">Configure manually</button>
          </div>
        </div>`);
      banner.querySelector('[data-cmd="signin"]').addEventListener('click', () => vscode.postMessage({ kind: 'signin' }));
      banner.querySelector('[data-cmd="configure"]').addEventListener('click', () => vscode.postMessage({ kind: 'configure' }));
      $messages.appendChild(banner);
    }
    scroll();
  }
  function addToolUse(tool) {
    if (tool.name === 'todo_write') {
      addTodoFrame(tool);
      return;
    }
    const node = el(`
      <details class="tool-frame">
        <summary>
          <span class="tool-arrow">▶</span><span class="tool-icon">⚙</span>
          <span class="tool-name">${esc(tool.name)}</span>
          <span class="tool-summary">${esc(summarizeInput(tool.input))}</span>
          <span class="tool-spinner">…</span>
        </summary>
        <div class="tool-body">
          <div class="tool-section"><div class="tool-label">Input</div>
            <pre><code>${esc(JSON.stringify(tool.input, null, 2))}</code></pre></div>
          <div class="tool-section tool-result-section" style="display:none;">
            <div class="tool-label">Result</div>
            <pre><code class="tool-result-content"></code></pre>
          </div>
        </div>
      </details>`);
    node.dataset.toolId = tool.id;
    $messages.appendChild(node); scroll();
  }

  function addTodoFrame(tool) {
    const todos = Array.isArray(tool.input && tool.input.todos) ? tool.input.todos : [];
    const completed = todos.filter((t) => t.status === 'completed').length;
    const total = todos.length;
    const inProgress = todos.find((t) => t.status === 'in_progress');
    const headline = inProgress
      ? esc(inProgress.activeForm || inProgress.content || 'Working…')
      : (completed === total && total > 0 ? 'All steps done' : 'Plan');

    const rows = todos.map((t) => {
      const s = t.status || 'pending';
      const icon = s === 'completed' ? '☑' : s === 'in_progress' ? '◐' : '☐';
      const label = s === 'in_progress' ? (t.activeForm || t.content || '') : (t.content || '');
      return `<li class="todo-item is-${esc(s)}">
        <span class="todo-icon">${icon}</span>
        <span class="todo-label">${esc(label)}</span>
      </li>`;
    }).join('');

    const node = el(`
      <details class="todo-frame" open>
        <summary>
          <span class="tool-arrow">▶</span>
          <span class="todo-headline">📋 ${esc(headline)}</span>
          <span class="todo-progress">${completed} / ${total}</span>
        </summary>
        <ul class="todo-list">${rows || '<li class="todo-empty">(empty)</li>'}</ul>
      </details>`);
    node.dataset.toolId = tool.id;
    $messages.appendChild(node); scroll();
  }
  function addToolResult(result) {
    // todo_write frames don't carry a spinner/result section — skip silently.
    const todoFrames = $messages.querySelectorAll('.todo-frame');
    for (const f of todoFrames) if (f.dataset.toolId === result.id) return;

    const frames = $messages.querySelectorAll('.tool-frame');
    let target;
    for (const f of frames) if (f.dataset.toolId === result.id) { target = f; break; }
    if (!target) target = frames[frames.length - 1]; if (!target) return;
    const spin = target.querySelector('.tool-spinner');
    if (spin) spin.textContent = result.isError ? '✗' : '✓';
    target.classList.add(result.isError ? 'is-error' : 'is-ok');
    const section = target.querySelector('.tool-result-section');
    const content = target.querySelector('.tool-result-content');
    if (section && content) {
      section.style.display = '';
      content.textContent = (result.content || '').slice(0, 4000) + ((result.content || '').length > 4000 ? '\n… (truncated)' : '');
    }
    scroll();
  }
  function wireCodeCopy(scope) {
    scope.querySelectorAll('.copy-code').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = btn.parentElement.querySelector('code')?.textContent || '';
        try {
          await navigator.clipboard.writeText(code);
          const t = btn.querySelector('.copy-text');
          if (t) { t.textContent = 'Copied'; setTimeout(() => { if (t) t.textContent = 'Copy'; }, 1200); }
        } catch {}
      });
    });
  }
  function welcome() {
    $messages.innerHTML = `<div class="msg assistant welcome">
      <div class="row-head"><span class="who">AIML</span></div>
      <div class="body">${md(
        `Hi — I'm your AIML coding agent. I can read files, list the workspace, check diagnostics, run tests, and **apply edits with your approval**.\n\n` +
        `**Try:**\n` +
        `- *Refactor the active selection to be testable.*\n` +
        `- *Find every TODO in this project.*\n\n` +
        `**Tip:** the file you're editing is already in context. Click **＋** to add more.`
      )}</div></div>`;
  }

  /** Re-render the persisted transcript on view restore. */
  function restoreTranscript(entries, savedAt) {
    if (!entries.length) return;
    $messages.innerHTML = '';
    // Header pill so the user knows this is restored context.
    const head = el(`
      <div class="restore-banner">
        <span class="dot"></span>
        Continuing your previous session
        <span class="ts">${savedAt ? '· last activity ' + new Date(savedAt).toLocaleString() : ''}</span>
        <button class="restore-clear" title="Start fresh">Reset</button>
      </div>`);
    head.querySelector('.restore-clear').addEventListener('click', () => vscode.postMessage({ kind: 'reset' }));
    $messages.appendChild(head);

    for (const e of entries) {
      if (e.role === 'user') {
        addUser(stripContextHeaders(e.content));
      } else if (e.role === 'assistant') {
        addAssistant(e.content || '', e.meta);
      } else if (e.role === 'tool_use') {
        try {
          const t = JSON.parse(e.content);
          addToolUse({ id: 'restored-' + Math.random().toString(36).slice(2, 8), name: t.name, input: t.input });
        } catch { /* skip malformed */ }
      } else if (e.role === 'tool_result') {
        // Best-effort: attach to the most recent tool frame.
        const frames = $messages.querySelectorAll('.tool-frame');
        const target = frames[frames.length - 1];
        if (target) {
          addToolResult({ id: target.dataset.toolId, content: e.content, isError: e.meta && e.meta.isError });
        }
      } else if (e.role === 'error') {
        addError(e.content);
      }
    }
    scroll();
  }

  /** When rendering user messages from the persisted transcript, strip the
   *  auto-added context headers so the bubble looks like what the user typed. */
  function stripContextHeaders(s) {
    return String(s || '')
      .replace(/^\*\*Active editor:\*\*[^\n]*\n+/, '')
      .replace(/^\*\*Workspace files \(use read_file as needed\):\*\*[\s\S]*?\n\n/, '')
      .replace(/^\*\*Uploaded file:[\s\S]*?```\n+/m, '');
  }
  function setBusy(busy) {
    $status.classList.toggle('busy', !!busy);
    $status.textContent = busy ? 'Thinking…' : '';
    $send.disabled = !!busy || !configured;
    if ($inputWrap) $inputWrap.classList.toggle('is-busy', !!busy);
  }
  function setWarning(text) {
    if (!text) { $warnings.innerHTML = ''; $warnings.style.display = 'none'; return; }
    $warnings.style.display = '';
    $warnings.innerHTML = `<div class="banner">⚠ ${esc(text)}</div>`;
  }

  /* ───── Handlers ───────────────────────────────────────────────── */
  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $input.value.trim();
    if (!text) return;
    if (!configured) { vscode.postMessage({ kind: 'signin' }); return; }
    addUser(text);
    vscode.postMessage({ kind: 'send', text });
    $input.value = '';
  });
  $input.addEventListener('keydown', (e) => {
    // Enter sends. Shift+Enter inserts a newline. Cmd/Ctrl+Enter also sends
    // (kept for muscle memory). IME composition (e.isComposing) is left alone.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $form.requestSubmit();
    }
    if (e.key === 'Escape') { closeAttachPopover(); closeOverflow(); }
  });

  $btnAdd      .addEventListener('click', (e) => { e.stopPropagation(); closeOverflow(); openAttachPopover(); });
  $btnModel    .addEventListener('click', () => vscode.postMessage({ kind: 'switchModel' }));
  $btnProfile  .addEventListener('click', () => vscode.postMessage(configured ? { kind: 'switchProfile' } : { kind: 'signin' }));
  $btnSave     .addEventListener('click', () => vscode.postMessage({ kind: 'save' }));
  $btnReset    .addEventListener('click', () => vscode.postMessage({ kind: 'reset' }));
  $btnConfigure.addEventListener('click', () => vscode.postMessage({ kind: 'configure' }));
  $btnOverflow .addEventListener('click', (e) => { e.stopPropagation(); closeAttachPopover(); toggleOverflow(); });

  $btnNewSession.addEventListener('click', () => vscode.postMessage({ kind: 'newSession' }));
  $btnHistory   .addEventListener('click', (e) => {
    e.stopPropagation();
    if (sessionsOpen) closeSessionsPopover();
    else openSessionsPopover();
  });
  $sessionTitle .addEventListener('click', () => {
    // Open the history popover so the user can pick or start a new session.
    if (sessionsOpen) closeSessionsPopover();
    else openSessionsPopover();
  });

  $attUpload   .addEventListener('click', () => { closeAttachPopover(); vscode.postMessage({ kind: 'uploadFromComputer' }); });
  $attSearch   .addEventListener('input', () => {
    // Re-query the server on each keystroke so paginated results follow the filter.
    vscode.postMessage({ kind: 'getWorkspaceFiles', query: $attSearch.value.trim() });
  });

  $overflowPop.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      closeOverflow();
      const act = b.dataset.act;
      if (act === 'save') vscode.postMessage({ kind: 'save' });
      else if (act === 'reset') vscode.postMessage({ kind: 'reset' });
      else if (act === 'profile') vscode.postMessage({ kind: 'switchProfile' });
      else if (act === 'configure') vscode.postMessage({ kind: 'configure' });
    });
  });

  /* ───── Inbox ──────────────────────────────────────────────────── */
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    switch (m.kind) {
      case 'state':
        configured = !!m.configured;
        profileLabel = m.profile || (configured ? 'default' : 'sign in');
        modelLabel = m.model || 'project default';
        attachments = m.attachments || [];
        renderFooter(); renderChips();
        if (!configured) setWarning('Not signed in. Click the profile pill or the gear icon to configure.');
        else setWarning('');
        break;
      case 'attachments':  attachments = m.paths || []; renderChips(); break;
      case 'activeContext':
        activeContext = m.context || null;
        activeContextOn = m.enabled !== false;
        renderChips();
        break;
      case 'restoreTranscript':
        restoreTranscript(m.entries || [], m.savedAt);
        break;
      case 'workspaceFiles':
        workspaceFiles = m.files || [];
        if (attachOpen) renderWorkspaceFiles();
        break;
      case 'openAttachPopover': openAttachPopover(); break;
      case 'user':         addUser(m.text); break;
      case 'assistant':    addAssistant(m.text || '', m.meta); break;
      case 'tool':         if (m.phase === 'call') addToolUse(m.tool || {}); if (m.phase === 'result') addToolResult(m.result || {}); break;
      case 'error':        addError(m.text || 'unknown error'); break;
      case 'busy':
        setBusy(m.busy);
        if (!m.busy) setProgress(0);
        break;
      case 'reset':        welcome(); break;
      case 'status':       $status.textContent = m.text; break;
      case 'header':
        if ($sessionTitle && typeof m.title === 'string') $sessionTitle.textContent = m.title;
        break;
      case 'progress':     setProgress(m.step, m.stepMax, m.label); break;
      case 'toolApproval': renderApproval(m); break;
      case 'toolApplied':  renderApplied(m); break;
      case 'toolReverted': markReverted(m); break;
      case 'toolRevertFailed': markRevertFailed(m); break;
      case 'sessions':     renderSessions(m.sessions || []); break;
    }
  });

  welcome(); renderFooter(); renderChips();
  vscode.postMessage({ kind: 'ready' });
}());
