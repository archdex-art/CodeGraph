import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// GET /api/browse?path=/abs/dir  -> { path, parent, home, entries: [{name, path}] }
// Server-side directory listing so the "Start Indexing" local-folder field can
// offer a folder picker instead of requiring a hand-typed absolute path. Only
// directory names are exposed (no file contents/listing) and hidden dirs are
// skipped. Defaults to the server's home directory when no path is given.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BrowseEntry {
  name: string;
  path: string;
}

function resolveBrowsePath(input: string): string {
  const raw = input.trim() || homedir();
  return path.resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

export async function GET(req: NextRequest) {
  const target = resolveBrowsePath(new URL(req.url).searchParams.get("path") || "");

  if (!existsSync(target)) {
    return NextResponse.json({ error: `Path does not exist: ${target}` }, { status: 404 });
  }

  let stat;
  try {
    stat = statSync(target);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Cannot stat path" }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: `Not a directory: ${target}` }, { status: 400 });
  }

  const entries: BrowseEntry[] = [];
  try {
    for (const d of readdirSync(target, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const full = path.join(target, d.name);
      try {
        statSync(full); // skip broken symlinks / unreadable entries
      } catch {
        continue;
      }
      entries.push({ name: d.name, path: full });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Cannot read directory" }, { status: 403 });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  return NextResponse.json({
    path: target,
    parent: parent === target ? null : parent,
    home: homedir(),
    entries,
  });
}
