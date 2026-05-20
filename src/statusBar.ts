/**
 * Bottom-right status bar item: shows the active profile, current model, and
 * cumulative tokens used in the current conversation. Click → opens the model
 * picker. Tooltip exposes deeper actions.
 */

import * as vscode from 'vscode';
import { getEffectiveConfig } from './profiles';

let item: vscode.StatusBarItem | undefined;

interface SessionTotals {
  tokensIn: number;
  tokensOut: number;
  turns: number;
  model: string | null;
}

let session: SessionTotals = { tokensIn: 0, tokensOut: 0, turns: 0, model: null };

export function initStatusBar(context: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'aiml.statusBarMenu';
  item.name = 'AIML';
  context.subscriptions.push(item);
  refresh();
  item.show();

  // Listen for config changes (profile switch, model change) to refresh.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiml')) refresh();
    }),
  );
}

export function recordTurn(args: { tokensIn: number; tokensOut: number; model: string | null }): void {
  session.tokensIn += args.tokensIn || 0;
  session.tokensOut += args.tokensOut || 0;
  session.turns += 1;
  if (args.model) session.model = args.model;
  refresh();
}

export function resetSession(): void {
  session = { tokensIn: 0, tokensOut: 0, turns: 0, model: null };
  refresh();
}

function shortNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

function shortModel(m: string | null | undefined): string {
  if (!m) return 'default';
  // claude-opus-4-7 → Opus 4.7
  const match = m.match(/claude-(opus|sonnet|haiku)-([\d-]+)/);
  if (match) {
    const family = match[1]!;
    const ver = match[2]!.replace(/-/g, '.');
    return family.charAt(0).toUpperCase() + family.slice(1) + ' ' + ver.replace(/\.20\d{6}$/, '');
  }
  return m.length > 24 ? m.slice(0, 22) + '…' : m;
}

function refresh(): void {
  if (!item) return;
  const cfg = getEffectiveConfig();
  const configured = !!(cfg.apiKey && cfg.projectId);

  if (!configured) {
    item.text = '$(sparkle) AIML · sign in';
    item.tooltip = new vscode.MarkdownString('AIML is not signed in. Click to sign in.');
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  item.backgroundColor = undefined;
  const modelLabel = shortModel(session.model || cfg.defaultModel);
  const totals = `${shortNum(session.tokensIn)}/${shortNum(session.tokensOut)}`;

  item.text = `$(sparkle) AIML · ${modelLabel} · ${totals}`;

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`**AIML** · profile: \`${cfg.activeLabel}\`\n\n`);
  md.appendMarkdown(`Model: \`${cfg.defaultModel || 'project default'}\` (live: \`${session.model || 'n/a'}\`)\n\n`);
  md.appendMarkdown(`Session: **${session.turns}** turns · **${session.tokensIn}** tokens in · **${session.tokensOut}** out\n\n`);
  md.appendMarkdown('---\n\n');
  md.appendMarkdown('[$(sparkle) Switch model](command:aiml.switchModel) · ');
  md.appendMarkdown('[$(arrow-swap) Switch profile](command:aiml.switchProfile) · ');
  md.appendMarkdown('[$(comment-discussion) Open chat](command:aiml.openChat) · ');
  md.appendMarkdown('[$(refresh) Reset session](command:aiml.clearConversation)');
  item.tooltip = md;
}
