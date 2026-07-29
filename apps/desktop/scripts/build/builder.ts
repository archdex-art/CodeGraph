import { copyAssets } from "./asset-copy";
import { verifyArtifacts } from "./verify";

async function main() {
  try {
    console.log("=========================================");
    console.log(" CodeGraph Desktop Build Orchestrator");
    console.log("=========================================\n");

    // Phase 1: Asset Collection
    await copyAssets();

    // Phase 2: Artifact Verification
    await verifyArtifacts();

    // Phase 3: Electron Build (Handoff to electron-builder would happen via npm scripts)
    console.log("[Build] SUCCESS: Build pipeline ready for electron-builder handoff.");
    
  } catch (error) {
    console.error("\n[Build] FATAL ERROR during build pipeline:");
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
