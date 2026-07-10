import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for slim Docker images.
  output: "standalone",
  // Pin the workspace root to this app so standalone output lands at
  // .next/standalone/server.js even when a parent-repo lockfile is present.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // Ensure Tree-sitter WASM grammars are copied into the standalone bundle.
  outputFileTracingIncludes: {
    "/api/**": ["./wasm/**"],
  },
  // node:sqlite + child_process git run only in Node route handlers.
  serverExternalPackages: ["web-tree-sitter"],
  // Baseline security headers. CSP is intentionally permissive on
  // script/style/worker sources — Monaco's editor loads from a CDN at
  // runtime (see CodeEditor.tsx) and Next.js injects inline hydration
  // scripts, so a strict nonce-based policy isn't safe to ship blind here.
  // What this DOES lock down for real: clickjacking (frame-ancestors),
  // arbitrary plugin/object embeds, and MIME-sniffing.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "font-src 'self' https://cdn.jsdelivr.net data:",
      "worker-src 'self' blob:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://cdn.jsdelivr.net",
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
