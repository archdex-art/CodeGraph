// Regression tests for verifyAnthropicApiKey (closes the "Invalid API key"
// gap: previously any string was accepted and persisted with zero
// validation, only failing deep inside a real chat turn against Anthropic).
// Also proves the /api/settings/assistant route actually rejects a
// confirmed-bad key BEFORE ever writing it to the settings table.
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

  it("reports ok:true when Anthropic accepts the key (200)", async () => {
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-real-key");
      expect((init?.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await verifyAnthropicApiKey("sk-ant-real-key");
    expect(result.ok).toBe(true);
  });

  it("reports ok:false reason:invalid when Anthropic returns 401 (this IS the 'Invalid API key' case)", async () => {
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

  it("reports ok:false reason:invalid on 403 too", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 403 })) as unknown as typeof fetch;
    const result = await verifyAnthropicApiKey("sk-ant-forbidden");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
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
  const USER_ID = 9001;
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

  beforeEach(() => {
    // GitHub OAuth isn't configured in this test env, so unauthorized() is a
    // no-op and every request lands in the ANONYMOUS_USER_ID bucket via
    // userIdFrom(req) -- fine, this suite tests the verification gate, not
    // the account-scoping gate (already covered by settings.test.ts).
  });

  it("rejects a key Anthropic returns 401 for, and never writes it to the DB", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })
    ) as unknown as typeof fetch;

    const res = await settingsPost(postRequest({ anthropicApiKey: "sk-ant-BAD-KEY" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("invalid x-api-key");

    // The anonymous bucket must not have picked up the rejected key.
    expect(getAssistantSettings(0).anthropicApiKey).toBeNull();
  });

  it("accepts and persists a key Anthropic returns 200 for", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

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
