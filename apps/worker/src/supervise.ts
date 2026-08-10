import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobContext } from "@codegraph/jobs";
import { childEnv } from "@codegraph/config";
import type { Logger } from "@codegraph/observability";
import { EXIT_BAD_PAYLOAD } from "./exit-codes";

/**
 * Run one job in a short-lived child process.
 *
 * THIS FUNCTION IS THE ADR-001 FIX. `web-tree-sitter`'s WASM linear memory can only
 * grow — never shrink, regardless of `.delete()` on every tree
 * (docs/postmortems/2026-07-10-tree-sitter-oom.md, ~26 MB per parsed file measured).
 * Nothing in-process can reclaim it; process exit reclaims it unconditionally. So the
 * executor is spawned per job and dies with it, which is why the
 * `CG_TREE_SITTER_MAX_RSS_BYTES` budget gate is no longer needed.
 *
 * Written as a `JobHandler` on purpose: `runJob` in `@codegraph/jobs` already owns
 * the heartbeat timer, cooperative cancellation, and outcome mapping, all tested.
 * Supervising a process instead of a function needs none of that rewritten — the
 * supervisor holds the lease and this is simply "the work".
 *
 * Progress crosses the boundary as one JSON object per line on stdout. Not a socket
 * or `process.send`: stdout survives `tsx`, works when the child is run by hand for
 * debugging, and is readable in a terminal. Lines that are not JSON are logged as
 * ordinary output — the child's dependencies print too, and a stray banner must not
 * fail a job.
 */

/**
 * Where the executor is, and how to run it.
 *
 * Decided from THIS module's own extension rather than from an env var or NODE_ENV: if
 * the supervisor is running as compiled `.mjs`, the executor beside it is compiled too,
 * and if it is running as `.ts` under tsx then so is the executor. That is the one
 * signal that cannot disagree with reality — a flag can be set wrong, and the failure
 * mode is a job that dies on every spawn with a module-resolution error.
 */
function executorCommand(): { file: string; nodeArgs: string[] } {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  return here.endsWith(".mjs") || here.endsWith(".js")
    ? { file: path.join(dir, "execute.mjs"), nodeArgs: [] }
    : // `tsx` is a devDependency and is absent from the production runtime, which is
      // why `npm run build` exists and why CG_USE_WORKER stays false until the
      // container runs the compiled output.
      { file: path.join(dir, "execute.ts"), nodeArgs: ["--import", "tsx"] };
}

export {
  EXIT_BAD_PAYLOAD,
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_OK,
} from "./exit-codes";

/** SIGTERM grace before SIGKILL. Longer than any stage boundary, shorter than a lease. */
const TERM_GRACE_MS = 5_000;
const CANCEL_POLL_MS = 1_000;
/** Enough stderr to explain a failure, bounded so a crash loop cannot grow it. */
const STDERR_KEEP = 4_000;

export async function runInChild(
  jobId: string,
  payload: unknown,
  ctx: JobContext,
  logger: Logger,
  executorPath?: string
): Promise<void> {
  const resolved = executorCommand();
  // An explicit path (tests, or an unusual layout) always runs under tsx: a test stub is
  // TypeScript.
  const file = executorPath ?? resolved.file;
  const nodeArgs = executorPath ? ["--import", "tsx"] : resolved.nodeArgs;
  const child = spawn(process.execPath, [...nodeArgs, file], {
    // Payload on stdin, not argv: a clone URL can carry a token, and argv is visible
    // in `ps` to every user on the host.
    stdio: ["pipe", "pipe", "pipe"],
    // childEnv, not a raw spread: the executor genuinely needs the whole inherited
    // environment (PATH for `git`, HOME, proxy vars), and LLD §10.3 confines that
    // spread to one place so the effective configuration stays knowable. jobId is NOT
    // passed here — it already travels in the stdin envelope below, and passing it
    // twice invites the two copies to disagree.
    env: childEnv(),
  });
  child.stdin.end(JSON.stringify({ jobId, payload }));

  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    // Chunk boundaries do not respect newlines, so a message can arrive split across
    // two events. Parsing per-chunk would silently drop those.
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) forward(line, ctx, logger, jobId);
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });

  let cancelling = false;
  const watch = setInterval(() => {
    if (cancelling || !ctx.cancelled()) return;
    cancelling = true;
    logger.info("cancelling executor", { jobId });
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn("executor ignored SIGTERM; killing", { jobId });
        child.kill("SIGKILL");
      }
    }, TERM_GRACE_MS).unref();
  }, CANCEL_POLL_MS);

  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("error", exited.reject);
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));

  try {
    const { code, signal } = await exited.promise;
    if (code === 0) return;

    const tail = stderr.trim().split("\n").slice(-5).join(" | ");
    // A signal death must not read as "exit code null" in the ledger. SIGKILL with no
    // cancellation pending is what an OOM kill looks like from here, and on a 512 MB
    // host that is the likeliest failure of all.
    const cause = signal
      ? `terminated by ${signal}${
          signal === "SIGKILL" && !cancelling ? " (no cancellation pending — likely the OOM killer)" : ""
        }`
      : `exited ${code}`;
    const error = new Error(`executor ${cause}${tail ? `: ${tail}` : ""}`);

    // PLAN.md §3's poison-pill quarantine. A malformed payload is the one failure
    // retrying cannot fix: the same bytes deserialise the same way every time, so the
    // default budget would burn three attempts and three child spawns to reach the
    // conclusion already available on the first. `permanent` tells the runner to go
    // terminal now.
    //
    // Deliberately narrow. It is NOT applied to a signal death, which looks
    // superficially similar and is the opposite case: an OOM kill often succeeds on
    // retry, because the second attempt may not land beside whatever else was
    // resident. Quarantining that would turn a transient memory-pressure failure into
    // a permanent one.
    if (code === EXIT_BAD_PAYLOAD && !signal) {
      Object.assign(error, { permanent: true });
    }

    // HLD §419: "a job that OOM-kills its worker twice is quarantined rather than
    // retried forever." A single signal death is worth retrying — the next attempt may
    // not land beside whatever else was resident — but a second one is evidence the
    // repository does not fit the memory this host has, and a third spawn only buys
    // another OOM. `attempts` is incremented on claim, so on the second attempt it
    // reads 2.
    if (signal && ctx.attempts >= 2) {
      Object.assign(error, { permanent: true });
      logger.warn("quarantining after repeated signal deaths", {
        jobId,
        attempts: ctx.attempts,
        signal,
      });
    }
    throw error;
  } finally {
    clearInterval(watch);
  }
}

function forward(line: string, ctx: JobContext, logger: Logger, jobId: string): void {
  if (!line.trim()) return;
  if (line.startsWith("{")) {
    try {
      const m: unknown = JSON.parse(line);
      if (typeof m === "object" && m !== null && "stage" in m) {
        const p = m as { percent?: unknown; stage?: unknown; message?: unknown; phase?: unknown };
        // Returns false once the lease is gone; `runJob` then abandons the job, so
        // there is nothing useful to do with it beyond stopping the noise.
        ctx.progress(
          typeof p.percent === "number" ? p.percent : 0,
          String(p.stage ?? ""),
          typeof p.message === "string" ? p.message : "",
          typeof p.phase === "string" ? p.phase : null
        );
        return;
      }
    } catch {
      // Not a protocol line. Fall through and log it.
    }
  }
  logger.debug("executor output", { jobId, line: line.slice(0, 500) });
}
