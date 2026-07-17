// Runtime (DB-backed) configuration for the AI Assistant, editable from the
// in-app Settings page (`/settings`) instead of only via `.env`/deployment
// env vars. Stored as per-account key/value rows in the `settings` table
// (`PRIMARY KEY (key, user_id)` — see `db.ts`'s migration).
//
// Scoping: every function here takes a `userId`. Pass the signed-in
// session's `userId` so a saved key/model/profile is visible and editable
// ONLY from that GitHub-linked account — never shared with or overwritten
// by a different signed-in user. `userId` defaults to `ANONYMOUS_USER_ID`
// (0) when omitted, the "no account" bucket used for self-hosted instances
// with no GitHub sign-in configured, or an anonymous visitor on a
// deployment that does have it configured (mirrors `repos.owner_id IS
// NULL`'s "shared public bucket" convention elsewhere in this app).
//
// Precedence: a value saved through the Settings UI always wins over the
// matching env var, so an operator can ship a deployment-default key via
// env and still let a user override it (or vice versa: leave env unset and
// configure everything from the UI on a self-hosted instance). Secrets are
// never echoed back in full over the API — only a masked preview.
import { db } from "./db";

/** Sentinel `user_id` for "no account" — self-hosted/no sign-in, or an
 *  anonymous visitor. Never a real GitHub user id (those are positive). */
export const ANONYMOUS_USER_ID = 0;

export interface AssistantSettings {
  anthropicApiKey: string | null;
  claudeModel: string | null;
  /** "true" to authenticate the Claude backend via a Claude Pro/Max/Team
   *  subscription login (`claude login` / CLAUDE_CODE_OAUTH_TOKEN on the
   *  server) instead of a pay-per-token Anthropic API key. */
  useClaudeSubscription: string | null;
  localBaseUrl: string | null;
  localModel: string | null;
  localApiKey: string | null;
  /** JSON-encoded string[] of curated model ids for the local-model dropdown. */
  localModelList: string | null;
  /** JSON-encoded LocalProviderProfile[] -- saved presets the user can switch
   *  between with one click instead of re-typing base URL/key each time. */
  localProviders: string | null;
}

const KEYS = {
  anthropicApiKey: "assistant.anthropicApiKey",
  claudeModel: "assistant.claudeModel",
  useClaudeSubscription: "assistant.useClaudeSubscription",
  localBaseUrl: "assistant.localBaseUrl",
  localModel: "assistant.localModel",
  localApiKey: "assistant.localApiKey",
  localModelList: "assistant.localModelList",
  localProviders: "assistant.localProviders",
} as const;

function getRaw(key: string, userId: number): string | null {
  const row = db().prepare("SELECT value FROM settings WHERE key = ? AND user_id = ?").get(key, userId) as { value: string } | undefined;
  return row?.value ?? null;
}

function setRaw(key: string, value: string | null, userId: number): void {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    db().prepare("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
  } else {
    db()
      .prepare("INSERT INTO settings (key, user_id, value) VALUES (?, ?, ?) ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value")
      .run(key, userId, trimmed);
  }
}

export function getAssistantSettings(userId: number = ANONYMOUS_USER_ID): AssistantSettings {
  return {
    anthropicApiKey: getRaw(KEYS.anthropicApiKey, userId),
    claudeModel: getRaw(KEYS.claudeModel, userId),
    useClaudeSubscription: getRaw(KEYS.useClaudeSubscription, userId),
    localBaseUrl: getRaw(KEYS.localBaseUrl, userId),
    localModel: getRaw(KEYS.localModel, userId),
    localApiKey: getRaw(KEYS.localApiKey, userId),
    localModelList: getRaw(KEYS.localModelList, userId),
    localProviders: getRaw(KEYS.localProviders, userId),
  };
}

