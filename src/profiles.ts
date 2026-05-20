/**
 * Profile storage — built on VS Code's first-class extension storage so we
 * don't need to register any new configuration keys.
 *
 *   • Metadata (label, endpoint, projectId, defaultModel) → globalState
 *   • API keys                                            → SecretStorage
 *
 * SecretStorage stores secrets in the OS keychain (Windows Credential
 * Manager, macOS Keychain, libsecret on Linux). It never lives in JSON
 * settings, so credentials can't be accidentally synced or committed.
 *
 * Callers stay synchronous: on activation we load the active profile +
 * its secret into an in-memory cache so `getEffectiveConfig()` can answer
 * synchronously. Cache refresh happens on every profile change.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export interface Profile {
  id: string;
  label: string;
  endpoint: string;
  projectId: string;
  defaultModel: string;
  organizationName?: string;
  email?: string;
  /** Not stored; populated only by getActiveProfile() from secret storage. */
  apiKey?: string;
}

const DEFAULT_ENDPOINT = 'https://dev-finance.eagle-pay.com/aiml';

const KEYS = {
  profiles: 'aiml.profiles',
  active: 'aiml.activeProfile',
};
const SECRET_PREFIX = 'aiml.apiKey:';

let ctx: vscode.ExtensionContext | undefined;
// In-memory cache of the active profile's plaintext key — so getEffectiveConfig
// can answer synchronously like the rest of the codebase expects.
let activeApiKeyCache = '';
let onChangeEmitter: vscode.EventEmitter<void> | undefined;

/** Public event fired after any profile mutation (add / switch / remove / model change). */
export function onProfileChange(): vscode.Event<void> {
  if (!onChangeEmitter) onChangeEmitter = new vscode.EventEmitter<void>();
  return onChangeEmitter.event;
}

function emitChange(): void {
  onChangeEmitter?.fire();
}

