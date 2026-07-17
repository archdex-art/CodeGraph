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
  // arbitrary plugin/object embeds, and MIME-sniffing.
  //
  // jsdelivr trust: an earlier revision scoped the `cdn.jsdelivr.net`
  // allowance to a path prefix (`/npm/monaco-editor/`) intended to match
  // only the one package this app needs, not jsdelivr's entire catalog
  // (docs/AUDIT_2026-07-12.md F021). That was a REAL, LIVE-BREAKING BUG:
  // jsdelivr's package-URL convention glues the version directly onto the
  // package name with no separating slash --
  // `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js`
  // (confirmed by reading `@monaco-editor/loader`'s actual default config)
  // -- so the path-prefix `/npm/monaco-editor/` (which requires a `/`
  // immediately after "monaco-editor") never matched the real request
  // path, and CSP silently blocked Monaco outright. Every file in the
  // Editor got stuck on Monaco's own indefinite "Loading..." placeholder
  // with no console error, because a CSP violation is a silent network
  // block, not a JS exception the app's own error handling could catch.
  // CSP host-source syntax has no way to wildcard mid-path-segment (only
  // the host portion supports `*`), so there is no path expression that
  // both matches every future monaco-editor version AND excludes the rest
  // of jsdelivr's catalog. Trust the origin instead, as before.
  async headers() {
    const MONACO_CDN = "https://cdn.jsdelivr.net";
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
