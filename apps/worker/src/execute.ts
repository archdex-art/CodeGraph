import { logger } from "@codegraph/observability";
import { analyze, parseAnalyzePayload, type AnalyzePayload } from "./handlers/analyze";

/**
 * The executor: runs exactly one job, then exits.
 *
 * Exiting is not tidiness, it is the mechanism. `web-tree-sitter`'s WASM heap only
 * grows for the lifetime of a process (postmortem 2026-07-10), so the only reliable
 * way to reclaim it is for the process to end — which is why this file exists at all
 * rather than the handler being called in the supervisor.
 *
 * It writes NO job state. The supervisor holds the lease and is the only writer, so
 * a stalled executor whose lease was reclaimed cannot race the new owner. All this
 * process controls is its own exit code:
 *
 *   0  the work completed
 *   1  the work failed (supervisor applies the retry budget)
 *   2  cancelled
 *   3  the payload was unusable — retrying cannot help
 */

import { EXIT_BAD_PAYLOAD, EXIT_CANCELLED, EXIT_FAILED, EXIT_OK } from "./exit-codes";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const raw = await readStdin();
  let payload: AnalyzePayload;
  // Sole source of the id: the envelope. An env var would be a second copy that
  // could disagree with it, and reading config from `process.env` outside
  // @codegraph/config is banned for that class of reason (LLD §10.3).
  let jobId = "unknown";
  try {
    const envelope: unknown = JSON.parse(raw);
    if (typeof envelope !== "object" || envelope === null) throw new Error("envelope not an object");
    const e = envelope as Record<string, unknown>;
    if (typeof e["jobId"] === "string") jobId = e["jobId"];
    payload = parseAnalyzePayload(e["payload"]);
  } catch (e) {
    // Malformed input is not worth a retry: the same bytes will fail identically.
    logger.error("executor received an unusable payload", {
      jobId,
      err: e instanceof Error ? e.message : String(e),
    });
    return EXIT_BAD_PAYLOAD;
  }

  // SIGTERM from the supervisor becomes an AbortSignal the handler checks at stage
  // boundaries. The supervisor escalates to SIGKILL if this is ignored, so a stage
  // that cannot be interrupted still terminates.
  const controller = new AbortController();
  const onTerm = (): void => controller.abort();
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onTerm);

  // Progress goes to the supervisor over stdout, which owns the lease and is the
  // only process permitted to write the job row. `phase` rides the same line rather
  // than getting a message kind of its own: a phase is only ever meaningful beside
  // the stage it belongs to, and one shape means `forward()` stays one branch.
  const report = (percent: number, stage: string, message: string, phase?: string | null): void => {
    process.stdout.write(`${JSON.stringify({ percent, stage, message, phase: phase ?? null })}\n`);
  };

  try {
    await analyze(payload, report, controller.signal);
    return EXIT_OK;
  } catch (e) {
    if (controller.signal.aborted) {
      logger.info("executor cancelled", { jobId });
      return EXIT_CANCELLED;
    }
    // stderr, not stdout: stdout is the protocol channel. The supervisor reads the
    // tail of stderr to build the queue's error message.
    logger.error("executor failed", { jobId, err: e instanceof Error ? e : String(e) });
    return EXIT_FAILED;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    logger.error("executor crashed before it could run", {
      err: e instanceof Error ? e : String(e),
    });
    process.exit(EXIT_FAILED);
  }
);
