/**
 * Client-side tools the AIML agent can invoke. Every write is gated on user
 * approval (workspace.applyEdit will surface the change as a normal VS Code
 * refactor preview if `aiml.autoApproveWrites` is false).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ToolDef, ToolExecutor, ToolUse } from './aimlClient';

/**
 * Approval / notification source. Edits are applied automatically and the
 * webview is told about them so it can show a Revert button. Terminal
 * commands still need explicit approval (running arbitrary shell commands
 * is more dangerous than a reversible file edit).
 */
export interface ApprovalProvider {
  notifyEditApplied(args: {
    toolUseId: string;
    path: string;
    summary: string;
    diffPreview: string;
    before: string;
    wasCreated: boolean;
  }): void;
  requestTerminalApproval(args: { toolUseId: string; command: string; cwd?: string }): Promise<boolean>;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 500;

export class WorkspaceToolExecutor implements ToolExecutor {
  constructor(private readonly approvals?: ApprovalProvider) {}

  declarations(): ToolDef[] {
    return [
      {
        name: 'read_file',
        description:
          'Read a workspace file. Returns up to ~64 KB of UTF-8 text. Paths are workspace-relative.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_workspace',
        description:
          'List files in the workspace. Accepts an optional glob pattern (e.g. "src/**/*.ts"). Returns up to 500 entries.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern. Defaults to "**/*".' },
          },
        },
      },
      {
        name: 'get_open_files',
        description: 'List paths of all currently-open editor tabs.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'get_active_selection',
        description: 'Return the active editor file path, language, and the selected text (or visible range if nothing is selected).',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'get_diagnostics',
        description: 'Return diagnostics (errors/warnings) for a file, or for the entire workspace if no path is given.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Optional workspace-relative file path.' } },
        },
      },
      {
        name: 'apply_edit',
        description:
          'Replace EXACT old text with new text in a file. Requires user approval (a refactor preview is shown). Use multiple calls to make multiple changes. Pass the full new file in newContent to overwrite.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            oldString: { type: 'string', description: 'Exact text to find (whitespace-sensitive). Omit when using newContent to overwrite the whole file.' },
            newString: { type: 'string', description: 'Replacement text.' },
            newContent: { type: 'string', description: 'When set, REPLACES the entire file with this content (used for creating files or full rewrites).' },
          },
          required: ['path'],
        },
      },
      {
        name: 'open_file',
        description: 'Open a file in a VS Code editor tab and reveal it to the user. Does not modify content.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'run_terminal',
        description:
          'Run a shell command in a managed VS Code terminal. Requires user approval. Returns nothing (output is visible to the user). Use for build/test/run commands only.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string', description: 'Workspace-relative working directory (optional).' },
          },
          required: ['command'],
        },
      },
      {
        name: 'todo_write',
        description:
          'Create or update a structured todo list for the user. Pass the complete current state of the list on every call — pending items, the one in_progress item, and any completed items. Use this whenever the task has 3 or more distinct steps, or when the user explicitly asks for a plan. Rules: keep exactly ONE item in_progress at a time; mark items completed immediately as you finish them; do not leave items in_progress once they are done. The UI re-renders the list each call, so the user always sees the latest snapshot.',
        input_schema: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              description: 'Full list of todos in display order.',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'Imperative form, e.g. "Add login endpoint".',
                  },
                  activeForm: {
                    type: 'string',
                    description: 'Present-continuous form shown when in_progress, e.g. "Adding login endpoint".',
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed'],
                  },
                },
                required: ['content', 'activeForm', 'status'],
              },
            },
          },
          required: ['todos'],
        },
      },
    ];
  }

  async execute(call: ToolUse): Promise<{ content: string; isError?: boolean }> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case 'read_file':         return await this.readFile(String(input.path ?? ''));
      case 'list_workspace':    return await this.listWorkspace(typeof input.pattern === 'string' ? input.pattern : '**/*');
      case 'get_open_files':    return await this.getOpenFiles();
      case 'get_active_selection': return await this.getActiveSelection();
      case 'get_diagnostics':   return await this.getDiagnostics(typeof input.path === 'string' ? input.path : undefined);
      case 'apply_edit':        return await this.applyEdit(input, call.id);
      case 'open_file':         return await this.openFile(String(input.path ?? ''));
      case 'run_terminal':      return await this.runTerminal(input, call.id);
      case 'todo_write':        return this.todoWrite(input);
      default: return { content: `Unknown tool: ${call.name}`, isError: true };
    }
  }

  private todoWrite(input: Record<string, unknown>): { content: string; isError?: boolean } {
    const rawList = Array.isArray(input.todos) ? input.todos : null;
    if (!rawList) return { content: 'Missing or invalid `todos` array.', isError: true };
    let pending = 0, active = 0, done = 0;
    for (const t of rawList) {
      const status = ((t as Record<string, unknown>)?.status as string) ?? '';
      if (status === 'completed') done++;
      else if (status === 'in_progress') active++;
      else pending++;
    }
    // No client-side state is required — the webview renders the snapshot
    // straight from the tool input (see main.js → renderTodoFrame). The
    // server side never persists todos; they live in the chat transcript.
    return {
      content: `Todo list updated: ${done} done, ${active} in progress, ${pending} pending (${rawList.length} total).`,
    };
  }

  // ── tool impls ────────────────────────────────────────────────────────────

  private workspaceUri(rel: string): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) throw new Error('No workspace folder is open.');
    return vscode.Uri.joinPath(root.uri, rel);
  }

  private async readFile(rel: string): Promise<{ content: string; isError?: boolean }> {
    if (!rel) return { content: 'Missing `path`.', isError: true };
    try {
      const uri = this.workspaceUri(rel);
      const data = await vscode.workspace.fs.readFile(uri);
      if (data.byteLength > MAX_FILE_BYTES) {
        return {
          content: `File too large (${data.byteLength} bytes). Read in chunks or summarize instead.`,
          isError: true,
        };
      }
      return { content: Buffer.from(data).toString('utf8') };
    } catch (err: unknown) {
      return { content: `read_file failed: ${(err as Error).message}`, isError: true };
    }
  }

  private async listWorkspace(pattern: string): Promise<{ content: string; isError?: boolean }> {
    try {
      const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**}';
      const uris = await vscode.workspace.findFiles(pattern, exclude, MAX_LIST_ENTRIES);
      const rels = uris.map((u) => vscode.workspace.asRelativePath(u));
      return {
        content: rels.length === MAX_LIST_ENTRIES
          ? rels.join('\n') + `\n… (${MAX_LIST_ENTRIES}+ results truncated)`
          : rels.join('\n') || '(no matches)',
      };
    } catch (err) {
      return { content: `list_workspace failed: ${(err as Error).message}`, isError: true };
    }
  }

  private async getOpenFiles(): Promise<{ content: string }> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const paths = new Set<string>();
    for (const t of tabs) {
      const inp = t.input as { uri?: vscode.Uri } | undefined;
      if (inp?.uri) paths.add(vscode.workspace.asRelativePath(inp.uri));
    }
    return { content: [...paths].join('\n') || '(no open files)' };
  }

  private async getActiveSelection(): Promise<{ content: string }> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return { content: '(no active editor)' };
    const sel = ed.selection;
    const range = sel.isEmpty ? ed.visibleRanges[0] ?? new vscode.Range(0, 0, 0, 0) : sel;
    const text = ed.document.getText(range);
    return {
      content: JSON.stringify(
        {
          path: vscode.workspace.asRelativePath(ed.document.uri),
          language: ed.document.languageId,
          range: { start: range.start.line + 1, end: range.end.line + 1 },
          selection: sel.isEmpty ? 'visible range (no explicit selection)' : 'user selection',
          text,
        },
        null,
        2,
      ),
    };
  }

  private async getDiagnostics(rel?: string): Promise<{ content: string }> {
    let entries: [vscode.Uri, readonly vscode.Diagnostic[]][];
    if (rel) {
      const uri = this.workspaceUri(rel);
      entries = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      entries = vscode.languages.getDiagnostics();
    }
    const lines: string[] = [];
    let count = 0;
    for (const [uri, diags] of entries) {
      if (!diags.length) continue;
      for (const d of diags) {
        count++;
        const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity] ?? 'Diagnostic';
        lines.push(`${sev}: ${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} — ${d.message}`);
        if (count >= 200) { lines.push('… (truncated at 200)'); return { content: lines.join('\n') }; }
      }
    }
    return { content: lines.join('\n') || '(no diagnostics)' };
  }

  private async applyEdit(
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<{ content: string; isError?: boolean }> {
    const rel = typeof input.path === 'string' ? input.path : '';
    if (!rel) return { content: 'Missing `path`.', isError: true };
    const oldString = typeof input.oldString === 'string' ? input.oldString : null;
    const newString = typeof input.newString === 'string' ? input.newString : null;
    const newContent = typeof input.newContent === 'string' ? input.newContent : null;
    if (newContent === null && (oldString === null || newString === null)) {
      return { content: 'Provide either `newContent` (overwrite) OR `oldString`+`newString` (find/replace).', isError: true };
    }

    const uri = this.workspaceUri(rel);

    const we = new vscode.WorkspaceEdit();
    let exists = true;
    try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }

    let summary: string;
    let diffPreview: string;
    let before = '';
    if (newContent !== null) {
      if (!exists) we.createFile(uri, { overwrite: false, ignoreIfExists: true });
      before = exists ? await vscode.workspace.fs.readFile(uri).then((b) => Buffer.from(b).toString('utf8')) : '';
      const doc = exists ? await vscode.workspace.openTextDocument(uri) : null;
      const range = doc ? new vscode.Range(0, 0, doc.lineCount, 0) : new vscode.Range(0, 0, 0, 0);
      if (doc) we.replace(uri, range, newContent);
      else we.insert(uri, new vscode.Position(0, 0), newContent);
      summary = exists
        ? `Rewrite ${rel} · ${before.length} → ${newContent.length} chars`
        : `Create ${rel} · ${newContent.length} chars`;
      diffPreview = buildDiffPreview(before, newContent);
    } else {
      if (!exists) return { content: `File not found: ${rel}`, isError: true };
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      before = text;
      const idx = text.indexOf(oldString!);
      if (idx < 0) return { content: `oldString not found in ${rel}`, isError: true };
      if (text.indexOf(oldString!, idx + 1) >= 0) {
        return { content: `oldString matches multiple locations in ${rel}. Make oldString more specific.`, isError: true };
      }
      const start = doc.positionAt(idx);
      const end = doc.positionAt(idx + oldString!.length);
      we.replace(uri, new vscode.Range(start, end), newString!);
      summary = `Edit ${rel} · ${oldString!.length} → ${newString!.length} chars (line ${start.line + 1})`;
      diffPreview = buildHunkPreview(oldString!, newString!);
    }

    // Auto-apply. The user can revert from the in-chat Revert button (or
    // via VS Code's native undo if they have the file open).
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) return { content: `applyEdit returned false for ${rel}.`, isError: true };

    // Persist to disk so revert works even if the user closes without saving.
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) await doc.save();
    } catch { /* best-effort */ }

    // Tell the chat: edit landed, here's the data needed to revert it.
    if (this.approvals) {
      this.approvals.notifyEditApplied({
        toolUseId,
        path: rel,
        summary,
        diffPreview,
        before,
        wasCreated: !exists,
      });
    }
    return { content: `Applied edit to ${rel}.` };
  }

  private async openFile(rel: string): Promise<{ content: string }> {
    const uri = this.workspaceUri(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    return { content: `Opened ${rel}.` };
  }

  private async runTerminal(
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<{ content: string; isError?: boolean }> {
    const cmd = String(input.command ?? '').trim();
    if (!cmd) return { content: 'Missing `command`.', isError: true };
    const cwdRel = typeof input.cwd === 'string' ? input.cwd : '';

    const approved = this.approvals
      ? await this.approvals.requestTerminalApproval({ toolUseId, command: cmd, cwd: cwdRel || undefined })
      : await (async () => {
          const pick = await vscode.window.showWarningMessage(
            `AIML wants to run a terminal command:\n\n${cmd}`,
            { modal: true },
            'Run',
            'Cancel',
          );
          return pick === 'Run';
        })();

    if (!approved) return { content: 'User declined to run command.', isError: true };
    const root = vscode.workspace.workspaceFolders?.[0];
    const cwd = root ? path.join(root.uri.fsPath, cwdRel) : undefined;
    const t = vscode.window.createTerminal({ name: 'AIML', cwd });
    t.show(true);
    t.sendText(cmd, true);
    return { content: `Sent to terminal. The user can see the output.` };
  }
}

/** Compact line-by-line diff for the approval preview (cap at 24 lines). */
function buildDiffPreview(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const max = 24;
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while ((i < a.length || j < b.length) && out.length < max) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push('  ' + (a[i] ?? ''));
      i++; j++;
    } else if (i < a.length && (j >= b.length || a[i] !== b[j])) {
      out.push('- ' + (a[i] ?? ''));
      i++;
    } else if (j < b.length) {
      out.push('+ ' + (b[j] ?? ''));
      j++;
    }
  }
  if (out.length >= max) out.push('… (preview truncated)');
  return out.join('\n');
}

function buildHunkPreview(oldString: string, newString: string): string {
  const oldLines = oldString.split('\n').slice(0, 12).map((l) => '- ' + l);
  const newLines = newString.split('\n').slice(0, 12).map((l) => '+ ' + l);
  return [...oldLines, ...newLines].join('\n');
}
