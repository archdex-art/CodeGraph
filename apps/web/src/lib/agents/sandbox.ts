import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { childEnv, config } from "@codegraph/config";
import type { ExecOptions, ExecResult, SandboxHandle } from "@codegraph/verify";

/**
 * A `SandboxHandle` over an already-cloned working tree.
 *
 * Lives here rather than in `@codegraph/verify` for two reasons that point the same way.
 * The layering rule (`child-process-only-in-vcs`) forbids a package outside `vcs` from
 * spawning, and more importantly the isolation available is a property of the HOST, not of
 * the verifier: the CLI has the developer's toolchain and their own container, Render grants
 * no privileged container at all (SPIKES §2). `Verifier` takes the handle so that decision
 * stays with whoever knows the answer.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE, stated plainly because gate 3 runs ARBITRARY CODE
 * from the analysed repository and a reader deserves to know the actual boundary:
 *
 *   Enforced here — a hard timeout with SIGKILL, no shell (argv array, so nothing in a
 *   repository's own scripts can inject through quoting), cwd pinned to the tree, and a
 *   scrubbed environment that carries no tokens.
 *
 *   NOT enforced here — kernel-level isolation. `network: false` is advisory: it sets the
 *   proxy and npm offline vars a well-behaved toolchain honours, and a determined script can
 *   ignore every one of them. Real network and resource confinement needs a container, which
 *   is why `canIsolate` below reports false unless the operator has said the host provides
 *   one. Claiming a sandbox this cannot deliver is the same class of overstatement as C3.
 */

export interface SandboxOptions {
  /** Absolute path to the working tree. Must already exist. */
  readonly root: string;
}

/** Beyond this, output is a liability rather than evidence. */
const OUTPUT_LIMIT = 512 * 1024;

export function createSandbox({ root }: SandboxOptions): SandboxHandle {
  return {
    root,
    exec: (command, args, opts) => run(root, command, args, opts),
  };
}

function run(
  root: string,
  command: string,
  args: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const child = spawn(command, [...args], {
    cwd: root,
    // No `shell: true`. A repository controls its own package.json scripts, and a shell
    // would let a crafted script name break out through quoting.
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: sandboxEnv(opts.network === true),
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const capture = (chunk: string, target: "out" | "err"): void => {
    if (target === "out") {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    } else if (stderr.length < OUTPUT_LIMIT) {
      stderr += chunk;
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => capture(c, "out"));
  child.stderr.on("data", (c: string) => capture(c, "err"));

  // SIGKILL, not SIGTERM. A test runner that traps SIGTERM to print a summary would sit
  // inside the timeout it just exceeded, and the caller has already decided this run is
  // over. Nothing here needs a graceful shutdown — the tree is disposable.
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const settle = (code: number | null): void => {
    clearTimeout(killer);
    resolve({ code, stdout, stderr, timedOut });
  };
  child.once("error", (e) => {
    clearTimeout(killer);
    // A missing binary is a normal outcome, not an exception: `npx` or a runner may simply
    // not be installed, and the gate turns a non-zero result into `skipped` or `failed`.
    resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}`, timedOut });
  });
  child.once("exit", settle);

  return promise;
}

/**
 * The environment a verification command runs in.
 *
 * `childEnv()` supplies the inherited environment a toolchain needs to function at all
 * (PATH, HOME), from the one place allowed to read `process.env` (LLD §10.3). What is added
 * here is subtractive: the variables that carry credentials or reach the network are
 * blanked, so a repository's own test suite cannot read the operator's GitHub token out of
 * the environment it was handed.
 */
function sandboxEnv(network: boolean): NodeJS.ProcessEnv {
  const env = childEnv({
    CI: "1",
    // Interactive prompts in a non-interactive run are a hang, not a question.
    npm_config_yes: "true",
    GIT_TERMINAL_PROMPT: "0",
    // Every CodeGraph secret, explicitly cleared rather than trusted not to be read.
    CG_SESSION_SECRET: undefined,
    CG_BASIC_AUTH_PASSWORD: undefined,
    GITHUB_OAUTH_CLIENT_SECRET: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  });

  if (!network) {
    // Advisory, and labelled as such above. These are the knobs a cooperating toolchain
    // reads; they are not a network namespace.
    env["npm_config_offline"] = "true";
    env["npm_config_audit"] = "false";
    env["npm_config_fund"] = "false";
    env["no_proxy"] = "*";
    env["NO_PROXY"] = "*";
    env["http_proxy"] = "http://127.0.0.1:9";
    env["https_proxy"] = "http://127.0.0.1:9";
    env["HTTP_PROXY"] = "http://127.0.0.1:9";
    env["HTTPS_PROXY"] = "http://127.0.0.1:9";
  }
  return env;
}

/**
 * Whether this host can isolate a test run well enough to be worth trusting.
 *
 * Opt-in via `CG_ALLOW_TEST_VERIFICATION`, because the honest answer cannot be detected:
 * the process can see that it is in a container, but not whether that container's network
 * and resource limits make running a stranger's test suite acceptable. Only the operator
 * knows. Default off means the hosted demo reports `partial` (SPIKES §2) rather than
 * quietly executing arbitrary code.
 */
export function canIsolateTests(): boolean {
  return config.allowTestVerification;
}

/** Detect the project's test command from its manifest. Null when there is nothing to run. */
export async function detectTestRunner(
  root: string
): Promise<{ command: string; args: readonly string[] } | null> {
  const manifest = path.join(root, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const scripts =
      typeof parsed === "object" && parsed !== null && "scripts" in parsed
        ? (parsed as { scripts?: unknown }).scripts
        : undefined;
    const test =
      typeof scripts === "object" && scripts !== null && "test" in scripts
        ? (scripts as { test?: unknown }).test
        : undefined;
    if (typeof test !== "string" || test.trim() === "") return null;
    // A no-op `test` script is the npm-init default and means "no tests", not "tests pass".
    // Reporting that as a passing gate would manufacture `level: "full"` out of nothing.
    if (/no test specified/i.test(test)) return null;
    return { command: "npm", args: ["test", "--silent"] };
  } catch {
    return null;
  }
}

/** Whether the project is configured for type checking, for gate 2. */
export async function hasTypeConfig(root: string): Promise<boolean> {
  return existsSync(path.join(root, "tsconfig.json"));
}
