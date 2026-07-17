// Verifies an Anthropic API key actually works before CodeGraph ever
// persists it, closing the gap that let "Invalid API key" surface deep
// inside a chat turn instead of immediately at save time: the Settings API
// previously accepted any string with zero validation (a truncated paste,
// a revoked key, or another provider's key entirely all "saved
// successfully" and only failed once a real chat session hit Anthropic).
//
// Uses GET /v1/models — the same base URL and `anthropic-version` header
// the official `@anthropic-ai/sdk` client itself sends (see
// `node_modules/@anthropic-ai/sdk/client.js`) — a free, side-effect-free
// metadata endpoint, so verifying costs nothing and can't consume a
// message/token budget.
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicKeyCheckResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "network"; message: string };

/** Calls Anthropic's own API with `key` and reports whether Anthropic itself
 *  accepts it. Distinguishes a confirmed-bad key (401/403 — reject the
 *  save) from a transient network/outage failure (don't block a save on
 *  our own connectivity issue; the key may well be fine). */
export async function verifyAnthropicApiKey(key: string, signal?: AbortSignal): Promise<AnthropicKeyCheckResult> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/models?limit=1`, {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      return {
        ok: false,
        reason: "invalid",
        message: body?.error?.message || "Anthropic rejected this API key (invalid or revoked).",
      };
    }
    // Any other status (429 rate-limited, 5xx) isn't evidence the KEY is
    // wrong -- don't block the save on it.
    return { ok: true };
  } catch {
    // Network failure reaching Anthropic (offline, DNS, timeout, egress
    // blocked) -- not evidence the key itself is bad, so don't block the save.
    return { ok: false, reason: "network", message: "Could not reach Anthropic to verify the key (network error) — saved anyway." };
  }
}
