import * as vscode from 'vscode';
import { AimlClient } from './aimlClient';
import { ChatViewProvider } from './chatView';
import { ConfigPanel } from './configPanel';
import { registerUriHandler, signInToAiml } from './auth';
import { placeInAuxiliarySidebarIfFirstRun, moveToAuxiliarySidebar } from './placement';
import {
  initProfiles,
  getEffectiveConfig,
  getActiveProfile,
  listProfiles,
  switchProfile,
  removeProfile,
  setActiveModel,
  onProfileChange,
} from './profiles';
import { initStatusBar, recordTurn, resetSession } from './statusBar';

let chatProvider: ChatViewProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

function refreshConfiguredContext(): void {
  const c = getEffectiveConfig();
  const configured = !!(c.apiKey && c.projectId);
  void vscode.commands.executeCommand('setContext', 'aiml.configured', configured);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  await initProfiles(context);
  initStatusBar(context);

  // Refresh the configured-context whenever a profile changes (so the
  // welcome view + sidebar swap correctly).
  context.subscriptions.push(
    onProfileChange()(() => {
      refreshConfiguredContext();
    }),
  );

  const client = new AimlClient(() => {
    const c = getEffectiveConfig();
    return {
      endpoint: c.endpoint,
      apiKey: c.apiKey,
      projectId: c.projectId,
      defaultModel: c.defaultModel,
      maxAgentSteps: c.maxAgentSteps,
    };
  });

  chatProvider = new ChatViewProvider(context.extensionUri, client, context);
  context.subscriptions.push(
    // Activity-bar (sidebar) instance
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
    // Panel instance (next to Copilot Chat / Claude Code)
    vscode.window.registerWebviewViewProvider('aiml.chatPanelView', chatProvider),
  );

  // Live active-editor context: any time the user switches files OR moves
  // their selection, push the new state into the chat panel.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => chatProvider?.setActiveEditor(ed)),
    vscode.window.onDidChangeTextEditorSelection((e) =>
      chatProvider?.setActiveEditor(e.textEditor),
    ),
  );
  // Initial push so the view shows the file that's already open at startup.
  chatProvider.setActiveEditor(vscode.window.activeTextEditor);

  // First-time default placement: move AIML to the auxiliary (right) side
  // bar. Runs once per machine — after the user has installed v0.1.10+ for
  // the first time. Defer so VS Code's view system has finished initializing.
  setTimeout(() => {
    void placeInAuxiliarySidebarIfFirstRun(context);
  }, 1500);

  // OAuth-style sign-in URI handler.
  registerUriHandler(context);

  refreshConfiguredContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiml')) refreshConfiguredContext();
    }),
  );

  // ── Commands ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aiml.openChat', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.aiml-sidebar');
    }),
    vscode.commands.registerCommand('aiml.clearConversation', () => {
      chatProvider?.resetConversation();
    }),
    vscode.commands.registerCommand('aiml.configure', () => {
      ConfigPanel.show(context);
    }),
    vscode.commands.registerCommand('aiml.moveToRightSidebar', async () => {
      await moveToAuxiliarySidebar();
    }),
    vscode.commands.registerCommand('aiml.openDashboard', async () => {
      const endpoint = vscode.workspace.getConfiguration('aiml').get<string>('endpoint', 'https://dev-finance.eagle-pay.com/aiml');
      void vscode.env.openExternal(vscode.Uri.parse(endpoint + '/dashboard'));
    }),
    vscode.commands.registerCommand('aiml.signOut', async () => {
      const active = getActiveProfile();
      if (active) await removeProfile(active.id);
      chatProvider?.resetConversation();
      resetSession();
      void vscode.window.showInformationMessage('Signed out of AIML.');
    }),

    // ── Profile switching ──────────────────────────────────────────────
    vscode.commands.registerCommand('aiml.switchProfile', async () => {
      const profiles = listProfiles();
      if (!profiles.length) {
        const pick = await vscode.window.showInformationMessage(
          'No AIML profiles yet. Sign in to add one.',
          'Sign in',
        );
        if (pick === 'Sign in') void vscode.commands.executeCommand('aiml.signIn');
        return;
      }
      const activeId = getActiveProfile()?.id;
      type Item = vscode.QuickPickItem & { id?: string; action?: 'add' | 'manage' };
      const items: Item[] = [
        ...profiles.map((p) => ({
          label: `${p.id === activeId ? '$(check) ' : '   '}${p.label}`,
          description: p.endpoint.replace(/^https?:\/\//, ''),
          detail: `project ${p.projectId.slice(0, 14)}…  ·  model ${p.defaultModel || 'project default'}`,
          id: p.id,
        })),
        { label: '$(add) Add another account…', action: 'add' },
        { label: '$(trash) Manage profiles…', action: 'manage' },
      ];
      const picked = await vscode.window.showQuickPick<Item>(items, {
        title: 'Switch AIML profile',
        placeHolder: 'Pick the profile to make active',
      });
      if (!picked) return;
      if (picked.action === 'add') {
        void vscode.commands.executeCommand('aiml.signIn');
        return;
      }
      if (picked.action === 'manage') {
        void vscode.commands.executeCommand('aiml.manageProfiles');
        return;
      }
      if (picked.id) {
        const p = await switchProfile(picked.id);
        if (p) {
          chatProvider?.resetConversation();
          resetSession();
          void vscode.window.showInformationMessage(`Switched to "${p.label}".`);
        }
      }
    }),

    vscode.commands.registerCommand('aiml.manageProfiles', async () => {
      const profiles = listProfiles();
      if (!profiles.length) {
        void vscode.window.showInformationMessage('No profiles to manage.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        profiles.map((p) => ({
          label: p.label,
          description: p.endpoint.replace(/^https?:\/\//, ''),
          detail: `project ${p.projectId.slice(0, 14)}…`,
          id: p.id,
        })),
        { title: 'Remove which profile?', placeHolder: 'This signs out of that account locally.' },
      ) as (vscode.QuickPickItem & { id: string }) | undefined;
      if (!pick) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove profile "${pick.label}" from this editor?`,
        { modal: true },
        'Remove',
      );
      if (confirm !== 'Remove') return;
      await removeProfile(pick.id);
      void vscode.window.showInformationMessage(`Removed "${pick.label}".`);
    }),

    // ── Model switching ───────────────────────────────────────────────
    vscode.commands.registerCommand('aiml.switchModel', async () => {
      const cfg = getEffectiveConfig();
      if (!cfg.apiKey) {
        const pick = await vscode.window.showInformationMessage(
          'Sign in to AIML first to load available models.',
          'Sign in',
        );
        if (pick === 'Sign in') void vscode.commands.executeCommand('aiml.signIn');
        return;
      }
      const models = await client.listModels();
      if (!models.length) {
        void vscode.window.showWarningMessage('Could not load models from AIML. Check your connection.');
        return;
      }
      const active = cfg.defaultModel;
      type Item = vscode.QuickPickItem & { id?: string };
      const items: Item[] = [
        {
          label: `${!active ? '$(check) ' : '   '}Project default`,
          description: '(use the model set on the project)',
          id: '',
        },
        ...models.map((m) => ({
          label: `${m.id === active ? '$(check) ' : '   '}${m.name}`,
          description: m.id,
          detail: m.description,
          id: m.id,
        })),
      ];
      const picked = await vscode.window.showQuickPick<Item>(items, {
        title: 'Switch foundation model',
        placeHolder: 'Pick the model to use for new chats in this profile',
      });
      if (!picked) return;
      await setActiveModel(picked.id ?? '');
      void vscode.window.showInformationMessage(
        picked.id ? `Model set to ${picked.label.replace(/^\$\(check\)\s*/, '').trim()}.` : 'Using project default model.',
      );
    }),

    // Status-bar menu — opens a small picker so users don't need to remember command names.
    // ── Save / Attach context ─────────────────────────────────────────
    vscode.commands.registerCommand('aiml.saveConversation', async () => {
      await chatProvider?.saveConversationToFile();
    }),
    vscode.commands.registerCommand('aiml.addContext', async () => {
      await chatProvider?.pickContextFile();
    }),

    vscode.commands.registerCommand('aiml.statusBarMenu', async () => {
      const cfg = getEffectiveConfig();
      if (!cfg.apiKey) return vscode.commands.executeCommand('aiml.signIn');
      const items: Array<vscode.QuickPickItem & { cmd: string }> = [
        { label: '$(comment-discussion) Open chat',     cmd: 'aiml.openChat' },
        { label: '$(sparkle) Switch model',             cmd: 'aiml.switchModel' },
        { label: '$(arrow-swap) Switch profile',        cmd: 'aiml.switchProfile' },
        { label: '$(gear) Configure…',                  cmd: 'aiml.configure' },
        { label: '$(refresh) Reset conversation',       cmd: 'aiml.clearConversation' },
        { label: '$(globe) Open dashboard',             cmd: 'aiml.openDashboard' },
        { label: '$(sign-out) Sign out',                cmd: 'aiml.signOut' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'AIML' });
      if (pick) void vscode.commands.executeCommand(pick.cmd);
    }),
    vscode.commands.registerCommand('aiml.signIn', async () => {
      try {
        const { projectId } = await signInToAiml();
        await vscode.window.showInformationMessage(
          projectId
            ? `Signed in to AIML. Active project saved.`
            : 'Signed in to AIML.',
          'Open chat',
        ).then((pick) => {
          if (pick === 'Open chat') {
            void vscode.commands.executeCommand('workbench.view.extension.aiml-sidebar');
          }
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'User cancelled.') return;
        void vscode.window.showErrorMessage(`AIML sign-in failed: ${msg}`);
      }
    }),

    // Editor-context commands
    vscode.commands.registerCommand('aiml.explain',       () => sendForSelection('Explain this code clearly and concisely. Include any non-obvious behavior or pitfalls.')),
    vscode.commands.registerCommand('aiml.refactor',      () => sendForSelection('Refactor the selected code. Preserve behavior. Then propose the edit via apply_edit so I can review.')),
    vscode.commands.registerCommand('aiml.optimize',      () => sendForSelection('Optimize the selected code for performance and clarity. Preserve behavior. Use apply_edit to propose the change.')),
    vscode.commands.registerCommand('aiml.generateTests', () => sendForSelection('Generate tests for the selected code. Detect the test framework from the project and create a new test file using apply_edit.')),
    vscode.commands.registerCommand('aiml.document',      () => sendForSelection('Add concise inline documentation (JSDoc/PEP257/etc. — match the language). Use apply_edit on the active file.')),
    vscode.commands.registerCommand('aiml.fixError',      () => sendForFile('Fix the errors/warnings reported by the language server in this file. Use get_diagnostics, then apply_edit. Don\'t introduce unrelated changes.')),
  );

  // One-time onboarding nudge if unconfigured.
  if (!vscode.workspace.getConfiguration('aiml').get<string>('apiKey')) {
    void vscode.window
      .showInformationMessage(
        'AIML is installed but not yet configured. Open the configuration panel to connect your workspace.',
        'Configure',
        'Open dashboard',
        'Dismiss',
      )
      .then((pick) => {
        if (pick === 'Configure') ConfigPanel.show(context);
        else if (pick === 'Open dashboard') void vscode.commands.executeCommand('aiml.signIn');
      });
  }
}

export function deactivate(): void {
  /* noop */
}

// ──────────────────────────────────────────────────────────────────────────
//  Editor-context entry points
// ──────────────────────────────────────────────────────────────────────────

async function sendForSelection(instruction: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('No active editor. Open a file and select some code first.');
    return;
  }
  const sel = editor.selection;
  const text = sel.isEmpty ? editor.document.lineAt(sel.active.line).text : editor.document.getText(sel);
  if (!text.trim()) {
    void vscode.window.showInformationMessage('Selection is empty.');
    return;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const prompt =
    `${instruction}\n\n` +
    `**File:** \`${rel}\`  (language: \`${editor.document.languageId}\`, ` +
    `lines ${sel.start.line + 1}–${sel.end.line + 1})\n\n` +
    '```' + editor.document.languageId + '\n' + text + '\n```';
  await chatProvider?.sendPrompt(prompt);
}

async function sendForFile(instruction: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('No active editor.');
    return;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const prompt = `${instruction}\n\n**Active file:** \`${rel}\`  (language: \`${editor.document.languageId}\`)`;
  await chatProvider?.sendPrompt(prompt);
}
