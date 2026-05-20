/**
 * Polished configuration panel — replaces the showInputBox sequence.
 *
 * Renders a single webview panel with all AIML settings, validation, a
 * "Test connection" action that hits AIML and lists projects, and a Save
 * button that writes to the global settings store.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface Settings {
  endpoint: string;
  apiKey: string;
  projectId: string;
  defaultModel: string;
}

export class ConfigPanel {
  private static current: ConfigPanel | undefined;

  static show(context: vscode.ExtensionContext): void {
    if (ConfigPanel.current) {
      ConfigPanel.current.panel.reveal(vscode.ViewColumn.One);
      ConfigPanel.current.postCurrent();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiml.config',
      'AIML — Configure',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'src', 'webview'),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
    ConfigPanel.current = new ConfigPanel(panel, context);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
  ) {
    panel.webview.html = this.renderHtml();
    panel.onDidDispose(() => {
      ConfigPanel.current = undefined;
    });

    panel.webview.onDidReceiveMessage(async (msg: { kind: string; settings?: Settings; field?: string }) => {
      if (msg.kind === 'ready') {
        this.postCurrent();
      } else if (msg.kind === 'save' && msg.settings) {
        await this.save(msg.settings);
        this.post({ kind: 'saved' });
        void vscode.window.showInformationMessage('AIML configuration saved.');
      } else if (msg.kind === 'test' && msg.settings) {
        await this.test(msg.settings);
      } else if (msg.kind === 'openDashboard' && msg.settings) {
        const base = msg.settings.endpoint.replace(/\/+$/, '') || 'https://dev-finance.eagle-pay.com/aiml';
        const sub = msg.field === 'apiKey' ? '/dashboard#keys' : msg.field === 'projectId' ? '/dashboard#projects' : '/dashboard';
        void vscode.env.openExternal(vscode.Uri.parse(base + sub));
      } else if (msg.kind === 'getStarted' && msg.settings) {
        const base = msg.settings.endpoint.replace(/\/+$/, '') || 'https://dev-finance.eagle-pay.com/aiml';
        void vscode.env.openExternal(vscode.Uri.parse(base + '/get-started'));
      }
    });
  }

  private post(m: unknown): void {
    this.panel.webview.postMessage(m);
  }

  private postCurrent(): void {
    const cfg = vscode.workspace.getConfiguration('aiml');
    this.post({
      kind: 'current',
      settings: {
        endpoint: cfg.get<string>('endpoint', 'https://dev-finance.eagle-pay.com/aiml'),
        apiKey: cfg.get<string>('apiKey', ''),
        projectId: cfg.get<string>('projectId', ''),
        defaultModel: cfg.get<string>('defaultModel', ''),
      },
    });
  }

  private async save(s: Settings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('aiml');
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update('endpoint', s.endpoint.trim().replace(/\/+$/, ''), target);
    await cfg.update('apiKey', s.apiKey.trim(), target);
    await cfg.update('projectId', s.projectId.trim(), target);
    await cfg.update('defaultModel', (s.defaultModel || '').trim(), target);
  }

  /**
   * Hit AIML to validate the credentials. Reports: API key valid (lists
   * projects), endpoint reachable, and whether the chosen project ID
   * belongs to the org.
   */
  private async test(s: Settings): Promise<void> {
    const start = Date.now();
    const endpoint = s.endpoint.trim().replace(/\/+$/, '');
    const apiKey = s.apiKey.trim();
    const projectId = s.projectId.trim();

    if (!endpoint) {
      this.post({ kind: 'test_result', ok: false, message: 'Endpoint is required.' });
      return;
    }
    if (!apiKey) {
      this.post({ kind: 'test_result', ok: false, message: 'API key is required.' });
      return;
    }

    try {
      // /v1/projects requires `admin` scope. If the key is chat-only, fall
      // back to a 404-tolerant ping by trying /health first.
      const healthRes = await fetch(endpoint + '/health');
      if (!healthRes.ok) {
        this.post({ kind: 'test_result', ok: false, message: `Endpoint not reachable (${healthRes.status}).` });
        return;
      }

      const projRes = await fetch(endpoint + '/v1/projects', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (projRes.status === 401) {
        this.post({ kind: 'test_result', ok: false, message: 'API key was rejected (401). Check it in Dashboard → Developers.' });
        return;
      }
      if (projRes.status === 402) {
        const body = await projRes.json().catch(() => ({} as { message?: string }));
        this.post({ kind: 'test_result', ok: false, message: 'Subscription not active. ' + ((body as { message?: string }).message ?? '') });
        return;
      }
      if (projRes.status === 403) {
        // chat-only key — that's actually fine for using the extension
        this.post({
          kind: 'test_result',
          ok: true,
          message: `Endpoint OK, key valid (chat-only scope). Connection time: ${Date.now() - start} ms.`,
          chatOnly: true,
        });
        return;
      }
      if (!projRes.ok) {
        const t = await projRes.text();
        this.post({ kind: 'test_result', ok: false, message: `Unexpected ${projRes.status}: ${t.slice(0, 200)}` });
        return;
      }

      const projects = (await projRes.json()) as Array<{ id: string; name: string; slug: string }>;
      const has = projects.some((p) => p.id === projectId);
      const lines = [
        `Endpoint OK. Found ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
        projectId
          ? has
            ? `✓ Project ID matches "${projects.find((p) => p.id === projectId)?.name ?? '?'}".`
            : `× Project ID "${projectId.slice(0, 16)}…" not found in this org.`
          : '(No project ID set yet — pick one below.)',
        `Connection time: ${Date.now() - start} ms.`,
      ];
      this.post({
        kind: 'test_result',
        ok: !projectId || has,
        message: lines.join('\n'),
        projects: projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
      });
    } catch (err) {
      this.post({
        kind: 'test_result',
        ok: false,
        message: `Network error: ${(err as Error).message}`,
      });
    }
  }

  private renderHtml(): string {
    const htmlPath = path.join(this.context.extensionUri.fsPath, 'src', 'webview', 'config.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'config.css'),
    );
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'config.js'),
    );
    const logoUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'icon.png'),
    );
    const nonce = randomNonce();
    return html
      .replace(/\{\{cspSource\}\}/g, this.panel.webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{stylesUri\}\}/g, cssUri.toString())
      .replace(/\{\{scriptUri\}\}/g, jsUri.toString())
      .replace(/\{\{logoUri\}\}/g, logoUri.toString());
  }
}

function randomNonce(): string {
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}
