"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchAssistantSettingsView, updateAssistantSettings, fetchMe, type AuthMe } from "@/lib/api";
import type { AssistantSettingsView } from "@/lib/settings";
import { Loader2, Save, CheckCircle2, Plus, X, RefreshCw, Zap, Trash2, User, LogIn, AlertTriangle } from "lucide-react";

/**
 * Form chrome, written once.
 *
 * Every control on this page is the same control, so the class strings live here
 * rather than being retyped per field — that is what kept eight inputs in step
 * before, and it is what keeps the focus treatment identical across all of them.
 * Focus deliberately does NOT set `outline-none`: `globals.css` gives every
 * focusable element a signal-coloured ring, and the border shift below is an
 * addition to it, not a replacement.
 */
const INPUT =
  "w-full min-h-11 rounded-lg border border-[var(--line)] bg-[var(--ink-800)] px-sm py-sm text-meta text-[var(--text-primary)] placeholder:text-[var(--text-faint)] transition-colors duration-200 hover:border-[var(--line-strong)] focus:border-[var(--signal-500)]";
const LABEL = "mb-xs block text-meta font-medium text-[var(--text-secondary)]";
const HELP = "mt-xs text-meta leading-relaxed text-[var(--text-muted)]";
const BTN =
  "flex min-h-11 cursor-pointer items-center gap-xs rounded-lg border border-[var(--line)] bg-[var(--ink-800)] px-sm text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-[var(--line-strong)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50";
