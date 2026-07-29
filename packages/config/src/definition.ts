import path from "node:path";
import {
  boolVar,
  computed,
  derivedStringVar,
  intVar,
  optionalBoolVar,
  optionalStringVar,
  presenceVar,
  resolve,
  stringVar,
  type EnvSource,
  type Reader,
} from "./schema";

/**
 * The whole of CodeGraph's environment surface (LLD §10.3).
 *
 * This interface is the contract, and `buildSchema` below must satisfy it — a
 * reader whose type drifts from the field it populates is a compile error rather
 * than a surprise at runtime.
 *
 * Every default was read off the v1 call site it replaces, not chosen. P1 is
 * structural: a deployment with a valid environment must behave identically
 * before and after. Where the LLD's illustrative snippet and the shipped code
 * disagreed, the shipped code won — see `allowLocalAccess`.
 *
 * `string | undefined` fields are required-but-possibly-absent on purpose. Under
 * `exactOptionalPropertyTypes` that is a different, stronger statement than
 * `field?: string`: the key is always present, so a typo in a consumer is caught
 * instead of silently reading `undefined`.
 */
export interface Config {
  /** Exposed because several defaults derive from it. */
  readonly nodeEnv: string;
  /** `NODE_ENV === "production"`, for the places that cannot inspect transport. */
  readonly isProduction: boolean;

  // ---------- storage ----------
  /** Parent of the SQLite file, its WAL, and cloned editor workspaces. */
  readonly dataDir: string;

  // ---------- indexing budgets ----------
  readonly maxFiles: number;
  readonly cloneTimeoutMs: number;
  readonly analysisBudgetMs: number;

  // ---------- worker (HLD §5.1, LLD §10.3) ----------
  readonly workerConcurrency: number;
  readonly workerPollIntervalMs: number;
  readonly workerLeaseMs: number;

  // ---------- network / proxy ----------
  readonly trustedProxyHops: number;

  // ---------- local filesystem access ----------
  readonly allowLocalAccess: boolean;
  readonly localAccessRoot: string | undefined;

  // ---------- auth ----------
  readonly basicAuthPassword: string | undefined;
  readonly basicAuthUser: string;
  readonly githubOauthClientId: string | undefined;
  readonly githubOauthClientSecret: string | undefined;
  readonly sessionSecret: string | undefined;
  readonly ownerGithubLogin: string | undefined;
  readonly publicAppUrl: string | undefined;
  readonly forceSecureCookies: boolean | undefined;

  // ---------- optional assistant backends ----------
  readonly anthropicApiKey: string | undefined;
  readonly claudeModel: string | undefined;
  readonly claudeUseSubscription: boolean;
  readonly claudeCodeOauthToken: string | undefined;
  readonly localLlmBaseUrl: string | undefined;
  readonly localLlmModel: string | undefined;
  readonly localLlmApiKey: string | undefined;

  // ---------- host environment ----------
  readonly homeDir: string | undefined;
  readonly noColor: boolean;
}

/** One reader per config field, checked against `Config` by the compiler. */
export type Schema = { readonly [K in keyof Config]: Reader<Config[K]> };

export interface LoadOptions {
  /**
   * Injectable so `dataDir`'s default is testable without chdir. Read lazily,
   * defaulting to `process.cwd()`, matching v1's
   * `path.join(process.cwd(), "data")`.
   */
  readonly cwd?: string;
}

/**
 * The reader map.
 *
 * Kept separate from resolution so one declaration backs both a snapshot
 * (`loadConfig`, for tests and boot validation) and the live view exported as
 * `config`.
 */