/** Only touches the keys present in `patch`; pass `null`/`""` to clear one. */
export function setAssistantSettings(patch: Partial<AssistantSettings>, userId: number = ANONYMOUS_USER_ID): void {
  if ("anthropicApiKey" in patch) setRaw(KEYS.anthropicApiKey, patch.anthropicApiKey ?? null, userId);
  if ("claudeModel" in patch) setRaw(KEYS.claudeModel, patch.claudeModel ?? null, userId);
  if ("useClaudeSubscription" in patch) setRaw(KEYS.useClaudeSubscription, patch.useClaudeSubscription ?? null, userId);
  if ("localBaseUrl" in patch) setRaw(KEYS.localBaseUrl, patch.localBaseUrl ?? null, userId);
  if ("localModel" in patch) setRaw(KEYS.localModel, patch.localModel ?? null, userId);
  if ("localApiKey" in patch) setRaw(KEYS.localApiKey, patch.localApiKey ?? null, userId);
  if ("localModelList" in patch) setRaw(KEYS.localModelList, patch.localModelList ?? null, userId);
  if ("localProviders" in patch) setRaw(KEYS.localProviders, patch.localProviders ?? null, userId);
}

/** A saved local-model provider preset -- name + base URL + key + curated
 *  model list, applied to the active local-model config in one click via
 *  `applyLocalProvider()` instead of retyping everything each time you switch. */
export interface LocalProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  models: string[];
}

function isLocalProviderProfile(v: unknown): v is LocalProviderProfile {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.name === "string" && typeof p.baseUrl === "string"
    && (p.apiKey === null || typeof p.apiKey === "string")
    && Array.isArray(p.models) && p.models.every((m) => typeof m === "string");
}

/** All saved provider profiles, raw (including their API keys) -- server-side
 *  use only. The client-facing view strips keys down to a `hasApiKey` flag. */
export function getLocalProviders(userId: number = ANONYMOUS_USER_ID): LocalProviderProfile[] {
  const raw = getAssistantSettings(userId).localProviders;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLocalProviderProfile) : [];
  } catch {
    return [];
  }
}

/** Creates or updates (by `id`) a saved provider profile. */
export function saveLocalProvider(profile: LocalProviderProfile, userId: number = ANONYMOUS_USER_ID): void {
  const list = getLocalProviders(userId);
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx >= 0) list[idx] = profile;
  else list.push(profile);
  setAssistantSettings({ localProviders: JSON.stringify(list) }, userId);
}

export function deleteLocalProvider(id: string, userId: number = ANONYMOUS_USER_ID): void {
  const list = getLocalProviders(userId).filter((p) => p.id !== id);
  setAssistantSettings({ localProviders: list.length > 0 ? JSON.stringify(list) : null }, userId);
}

/** Copies a saved profile's base URL/key/models into the active local-model
 *  config -- the one-click "switch provider" action. Returns `false` if no
 *  profile with that id exists. */
export function applyLocalProvider(id: string, userId: number = ANONYMOUS_USER_ID): boolean {
  const profile = getLocalProviders(userId).find((p) => p.id === id);
  if (!profile) return false;
  setAssistantSettings({
    localBaseUrl: profile.baseUrl,
    localApiKey: profile.apiKey,
    localModelList: profile.models.length > 0 ? JSON.stringify(profile.models) : null,
    localModel: profile.models[0] ?? null,
  }, userId);
  return true;
}

/** The curated list of local model ids the user has explicitly added via
 *  Settings, or `[]` if they haven't curated one yet (falls back to
 *  auto-discovery from the provider's /v1/models in that case). */
