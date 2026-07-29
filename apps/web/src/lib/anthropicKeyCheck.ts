// Verifies an Anthropic API key actually works before CodeGraph ever
// persists it, closing the gap that let "Invalid API key" surface deep
// inside a chat turn instead of immediately at save time: the Settings API
// previously accepted any string with zero validation (a truncated paste,
// a revoked key, or another provider's key entirely all "saved
// successfully" and only failed once a real chat session hit Anthropic).
//
// IMPORTANT: verifies against POST /v1/messages -- the exact endpoint the
// real chat feature uses -- NOT /v1/models. An earlier version of this
// file used /v1/models (a metadata/listing endpoint) and that was a real,
// shipped bug: Anthropic supports scoped/restricted API keys that can work
// perfectly for chat completions while lacking permission to list models,
// so a fully valid, working key could get a false 403 on /v1/models and be
// silently rejected at save time -- users could no longer save a real key
// at all. Verifying against /v1/messages instead eliminates that entire
// class of false positives by construction: whatever this call proves
// works IS the exact capability the app actually needs.
//
// Zero-cost: sends a deliberately empty/invalid body (missing the required
// `model`/`messages`/`max_tokens` fields). Confirmed live against the real
// API (not assumed) that Anthropic validates the `x-api-key` header BEFORE
// it ever validates the request body -- an invalid key gets a 401
// regardless of body content, so this never reaches the model and never
// consumes a token, while still exercising the identical auth path a real
// chat request takes.
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicKeyCheckResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "network"; message: string };

/** Calls Anthropic's own API with `key` and reports whether Anthropic itself
 *  rejects it outright. Deliberately conservative: only a confirmed,
 *  unambiguous 401 ("invalid x-api-key") blocks a save. Every other
 *  response -- including the expected 400 invalid_request_error from the
 *  intentionally-empty body once auth succeeds, 403, 429, 5xx, or a
 *  network failure reaching Anthropic at all -- is treated as "not
 *  evidence the key itself is bad" and does not block saving it. */
export async function verifyAnthropicApiKey(key: string, signal?: AbortSignal): Promise<AnthropicKeyCheckResult> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: "{}", // deliberately missing required fields -- never reaches the model
      signal,
    });
    if (res.status !== 401) return { ok: true };
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    return {
      ok: false,
      reason: "invalid",
      message: body?.error?.message || "Anthropic rejected this API key (invalid or revoked).",
    };
  } catch {
    // Network failure reaching Anthropic (offline, DNS, timeout, egress
    // blocked) -- not evidence the key itself is bad, so don't block the save.
    return { ok: false, reason: "network", message: "Could not reach Anthropic to verify the key (network error) — saved anyway." };
  }
}
