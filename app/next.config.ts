import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for slim Docker images.
  output: "standalone",
  // Pin the workspace root to this app so standalone output lands at
  // .next/standalone/server.js even when a parent-repo lockfile is present.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // Ensure Tree-sitter WASM grammars AND the Claude Agent SDK's platform-
  // specific native binary package are copied into the standalone bundle.
  // Both are resolved dynamically at runtime (tree-sitter's WASM loader,
  // the SDK's own process.platform/arch detection) rather than through a
  // statically-analyzable `require`, so webpack/turbopack's file tracer
  // can't see the reference and silently drops them from `.next/standalone`
  // — reproduced locally: without this, `.next/standalone/node_modules/
  // @anthropic-ai/` contains only the base `claude-agent-sdk` package, no
  // `claude-agent-sdk-<platform>-<arch>` subpackage, so the SDK's `query()`
  // throws "Native CLI binary for <platform> not found" the moment the AI
  // Assistant is used on ANY deployed (non-dev) instance.
  outputFileTracingIncludes: {
    "/api/**": ["./wasm/**", "./node_modules/@anthropic-ai/claude-agent-sdk-*/**"],
  },
  // node:sqlite + child_process git run only in Node route handlers.
  serverExternalPackages: ["web-tree-sitter"],
  // Baseline security headers. script/style/worker-src stay permissive on
  // 'unsafe-inline'/'unsafe-eval' — Monaco's editor loads from a CDN at
  // runtime (see CodeEditor.tsx) and Next.js injects inline hydration
  // scripts, so a strict nonce-based policy isn't safe to ship blind here
  // (see docs/AUDIT_2026-07-12.md F020, deliberately deferred — needs a
  // dedicated migration + telemetry pass, not a blind tightening).
  // What this DOES lock down for real: clickjacking (frame-ancestors),
  // arbitrary plugin/object embeds, MIME-sniffing, and (F021) the CDN
  // trust boundary — jsdelivr is a public CDN serving arbitrary npm/GitHub
  // packages, so each allowance is scoped to the one path prefix
  // (`/npm/monaco-editor/`) `@monaco-editor/react`'s default loader
  // actually fetches from, not jsdelivr's entire catalog.
  async headers() {
    const MONACO_CDN = "https://cdn.jsdelivr.net/npm/monaco-editor/";
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${MONACO_CDN}`,
      `style-src 'self' 'unsafe-inline' ${MONACO_CDN}`,
      `font-src 'self' ${MONACO_CDN} data:`,
      "worker-src 'self' blob:",
      "img-src 'self' data: blob: https:",
      `connect-src 'self' ${MONACO_CDN}`,
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
