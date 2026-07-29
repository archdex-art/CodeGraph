import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { localAccessAllowed, LOCAL_ACCESS_DISABLED_MESSAGE } from "@/lib/localAccess";
import { rateLimit, clientIp } from "@/lib/rateLimit";

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

// F016: optional defense-in-depth containment. `localAccessAllowed()` is
// the primary gate (an explicit single-operator opt-in); this adds a
// secondary boundary so a local-access misconfiguration doesn't
// automatically mean full-filesystem read exposure. Off by default —
// unset CG_LOCAL_ACCESS_ROOT preserves today's unrestricted behavior.
function withinConfiguredRoot(target: string): boolean {
  const configuredRoot = process.env.CG_LOCAL_ACCESS_ROOT;
  if (!configuredRoot) return true;
  try {
    const rootReal = realpathSync(path.resolve(configuredRoot));
    const targetReal = existsSync(target) ? realpathSync(target) : path.resolve(target);
    return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  if (!localAccessAllowed()) {
    return NextResponse.json({ error: LOCAL_ACCESS_DISABLED_MESSAGE }, { status: 403 });
  }
  // F015: cheap directory-listing enumeration once local access is on.
  const limited = rateLimit(`browse:${clientIp(req)}`, { capacity: 30, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many browse requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
  }
  const target = resolveBrowsePath(new URL(req.url).searchParams.get("path") || "");
  if (!withinConfiguredRoot(target)) {
    return NextResponse.json({ error: "Path is outside the configured local-access root" }, { status: 403 });
  }

  if (!existsSync(target)) {
    return NextResponse.json({ error: `Path does not exist: ${target}` }, { status: 404 });
  }

  let stat;
  try {
    stat = statSync(target);
  } catch (e) {
    console.warn("browse: failed to stat path:", e);
    return NextResponse.json({ error: "Cannot stat path" }, { status: 400 });
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
    console.warn("browse: failed to read directory:", e);
    return NextResponse.json({ error: "Cannot read directory" }, { status: 403 });
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
