"use client";

import { useEffect, useState } from "react";
import { fetchAssistantSettingsView, updateAssistantSettings, fetchMe, type AuthMe } from "@/lib/api";
import type { AssistantSettingsView } from "@/lib/settings";
import { Loader2, Save, CheckCircle2, Plus, X, RefreshCw, Zap, Trash2, User, LogIn } from "lucide-react";

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
      <div className="max-w-3xl mx-auto p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-md">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 pb-24">
      <h1 className="text-2xl font-semibold text-white mb-2">Settings</h1>

      {me?.githubAuthEnabled && (
        <div className={`mb-6 flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs ${
          me.user ? "border-purple-500/20 bg-purple-500/5 text-purple-300" : "border-amber-500/20 bg-amber-500/5 text-amber-300"
        }`}>
          {me.user ? <User className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <LogIn className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
          {me.user ? (
            <span>
              Signed in as <strong>{me.user.login}</strong> — everything below is saved to your account only, never
              shared with or visible to any other GitHub account on this deployment.
            </span>
          ) : (
            <span>
              You&apos;re not signed in with GitHub. Settings saved now go to a shared configuration anyone using this
              deployment can see and overwrite.{" "}
              <a href="/api/auth/github?returnTo=/settings" className="underline hover:text-amber-200">
                Sign in with GitHub
              </a>{" "}
              first to keep your API key and model choices private to your own account.
            </span>
          )}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-8">
        
        {/* Claude Section */}
        <div className="bg-[#0f0f0f] border border-white/10 rounded-lg p-6">
          <h2 className="text-lg font-medium text-white mb-4">Claude AI Assistant</h2>
          <p className="text-sm text-gray-400 mb-6">
            Configure Anthropic Claude to power the in-editor AI Assistant. 
            CodeGraph uses the official Claude Agent SDK.
          </p>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Anthropic API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder={settings?.anthropicApiKeyMasked ? `Saved (${settings.anthropicApiKeyMasked})` : "sk-ant-..."}
                  className="flex-1 bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
                />
                {settings?.anthropicApiKeySavedInDb && (
                  <button
                    type="button"
                    onClick={handleClearAnthropic}
                    className="px-3 py-2 border border-white/10 rounded-md text-sm text-gray-400 hover:text-white hover:bg-white/5"
                  >
                    Clear
                  </button>
                )}
              </div>
              {settings?.anthropicApiKeySet && !settings.anthropicApiKeySavedInDb && (
                <p className="text-xs text-gray-500 mt-1">Currently loaded from ANTHROPIC_API_KEY environment variable.</p>
              )}
            </div>

            <div className="pt-2 border-t border-white/10">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useSubscription}
                  onChange={handleToggleSubscription}
                  disabled={subscriptionBusy}
                  className="mt-0.5"
                />
                <span className="text-sm text-gray-300">
                  Use my Claude Pro/Max/Team subscription instead of an API key
                  {subscriptionBusy && <Loader2 className="inline w-3.5 h-3.5 animate-spin ml-2" />}
                </span>
              </label>
              <p className="text-xs text-gray-500 mt-1.5 ml-6">
                Only works if the machine running CodeGraph already has Claude Code logged in
                (run <code className="text-gray-400">claude login</code> in a terminal there once), or has{" "}
                <code className="text-gray-400">CLAUDE_CODE_OAUTH_TOKEN</code> set in its environment.
                Uses your subscription&apos;s included usage instead of per-token API billing.
                An API Key above, if set, always takes priority over this.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Model
              </label>
              <div className="flex gap-2">
                <select
                  value={claudeModel}
                  onChange={(e) => setClaudeModel(e.target.value)}
                  className="flex-1 bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
                >
                  <option value="opus">Claude Opus (most capable)</option>
                  <option value="sonnet">Claude Sonnet (balanced)</option>
                  <option value="haiku">Claude Haiku (fastest)</option>
                </select>
                {settings?.claudeModelSavedInDb && (
                  <button
                    type="button"
                    onClick={handleClearClaudeModel}
                    className="px-3 py-2 border border-white/10 rounded-md text-sm text-gray-400 hover:text-white hover:bg-white/5"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {settings?.claudeModelSavedInDb
                  ? "Saved to your account — click Save Settings below after changing it, or Clear to fall back to the deployment default."
                  : "Using the deployment default. Pick a model and click Save Settings below to save it to your account."}
              </p>
            </div>
          </div>
        </div>

        {/* Local LLM Section */}
        <div className="bg-[#0f0f0f] border border-white/10 rounded-lg p-6">
          <h2 className="text-lg font-medium text-white mb-4">Local Model (OpenAI-Compatible)</h2>
          <p className="text-sm text-gray-400 mb-6">
            Point the AI Assistant at your own local model server (Ollama, LM Studio, vLLM, etc).
          </p>

          {settings && settings.localProviders.length > 0 && (
            <div className="mb-6 space-y-2">
              <p className="text-sm font-medium text-gray-300">Saved Providers</p>
              {settings.localProviders.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">{p.name}</div>
                    <div className="text-xs text-gray-500 truncate font-mono">{p.baseUrl}{p.hasApiKey ? " · has key" : ""}{p.models.length ? ` · ${p.models.length} model${p.models.length === 1 ? "" : "s"}` : ""}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleUseProvider(p.id)}
                      disabled={providerBusy === p.id}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs border border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
                    >
                      {providerBusy === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                      Use
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteProvider(p.id)}
                      disabled={providerBusy === p.id}
                      className="p-1.5 rounded-md border border-white/10 text-gray-500 hover:text-red-400 hover:border-red-500/30 disabled:opacity-50"
                      title="Delete profile"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Base URL</label>
              <input
                type="text"
                value={localBaseUrl}
                onChange={(e) => setLocalBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="w-full bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Model Name</label>
              <input
                type="text"
                value={localModel}
                onChange={(e) => setLocalModel(e.target.value)}
                placeholder="qwen2.5-coder:7b"
                className="w-full bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">API Key (Optional)</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={localApiKey}
                  onChange={(e) => setLocalApiKey(e.target.value)}
                  placeholder={settings?.localApiKeyMasked ? `Saved (${settings.localApiKeyMasked})` : "Bearer token (if required)"}
                  className="flex-1 bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
                />
                {settings?.localSavedInDb && settings?.localApiKeyMasked && (
                   <button
                   type="button"
                   onClick={handleClearLocalKey}
                   className="px-3 py-2 border border-white/10 rounded-md text-sm text-gray-400 hover:text-white hover:bg-white/5"
                 >
                   Clear
                 </button>
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-300">
                  Manage Models <span className="text-gray-500 font-normal">(shown in the chat panel&apos;s dropdown)</span>
                </label>
                <button
                  type="button"
                  onClick={handleDiscover}
                  disabled={discovering}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-white disabled:opacity-50"
                >
                  {discovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Discover from server
                </button>
              </div>

              {modelList.length === 0 && (
                <p className="text-xs text-gray-500 mb-2">
                  No curated models yet — the chat dropdown will auto-fetch the server&apos;s full live list until you add at least one here.
                </p>
              )}

              <div className="flex flex-wrap gap-1.5 mb-2">
                {modelList.map((m) => (
                  <span key={m} className="flex items-center gap-1 bg-[#1a1a1a] border border-white/10 rounded-full pl-2.5 pr-1 py-1 text-xs text-gray-300">
                    {m}
                    <button type="button" onClick={() => handleRemoveModel(m)} className="p-0.5 rounded-full hover:bg-white/10 hover:text-white text-gray-500">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newModelInput}
                  onChange={(e) => setNewModelInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddModel(); } }}
                  placeholder="e.g. llama-3.3-70b-versatile"
                  className="flex-1 bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
                />
                <button
                  type="button"
                  onClick={handleAddModel}
                  className="flex items-center gap-1 px-3 py-2 border border-white/10 rounded-md text-sm text-gray-300 hover:bg-white/5"
                >
                  <Plus className="w-4 h-4" /> Add
                </button>
              </div>

              {discovered.length > 0 && (
                <div className="mt-3 border border-white/10 rounded-md p-3 bg-black/20">
                  <p className="text-xs text-gray-500 mb-2">Found on the server — click to add:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {discovered.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => { persistModelList([...modelList, m]); setDiscovered((prev) => prev.filter((x) => x !== m)); }}
                        className="flex items-center gap-1 bg-[#1a1a1a] border border-white/10 rounded-full pl-2.5 pr-2 py-1 text-xs text-gray-300 hover:border-purple-500/50 hover:text-white"
                      >
                        <Plus className="w-3 h-3" /> {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {modelListError && <p className="text-xs text-red-400 mt-2">{modelListError}</p>}
            </div>

            <div className="pt-2 border-t border-white/10">
              <label className="block text-sm font-medium text-gray-300 mb-1">Save current config as a profile</label>
              <p className="text-xs text-gray-500 mb-2">
                Names this Base URL + API key + model list so you can switch back to it with one click, instead of retyping it.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSaveProvider(); } }}
                  placeholder="e.g. Groq"
                  className="flex-1 bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
                />
                <button
                  type="button"
                  onClick={handleSaveProvider}
                  disabled={providerBusy === "__new__"}
                  className="flex items-center gap-1 px-3 py-2 border border-white/10 rounded-md text-sm text-gray-300 hover:bg-white/5 disabled:opacity-50"
                >
                  {providerBusy === "__new__" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Profile
                </button>
              </div>
              {providerError && <p className="text-xs text-red-400 mt-2">{providerError}</p>}
            </div>
          </div>
        </div>

        {error && (
          <div className="text-red-400 text-sm">{error}</div>
        )}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Settings
          </button>
          
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <CheckCircle2 className="w-4 h-4" /> Saved
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
