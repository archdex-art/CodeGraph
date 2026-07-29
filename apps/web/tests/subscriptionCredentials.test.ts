// Regression tests for the "Not logged in - Please run /login" bug: toggling
// "Use my Claude subscription" alone used to be treated as sufficient
// evidence Claude was configured, even when this server process had never
// actually authenticated (no CLAUDE_CODE_OAUTH_TOKEN, no local `claude
// login` credentials file). The very first chat turn then failed deep
// inside the headless CLI subprocess, with no clear explanation.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CG_SESSION_SECRET = process.env.CG_SESSION_SECRET || "test-secret-for-subscription-credentials";

import { claudeSubscriptionCredentialsAvailable, effectiveUseClaudeSubscription } from "@/lib/settings";

describe("claudeSubscriptionCredentialsAvailable", () => {
  const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  afterEach(() => {
    if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  });

  it("is true when CLAUDE_CODE_OAUTH_TOKEN is set, regardless of any credentials file", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "a-real-looking-token";
    expect(claudeSubscriptionCredentialsAvailable()).toBe(true);
  });

  it("is false when CLAUDE_CODE_OAUTH_TOKEN is unset and no ~/.claude/.credentials.json exists (this test environment's real state)", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Not mocking homedir() here deliberately: this proves the real check
    // against this actual CI/sandbox environment, which has no `claude
    // login` session -- exactly the state a fresh Render deploy is in.
    expect(claudeSubscriptionCredentialsAvailable()).toBe(false);
  });
});

describe("effectiveUseClaudeSubscription vs claudeSubscriptionCredentialsAvailable — the fix's core distinction", () => {
  const originalToggle = process.env.CG_CLAUDE_USE_SUBSCRIPTION;
  const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  afterEach(() => {
    if (originalToggle === undefined) delete process.env.CG_CLAUDE_USE_SUBSCRIPTION;
    else process.env.CG_CLAUDE_USE_SUBSCRIPTION = originalToggle;
    if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  });

  it("the toggle being on is NOT, by itself, evidence credentials exist -- these are two independent facts", () => {
    process.env.CG_CLAUDE_USE_SUBSCRIPTION = "true";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(effectiveUseClaudeSubscription()).toBe(true); // user's preference: on
    expect(claudeSubscriptionCredentialsAvailable()).toBe(false); // but unusable on this server
  });

  it("credentials existing does NOT mean the toggle is on -- the user still controls whether it's used", () => {
    delete process.env.CG_CLAUDE_USE_SUBSCRIPTION;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "a-real-looking-token";
    expect(effectiveUseClaudeSubscription()).toBe(false); // user hasn't opted in
    expect(claudeSubscriptionCredentialsAvailable()).toBe(true); // even though it would work
  });
});
