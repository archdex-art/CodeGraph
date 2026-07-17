// Regression tests for the per-user credential-isolation fix: on an OPEN
// multi-tenant deployment (GitHub sign-in configured, no owner-lock), a
// signed-in user who has NOT saved their own credentials must NOT silently
// fall back to the operator's deployment-wide env-var credentials
// (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, CG_LOCAL_LLM_*). Every real
// account must bring its own key/subscription. The env-var fallback is only
// legitimate on a genuinely single-operator/trusted-team deployment:
//   - GitHub OAuth not configured at all (pure self-hosted), OR
//   - owner-lock active (CG_OWNER_GITHUB_LOGIN set -> only trusted logins).
//
// A user's OWN saved key ALWAYS wins in every mode -- that path (the whole
// "let users use their own Claude API token" feature) is deliberately never
// gated and is asserted here to prove the fix didn't break it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-credisolation-"));
process.env.CG_DATA_DIR = dataDir;

import {
  ANONYMOUS_USER_ID,
  setAssistantSettings,
  effectiveAnthropicApiKey,
  effectiveLocalLlmConfig,
  deploymentWideCredentialsAllowed,
  viewAssistantSettings,
} from "@/lib/settings";
import { aiAssistantConfigured } from "@/lib/agents/assistant";

const USER = 5001;

// Snapshot every process-global env var these functions read, so each test
// starts from a known state and never leaks into the next.
const ENV_KEYS = [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "CG_SESSION_SECRET",
  "CG_OWNER_GITHUB_LOGIN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CG_CLAUDE_USE_SUBSCRIPTION",
  "CG_LOCAL_LLM_BASE_URL",
  "CG_LOCAL_LLM_MODEL",
  "CG_LOCAL_LLM_API_KEY",
] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    original[k] = process.env[k];
    delete process.env[k];
  }
  // Clear any DB-saved values for our test user between cases.
  setAssistantSettings(
    { anthropicApiKey: null, localBaseUrl: null, localModel: null, localApiKey: null, useClaudeSubscription: null },
    USER,
  );
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k]!;
  }
});

/** Put the process into "open multi-tenant" mode: GitHub sign-in configured,
 *  no owner-lock -> arbitrary strangers can sign in. */
function openMultiTenant() {
  process.env.GITHUB_OAUTH_CLIENT_ID = "client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.CG_SESSION_SECRET = "session-secret";
  delete process.env.CG_OWNER_GITHUB_LOGIN;
}

describe("deploymentWideCredentialsAllowed", () => {
  it("is true on a pure self-hosted deployment (no GitHub OAuth configured)", () => {
    // No GITHUB_OAUTH_* vars set (beforeEach cleared them).
    expect(deploymentWideCredentialsAllowed()).toBe(true);
  });

  it("is false on an open multi-tenant deployment (GitHub OAuth on, no owner-lock)", () => {
    openMultiTenant();
    expect(deploymentWideCredentialsAllowed()).toBe(false);
  });

  it("is true again once owner-lock is active (CG_OWNER_GITHUB_LOGIN set)", () => {
    openMultiTenant();
    process.env.CG_OWNER_GITHUB_LOGIN = "trusted-op";
    expect(deploymentWideCredentialsAllowed()).toBe(true);
  });
});

describe("effectiveAnthropicApiKey — env fallback is gated, own key never is", () => {
  it("self-hosted: a user with no saved key inherits ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator";
    expect(effectiveAnthropicApiKey(USER)).toBe("sk-ant-operator");
  });

  it("open multi-tenant: a user with no saved key gets undefined, NOT the operator's key", () => {
    openMultiTenant();
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator";
    expect(effectiveAnthropicApiKey(USER)).toBeUndefined();
  });

  it("open multi-tenant: a user's OWN saved key always wins (the bring-your-own-key path)", () => {
    openMultiTenant();
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator";
    setAssistantSettings({ anthropicApiKey: "sk-ant-mine" }, USER);
    expect(effectiveAnthropicApiKey(USER)).toBe("sk-ant-mine");
  });

  it("owner-lock: a trusted-team deployment still inherits the env key with no saved key", () => {
    openMultiTenant();
    process.env.CG_OWNER_GITHUB_LOGIN = "trusted-op";
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator";
    expect(effectiveAnthropicApiKey(USER)).toBe("sk-ant-operator");
  });

  it("own saved key wins even in owner-lock mode", () => {
    openMultiTenant();
    process.env.CG_OWNER_GITHUB_LOGIN = "trusted-op";
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator";
    setAssistantSettings({ anthropicApiKey: "sk-ant-mine" }, USER);
    expect(effectiveAnthropicApiKey(USER)).toBe("sk-ant-mine");
  });
});