/** Coral is risk, and clearing a saved credential is the only risk on this page. */
const BTN_DANGER =
  "flex min-h-11 cursor-pointer items-center gap-xs rounded-lg border border-[var(--line)] bg-[var(--ink-800)] px-sm text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-[var(--coral-500)]/40 hover:text-[var(--coral-400)] disabled:cursor-not-allowed disabled:opacity-50";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AssistantSettingsView | null>(null);
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [anthropicKey, setAnthropicKey] = useState("");
  const [localBaseUrl, setLocalBaseUrl] = useState("");
  const [localModel, setLocalModel] = useState("");
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [useSubscription, setUseSubscription] = useState(false);
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [localApiKey, setLocalApiKey] = useState("");
  const [modelList, setModelList] = useState<string[]>([]);
  const [newModelInput, setNewModelInput] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [modelListError, setModelListError] = useState<string | null>(null);
  const [providerName, setProviderName] = useState("");
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);

  useEffect(() => {
    fetchAssistantSettingsView()
      .then((data) => {
        setSettings(data);
        setLocalBaseUrl(data.localBaseUrl || "");
        setLocalModel(data.localModel || "");
        setClaudeModel(data.claudeModel || "sonnet");
        setUseSubscription(data.useClaudeSubscription);
        setModelList(data.localModelList || []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load settings");
        setLoading(false);
      });
    fetchMe().then(setMe).catch(() => {});
  }, []);

  async function persistModelList(next: string[]) {
    setModelListError(null);
    try {
      const updated = await updateAssistantSettings({ localModelList: next.length > 0 ? next : null });
      setSettings(updated);
      setModelList(updated.localModelList || []);
    } catch (err) {
      setModelListError(err instanceof Error ? err.message : "Failed to update model list");
    }
  }

  function handleAddModel() {
    const trimmed = newModelInput.trim();
    if (!trimmed || modelList.includes(trimmed)) { setNewModelInput(""); return; }
    setNewModelInput("");
    persistModelList([...modelList, trimmed]);
  }

  function handleRemoveModel(m: string) {
    persistModelList(modelList.filter((x) => x !== m));
  }

  async function handleDiscover() {
    setDiscovering(true);
    setModelListError(null);
    try {
      const res = await fetch("/api/settings/models?discover=true");
      const data = await res.json() as { models?: string[] };
      setDiscovered((data.models || []).filter((m) => !modelList.includes(m)));
    } catch (err) {
      setModelListError(err instanceof Error ? err.message : "Failed to reach the local model server");
    } finally {
      setDiscovering(false);
    }
  }

  async function handleUseProvider(id: string) {
    setProviderBusy(id);
    setProviderError(null);
    try {
      const updated = await updateAssistantSettings({ useProviderId: id });
      setSettings(updated);
      setLocalBaseUrl(updated.localBaseUrl || "");
      setLocalModel(updated.localModel || "");
      setModelList(updated.localModelList || []);
      setLocalApiKey("");
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Failed to switch provider");
    } finally {
      setProviderBusy(null);
    }
  }

  async function handleDeleteProvider(id: string) {
    if (!confirm("Delete this saved provider profile?")) return;
    setProviderBusy(id);
    setProviderError(null);
    try {
      const updated = await updateAssistantSettings({ deleteProviderId: id });
      setSettings(updated);
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Failed to delete profile");
    } finally {
      setProviderBusy(null);
    }
  }

  async function handleSaveProvider() {
    const name = providerName.trim();
    if (!name) { setProviderError("Enter a name for this profile"); return; }
    if (!localBaseUrl.trim()) { setProviderError("Set a Base URL above before saving a profile"); return; }
    setProviderBusy("__new__");
    setProviderError(null);
    try {
      const updated = await updateAssistantSettings({
        saveProvider: { name, baseUrl: localBaseUrl.trim(), apiKey: localApiKey || undefined, models: modelList },
      });
      setSettings(updated);
      setProviderName("");
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProviderBusy(null);
    }
  }

  async function handleToggleSubscription() {
    setSubscriptionBusy(true);
    setError(null);
    try {
      const next = !useSubscription;
      const updated = await updateAssistantSettings({ useClaudeSubscription: next });
      setSettings(updated);
      setUseSubscription(updated.useClaudeSubscription);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update subscription setting");
    } finally {
      setSubscriptionBusy(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const patch: { anthropicApiKey?: string | null; claudeModel?: string | null; localBaseUrl?: string | null; localModel?: string | null; localApiKey?: string | null } = {
        localBaseUrl: localBaseUrl || null,
        localModel: localModel || null,
        claudeModel: claudeModel || null,
      };
      
      if (anthropicKey) patch.anthropicApiKey = anthropicKey;
      if (localApiKey) patch.localApiKey = localApiKey;

      const updated = await updateAssistantSettings(patch);
      setSettings(updated);
      setAnthropicKey(""); 
      setLocalApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearAnthropic() {
    if (!confirm("Clear saved Anthropic API key?")) return;
    setSaving(true);
    try {
      const updated = await updateAssistantSettings({ anthropicApiKey: null });
      setSettings(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearLocalKey() {
    if (!confirm("Clear saved Local API key?")) return;
    setSaving(true);
    try {
      const updated = await updateAssistantSettings({ localApiKey: null });
      setSettings(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearClaudeModel() {
    setSaving(true);
    try {
      const updated = await updateAssistantSettings({ claudeModel: null });
      setSettings(updated);
      setClaudeModel(updated.claudeModel || "sonnet");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="shell flex max-w-note items-center justify-center gap-sm py-3xl text-meta text-[var(--text-muted)]">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--signal-500)]" /> Loading settings…
      </div>
    );
  }

  if (error && !settings) {
    // The whole page for anyone who is not signed in, so it gets a designed state
    // rather than a bare pill above an empty screen: name the situation, explain it
    // in one line, and offer the action that resolves it. An error with no way out
    // is a dead end, and this one has an obvious exit.
    const needsAuth = /unauthor|sign in/i.test(error ?? "");
    return (
      <div className="shell max-w-measure py-3xl">
        <div className="panel p-lg sm:p-xl">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--coral-500)]/30 bg-[var(--coral-500)]/[0.08]">
            <AlertTriangle className="h-[18px] w-[18px] text-[var(--coral-400)]" />
          </div>
          <div className="eyebrow mt-md">{needsAuth ? "Sign-in required" : "Settings unavailable"}</div>
          <h1 className="font-display mt-sm text-h3 leading-snug tracking-tight text-[var(--text-primary)]">
            {needsAuth ? "Settings are per-account." : "Could not load settings."}
          </h1>
          <p className="mt-sm max-w-note text-meta leading-relaxed text-[var(--text-secondary)]">{error}</p>
          <div className="mt-lg flex flex-wrap gap-sm">
            {needsAuth && (
              <a
                href={`/api/auth/github?returnTo=${encodeURIComponent("/settings")}`}
                className="flex min-h-11 cursor-pointer items-center gap-sm rounded-xl bg-[var(--signal-500)] px-md text-meta font-semibold text-[var(--ink-900)] transition-colors duration-200 hover:bg-[var(--signal-400)]"
              >
                <LogIn className="h-4 w-4" /> Sign in with GitHub
              </a>
            )}
            <Link
              href="/"
              className="flex min-h-11 cursor-pointer items-center rounded-xl border border-[var(--line)] px-md text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-line-strong hover:text-[var(--text-primary)]"
            >
              Back to indexing
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell max-w-measure py-xl pb-3xl">
      <p className="eyebrow mb-sm">Configuration</p>
      <h1 className="font-display mb-lg text-h1 tracking-tight text-[var(--text-primary)]">Settings</h1>

      {me?.githubAuthEnabled && (
        <div className={`mb-lg flex items-start gap-sm rounded-xl border px-md py-sm text-meta leading-relaxed text-[var(--text-secondary)] ${
          me.user
            ? "border-[var(--signal-500)]/25 bg-[var(--signal-500)]/[0.05]"
            : "border-[var(--amber-400)]/25 bg-[var(--amber-400)]/[0.05]"
        }`}>
          {me.user
            ? <User className="mt-hair h-3.5 w-3.5 shrink-0 text-[var(--signal-500)]" />
            : <LogIn className="mt-hair h-3.5 w-3.5 shrink-0 text-[var(--amber-400)]" />}
          {me.user ? (
            <span>
              Signed in as <strong className="font-medium text-[var(--text-primary)]">{me.user.login}</strong> — everything below is saved to your account only, never
              shared with or visible to any other GitHub account on this deployment.
            </span>
          ) : (
            <span>
              You&apos;re not signed in with GitHub. Settings saved now go to a shared configuration anyone using this
              deployment can see and overwrite.{" "}
              <a
                href="/api/auth/github?returnTo=/settings"
                className="cursor-pointer text-[var(--amber-400)] underline decoration-[var(--amber-400)]/40 underline-offset-2 transition-colors duration-200 hover:decoration-[var(--amber-400)]"
              >
                Sign in with GitHub
              </a>{" "}
              first to keep your API key and model choices private to your own account.
            </span>
          )}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-lg">
        
        {/* Claude Section */}
        <div className="panel p-lg">
          <p className="eyebrow mb-xs">Channel 01</p>
          <h2 className="font-display text-h3 tracking-tight text-[var(--text-primary)]">Claude AI Assistant</h2>
          <p className="mt-sm mb-lg text-meta leading-relaxed text-[var(--text-secondary)]">
            Configure Anthropic Claude to power the in-editor AI Assistant. 
            CodeGraph uses the official Claude Agent SDK.
          </p>
          
          <div className="space-y-md">
            <div>
              <label htmlFor="anthropic-key" className={LABEL}>
                Anthropic API Key
              </label>
              <div className="flex gap-sm">
                <input
                  id="anthropic-key"
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder={settings?.anthropicApiKeyMasked ? `Saved (${settings.anthropicApiKeyMasked})` : "sk-ant-..."}
                  className={`flex-1 font-mono ${INPUT}`}
                />
                {settings?.anthropicApiKeySavedInDb && (
                  <button
                    type="button"
                    onClick={handleClearAnthropic}
                    className={BTN_DANGER}
                  >
                    Clear
                  </button>
                )}
              </div>
              {settings?.anthropicApiKeySet && !settings.anthropicApiKeySavedInDb && (
                <p className={HELP}>Currently loaded from ANTHROPIC_API_KEY environment variable.</p>
              )}
            </div>

            <div className="border-t border-[var(--line-soft)] pt-md">
              <label htmlFor="use-subscription" className="flex cursor-pointer items-start gap-sm">
                <input
                  id="use-subscription"
                  type="checkbox"
                  checked={useSubscription}
                  onChange={handleToggleSubscription}
                  disabled={subscriptionBusy}
                  className="mt-hair h-4 w-4 cursor-pointer accent-[var(--signal-500)]"
                />
                <span className="text-meta text-[var(--text-primary)]">
                  Use my Claude Pro/Max/Team subscription instead of an API key
                  {subscriptionBusy && <Loader2 className="ml-sm inline h-3.5 w-3.5 animate-spin text-[var(--signal-500)]" />}
                </span>
              </label>
              <p className={`${HELP} ml-lg`}>
                Uses your subscription&apos;s included usage instead of per-token API billing. An API Key above, if set, always
                takes priority over this.
              </p>
              {useSubscription && settings && !settings.claudeSubscriptionUsable && (
                <div className="mt-sm ml-lg space-y-sm rounded-lg border border-[var(--amber-400)]/25 bg-[var(--amber-400)]/[0.05] p-sm text-meta leading-relaxed">
                  <p className="flex items-start gap-sm font-medium text-[var(--amber-400)]">
                    <AlertTriangle className="mt-hair h-3.5 w-3.5 shrink-0" />
                    <span>This server has no usable Claude Code login right now — starting a chat with this toggle on and no API Key set above will fail.</span>
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    To actually use your subscription instead of an API key, on <strong className="font-medium text-[var(--text-primary)]">your own computer</strong>{" "}
                    (not this server) run:
                  </p>
                  <pre className="overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--ink-900)] px-sm py-sm font-mono text-[var(--text-primary)]">
                    npx @anthropic-ai/claude-code setup-token
                  </pre>
                  <p className="text-[var(--text-secondary)]">
                    This opens a browser to sign in with your Claude Pro/Max/Team account and prints a long-lived (1 year)
                    token. Set that as <code className="rounded bg-[var(--ink-700)] px-2xs py-hair font-mono text-[var(--text-primary)]">CLAUDE_CODE_OAUTH_TOKEN</code> in this deployment&apos;s
                    environment (e.g. the Render dashboard&apos;s Environment tab) and redeploy — the server itself never needs
                    an interactive login, only that one token.
                  </p>
                </div>
              )}
            </div>
            <div>
              <label htmlFor="claude-model" className={LABEL}>
                Model
              </label>
              <div className="flex gap-sm">
                <select
                  id="claude-model"
                  value={claudeModel}
                  onChange={(e) => setClaudeModel(e.target.value)}
                  className={`flex-1 cursor-pointer ${INPUT}`}
                >
                  <option value="opus">Claude Opus (most capable)</option>
                  <option value="sonnet">Claude Sonnet (balanced)</option>
                  <option value="haiku">Claude Haiku (fastest)</option>
                </select>
                {settings?.claudeModelSavedInDb && (
                  <button
                    type="button"
                    onClick={handleClearClaudeModel}
                    className={BTN_DANGER}
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className={HELP}>
                {settings?.claudeModelSavedInDb
                  ? "Saved to your account — click Save Settings below after changing it, or Clear to fall back to the deployment default."
                  : "Using the deployment default. Pick a model and click Save Settings below to save it to your account."}
              </p>
            </div>
          </div>
        </div>

        {/* Local LLM Section */}
        <div className="panel p-lg">
          <p className="eyebrow mb-xs">Channel 02</p>
          <h2 className="font-display text-h3 tracking-tight text-[var(--text-primary)]">Local Model (OpenAI-Compatible)</h2>
          <p className="mt-sm mb-lg text-meta leading-relaxed text-[var(--text-secondary)]">
            Point the AI Assistant at your own local model server (Ollama, LM Studio, vLLM, etc).
          </p>

          {settings && settings.localProviders.length > 0 && (
            <div className="mb-lg space-y-sm">
              <p className="eyebrow mb-sm">Saved providers</p>
              {settings.localProviders.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-sm rounded-lg border border-[var(--line)] bg-[var(--ink-800)] px-sm py-sm">
                  <div className="min-w-0">
                    <div className="truncate text-meta text-[var(--text-primary)]">{p.name}</div>
                    <div className="truncate font-mono text-meta text-[var(--text-muted)]">{p.baseUrl}{p.hasApiKey ? " · has key" : ""}{p.models.length ? ` · ${p.models.length} model${p.models.length === 1 ? "" : "s"}` : ""}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-sm">
                    <button
                      type="button"
                      onClick={() => handleUseProvider(p.id)}
                      disabled={providerBusy === p.id}
                      className="flex min-h-11 cursor-pointer items-center gap-xs rounded-lg border border-[var(--signal-500)]/35 bg-[var(--signal-500)]/[0.08] px-sm text-meta font-medium text-[var(--signal-500)] transition-colors duration-200 hover:bg-[var(--signal-500)]/[0.16] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {providerBusy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                      Use
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteProvider(p.id)}
                      disabled={providerBusy === p.id}
                      className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-[var(--line)] text-[var(--text-muted)] transition-colors duration-200 hover:border-[var(--coral-500)]/40 hover:text-[var(--coral-400)] disabled:cursor-not-allowed disabled:opacity-50"
                      title="Delete profile"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          <div className="space-y-md">
            <div>
              <label htmlFor="local-base-url" className={LABEL}>Base URL</label>
              <input
                id="local-base-url"
                type="text"
                value={localBaseUrl}
                onChange={(e) => setLocalBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className={`font-mono ${INPUT}`}
              />
              <p className={HELP}>The OpenAI-compatible endpoint, including its version path.</p>
            </div>
            
            <div>
              <label htmlFor="local-model" className={LABEL}>Model Name</label>
              <input
                id="local-model"
                type="text"
                value={localModel}
                onChange={(e) => setLocalModel(e.target.value)}
                placeholder="qwen2.5-coder:7b"
                className={`font-mono ${INPUT}`}
              />
              <p className={HELP}>The model the assistant uses by default on this server.</p>
            </div>

            <div>
              <label htmlFor="local-api-key" className={LABEL}>API Key (Optional)</label>
              <div className="flex gap-sm">
                <input
                  id="local-api-key"
                  type="password"
                  value={localApiKey}
                  onChange={(e) => setLocalApiKey(e.target.value)}
                  placeholder={settings?.localApiKeyMasked ? `Saved (${settings.localApiKeyMasked})` : "Bearer token (if required)"}
                  className={`flex-1 font-mono ${INPUT}`}
                />
                {settings?.localSavedInDb && settings?.localApiKeyMasked && (
                   <button
                   type="button"
                   onClick={handleClearLocalKey}
                   className={BTN_DANGER}
                 >
                   Clear
                 </button>
                )}
              </div>
              <p className={HELP}>Only needed for hosted OpenAI-compatible providers; local servers usually accept none.</p>
            </div>

            <div className="border-t border-[var(--line-soft)] pt-md">
              <div className="mb-sm flex flex-wrap items-start justify-between gap-sm">
                <div>
                  <p className="text-meta font-medium text-[var(--text-secondary)]">Manage Models</p>
                  <p className="mt-2xs text-meta text-[var(--text-muted)]">Shown in the chat panel&apos;s dropdown.</p>
                </div>
                <button
                  type="button"
                  onClick={handleDiscover}
                  disabled={discovering}
                  className={BTN}
                >
                  {discovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Discover from server
                </button>
              </div>

              {modelList.length === 0 && (
                <p className="mb-sm text-meta leading-relaxed text-[var(--text-muted)]">
                  No curated models yet — the chat dropdown will auto-fetch the server&apos;s full live list until you add at least one here.
                </p>
              )}

              {modelList.length > 0 && (
                <div className="mb-sm flex flex-wrap gap-sm">
                  {modelList.map((m) => (
                    <span key={m} className="flex min-h-11 items-center gap-2xs rounded-full border border-[var(--line)] bg-[var(--ink-800)] pl-md pr-2xs font-mono text-meta text-[var(--text-secondary)]">
                      {m}
                      <button
                        type="button"
                        onClick={() => handleRemoveModel(m)}
                        aria-label={`Remove ${m}`}
                        className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--text-muted)] transition-colors duration-200 hover:bg-[var(--ink-600)] hover:text-[var(--coral-400)]"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <label htmlFor="new-model" className={LABEL}>Add a model</label>
              <div className="flex gap-sm">
                <input
                  id="new-model"
                  type="text"
                  value={newModelInput}
                  onChange={(e) => setNewModelInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddModel(); } }}
                  placeholder="e.g. llama-3.3-70b-versatile"
                  className={`flex-1 font-mono ${INPUT}`}
                />
                <button
                  type="button"
                  onClick={handleAddModel}
                  className={BTN}
                >
                  <Plus className="h-4 w-4" /> Add
                </button>
              </div>

              {discovered.length > 0 && (
                <div className="mt-md rounded-lg border border-[var(--line)] bg-[var(--ink-850)] p-sm">
                  <p className="eyebrow mb-sm">Found on the server — click to add</p>
                  <div className="flex flex-wrap gap-sm">
                    {discovered.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => { persistModelList([...modelList, m]); setDiscovered((prev) => prev.filter((x) => x !== m)); }}
                        className="flex min-h-11 cursor-pointer items-center gap-xs rounded-full border border-[var(--line)] bg-[var(--ink-800)] px-md font-mono text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-[var(--signal-500)]/40 hover:text-[var(--signal-500)]"
                      >
                        <Plus className="h-3 w-3" /> {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {modelListError && (
                <p className="mt-sm flex items-start gap-sm text-meta leading-relaxed text-[var(--coral-400)]">
                  <AlertTriangle className="mt-hair h-3.5 w-3.5 shrink-0" /> {modelListError}
                </p>
              )}
            </div>

            <div className="border-t border-[var(--line-soft)] pt-md">
              <label htmlFor="provider-name" className={LABEL}>Save current config as a profile</label>
              <p className="mb-sm text-meta leading-relaxed text-[var(--text-muted)]">
                Names this Base URL + API key + model list so you can switch back to it with one click, instead of retyping it.
              </p>
              <div className="flex gap-sm">
                <input
                  id="provider-name"
                  type="text"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSaveProvider(); } }}
                  placeholder="e.g. Groq"
                  className={`flex-1 ${INPUT}`}
                />
                <button
                  type="button"
                  onClick={handleSaveProvider}
                  disabled={providerBusy === "__new__"}
                  className={BTN}
                >
                  {providerBusy === "__new__" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save Profile
                </button>
              </div>
              {providerError && (
                <p className="mt-sm flex items-start gap-sm text-meta leading-relaxed text-[var(--coral-400)]">
                  <AlertTriangle className="mt-hair h-3.5 w-3.5 shrink-0" /> {providerError}
                </p>
              )}
            </div>
          </div>
        </div>

        {error && (
          <p className="flex items-start gap-sm text-meta leading-relaxed text-[var(--coral-400)]">
            <AlertTriangle className="mt-hair h-4 w-4 shrink-0" /> {error}
          </p>
        )}

        <div className="flex items-center gap-md">
          <button
            type="submit"
            disabled={saving}
            className="flex min-h-11 cursor-pointer items-center gap-sm rounded-lg bg-[var(--signal-500)] px-md text-meta font-medium text-[var(--ink-900)] transition-colors duration-200 hover:bg-[var(--signal-400)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Settings
          </button>
          
          {saved && (
            <span className="flex items-center gap-xs text-meta text-[var(--signal-500)]">
              <CheckCircle2 className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
