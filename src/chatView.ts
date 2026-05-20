/**
 * Sidebar chat view + matching panel view.
 *
 * Keeps an in-memory transcript so the user can save the session to a local
 * Markdown file, and a list of attached file paths that prefix the next
 * outgoing user message as compact context.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { AimlClient, type AgentUpdate } from './aimlClient';
import { WorkspaceToolExecutor, type ApprovalProvider } from './tools';
import { recordTurn, resetSession } from './statusBar';
import { getEffectiveConfig } from './profiles';

interface TranscriptEntry {
  ts: Date;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  meta?: Record<string, unknown>;
}

interface ActiveContext {
  path: string;
  language: string;
  selection: { startLine: number; endLine: number } | null;
}

interface PersistedSession {
  id: string;
  title: string;
  conversationId?: string;
  profileId?: string;
  projectId?: string;
  transcript: TranscriptEntry[];
  createdAt: string;
  updatedAt: string;
}

const SESSIONS_KEY = 'aiml.sessions.v2';
const ACTIVE_SESSION_KEY = 'aiml.activeSession.v2';
const MAX_PERSISTED_ENTRIES = 200;
const MAX_SESSIONS = 30;

export class ChatViewProvider implements vscode.WebviewViewProvider, ApprovalProvider {
  public static readonly viewType = 'aiml.chatView';

  private view?: vscode.WebviewView;
  private activeSessionId: string = '';
  private conversationId: string | undefined;
  private busy = false;
  private attachments: string[] = [];
  /** Computer-uploaded files: path → text content, included inline on next send. */
  private inlineUploads: Record<string, string> = {};
  private transcript: TranscriptEntry[] = [];
  private activeContext: ActiveContext | null = null;
  private activeContextEnabled = true;
  private persistTimer: NodeJS.Timeout | undefined;
  /** Pending approval requests keyed by toolUseId → resolver. */
  private pendingApprovals = new Map<string, (decision: string) => void>();
  /** Revert data for auto-applied edits, keyed by toolUseId. */
  private pendingReverts = new Map<string, { path: string; before: string; wasCreated: boolean }>();
  /** Current session title (auto from first user msg). */
  private sessionTitle = 'New conversation';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: AimlClient,
    private readonly context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')],
    };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg.kind) {
        case 'ready':
          this.postState();
          this.restoreSession();
          break;
        case 'toggleActiveContext':
          this.activeContextEnabled = !!msg.enabled;
          this.postActiveContext();
          break;
        case 'send':
          if (typeof msg.text === 'string') await this.runTurn(msg.text);
          break;
        case 'reset':
          this.resetConversation();
          break;
        case 'configure':
          await vscode.commands.executeCommand('aiml.configure');
          break;
        case 'signin':
          await vscode.commands.executeCommand('aiml.signIn');
          break;
        case 'openDashboard':
          await vscode.commands.executeCommand('aiml.openDashboard');
          break;
        case 'switchModel':
          await vscode.commands.executeCommand('aiml.switchModel');
          break;
        case 'switchProfile':
          await vscode.commands.executeCommand('aiml.switchProfile');
          break;
        case 'save':
          await this.saveConversationToFile();
          break;
        case 'addContext':
          // Legacy menu entry — keep working but also send the workspace file list
          // so the inline picker can populate.
          await this.sendWorkspaceFiles();
          break;
        case 'getWorkspaceFiles':
          await this.sendWorkspaceFiles(typeof msg.query === 'string' ? msg.query : undefined);
          break;
        case 'attachWorkspaceFile':
          if (typeof msg.path === 'string' && !this.attachments.includes(msg.path)) {
            this.attachments.push(msg.path);
            this.post({ kind: 'attachments', paths: this.attachments });
          }
          break;
        case 'uploadFromComputer':
          await this.uploadFromComputer();
          break;
        case 'approveTool': {
          const cb = this.pendingApprovals.get(msg.toolUseId);
          if (cb) cb(msg.decision || 'reject');
          this.pendingApprovals.delete(msg.toolUseId);
          break;
        }
        case 'revertEdit': {
          if (typeof msg.toolUseId === 'string') await this.revertEdit(msg.toolUseId);
          break;
        }
        case 'newSession':
          this.startNewSession();
          break;
        case 'switchSession':
          if (typeof msg.id === 'string') await this.switchSession(msg.id);
          break;
        case 'listSessions':
          this.post({ kind: 'sessions', sessions: this.listSessionsSummary() });
          break;
        case 'deleteSession':
          if (typeof msg.id === 'string') await this.deleteSession(msg.id);
          break;
        case 'removeAttachment':
          if (typeof msg.path === 'string') {
            this.attachments = this.attachments.filter((p) => p !== msg.path);
            delete this.inlineUploads[msg.path];
            this.post({ kind: 'attachments', paths: this.attachments });
          }
          break;
      }
    });
  }

  /** Programmatic entry — used by the editor-context commands. */
  async sendPrompt(text: string): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand('workbench.view.extension.aiml-sidebar');
    }
    this.post({ kind: 'user', text });
    await this.runTurn(text);
  }

  resetConversation(): void {
    // "Reset" now means "start a new session" — keeps the old one in
    // history rather than deleting it.
    this.startNewSession();
    this.postActiveContext();
  }

  /** Called from extension.ts on every active-editor change. */
  setActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      this.activeContext = null;
      this.postActiveContext();
      return;
    }
    const doc = editor.document;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
      // Skip output channels, search views, etc.
      this.activeContext = null;
      this.postActiveContext();
      return;
    }
    const sel = editor.selection;
    this.activeContext = {
      path: vscode.workspace.asRelativePath(doc.uri),
      language: doc.languageId,
      selection: sel && !sel.isEmpty ? { startLine: sel.start.line + 1, endLine: sel.end.line + 1 } : null,
    };
    this.postActiveContext();
  }

  private postActiveContext(): void {
    this.post({
      kind: 'activeContext',
      context: this.activeContextEnabled ? this.activeContext : null,
      enabled: this.activeContextEnabled,
    });
  }

  /** Legacy entry point — opens the inline picker if a view is mounted,
   *  otherwise falls back to the native dialog. Wired to `aiml.addContext`. */
  async pickContextFile(): Promise<void> {
    if (this.view) {
      await this.sendWorkspaceFiles();
      this.post({ kind: 'openAttachPopover' });
      return;
    }
    // No view yet — fallback for the command-palette invocation.
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Attach to chat',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!uris || uris.length === 0) return;
    for (const u of uris) {
      const rel = vscode.workspace.asRelativePath(u);
      if (!this.attachments.includes(rel)) this.attachments.push(rel);
    }
    this.post({ kind: 'attachments', paths: this.attachments });
  }

  /** Send the webview a list of workspace files matching an optional fuzzy query. */
  private async sendWorkspaceFiles(query?: string): Promise<void> {
    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**}';
    const include = query ? `**/${query}*` : '**/*';
    const uris = await vscode.workspace.findFiles(include, exclude, 500);
    const files = uris.map((u) => vscode.workspace.asRelativePath(u));
    this.post({ kind: 'workspaceFiles', files });
  }

  /** Pick a file outside the workspace, read its text content, attach inline. */
  private async uploadFromComputer(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Upload to chat',
    });
    if (!uris || uris.length === 0) return;
    const limitBytes = 64 * 1024;
    for (const u of uris) {
      const label = u.fsPath;
      try {
        const stat = await vscode.workspace.fs.stat(u);
        if (stat.size > limitBytes) {
          void vscode.window.showWarningMessage(
            `Skipping ${path.basename(u.fsPath)} — file is ${Math.round(stat.size / 1024)} KB, max 64 KB for inline uploads.`,
          );
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(u);
        const text = Buffer.from(bytes).toString('utf8');
        // Crude binary check
        if (/ /.test(text)) {
          void vscode.window.showWarningMessage(`Skipping ${path.basename(u.fsPath)} — looks like a binary file.`);
          continue;
        }
        this.inlineUploads[label] = text;
        if (!this.attachments.includes(label)) this.attachments.push(label);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Could not read ${path.basename(u.fsPath)}: ${(err as Error).message}`,
        );
      }
    }
    this.post({ kind: 'attachments', paths: this.attachments });
  }

  /** Save the current transcript as a Markdown file. */
  async saveConversationToFile(): Promise<void> {
    if (this.transcript.length === 0) {
      void vscode.window.showInformationMessage('Nothing to save yet — start a conversation first.');
      return;
    }
    const cfg = getEffectiveConfig();
    const defaultName = `aiml-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Save AIML conversation',
      defaultUri: vscode.Uri.file(
        path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.', defaultName),
      ),
      filters: { Markdown: ['md'] },
    });
    if (!target) return;
    const body = this.renderMarkdown(cfg.activeLabel);
    await vscode.workspace.fs.writeFile(target, Buffer.from(body, 'utf8'));
    void vscode.window.showInformationMessage('Conversation saved.', 'Open file').then((pick) => {
      if (pick === 'Open file') void vscode.commands.executeCommand('vscode.open', target);
    });
  }

  // ── internals ───────────────────────────────────────────────────────────

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  /** Tell the webview the current profile / model so the footer can render it. */
  private postState(): void {
    const cfg = getEffectiveConfig();
    this.post({
      kind: 'state',
      configured: !!(cfg.apiKey && cfg.projectId),
      profile: cfg.activeLabel,
      model: cfg.defaultModel || 'project default',
      attachments: this.attachments,
    });
  }

  private async runTurn(text: string): Promise<void> {
    if (this.busy) {
      this.post({ kind: 'status', text: 'Already running — wait for the current turn to finish.' });
      return;
    }
    this.busy = true;
    this.post({ kind: 'busy', busy: true });

    // Build the message in three layers:
    //   1) Active editor (live context) — what the user is currently looking at
    //   2) Manual attachments (workspace paths + inlined uploads)
    //   3) The user's typed text
    let outgoing = text;
    const parts: string[] = [];

    // Active editor (auto)
    if (this.activeContextEnabled && this.activeContext) {
      const a = this.activeContext;
      const range = a.selection ? ` (lines ${a.selection.startLine}–${a.selection.endLine} selected)` : '';
      parts.push(`**Active editor:** \`${a.path}\` · ${a.language}${range}`);
    }

    // Manual attachments
    if (this.attachments.length > 0) {
      const wsRefs: string[] = [];
      const inlineBlocks: string[] = [];
      for (const p of this.attachments) {
        if (this.inlineUploads[p]) {
          const name = path.basename(p);
          inlineBlocks.push(
            `**Uploaded file: \`${name}\`** (\`${p}\`)\n\n\`\`\`\n${this.inlineUploads[p]}\n\`\`\``,
          );
        } else {
          wsRefs.push(`- \`${p}\``);
        }
      }
      if (wsRefs.length) parts.push(`**Workspace files (use read_file as needed):**\n${wsRefs.join('\n')}`);
      if (inlineBlocks.length) parts.push(inlineBlocks.join('\n\n'));
    }

    parts.push(text);
    outgoing = parts.length === 1 ? text : parts.join('\n\n');

    // If this is the first user message in the session, set the title.
    if (this.transcript.filter((e) => e.role === 'user').length === 0) {
      this.sessionTitle = this.deriveTitle(text);
      this.postHeader();
    }
    this.transcript.push({ ts: new Date(), role: 'user', content: outgoing });
    this.persist();

    try {
      const executor = new WorkspaceToolExecutor(this);
      const { conversationId } = await this.client.chat({
        message: outgoing,
        conversationId: this.conversationId,
        executor,
        onUpdate: (u) => this.dispatch(u),
      });
      this.conversationId = conversationId;
      // Clear attachments only after success so user can retry on error.
      this.attachments = [];
      this.inlineUploads = {};
      this.post({ kind: 'attachments', paths: this.attachments });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.transcript.push({ ts: new Date(), role: 'error', content: msg });
      this.post({ kind: 'error', text: msg });
    } finally {
      this.busy = false;
      this.post({ kind: 'busy', busy: false });
    }
  }

  // ── Multi-session storage ─────────────────────────────────────────────

  private readAllSessions(): Record<string, PersistedSession> {
    return this.context.workspaceState.get<Record<string, PersistedSession>>(SESSIONS_KEY) ?? {};
  }
  private async writeAllSessions(s: Record<string, PersistedSession>): Promise<void> {
    await this.context.workspaceState.update(SESSIONS_KEY, s);
  }
  private deriveTitle(text: string): string {
    const first = text.trim().split('\n').find((l) => l.trim().length > 0) ?? text;
    return first.length > 60 ? first.slice(0, 60).trim() + '…' : first;
  }

  /** Debounced save of the active session. */
  private persist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persistNow();
    }, 250);
  }

  private async persistNow(): Promise<void> {
    if (!this.activeSessionId) this.activeSessionId = randomBytes(6).toString('hex');
    const cfg = getEffectiveConfig();
    const sessions = this.readAllSessions();
    const existing = sessions[this.activeSessionId];
    const nowIso = new Date().toISOString();
    sessions[this.activeSessionId] = {
      id: this.activeSessionId,
      title: this.sessionTitle,
      conversationId: this.conversationId,
      profileId: cfg.activeLabel,
      projectId: cfg.projectId,
      transcript: this.transcript.slice(-MAX_PERSISTED_ENTRIES),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    // Cap total sessions: drop the oldest if over the limit.
    const ids = Object.keys(sessions);
    if (ids.length > MAX_SESSIONS) {
      const sorted = ids
        .map((id) => sessions[id]!)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const drop = sorted.slice(0, sorted.length - MAX_SESSIONS);
      for (const s of drop) delete sessions[s.id];
    }
    await this.writeAllSessions(sessions);
    await this.context.workspaceState.update(ACTIVE_SESSION_KEY, this.activeSessionId);
  }

  /** Load the active session (or pick the most recent one). */
  private restoreSession(): void {
    const sessions = this.readAllSessions();
    const cfg = getEffectiveConfig();

    let id = this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY, '');
    if (!id || !sessions[id]) {
      // Pick the most recent session that matches the current project.
      const list = Object.values(sessions)
        .filter((s) => !s.projectId || s.projectId === cfg.projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      id = list[0]?.id ?? '';
    }
    if (!id) return;

    const saved = sessions[id];
    if (!saved || saved.transcript.length === 0) return;

    // If the saved session belongs to a different project than the active
    // profile, don't auto-restore — it would mix contexts. The user can
    // pick it from the history menu.
    if (saved.projectId && cfg.projectId && saved.projectId !== cfg.projectId) return;

    this.activeSessionId = saved.id;
    this.conversationId = saved.conversationId;
    this.transcript = saved.transcript;
    this.sessionTitle = saved.title;
    this.post({ kind: 'restoreTranscript', entries: saved.transcript, savedAt: saved.updatedAt });
    this.postHeader();
  }

  private startNewSession(): void {
    this.activeSessionId = randomBytes(6).toString('hex');
    this.conversationId = undefined;
    this.attachments = [];
    this.inlineUploads = {};
    this.transcript = [];
    this.sessionTitle = 'New conversation';
    resetSession();
    void this.context.workspaceState.update(ACTIVE_SESSION_KEY, this.activeSessionId);
    this.post({ kind: 'reset' });
    this.postHeader();
    this.postState();
  }

  private async switchSession(id: string): Promise<void> {
    const sessions = this.readAllSessions();
    const s = sessions[id];
    if (!s) return;
    this.activeSessionId = s.id;
    this.conversationId = s.conversationId;
    this.transcript = s.transcript;
    this.sessionTitle = s.title;
    await this.context.workspaceState.update(ACTIVE_SESSION_KEY, id);
    this.post({ kind: 'restoreTranscript', entries: s.transcript, savedAt: s.updatedAt });
    this.postHeader();
  }

  private async deleteSession(id: string): Promise<void> {
    const sessions = this.readAllSessions();
    if (!sessions[id]) return;
    delete sessions[id];
    await this.writeAllSessions(sessions);
    if (id === this.activeSessionId) this.startNewSession();
    this.post({ kind: 'sessions', sessions: this.listSessionsSummary() });
  }

  private listSessionsSummary(): Array<{
    id: string;
    title: string;
    updatedAt: string;
    active: boolean;
    messageCount: number;
  }> {
    const sessions = this.readAllSessions();
    return Object.values(sessions)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        active: s.id === this.activeSessionId,
        messageCount: s.transcript.length,
      }));
  }

  private postHeader(): void {
    this.post({ kind: 'header', title: this.sessionTitle });
  }

  // ── ApprovalProvider implementation ───────────────────────────────────

  notifyEditApplied(args: {
    toolUseId: string;
    path: string;
    summary: string;
    diffPreview: string;
    before: string;
    wasCreated: boolean;
  }): void {
    this.pendingReverts.set(args.toolUseId, {
      path: args.path,
      before: args.before,
      wasCreated: args.wasCreated,
    });
    this.post({
      kind: 'toolApplied',
      toolUseId: args.toolUseId,
      path: args.path,
      summary: args.summary,
      diffPreview: args.diffPreview,
      wasCreated: args.wasCreated,
    });
  }

  private async revertEdit(toolUseId: string): Promise<void> {
    const data = this.pendingReverts.get(toolUseId);
    if (!data) {
      this.post({ kind: 'toolRevertFailed', toolUseId, error: 'No revert data available (already reverted?)' });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      this.post({ kind: 'toolRevertFailed', toolUseId, error: 'No workspace folder' });
      return;
    }
    const uri = vscode.Uri.joinPath(root.uri, data.path);
    try {
      if (data.wasCreated) {
        // Restore by deleting the file we created.
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } catch (err) {
          this.post({
            kind: 'toolRevertFailed',
            toolUseId,
            error: `Could not delete ${data.path}: ${(err as Error).message}`,
          });
          return;
        }
      } else {
        // Overwrite the file with its original content.
        const we = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(uri);
        const range = new vscode.Range(0, 0, doc.lineCount, 0);
        we.replace(uri, range, data.before);
        const ok = await vscode.workspace.applyEdit(we);
        if (!ok) {
          this.post({ kind: 'toolRevertFailed', toolUseId, error: 'applyEdit returned false' });
          return;
        }
        try { if (doc.isDirty) await doc.save(); } catch { /* best-effort */ }
      }
      this.pendingReverts.delete(toolUseId);
      this.post({ kind: 'toolReverted', toolUseId, path: data.path });
    } catch (err) {
      this.post({
        kind: 'toolRevertFailed',
        toolUseId,
        error: (err as Error).message,
      });
    }
  }

  requestTerminalApproval(args: {
    toolUseId: string;
    command: string;
    cwd?: string;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(args.toolUseId, (d: string) => {
        resolve(d === 'apply' || d === 'run');
      });
      this.post({
        kind: 'toolApproval',
        toolUseId: args.toolUseId,
        approvalType: 'terminal',
        command: args.command,
        cwd: args.cwd,
      });
    });
  }

  private dispatch(u: AgentUpdate): void {
    if (u.kind === 'progress') {
      this.post({
        kind: 'progress',
        step: u.step,
        stepMax: u.stepMax,
        label: u.stepLabel,
      });
      return;
    }
    if (u.kind === 'assistant_text') {
      if (u.response) {
        recordTurn({
          tokensIn: u.response.usage.tokensIn,
          tokensOut: u.response.usage.tokensOut,
          model: u.response.usage.model,
        });
      }
      const meta = u.response
        ? {
            handler: u.response.handler,
            tokensIn: u.response.usage.tokensIn,
            tokensOut: u.response.usage.tokensOut,
            latencyMs: u.response.usage.latencyMs,
            ragSources: u.response.ragSources,
            model: u.response.usage.model,
            warnings: u.response.warnings,
            blocked: u.response.blocked,
          }
        : null;
      this.transcript.push({
        ts: new Date(),
        role: 'assistant',
        content: u.text ?? '',
        meta: meta ?? undefined,
      });
      this.post({ kind: 'assistant', text: u.text ?? '', meta });
      this.persist();
    } else if (u.kind === 'tool_use' && u.tool) {
      this.transcript.push({
        ts: new Date(),
        role: 'tool_use',
        content: JSON.stringify({ name: u.tool.name, input: u.tool.input }),
      });
      this.post({ kind: 'tool', phase: 'call', tool: u.tool });
    } else if (u.kind === 'tool_result' && u.result) {
      this.transcript.push({
        ts: new Date(),
        role: 'tool_result',
        content: u.result.content,
        meta: { isError: u.result.isError, toolUseId: u.result.id },
      });
      this.post({ kind: 'tool', phase: 'result', result: u.result });
    } else if (u.kind === 'error') {
      this.transcript.push({ ts: new Date(), role: 'error', content: u.error ?? 'unknown error' });
      this.post({ kind: 'error', text: u.error });
    }
  }

  private renderMarkdown(profileLabel: string): string {
    const head = [
      '# AIML conversation',
      '',
      `- Saved: ${new Date().toISOString()}`,
      `- Profile: ${profileLabel}`,
      `- Conversation ID: ${this.conversationId ?? '(local)'}`,
      '',
      '---',
      '',
    ];
    const lines: string[] = [...head];
    for (const e of this.transcript) {
      const ts = e.ts.toISOString();
      if (e.role === 'user') {
        lines.push(`### 🟢 You · ${ts}`, '', e.content, '');
      } else if (e.role === 'assistant') {
        const m = e.meta as { handler?: string; tokensIn?: number; tokensOut?: number; latencyMs?: number; model?: string } | undefined;
        const tag = m ? ` _(handler: \`${m.handler}\`, ${m.tokensIn}/${m.tokensOut} tok, ${m.latencyMs}ms, model: \`${m.model ?? '?'}\`)_` : '';
        lines.push(`### 🤖 AIML · ${ts}${tag}`, '', e.content, '');
      } else if (e.role === 'tool_use') {
        try {
          const t = JSON.parse(e.content);
          lines.push(`#### ⚙ tool_use → \`${t.name}\``, '', '```json', JSON.stringify(t.input, null, 2), '```', '');
        } catch {
          lines.push('#### ⚙ tool_use', '', '```', e.content, '```', '');
        }
      } else if (e.role === 'tool_result') {
        const isErr = (e.meta as { isError?: boolean } | undefined)?.isError;
        lines.push(`#### ${isErr ? '✗' : '✓'} tool_result`, '', '```', e.content.slice(0, 2000), '```', '');
      } else if (e.role === 'error') {
        lines.push(`### ⚠ Error · ${ts}`, '', '> ' + e.content, '');
      }
    }
    return lines.join('\n');
  }

  private renderHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'styles.css'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'main.js'),
    );
    const nonce = randomNonce();

    html = html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{stylesUri\}\}/g, cssUri.toString())
      .replace(/\{\{scriptUri\}\}/g, jsUri.toString());
    return html;
  }
}

function randomNonce(): string {
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}