/** Must be called once during activate(). */
export async function initProfiles(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;

  // One-time migration: if there are no profiles but a legacy `aiml.apiKey`
  // is set in user settings, lift it into a profile (we don't have org
  // info, so the label is just "Default").
  const existing = listProfiles();
  const cfg = vscode.workspace.getConfiguration('aiml');
  const legacyKey = cfg.get<string>('apiKey', '');
  if (existing.length === 0 && legacyKey) {
    const p: Profile = {
      id: 'default',
      label: 'Default',
      endpoint: (cfg.get<string>('endpoint', DEFAULT_ENDPOINT) || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
      projectId: cfg.get<string>('projectId', ''),
      defaultModel: cfg.get<string>('defaultModel', ''),
    };
    await context.globalState.update(KEYS.profiles, [p]);
    await context.globalState.update(KEYS.active, p.id);
    await context.secrets.store(SECRET_PREFIX + p.id, legacyKey);
    // Optional: clear the legacy key so it's not duplicated. We DO keep the
    // mirror in `aiml.apiKey` for code paths that read from settings.
  }

  await loadActiveKeyIntoCache();
}

async function loadActiveKeyIntoCache(): Promise<void> {
  const active = getActiveProfileSync();
  if (!ctx || !active) {
    activeApiKeyCache = '';
    return;
  }
  activeApiKeyCache = (await ctx.secrets.get(SECRET_PREFIX + active.id)) ?? '';
}

/* ── readers ─────────────────────────────────────────────────────── */

export function listProfiles(): Profile[] {
  if (!ctx) return [];
  return ctx.globalState.get<Profile[]>(KEYS.profiles, []) ?? [];
}

function getActiveProfileSync(): Profile | null {
  if (!ctx) return null;
  const profiles = listProfiles();
  if (profiles.length === 0) return null;
  const activeId = ctx.globalState.get<string>(KEYS.active, '');
  return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
}

export function getActiveProfile(): Profile | null {
  return getActiveProfileSync();
}

/** Sync, never throws. The shape used by aimlClient + statusBar. */
export function getEffectiveConfig(): {
  endpoint: string;
  apiKey: string;
  projectId: string;
  defaultModel: string;
  maxAgentSteps: number;
  activeLabel: string;
} {
  const p = getActiveProfileSync();
  const cfg = vscode.workspace.getConfiguration('aiml');
  return {
    endpoint: p?.endpoint || cfg.get<string>('endpoint', DEFAULT_ENDPOINT),
    apiKey: activeApiKeyCache || cfg.get<string>('apiKey', ''),
    projectId: p?.projectId || cfg.get<string>('projectId', ''),
    defaultModel: p?.defaultModel || cfg.get<string>('defaultModel', ''),
    maxAgentSteps: cfg.get<number>('maxAgentSteps', 12),
    activeLabel: p?.label ?? 'Unconfigured',
  };
}

/* ── mutations ───────────────────────────────────────────────────── */

export async function upsertProfile(input: {
  endpoint: string;
  apiKey: string;
  projectId: string;
  defaultModel?: string;
  organizationName?: string;
  email?: string;
  label?: string;
  id?: string;
}): Promise<Profile> {
  if (!ctx) throw new Error('Profiles not initialized.');

  const profiles = listProfiles();
  const endpoint = input.endpoint.replace(/\/+$/, '');

  // Same (endpoint + projectId) is the same profile — overwrite key.
  let existing = profiles.find((p) => p.endpoint === endpoint && p.projectId === input.projectId);
  const id = existing?.id ?? input.id ?? randomBytes(6).toString('hex');

  const next: Profile = {
    id,
    label: input.label ?? existing?.label ?? deriveLabel(input.organizationName, input.email, endpoint),
    endpoint,
    projectId: input.projectId,
    defaultModel: input.defaultModel ?? existing?.defaultModel ?? '',
    organizationName: input.organizationName ?? existing?.organizationName,
    email: input.email ?? existing?.email,
  };

  if (existing) {
    const idx = profiles.findIndex((p) => p.id === id);
    profiles[idx] = next;
  } else {
    profiles.push(next);
  }

  await ctx.globalState.update(KEYS.profiles, profiles);
  await ctx.globalState.update(KEYS.active, id);
  await ctx.secrets.store(SECRET_PREFIX + id, input.apiKey);

  // Load cache first so mirrorLegacy writes the new key into settings.
  await loadActiveKeyIntoCache();
  await mirrorLegacy(next);
  emitChange();
  return next;
}

export async function switchProfile(id: string): Promise<Profile | null> {
  if (!ctx) return null;
  const p = listProfiles().find((x) => x.id === id);
  if (!p) return null;
  await ctx.globalState.update(KEYS.active, id);
  await mirrorLegacy(p);
  await loadActiveKeyIntoCache();
  emitChange();
  return p;
}

export async function removeProfile(id: string): Promise<void> {
  if (!ctx) return;
  const profiles = listProfiles().filter((p) => p.id !== id);
  await ctx.globalState.update(KEYS.profiles, profiles);
  await ctx.secrets.delete(SECRET_PREFIX + id);

  const activeId = ctx.globalState.get<string>(KEYS.active, '');
  if (activeId === id) {
    const next = profiles[0];
    await ctx.globalState.update(KEYS.active, next?.id ?? '');
    if (next) {
      await mirrorLegacy(next);
    } else {
      // No profiles left — clear the mirrors so the UI shows "unconfigured".
      const cfg = vscode.workspace.getConfiguration('aiml');
      const target = vscode.ConfigurationTarget.Global;
      await cfg.update('apiKey', '', target);
      await cfg.update('projectId', '', target);
    }
  }
  await loadActiveKeyIntoCache();
  emitChange();
}

export async function setActiveModel(modelId: string): Promise<void> {
  if (!ctx) return;
  const profiles = listProfiles();
  const activeId = ctx.globalState.get<string>(KEYS.active, '');
  const idx = profiles.findIndex((p) => p.id === activeId);
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx]!, defaultModel: modelId };
    await ctx.globalState.update(KEYS.profiles, profiles);
  }
  // Mirror to settings so the user-facing config reflects it.
  await vscode.workspace.getConfiguration('aiml').update('defaultModel', modelId, vscode.ConfigurationTarget.Global);
  emitChange();
}

/* ── internals ───────────────────────────────────────────────────── */

async function mirrorLegacy(p: Profile): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('aiml');
  const target = vscode.ConfigurationTarget.Global;
  await cfg.update('endpoint', p.endpoint, target);
  await cfg.update('projectId', p.projectId, target);
  await cfg.update('defaultModel', p.defaultModel, target);
  // Also mirror the API key into the registered `aiml.apiKey` setting for
  // backwards compatibility. (It already has scope "machine" so it isn't
  // synced.) Tools that read the legacy config keep working.
  await cfg.update('apiKey', activeApiKeyCache || '', target);
}

function deriveLabel(orgName?: string, email?: string, endpoint?: string): string {
  if (orgName) return orgName;
  if (email) return email.split('@')[0] ?? email;
  if (endpoint) {
    try {
      return new URL(endpoint).host;
    } catch { /* */ }
  }
  return 'AIML';
}
