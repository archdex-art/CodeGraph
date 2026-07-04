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
};

export default nextConfig;
