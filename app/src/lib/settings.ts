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
  localBaseUrl: string | null;
  localModel: string | null;
  localApiKey: string | null;
}

const KEYS = {
  anthropicApiKey: "assistant.anthropicApiKey",
  localBaseUrl: "assistant.localBaseUrl",
  localModel: "assistant.localModel",
  localApiKey: "assistant.localApiKey",
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
    localBaseUrl: getRaw(KEYS.localBaseUrl),
    localModel: getRaw(KEYS.localModel),
    localApiKey: getRaw(KEYS.localApiKey),
  };
}

/** Only touches the keys present in `patch`; pass `null`/`""` to clear one. */
export function setAssistantSettings(patch: Partial<AssistantSettings>): void {
  if ("anthropicApiKey" in patch) setRaw(KEYS.anthropicApiKey, patch.anthropicApiKey ?? null);
  if ("localBaseUrl" in patch) setRaw(KEYS.localBaseUrl, patch.localBaseUrl ?? null);
  if ("localModel" in patch) setRaw(KEYS.localModel, patch.localModel ?? null);
  if ("localApiKey" in patch) setRaw(KEYS.localApiKey, patch.localApiKey ?? null);
}

/** The Anthropic API key to actually use: DB-saved value, else `ANTHROPIC_API_KEY` env var. */
export function effectiveAnthropicApiKey(): string | undefined {
  return getAssistantSettings().anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined;
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

/** What the Settings page renders: never the raw secret, only whether one is
 *  set (and from where) plus a masked preview so the user can recognize it. */
export interface AssistantSettingsView {
  anthropicApiKeySet: boolean;
  anthropicApiKeyMasked: string | null;
  anthropicApiKeySavedInDb: boolean;
  localBaseUrl: string | null;
  localModel: string | null;
  localApiKeySet: boolean;
  localApiKeyMasked: string | null;
  localSavedInDb: boolean;
}

export function viewAssistantSettings(): AssistantSettingsView {
  const s = getAssistantSettings();
  const anthropicKey = s.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
  const localApiKey = s.localApiKey || process.env.CG_LOCAL_LLM_API_KEY || null;
  return {
    anthropicApiKeySet: !!anthropicKey,
    anthropicApiKeyMasked: mask(anthropicKey),
    anthropicApiKeySavedInDb: !!s.anthropicApiKey,
    localBaseUrl: s.localBaseUrl || process.env.CG_LOCAL_LLM_BASE_URL || null,
    localModel: s.localModel || process.env.CG_LOCAL_LLM_MODEL || null,
    localApiKeySet: !!localApiKey,
    localApiKeyMasked: mask(localApiKey),
    localSavedInDb: !!(s.localBaseUrl || s.localModel),
  };
}