export function effectiveLocalModelList(userId: number = ANONYMOUS_USER_ID): string[] {
  const raw = getAssistantSettings(userId).localModelList;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/** The Anthropic API key to actually use: this account's DB-saved value, else `ANTHROPIC_API_KEY` env var. */
export function effectiveAnthropicApiKey(userId: number = ANONYMOUS_USER_ID): string | undefined {
  return getAssistantSettings(userId).anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined;
}

/** The Claude model alias/id to use (e.g. "sonnet", "opus", "haiku"), or
 *  `undefined` to let the Claude Agent SDK fall back to its own default. */
export function effectiveClaudeModel(userId: number = ANONYMOUS_USER_ID): string | undefined {
  return getAssistantSettings(userId).claudeModel || process.env.CG_CLAUDE_MODEL || undefined;
}

/** Whether the Claude backend should authenticate via a Claude Pro/Max/Team
 *  subscription login instead of an Anthropic API key. This only works if
 *  the machine running this Node process already has valid Claude Code
 *  credentials -- either `claude login` was run there, or
 *  `CLAUDE_CODE_OAUTH_TOKEN` is set in its environment. CodeGraph itself
 *  never stores or sees the subscription credentials; it just skips
 *  overriding ANTHROPIC_API_KEY so the bundled Claude Code executable falls
 *  back to whatever auth it already has. */
export function effectiveUseClaudeSubscription(userId: number = ANONYMOUS_USER_ID): boolean {
  return getAssistantSettings(userId).useClaudeSubscription === "true" || process.env.CG_CLAUDE_USE_SUBSCRIPTION === "true";
}

export interface EffectiveLocalLlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** The local-model endpoint to actually use, or `null` if neither the DB nor env has both a base URL and model. */
export function effectiveLocalLlmConfig(userId: number = ANONYMOUS_USER_ID): EffectiveLocalLlmConfig | null {
  const s = getAssistantSettings(userId);
  const baseUrl = s.localBaseUrl || process.env.CG_LOCAL_LLM_BASE_URL;
  const model = s.localModel || process.env.CG_LOCAL_LLM_MODEL;
  if (!baseUrl || !model) return null;
  const apiKey = s.localApiKey || process.env.CG_LOCAL_LLM_API_KEY || "local";
  return { baseUrl, model, apiKey };
}

function mask(secret: string | null | undefined): string | null {
  if (!secret) return null;
  return secret.length <= 8 ? "••••••••" : `${secret.slice(0, 4)}${"•".repeat(8)}${secret.slice(-4)}`;
}

export interface AssistantSettingsView {
  anthropicApiKeySet: boolean;
  anthropicApiKeyMasked: string | null;
  anthropicApiKeySavedInDb: boolean;
  claudeModel: string | null;
  claudeModelSavedInDb: boolean;
  useClaudeSubscription: boolean;
  localBaseUrl: string | null;
  localModel: string | null;
  localModelList: string[];
  localApiKeySet: boolean;
  localApiKeyMasked: string | null;
  localSavedInDb: boolean;
  localProviders: Array<{ id: string; name: string; baseUrl: string; hasApiKey: boolean; models: string[] }>;
}

export function viewAssistantSettings(userId: number = ANONYMOUS_USER_ID): AssistantSettingsView {
  const s = getAssistantSettings(userId);
  const anthropicKey = s.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
  const localApiKey = s.localApiKey || process.env.CG_LOCAL_LLM_API_KEY || null;
  return {
    anthropicApiKeySet: !!anthropicKey,
    anthropicApiKeyMasked: mask(anthropicKey),
    anthropicApiKeySavedInDb: !!s.anthropicApiKey,
    claudeModel: s.claudeModel || process.env.CG_CLAUDE_MODEL || null,
    claudeModelSavedInDb: !!s.claudeModel,
    useClaudeSubscription: effectiveUseClaudeSubscription(userId),
    localBaseUrl: s.localBaseUrl || process.env.CG_LOCAL_LLM_BASE_URL || null,
    localModel: s.localModel || process.env.CG_LOCAL_LLM_MODEL || null,
    localModelList: effectiveLocalModelList(userId),
    localApiKeySet: !!localApiKey,
    localApiKeyMasked: mask(localApiKey),
    localSavedInDb: !!(s.localBaseUrl || s.localModel),
    localProviders: getLocalProviders(userId).map((p) => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, hasApiKey: !!p.apiKey, models: p.models,
    })),
  };
}
