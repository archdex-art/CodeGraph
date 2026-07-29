// Extension -> Monaco language id + human label, for the built-in editor's
// syntax highlighting and status-bar "language mode" indicator.
const EXT_LANG: Record<string, { id: string; label: string }> = {
  ".ts": { id: "typescript", label: "TypeScript" },
  ".tsx": { id: "typescript", label: "TypeScript React" },
  ".js": { id: "javascript", label: "JavaScript" },
  ".jsx": { id: "javascript", label: "JavaScript React" },
  ".mjs": { id: "javascript", label: "JavaScript" },
  ".cjs": { id: "javascript", label: "JavaScript" },
  ".json": { id: "json", label: "JSON" },
  ".py": { id: "python", label: "Python" },
  ".go": { id: "go", label: "Go" },
  ".rs": { id: "rust", label: "Rust" },
  ".java": { id: "java", label: "Java" },
  ".rb": { id: "ruby", label: "Ruby" },
  ".php": { id: "php", label: "PHP" },
  ".c": { id: "c", label: "C" },
  ".h": { id: "c", label: "C" },
  ".cpp": { id: "cpp", label: "C++" },
  ".hpp": { id: "cpp", label: "C++" },
  ".cs": { id: "csharp", label: "C#" },
  ".swift": { id: "swift", label: "Swift" },
  ".kt": { id: "kotlin", label: "Kotlin" },
  ".scala": { id: "scala", label: "Scala" },
  ".sh": { id: "shell", label: "Shell Script" },
  ".bash": { id: "shell", label: "Shell Script" },
  ".sql": { id: "sql", label: "SQL" },
  ".css": { id: "css", label: "CSS" },
  ".scss": { id: "scss", label: "SCSS" },
  ".less": { id: "less", label: "LESS" },
  ".html": { id: "html", label: "HTML" },
  ".htm": { id: "html", label: "HTML" },
  ".md": { id: "markdown", label: "Markdown" },
  ".mdx": { id: "markdown", label: "MDX" },
  ".yml": { id: "yaml", label: "YAML" },
  ".yaml": { id: "yaml", label: "YAML" },
  ".xml": { id: "xml", label: "XML" },
  ".toml": { id: "ini", label: "TOML" },
  ".ini": { id: "ini", label: "INI" },
  ".dockerfile": { id: "dockerfile", label: "Dockerfile" },
  ".graphql": { id: "graphql", label: "GraphQL" },
  ".vue": { id: "html", label: "Vue" },
  ".txt": { id: "plaintext", label: "Plain Text" },
};

export function languageForPath(filePath: string): { id: string; label: string } {
  const name = filePath.split("/").pop() || filePath;
  if (/^dockerfile$/i.test(name)) return EXT_LANG[".dockerfile"];
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return EXT_LANG[ext] || { id: "plaintext", label: "Plain Text" };
}
