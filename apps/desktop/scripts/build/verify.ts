import * as fs from "fs/promises";
import * as path from "path";
import manifest from "./manifest.json";

/**
 * Validates that all required artifacts exist in the build output
 * BEFORE we hand off to electron-builder.
 */
export async function verifyArtifacts(): Promise<void> {
  console.log("[Build] Starting Artifact Verification Phase...");
  
  const targetRoot = path.resolve(__dirname, manifest.targetRoot);
  let hasErrors = false;

  for (const artifact of manifest.artifacts) {
    if (!artifact.required) continue;

    const targetPath = path.join(targetRoot, artifact.target);

    try {
      const stats = await fs.stat(targetPath);
      
      if (artifact.type === "directory" && !stats.isDirectory()) {
        console.error(`[Verify] ✗ Failed: ${artifact.id} is not a directory.`);
        hasErrors = true;
      } else if (artifact.type === "file" && !stats.isFile()) {
        console.error(`[Verify] ✗ Failed: ${artifact.id} is not a file.`);
        hasErrors = true;
      } else {
        console.log(`  ✓ Verified: ${artifact.id}`);
      }

      // Explicit Native Binary Checks
      if (artifact.id === "claude-native-sdk") {
        await verifyClaudeSDK(targetPath);
      }

      if (artifact.id === "tree-sitter-wasm") {
        await verifyTreeSitter(targetPath);
      }

    } catch {
      console.error(`[Verify] ✗ FATAL: Required artifact missing from build output: ${artifact.id}`);
      hasErrors = true;
    }
  }

  // Independent of the per-artifact loop: sweep the assembled tree for runtime
  // state that must never ship. This does not trust asset-copy's exclusion —
  // it checks the bytes that electron-builder will actually pack.
  await verifyNoRuntimeState(targetRoot);

  if (hasErrors) {
    throw new Error("Artifact verification failed. Halting build.");
  }

  console.log("[Build] Artifact Verification Complete.\n");
}

/**
 * Fails the build if operator runtime state reached the bundle.
 *
 * Guards a real leak: Next's standalone writer copies `apps/web/data/`
 * wholesale (SQLite database + full git clones of analysed repositories), and
 * before `asset-copy.ts` filtered it, 16 MB of it landed in
 * `build/standalone/apps/web/data` on the way to a shippable .dmg. Those paths
 * are gitignored, so neither CI nor a fresh checkout can reveal the mistake —
 * only a check against the assembled output can, which is why this runs on
 * every `build:orchestrate` rather than living in a test.
 */
async function verifyNoRuntimeState(targetRoot: string): Promise<void> {
  const forbidden = [
    { label: "runtime data directory", path: path.join("standalone", "apps", "web", "data") },
  ];

  let leaked = false;
  for (const entry of forbidden) {
    const full = path.join(targetRoot, entry.path);
    try {
      await fs.stat(full);
    } catch {
      continue; // absent — this is the expected case
    }
    console.error(`[Verify] ✗ FATAL: ${entry.label} leaked into the bundle: ${entry.path}`);
    console.error(`          This would ship the operator's own database and cloned`);
    console.error(`          repositories inside the distributable. See EXCLUDED_PATHS`);
    console.error(`          in scripts/build/asset-copy.ts.`);
    leaked = true;
  }

  if (leaked) {
    throw new Error("Runtime state leaked into the build output. Halting build.");
  }
  console.log("  ✓ Verified: no runtime state (database, cloned repos) in bundle");
}

async function verifyClaudeSDK(sdkPath: string): Promise<void> {
  // A naive check to ensure at least one platform-specific binary directory exists
  const dirs = await fs.readdir(sdkPath);
  const hasPlatformBinary = dirs.some(d => d.includes("claude-agent-sdk-"));
  if (!hasPlatformBinary) {
    console.error(`[Verify] ✗ Native Claude SDK binaries missing from ${sdkPath}`);
    throw new Error("Claude SDK Native Binary Missing");
  }
}

async function verifyTreeSitter(wasmPath: string): Promise<void> {
  // Ensure we have .wasm files
  const files = await fs.readdir(wasmPath);
  const hasWasm = files.some(f => f.endsWith(".wasm"));
  if (!hasWasm) {
    console.error(`[Verify] ✗ Tree-sitter WASM grammars missing from ${wasmPath}`);
    throw new Error("Tree-sitter WASM Missing");
  }
}
