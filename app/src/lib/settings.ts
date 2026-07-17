// Runtime (DB-backed) configuration for the AI Assistant, editable from the
// in-app Settings page (`/settings`) instead of only via `.env`/deployment
// env vars. Stored as plain key/value rows in the `settings` table.
//
// Precedence: a value saved through the Settings UI always wins over the
// matching env var, so an operator can ship a deployment-default key via
// env and still let a user override it (or vice versa: leave env unset and
// configure everything from the UI on a self-hosted instance). Secrets are
// never echoed back in full over the API — only a masked preview.
import { db } from "./db";

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

function getRaw(key: string): string | null {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setRaw(key: string, value: string | null): void {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    db()
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, trimmed);
  }
}

export function getAssistantSettings(): AssistantSettings {
  return {
    anthropicApiKey: getRaw(KEYS.anthropicApiKey),
    claudeModel: getRaw(KEYS.claudeModel),
    useClaudeSubscription: getRaw(KEYS.useClaudeSubscription),
    localBaseUrl: getRaw(KEYS.localBaseUrl),
    localModel: getRaw(KEYS.localModel),
    localApiKey: getRaw(KEYS.localApiKey),
    localModelList: getRaw(KEYS.localModelList),
    localProviders: getRaw(KEYS.localProviders),
  };
}

/** Only touches the keys present in `patch`; pass `null`/`""` to clear one. */
export function setAssistantSettings(patch: Partial<AssistantSettings>): void {
  if ("anthropicApiKey" in patch) setRaw(KEYS.anthropicApiKey, patch.anthropicApiKey ?? null);
  if ("claudeModel" in patch) setRaw(KEYS.claudeModel, patch.claudeModel ?? null);
  if ("useClaudeSubscription" in patch) setRaw(KEYS.useClaudeSubscription, patch.useClaudeSubscription ?? null);
  if ("localBaseUrl" in patch) setRaw(KEYS.localBaseUrl, patch.localBaseUrl ?? null);
  if ("localModel" in patch) setRaw(KEYS.localModel, patch.localModel ?? null);
  if ("localApiKey" in patch) setRaw(KEYS.localApiKey, patch.localApiKey ?? null);
  if ("localModelList" in patch) setRaw(KEYS.localModelList, patch.localModelList ?? null);
  if ("localProviders" in patch) setRaw(KEYS.localProviders, patch.localProviders ?? null);
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
export function getLocalProviders(): LocalProviderProfile[] {
  const raw = getAssistantSettings().localProviders;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLocalProviderProfile) : [];
  } catch {
    return [];
  }
}

/** Creates or updates (by `id`) a saved provider profile. */
export function saveLocalProvider(profile: LocalProviderProfile): void {
  const list = getLocalProviders();
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx >= 0) list[idx] = profile;
  else list.push(profile);
  setAssistantSettings({ localProviders: JSON.stringify(list) });
}

export function deleteLocalProvider(id: string): void {
  const list = getLocalProviders().filter((p) => p.id !== id);
  setAssistantSettings({ localProviders: list.length > 0 ? JSON.stringify(list) : null });
}

/** Copies a saved profile's base URL/key/models into the active local-model
 *  config -- the one-click "switch provider" action. Returns `false` if no
 *  profile with that id exists. */
export function applyLocalProvider(id: string): boolean {
  const profile = getLocalProviders().find((p) => p.id === id);
  if (!profile) return false;
  setAssistantSettings({
    localBaseUrl: profile.baseUrl,
    localApiKey: profile.apiKey,
    localModelList: profile.models.length > 0 ? JSON.stringify(profile.models) : null,
    localModel: profile.models[0] ?? null,
  });
  return true;
}

/** The curated list of local model ids the user has explicitly added via
 *  Settings, or `[]` if they haven't curated one yet (falls back to
 *  auto-discovery from the provider's /v1/models in that case). */
export function effectiveLocalModelList(): string[] {
  const raw = getAssistantSettings().localModelList;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/** The Anthropic API key to actually use: DB-saved value, else `ANTHROPIC_API_KEY` env var. */
export function effectiveAnthropicApiKey(): string | undefined {
  return getAssistantSettings().anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined;
}

/** The Claude model alias/id to use (e.g. "sonnet", "opus", "haiku"), or
 *  `undefined` to let the Claude Agent SDK fall back to its own default. */
export function effectiveClaudeModel(): string | undefined {
  return getAssistantSettings().claudeModel || process.env.CG_CLAUDE_MODEL || undefined;
}

/** Whether the Claude backend should authenticate via a Claude Pro/Max/Team
 *  subscription login instead of an Anthropic API key. This only works if
 *  the machine running this Node process already has valid Claude Code
 *  credentials -- either `claude login` was run there, or
 *  `CLAUDE_CODE_OAUTH_TOKEN` is set in its environment. CodeGraph itself
 *  never stores or sees the subscription credentials; it just skips
 *  overriding ANTHROPIC_API_KEY so the bundled Claude Code executable falls
 *  back to whatever auth it already has. */
export function effectiveUseClaudeSubscription(): boolean {
  return getAssistantSettings().useClaudeSubscription === "true" || process.env.CG_CLAUDE_USE_SUBSCRIPTION === "true";
}

export interface EffectiveLocalLlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** The local-model endpoint to actually use, or `null` if neither the DB nor env has both a base URL and model. */
export function effectiveLocalLlmConfig(): EffectiveLocalLlmConfig | null {
  const s = getAssistantSettings();
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
  useClaudeSubscription: boolean;
  localBaseUrl: string | null;
  localModel: string | null;
  localModelList: string[];
  localApiKeySet: boolean;
  localApiKeyMasked: string | null;
  localSavedInDb: boolean;
  localProviders: Array<{ id: string; name: string; baseUrl: string; hasApiKey: boolean; models: string[] }>;
}

export function viewAssistantSettings(): AssistantSettingsView {
  const s = getAssistantSettings();
  const anthropicKey = s.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
  const localApiKey = s.localApiKey || process.env.CG_LOCAL_LLM_API_KEY || null;
  return {
    anthropicApiKeySet: !!anthropicKey,
    anthropicApiKeyMasked: mask(anthropicKey),
    anthropicApiKeySavedInDb: !!s.anthropicApiKey,
    claudeModel: s.claudeModel || process.env.CG_CLAUDE_MODEL || null,
    useClaudeSubscription: effectiveUseClaudeSubscription(),
    localBaseUrl: s.localBaseUrl || process.env.CG_LOCAL_LLM_BASE_URL || null,
    localModel: s.localModel || process.env.CG_LOCAL_LLM_MODEL || null,
    localModelList: effectiveLocalModelList(),
    localApiKeySet: !!localApiKey,
    localApiKeyMasked: mask(localApiKey),
    localSavedInDb: !!(s.localBaseUrl || s.localModel),
    localProviders: getLocalProviders().map((p) => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, hasApiKey: !!p.apiKey, models: p.models,
    })),
  };
}