describe("effectiveLocalLlmConfig — env fallback gated identically", () => {
  it("self-hosted: inherits CG_LOCAL_LLM_* env config", () => {
    process.env.CG_LOCAL_LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.CG_LOCAL_LLM_MODEL = "qwen2.5-coder:7b";
    const cfg = effectiveLocalLlmConfig(USER);
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg!.model).toBe("qwen2.5-coder:7b");
  });

  it("open multi-tenant: a user with no saved local config gets null, NOT the operator's server", () => {
    openMultiTenant();
    process.env.CG_LOCAL_LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.CG_LOCAL_LLM_MODEL = "qwen2.5-coder:7b";
    expect(effectiveLocalLlmConfig(USER)).toBeNull();
  });

  it("open multi-tenant: a user's OWN saved local config always wins", () => {
    openMultiTenant();
    setAssistantSettings({ localBaseUrl: "http://mine:8080/v1", localModel: "my-model" }, USER);
    const cfg = effectiveLocalLlmConfig(USER);
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("http://mine:8080/v1");
    expect(cfg!.model).toBe("my-model");
  });
});

describe("aiAssistantConfigured — reflects the gate end-to-end", () => {
  it("open multi-tenant: false for a user with no saved key even though ANTHROPIC_API_KEY is set on the server", () => {
    openMultiTenant();
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator";
    expect(aiAssistantConfigured(USER)).toBe(false);
  });

  it("open multi-tenant: true once the user saves their own key", () => {
    openMultiTenant();
    setAssistantSettings({ anthropicApiKey: "sk-ant-mine" }, USER);
    expect(aiAssistantConfigured(USER)).toBe(true);
  });

  it("open multi-tenant: subscription toggle alone does NOT configure Claude through the operator's account", () => {
    openMultiTenant();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "operator-oauth-token";
    process.env.CG_CLAUDE_USE_SUBSCRIPTION = "true";
    expect(aiAssistantConfigured(USER)).toBe(false);
  });

  it("self-hosted: subscription mode works when the server has a real OAuth token", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "operator-oauth-token";
    process.env.CG_CLAUDE_USE_SUBSCRIPTION = "true";
    expect(aiAssistantConfigured(ANONYMOUS_USER_ID)).toBe(true);
  });
});

describe("viewAssistantSettings — Settings page never advertises the operator's credentials", () => {
  it("open multi-tenant: a user with no saved key sees anthropicApiKeySet=false despite the server env var", () => {
    openMultiTenant();
    process.env.ANTHROPIC_API_KEY = "sk-ant-operator";
    const view = viewAssistantSettings(USER);
    expect(view.anthropicApiKeySet).toBe(false);
    expect(view.anthropicApiKeyMasked).toBeNull();
    expect(view.anthropicApiKeySavedInDb).toBe(false);
  });

  it("open multi-tenant: claudeSubscriptionUsable is false even with a server OAuth token", () => {
    openMultiTenant();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "operator-oauth-token";
    expect(viewAssistantSettings(USER).claudeSubscriptionUsable).toBe(false);
  });

  it("self-hosted: claudeSubscriptionUsable is true with a server OAuth token", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "operator-oauth-token";
    expect(viewAssistantSettings(ANONYMOUS_USER_ID).claudeSubscriptionUsable).toBe(true);
  });

  it("open multi-tenant: a user's own saved key shows through normally", () => {
    openMultiTenant();
    setAssistantSettings({ anthropicApiKey: "sk-ant-mine-1234567890" }, USER);
    const view = viewAssistantSettings(USER);
    expect(view.anthropicApiKeySet).toBe(true);
    expect(view.anthropicApiKeySavedInDb).toBe(true);
    expect(view.anthropicApiKeyMasked).not.toBeNull();
  });
});
