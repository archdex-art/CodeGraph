"use client";

import { useEffect, useState } from "react";
import { fetchAssistantSettingsView, updateAssistantSettings } from "@/lib/api";
import type { AssistantSettingsView } from "@/lib/settings";
import { Loader2, Save, CheckCircle2 } from "lucide-react";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AssistantSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [anthropicKey, setAnthropicKey] = useState("");
  const [localBaseUrl, setLocalBaseUrl] = useState("");
  const [localModel, setLocalModel] = useState("");
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [localApiKey, setLocalApiKey] = useState("");

  useEffect(() => {
    fetchAssistantSettingsView()
      .then((data) => {
        setSettings(data);
        setLocalBaseUrl(data.localBaseUrl || "");
        setLocalModel(data.localModel || "");
        setClaudeModel(data.claudeModel || "sonnet");
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load settings");
        setLoading(false);
      });
  }, []);

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
      <h1 className="text-2xl font-semibold text-white mb-6">Settings</h1>
      
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
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Model
              </label>
              <select
                value={claudeModel}
                onChange={(e) => setClaudeModel(e.target.value)}
                className="w-full bg-[#1a1a1a] border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
              >
                <option value="opus">Claude Opus (most capable)</option>
                <option value="sonnet">Claude Sonnet (balanced)</option>
                <option value="haiku">Claude Haiku (fastest)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Local LLM Section */}
        <div className="bg-[#0f0f0f] border border-white/10 rounded-lg p-6">
          <h2 className="text-lg font-medium text-white mb-4">Local Model (OpenAI-Compatible)</h2>
          <p className="text-sm text-gray-400 mb-6">
            Point the AI Assistant at your own local model server (Ollama, LM Studio, vLLM, etc).
          </p>
          
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