export function buildSchema(options: LoadOptions = {}): Schema {
  const cwd = (): string => options.cwd ?? process.cwd();

  return {
    nodeEnv: stringVar("NODE_ENV", "development"),
    isProduction: computed((env) => env["NODE_ENV"] === "production"),

    dataDir: derivedStringVar("CG_DATA_DIR", () => path.join(cwd(), "data")),

    maxFiles: intVar("CG_MAX_FILES", { fallback: 4000, min: 1 }),
    cloneTimeoutMs: intVar("CG_CLONE_TIMEOUT_MS", { fallback: 90_000, min: 1 }),
    analysisBudgetMs: intVar("CG_ANALYSIS_BUDGET_MS", { fallback: 120_000, min: 1 }),

    /**
     * Jobs run at once per worker process (LLD §10.3: default 1, max 8).
     *
     * The default is 1 deliberately, and it is not timidity: HLD §3 pins peak RSS
     * under 400 MB on a 512 MB host, and a single analysis is the thing that
     * already OOM'd it once (docs/postmortems/2026-07-10-tree-sitter-oom.md).
     * Two concurrent analyses in one process share the same WASM linear memory,
     * which only grows — so raising this multiplies the exposure to the exact
     * failure the worker exists to contain. Raise it only with real headroom.
     */
    workerConcurrency: intVar("CG_WORKER_CONCURRENCY", { fallback: 1, min: 1, max: 8 }),

    /**
     * Idle poll interval. Only paid when the queue is empty: a worker that just
     * finished a job re-polls immediately, so this is latency on an idle queue,
     * not throughput under load.
     */
    workerPollIntervalMs: intVar("CG_WORKER_POLL_INTERVAL_MS", { fallback: 1_000, min: 50 }),

    /**
     * How long a claim is held before another worker may reclaim the job
     * (LLD §8.3's orphan-reclaim clause).
     *
     * Floor of 5s, and it must exceed `workerPollIntervalMs` by enough that a
     * busy worker always heartbeats before its own lease expires — otherwise a
     * healthy job gets stolen mid-run and two workers write the same run. The
     * worker asserts that relationship at boot rather than trusting the operator
     * to have reasoned it through.
     */
    workerLeaseMs: intVar("CG_WORKER_LEASE_MS", { fallback: 60_000, min: 5_000 }),

    /**
     * How many reverse-proxy hops to trust when reading `X-Forwarded-For` from
     * the right. `0` means refuse to trust the header at all, which v1 accepted
     * via `Number.isFinite(hops) && hops >= 1` — so the floor is 0, not 1, and
     * rejecting 0 would break a documented direct-exposed deployment.
     */
    trustedProxyHops: intVar("CG_TRUSTED_PROXY_HOPS", { fallback: 1, min: 0 }),

    /**
     * Reading arbitrary host paths is the point when self-hosting, and a
     * file-disclosure hole on a shared deployment.
     *
     * Default is `NODE_ENV !== "production"`, copied from lib/localAccess.ts.
     * LLD §10.3 sketches `.default(false)`, which would silently disable
     * local-folder indexing in development — a behaviour change P1 may not make.
     * The two agree in production, which is where it matters.
     */
    allowLocalAccess: boolVar("CG_ALLOW_LOCAL_ACCESS", (env) => env["NODE_ENV"] !== "production"),
    localAccessRoot: optionalStringVar("CG_LOCAL_ACCESS_ROOT"),

    /** Unset = the Basic Auth gate is off entirely. */
    basicAuthPassword: optionalStringVar("CG_BASIC_AUTH_PASSWORD"),
    basicAuthUser: stringVar("CG_BASIC_AUTH_USER", "codegraph"),

    /**
     * All three must be set for GitHub sign-in to count as configured; a
     * missing one leaves the feature hidden and changes nothing else. Hence
     * optional rather than required — the app boots with an entirely empty
     * environment, and `CG_SESSION_SECRET` is validated lazily at the point a
     * session is actually encrypted, not here.
     */
    githubOauthClientId: optionalStringVar("GITHUB_OAUTH_CLIENT_ID"),
    githubOauthClientSecret: optionalStringVar("GITHUB_OAUTH_CLIENT_SECRET"),
    sessionSecret: optionalStringVar("CG_SESSION_SECRET"),

    /** Comma-separated GitHub logins; unset = no owner lock. */
    ownerGithubLogin: optionalStringVar("CG_OWNER_GITHUB_LOGIN"),
    publicAppUrl: optionalStringVar("NEXT_PUBLIC_APP_URL"),

    /**
     * Deliberately three-valued. Unset does NOT mean `false`, and does not mean
     * `NODE_ENV === "production"` either: lib/session.ts falls back to
     * inspecting the real transport (`x-forwarded-proto`, then the request
     * scheme), because NODE_ENV is a build-mode flag that can diverge from how
     * the connection actually arrived (F013). Resolving this eagerly would mark
     * cookies `Secure` on a production deployment served over plain HTTP, and
     * the browser would then stop sending the session cookie at all.
     */
    forceSecureCookies: optionalBoolVar("CG_FORCE_SECURE_COOKIES"),

    anthropicApiKey: optionalStringVar("ANTHROPIC_API_KEY"),
    claudeModel: optionalStringVar("CG_CLAUDE_MODEL"),
    claudeUseSubscription: boolVar("CG_CLAUDE_USE_SUBSCRIPTION", () => false),
    claudeCodeOauthToken: optionalStringVar("CLAUDE_CODE_OAUTH_TOKEN"),
    localLlmBaseUrl: optionalStringVar("CG_LOCAL_LLM_BASE_URL"),
    localLlmModel: optionalStringVar("CG_LOCAL_LLM_MODEL"),
    localLlmApiKey: optionalStringVar("CG_LOCAL_LLM_API_KEY"),

    /** Used only to expand a leading `~` in a user-supplied local path. */
    homeDir: optionalStringVar("HOME"),
    /** https://no-color.org — presence alone disables ANSI in the CLI. */
    noColor: presenceVar("NO_COLOR"),
  };
}

/**
 * Resolve every variable from `source` into a frozen snapshot, throwing a
 * `ConfigError` listing every problem at once if anything is invalid.
 *
 * This is what tests should use (`loadConfig({ CG_MAX_FILES: "3" })`) and what
 * validates the real environment at boot. Application code reads the live
 * `config` export instead.
 */
export function loadConfig(source: EnvSource, options: LoadOptions = {}): Config {
  return resolve(buildSchema(options), source);
}
