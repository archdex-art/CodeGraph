import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Ensure tests use a fresh, ephemeral SQLite database so they don't read
// dev settings (like local LLM base URLs) from the real data/codegraph.sqlite
process.env.CG_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cg-test-db-"));
