// Shared color maps for all visualizations.

export const LANG_COLOR: Record<string, string> = {
  TypeScript: "#3b82f6", JavaScript: "#eab308", Python: "#22c55e", Go: "#06b6d4",
  Rust: "#f97316", Java: "#ef4444", Ruby: "#e11d48", PHP: "#8b5cf6", C: "#94a3b8",
  "C++": "#a78bfa", "C#": "#14b8a6", Swift: "#fb923c", Kotlin: "#c084fc",
  Scala: "#dc2626", Shell: "#facc15", SQL: "#38bdf8", CSS: "#ec4899",
  HTML: "#fb7185", Markdown: "#64748b", JSON: "#a3a3a3", YAML: "#9ca3af",
};

export const EXT_COLOR: Record<string, string> = {
  ".css": "#a3e635", ".scss": "#a78bfa", ".html": "#fb7185", ".js": "#c084fc",
  ".jsx": "#c084fc", ".mjs": "#c084fc", ".cjs": "#c084fc", ".ts": "#60a5fa",
  ".tsx": "#2dd4bf", ".json": "#f9a8d4", ".md": "#6366f1", ".py": "#4f46e5",
  ".go": "#22d3ee", ".rs": "#fb923c", ".java": "#ef4444", ".rb": "#e11d48",
  ".php": "#8b5cf6", ".c": "#94a3b8", ".cpp": "#a78bfa", ".cs": "#14b8a6",
  ".sh": "#facc15", ".svg": "#f59e0b", ".png": "#38bdf8", ".yml": "#9ca3af",
  ".yaml": "#9ca3af",
};

export const langColor = (l: string | null | undefined) => (l && LANG_COLOR[l]) || "#6b7280";
export const extColor = (e: string | null | undefined) => (e && EXT_COLOR[e]) || "#9ca3af";
