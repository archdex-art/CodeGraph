// Regression tests for verifyAnthropicApiKey (closes the "Invalid API key"
// gap: previously any string was accepted and persisted with zero
// validation, only failing deep inside a real chat turn against Anthropic).
//
// Also locks in the fix for a real, shipped regression: the first version
// of this check verified against GET /v1/models (a metadata/listing
// endpoint). Anthropic supports scoped/restricted API keys that can work
// perfectly for chat completions while lacking permission to list models --
// so a fully valid, working key could get a false 403 there and be
// silently rejected at save time, meaning a real key could no longer be
// saved at all. This file now verifies the check calls POST /v1/messages
// (the exact endpoint the real chat feature uses) and only ever blocks a
// save on a confirmed 401 -- everything else, including 403, is treated as
// "not evidence the key is bad".
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-keycheck-"));
process.env.CG_DATA_DIR = dataDir;
process.env.CG_SESSION_SECRET = process.env.CG_SESSION_SECRET || "test-secret-for-keycheck";

import { verifyAnthropicApiKey } from "@/lib/anthropicKeyCheck";
import { getAssistantSettings } from "@/lib/settings";
import { POST as settingsPost } from "@/app/api/settings/assistant/route";

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("verifyAnthropicApiKey", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("calls POST /v1/messages (NOT /v1/models) with the exact same auth headers the real chat feature sends", async () => {
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-real-key");
      expect((init?.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "model: Field required" } }), { status: 400 });
    }) as unknown as typeof fetch;

    const result = await verifyAnthropicApiKey("sk-ant-real-key");
    expect(result.ok).toBe(true);
  });

  it("reports ok:true when Anthropic returns the expected 400 for the deliberately-empty body (proves auth passed)", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "model: Field required" } }), { status: 400 })
    ) as unknown as typeof fetch;
    expect((await verifyAnthropicApiKey("sk-ant-real-working-key")).ok).toBe(true);
  });

  it("reports ok:false reason:invalid ONLY on a confirmed 401 (this IS the 'Invalid API key' case)", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })
    ) as unknown as typeof fetch;

    const result = await verifyAnthropicApiKey("sk-ant-totally-wrong");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid");
      expect(result.message).toBe("invalid x-api-key");
    }
  });

  it("does NOT reject on 403 -- a scoped/restricted key can legitimately lack unrelated permissions without being broken for chat (this is the exact false-positive the /v1/models version had)", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 403 })) as unknown as typeof fetch;
    const result = await verifyAnthropicApiKey("sk-ant-scoped-but-working-key");
    expect(result.ok).toBe(true);
  });

  it("does NOT treat a rate-limit (429) or server error (500) as an invalid key", async () => {
    global.fetch = vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    expect((await verifyAnthropicApiKey("sk-ant-x")).ok).toBe(true);

    global.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect((await verifyAnthropicApiKey("sk-ant-x")).ok).toBe(true);
  });

  it("does NOT block on a network failure (not evidence the key itself is bad)", async () => {
    global.fetch = vi.fn(async () => { throw new Error("fetch failed: ENOTFOUND"); }) as unknown as typeof fetch;
    const result = await verifyAnthropicApiKey("sk-ant-x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network");
  });
});

describe("POST /api/settings/assistant rejects a confirmed-invalid key before persisting it", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function postRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/settings/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a key Anthropic returns 401 for, and never writes it to the DB", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })
    ) as unknown as typeof fetch;

    const res = await settingsPost(postRequest({ anthropicApiKey: "sk-ant-BAD-KEY" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("invalid x-api-key");

    expect(getAssistantSettings(0).anthropicApiKey).toBeNull();
  });

  it("accepts and persists a real key even when Anthropic returns 403 on this check (the exact regression that used to silently break saving)", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 403 })) as unknown as typeof fetch;

    const res = await settingsPost(postRequest({ anthropicApiKey: "sk-ant-SCOPED-BUT-VALID-KEY" }));
    expect(res.status).toBe(200);
    expect(getAssistantSettings(0).anthropicApiKey).toBe("sk-ant-SCOPED-BUT-VALID-KEY");
  });

  it("accepts and persists a key Anthropic's expected 400 (empty-body validation error) confirms is authenticated", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "model: Field required" } }), { status: 400 })) as unknown as typeof fetch;

    const res = await settingsPost(postRequest({ anthropicApiKey: "sk-ant-GOOD-KEY" }));
    expect(res.status).toBe(200);
    expect(getAssistantSettings(0).anthropicApiKey).toBe("sk-ant-GOOD-KEY");
  });

  it("still allows clearing a key (null) without calling Anthropic at all", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const res = await settingsPost(postRequest({ anthropicApiKey: null }));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
