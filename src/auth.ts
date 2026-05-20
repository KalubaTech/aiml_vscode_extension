/**
 * Browser-based "Sign in with AIML" flow.
 *
 *  1. Generate a random `state` token, hold it in memory.
 *  2. Open the user's browser to <endpoint>/authorize?state=&redirect_uri=...
 *  3. They sign in, pick a project, hit "Authorize editor".
 *  4. Their browser is redirected to vscode://eagle-pay.aiml-vscode/auth
 *     ?code=&state=&projectId=.
 *  5. VS Code routes the URI to our handler; we POST the code to
 *     /api/auth/editor/exchange and get the plaintext API key once.
 *  6. We write it (plus projectId) into the user's settings.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { upsertProfile, type Profile } from './profiles';

interface PendingFlow {
  state: string;
  resolve: (value: { code: string; projectId: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let pending: PendingFlow | undefined;

/** Register the vscode://eagle-pay.aiml-vscode/auth handler exactly once. */
export function registerUriHandler(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        if (uri.path !== '/auth') return;
        const params = new URLSearchParams(uri.query);
        const code = params.get('code');
        const state = params.get('state');
        const projectId = params.get('projectId');
        if (!code || !state || !projectId) {
          vscode.window.showErrorMessage('AIML sign-in callback missing parameters.');
          return;
        }
        if (!pending) {
          // The flow timed out, or this is a stale callback.
          vscode.window.showWarningMessage('AIML sign-in callback arrived too late. Try signing in again.');
          return;
        }
        if (pending.state !== state) {
          pending.reject(new Error('state_mismatch'));
          return;
        }
        clearTimeout(pending.timer);
        pending.resolve({ code, projectId });
        pending = undefined;
      },
    }),
  );
}

/**
 * Run the full sign-in flow. Saves apiKey + projectId into VS Code settings
 * and resolves with the chosen project's id, or rejects on cancel / error.
 */
export async function signInToAiml(): Promise<{ projectId: string; apiKey: string }> {
  if (pending) {
    pending.reject(new Error('Replaced by a newer sign-in.'));
    clearTimeout(pending.timer);
    pending = undefined;
  }

  const cfg = vscode.workspace.getConfiguration('aiml');
  const endpoint = cfg.get<string>('endpoint', 'https://dev-finance.eagle-pay.com/aiml').replace(/\/+$/, '');
  const state = randomBytes(24).toString('base64url');
  const publisher = 'eagle-pay';
  const extId = 'aiml-vscode';
  const editorScheme = vscode.env.uriScheme ?? 'vscode'; // vscode | cursor | vscode-insiders | ...
  const redirectUri = `${editorScheme}://${publisher}.${extId}/auth`;

  const authorizeUrl =
    `${endpoint}/authorize?state=${encodeURIComponent(state)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&editor=${encodeURIComponent(editorScheme)}`;

  await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));

  // Park a promise the URI handler will resolve once the redirect fires.
  const callback = new Promise<{ code: string; projectId: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = undefined;
      reject(new Error('Sign-in timed out (5 minutes). Try again.'));
    }, 5 * 60 * 1000);
    pending = { state, resolve, reject, timer };
  });

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'AIML: signing in…',
      cancellable: true,
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('User cancelled.'));
          pending = undefined;
        }
      });

      const { code, projectId } = await callback;

      // Exchange the auth code for the plaintext API key.
      const res = await fetch(`${endpoint}/api/auth/editor/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { apiKey: string; projectId: string | null };
      if (!data.apiKey) throw new Error('No API key returned from exchange.');

      const finalProjectId = projectId || data.projectId || '';

      // Best-effort enrichment: fetch org name + email from /api/auth/me using
      // a session — only works if the user happens to be browser-signed-in
      // on this machine. Failures here are silent.
      let organizationName: string | undefined;
      let email: string | undefined;
      try {
        const meRes = await fetch(`${endpoint}/v1/projects`, {
          headers: { Authorization: `Bearer ${data.apiKey}` },
        });
        if (meRes.ok) {
          const projects = (await meRes.json()) as Array<{ name: string; organizationId: string }>;
          // Project's name (the one the user picked) is the cleanest label.
          const proj = projects.find((p) => (p as unknown as { id: string }).id === finalProjectId);
          organizationName = proj?.name;
        }
      } catch {
        /* swallow */
      }

      // Persist to profile system (key into SecretStorage, metadata into
      // globalState; legacy `aiml.apiKey` setting also gets mirrored for
      // backwards compatibility).
      const profile: Profile = await upsertProfile({
        endpoint,
        apiKey: data.apiKey,
        projectId: finalProjectId,
        defaultModel: cfg.get<string>('defaultModel', ''),
        organizationName,
        email,
      });

      return { projectId: profile.projectId, apiKey: data.apiKey };
    },
  );
}
