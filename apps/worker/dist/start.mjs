import { createRequire as __cgCreateRequire } from "node:module";
import { fileURLToPath as __cgFileURLToPath } from "node:url";
import { dirname as __cgDirname } from "node:path";
const require = __cgCreateRequire(import.meta.url);
const __filename = __cgFileURLToPath(import.meta.url);
const __dirname = __cgDirname(__filename);

// ../../packages/observability/src/logger.ts
function serializeError(value, depth = 0) {
  if (!(value instanceof Error)) {
    return typeof value === "string" ? value : String(value);
  }
  const base = {
    name: value.name,
    message: value.message,
    stack: value.stack
  };
  if (value.cause !== void 0 && depth < 3) {
    return { ...base, cause: serializeError(value.cause, depth + 1) };
  }
  return base;
}
function normalizeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}
var IS_NODE = typeof process !== "undefined" && typeof process.versions === "object" && process.versions !== null && typeof process.versions.node === "string";
function write(line) {
  if (IS_NODE) {
    process.stderr.write(`${line}
`);
    return;
  }
  console.error(line);
}
function createLogger(options = {}) {
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? write;
  const now = options.now ?? Date.now;
  const emit = (level, message, fields) => {
    const payload = {
      // Field order is deliberate: level and time first so a human scanning raw
      // lines gets the two things they always want without reading past the
      // payload.
      level,
      time: new Date(now()).toISOString(),
      msg: message,
      ...normalizeFields(bindings),
      ...fields ? normalizeFields(fields) : {}
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      sink(JSON.stringify({ level, time: new Date(now()).toISOString(), msg: message, logError: "unserializable fields" }));
    }
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childBindings) => createLogger({
      ...options,
      bindings: { ...bindings, ...childBindings }
    })
  };
}

// ../../packages/observability/src/index.ts
var logger = createLogger();

// src/main.ts
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// ../../packages/config/src/definition.ts
import path from "node:path";

// ../../packages/config/src/schema.ts
var ConfigError = class extends Error {
  constructor(problems) {
    const lines = problems.map((p) => `  ${p.key}=${JSON.stringify(p.value)} \u2014 expected ${p.expected}`);
    super(`Invalid environment configuration:
${lines.join("\n")}`);
    this.problems = problems;
    this.name = "ConfigError";
  }
  problems;
};
function present(source, key) {
  const raw = source[key];
  if (raw === void 0) return void 0;
  return raw.trim() === "" ? void 0 : raw;
}
function stringVar(key, fallback) {
  return {
    keys: [key],
    read: (source) => present(source, key) ?? fallback
  };
}
function optionalStringVar(key) {
  return {
    keys: [key],
    read: (source) => present(source, key)
  };
}
function derivedStringVar(key, fallback) {
  return {
    keys: [key],
    read: (source) => present(source, key) ?? fallback(source)
  };
}
function intVar(key, options) {
  const { fallback, min, max } = options;
  const bounds = [
    "an integer",
    min !== void 0 ? `>= ${min}` : null,
    max !== void 0 ? `<= ${max}` : null
  ].filter((part) => part !== null).join(" ");
  return {
    keys: [key],
    read: (source, problems) => {
      const raw = present(source, key);
      if (raw === void 0) return fallback;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) {
        problems.push({ key, value: raw, expected: bounds });
        return fallback;
      }
      if (min !== void 0 && parsed < min || max !== void 0 && parsed > max) {
        problems.push({ key, value: raw, expected: bounds });
        return fallback;
      }
      return parsed;
    }
  };
}
function parseBool(source, key, problems) {
  const raw = present(source, key);
  if (raw === void 0) return void 0;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  problems.push({ key, value: raw, expected: '"true" or "false"' });
  return void 0;
}
function boolVar(key, fallback) {
  return {
    keys: [key],
    read: (source, problems) => parseBool(source, key, problems) ?? fallback(source)
  };
}
function optionalBoolVar(key) {
  return {
    keys: [key],
    read: (source, problems) => parseBool(source, key, problems)
  };
}
function presenceVar(key) {
  return {
    keys: [key],
    read: (source) => source[key] !== void 0
  };
}
function computed(compute) {
  return { keys: [], read: (source) => compute(source) };
}
function resolve(schema, source) {
  const problems = [];
  const out = {};
  for (const [name, reader] of Object.entries(schema)) {
    out[name] = reader.read(source, problems);
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(out);
}
function resolveOne(reader, source) {
  const problems = [];
  const value = reader.read(source, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return value;
}
function liveView(schema, source) {
  const descriptors = {};
  for (const [name, reader] of Object.entries(schema)) {
    descriptors[name] = {
      enumerable: true,
      get: () => resolveOne(reader, source())
    };
  }
  return Object.freeze(Object.defineProperties({}, descriptors));
}

// ../../packages/config/src/definition.ts
function buildSchema(options = {}) {
  const cwd = () => options.cwd ?? process.cwd();
  return {
    nodeEnv: stringVar("NODE_ENV", "development"),
    isProduction: computed((env) => env["NODE_ENV"] === "production"),
    dataDir: derivedStringVar("CG_DATA_DIR", () => path.join(cwd(), "data")),
    maxFiles: intVar("CG_MAX_FILES", { fallback: 4e3, min: 1 }),
    cloneTimeoutMs: intVar("CG_CLONE_TIMEOUT_MS", { fallback: 9e4, min: 1 }),
    analysisBudgetMs: intVar("CG_ANALYSIS_BUDGET_MS", { fallback: 12e4, min: 1 }),
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
    useWorker: boolVar("CG_USE_WORKER", () => false),
    workerConcurrency: intVar("CG_WORKER_CONCURRENCY", { fallback: 1, min: 1, max: 8 }),
    /**
     * Idle poll interval. Only paid when the queue is empty: a worker that just
     * finished a job re-polls immediately, so this is latency on an idle queue,
     * not throughput under load.
     */
    workerPollIntervalMs: intVar("CG_WORKER_POLL_INTERVAL_MS", { fallback: 1e3, min: 50 }),
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
    workerLeaseMs: intVar("CG_WORKER_LEASE_MS", { fallback: 6e4, min: 5e3 }),
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
    noColor: presenceVar("NO_COLOR")
  };
}
function loadConfig(source, options = {}) {
  return resolve(buildSchema(options), source);
}

// ../../packages/config/src/index.ts
loadConfig(process.env);
var config = liveView(buildSchema(), () => process.env);
function childEnv(overrides = {}) {
  return Object.assign({}, process.env, overrides);
}

// ../../packages/persistence/src/sqlite.ts
var sqliteModule = process.getBuiltinModule("node:sqlite");
if (!sqliteModule || typeof sqliteModule !== "object" || !("DatabaseSync" in sqliteModule)) {
  throw new Error("node:sqlite is unavailable \u2014 CodeGraph requires Node >= 22");
}
var DatabaseSync = sqliteModule.DatabaseSync;

// ../../packages/persistence/src/db.ts
import { mkdirSync } from "node:fs";
import path2 from "node:path";

// ../../packages/persistence/src/migrations/001_initial_schema.ts
var REPOS_ADDED_COLUMNS = [
  ["source_type", "TEXT NOT NULL DEFAULT 'git'"],
  ["viz", `TEXT DEFAULT '{"nodes":[],"edges":[],"truncated":false}'`],
  ["deps", "TEXT DEFAULT '[]'"],
  ["tree", "TEXT DEFAULT '{}'"],
  ["modules", `TEXT DEFAULT '{"nodes":[],"edges":[]}'`],
  [
    "symbols",
    `TEXT DEFAULT '{"symbols":[],"edges":[],"truncated":false,"stats":{"symbols":0,"edges":0,"resolvedCalls":0}}'`
  ],
  ["workspace_dir", "TEXT"],
  ["save_mode", "TEXT NOT NULL DEFAULT 'local'"],
  ["owner_id", "INTEGER"],
  ["churn_by_file", "TEXT DEFAULT '{}'"],
  // The exact commit hash the live workspace was analyzed at (git sources
  // only). Lets the Timeline engine recognize when a requested historical
  // snapshot IS the already-indexed HEAD and reuse that result instead of
  // re-running the full git-archive + indexRepo pipeline for content it has
  // already computed — see TimelineEngine.ensureSnapshot.
  ["head_hash", "TEXT"]
];
function columnNames(db2, table) {
  const rows = db2.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}
var migration001 = {
  version: 1,
  name: "initial_schema",
  up(db2) {
    db2.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'git',
        status TEXT NOT NULL,
        score REAL,
        loc INTEGER DEFAULT 0,
        error TEXT,
        languages TEXT DEFAULT '[]',
        graph TEXT DEFAULT '{}',
        dimensions TEXT DEFAULT '[]',
        deps TEXT DEFAULT '[]',
        issues TEXT DEFAULT '[]',
        viz TEXT DEFAULT '{"nodes":[],"edges":[],"truncated":false}',
        tree TEXT DEFAULT '{}',
        modules TEXT DEFAULT '{"nodes":[],"edges":[]}',
        symbols TEXT DEFAULT '{"symbols":[],"edges":[],"truncated":false,"stats":{"symbols":0,"edges":0,"resolvedCalls":0}}',
        churn_by_file TEXT DEFAULT '{}',
        owner_id INTEGER,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        message TEXT DEFAULT '',
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS trash (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        orig_path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER DEFAULT 0,
        deleted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trash_repo ON trash(repo_id, deleted_at);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        value TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      );
    `);
    const existing = columnNames(db2, "repos");
    for (const [name, definition] of REPOS_ADDED_COLUMNS) {
      if (!existing.has(name)) db2.exec(`ALTER TABLE repos ADD COLUMN ${name} ${definition}`);
    }
    db2.exec("CREATE INDEX IF NOT EXISTS idx_repos_owner ON repos(owner_id);");
    if (!columnNames(db2, "settings").has("user_id")) {
      db2.exec(`
        ALTER TABLE settings RENAME TO settings_pre_peruser;
        CREATE TABLE settings (
          key TEXT NOT NULL,
          user_id INTEGER NOT NULL DEFAULT 0,
          value TEXT NOT NULL,
          PRIMARY KEY (key, user_id)
        );
        INSERT INTO settings (key, user_id, value) SELECT key, 0, value FROM settings_pre_peruser;
        DROP TABLE settings_pre_peruser;
      `);
    }
  }
};

// ../../packages/persistence/src/migrations/002_findings_rows.ts
var migration002 = {
  version: 2,
  name: "findings_rows",
  up(db2) {
    db2.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        commit_sha TEXT,
        engine_version TEXT NOT NULL,
        score_model_version TEXT NOT NULL,
        status TEXT NOT NULL,
        score REAL,
        loc INTEGER,
        coverage_json TEXT NOT NULL DEFAULT '{}',
        timings_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        dimension TEXT NOT NULL,
        severity INTEGER NOT NULL,
        confidence REAL NOT NULL,
        confidence_basis TEXT NOT NULL,
        analysis_tier TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        start_col INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        end_col INTEGER NOT NULL,
        symbol_id TEXT,
        blast_radius REAL NOT NULL,
        churn INTEGER NOT NULL DEFAULT 1,
        score REAL,
        priority TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id, priority, score DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_findings_run_dim ON findings(run_id, dimension, severity);

      -- Suppressions key on fingerprint, not id, which is the entire point of
      -- having a fingerprint: a dismissal has to survive the next run.
      CREATE TABLE IF NOT EXISTS suppressions (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        reason TEXT,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, fingerprint)
      );
    `);
  }
};

// ../../packages/core-domain/src/finding.ts
var TIER_RANK = Object.freeze({
  skipped: 0,
  lexical: 1,
  ast: 2,
  full: 3
});

// ../../packages/core-domain/src/fingerprint.ts
import { createHash } from "node:crypto";
var STRING_SENTINEL = "s";
var NUMBER_SENTINEL = "n";
var STRING_LITERAL_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
var NUMBER_LITERAL_RE = /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
var WHITESPACE_RUN_RE = /\s+/g;
var SPACE_BESIDE_PUNCTUATION_RE = /(?<![A-Za-z0-9_$]) | (?![A-Za-z0-9_$])/g;
function normalizeSnippet(raw) {
  return raw.replace(STRING_LITERAL_RE, STRING_SENTINEL).replace(NUMBER_LITERAL_RE, NUMBER_SENTINEL).replace(WHITESPACE_RUN_RE, " ").replace(SPACE_BESIDE_PUNCTUATION_RE, "").trim();
}
function canonicalize(fields) {
  let out = "";
  for (const field of fields) {
    out += `${field.length}:${field}`;
  }
  return out;
}
function fingerprint(input) {
  const canonical = canonicalize([
    input.ruleId.trim(),
    input.scope.trim(),
    input.normalizedSnippet
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

// ../../packages/persistence/src/migrations/003_backfill_findings.ts
var ENGINE_VERSION_LEGACY = "v1-backfill";
function legacyRuleId(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `legacy/${slug || "unknown"}`;
}
function basename(file) {
  const parts = file.split("/");
  return parts[parts.length - 1] || file;
}
function asString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function parseIssues(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
var migration003 = {
  version: 3,
  name: "backfill_findings",
  up(db2) {
    const repos = db2.prepare(
      `SELECT id, issues, score, loc, head_hash, status, created_at, finished_at
         FROM repos WHERE issues IS NOT NULL AND issues != '' AND issues != '[]'`
    ).all();
    const insertRun = db2.prepare(
      `INSERT INTO runs (id, repo_id, commit_sha, engine_version, score_model_version,
        status, score, loc, coverage_json, timings_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?)`
    );
    const insertFinding = db2.prepare(
      `INSERT INTO findings (id, run_id, rule_id, fingerprint, dimension, severity,
        confidence, confidence_basis, analysis_tier, file, start_line, start_col,
        end_line, end_col, symbol_id, blast_radius, churn, score, priority,
        evidence_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 'open')`
    );
    for (const repo of repos) {
      const issues = parseIssues(repo.issues);
      if (issues.length === 0) continue;
      const runId2 = `run_legacy_${repo.id}`;
      insertRun.run(
        runId2,
        repo.id,
        repo.head_hash,
        ENGINE_VERSION_LEGACY,
        ENGINE_VERSION_LEGACY,
        repo.status === "done" ? "succeeded" : "failed",
        repo.score,
        repo.loc,
        repo.created_at,
        repo.finished_at
      );
      let ordinal = 0;
      for (const issue of issues) {
        const title = asString(issue.title, "Unknown finding");
        const file = asString(issue.file, "");
        const line = Math.max(1, Math.trunc(asNumber(issue.line, 1)));
        const ruleId = legacyRuleId(title);
        insertFinding.run(
          `f_legacy_${repo.id}_${ordinal++}`,
          runId2,
          ruleId,
          // Empty normalized snippet: v1 stored none. See the header for why
          // this is rule+file granularity rather than per-occurrence.
          fingerprint({ ruleId, scope: basename(file), normalizedSnippet: normalizeSnippet("") }),
          asString(issue.dimension, "maintainability"),
          Math.min(5, Math.max(1, Math.trunc(asNumber(issue.severity, 1)))),
          asNumber(issue.confidence, 1),
          // v1 matched line-level regexes over raw text. That is exactly what
          // "syntactic" means (LLD §2), and recording it truthfully is what stops
          // a backfilled finding being presented as confidently as a
          // dataflow-verified one.
          "syntactic",
          "lexical",
          file,
          line,
          1,
          line,
          1,
          asNumber(issue.blastRadius, 1),
          Math.trunc(asNumber(issue.churn, 1)),
          // The title is the only evidence v1 kept. Saying so beats an empty
          // object that looks like evidence was lost.
          JSON.stringify({ snippet: "", rationale: title })
        );
      }
    }
  }
};

// ../../packages/persistence/src/migrations/004_jobs_queue.ts
var JOBS_ADDED_COLUMNS = [
  // analyze | fix | timeline. Defaulted rather than NOT NULL without a default:
  // rows already in the table were all analysis jobs, and SQLite cannot add a
  // NOT NULL column to a populated table without one.
  ["kind", "TEXT NOT NULL DEFAULT 'analyze'"],
  // The handler's input. '{}' rather than NULL so a handler can parse
  // unconditionally instead of branching on absence.
  ["payload_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["priority", "INTEGER NOT NULL DEFAULT 0"],
  ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["max_attempts", "INTEGER NOT NULL DEFAULT 3"],
  // Epoch ms. NULL = unclaimed. Compared against `Date.now()` by the claim
  // query, so an expired lease is indistinguishable from never-claimed —
  // deliberately, because both mean "available".
  ["lease_until", "INTEGER"],
  ["worker_id", "TEXT"],
  // The coarse pipeline phase (`cloning`, `indexing`, `scoring`). Distinct from
  // `message`, which is human-facing prose; `stage` is what metrics and the SSE
  // stream key on, so it must not carry a sentence.
  ["stage", "TEXT"],
  ["error", "TEXT"],
  ["idempotency_key", "TEXT"],
  ["created_at", "INTEGER NOT NULL DEFAULT 0"],
  ["updated_at", "INTEGER NOT NULL DEFAULT 0"]
];
function columnNames2(db2, table) {
  const rows = db2.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}
var migration004 = {
  version: 4,
  name: "jobs_queue",
  up(db2) {
    db2.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        message TEXT DEFAULT '',
        error TEXT
      );
    `);
    const existing = columnNames2(db2, "jobs");
    for (const [name, definition] of JOBS_ADDED_COLUMNS) {
      if (!existing.has(name)) {
        db2.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      }
    }
    db2.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, created_at)`);
    db2.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL`
    );
    db2.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_repo_status ON jobs(repo_id, status)`);
  }
};

// ../../packages/persistence/src/migrations/index.ts
var MIGRATIONS = [
  migration001,
  migration002,
  migration003,
  migration004
];

// ../../packages/persistence/src/migrate.ts
function appliedVersions(db2) {
  db2.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const rows = db2.prepare("SELECT version FROM schema_migrations").all();
  return new Set(rows.map((r) => r.version));
}
function runMigrations(db2) {
  const applied = appliedVersions(db2);
  const pending = [...MIGRATIONS].sort((a, b) => a.version - b.version).filter((m) => !applied.has(m.version));
  if (pending.length === 0) return;
  for (const migration of pending) {
    db2.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db2);
      db2.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        Date.now()
      );
      db2.exec("COMMIT");
    } catch (e) {
      db2.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      );
    }
  }
}

// ../../packages/persistence/src/db.ts
var g = globalThis;
function dataDir() {
  return config.dataDir;
}
function open() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const db2 = new DatabaseSync(path2.join(dir, "codegraph.sqlite"));
  db2.exec("PRAGMA journal_mode = WAL;");
  db2.exec("PRAGMA busy_timeout = 5000;");
  db2.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db2);
  return db2;
}
function db() {
  if (!g.__cgDb) g.__cgDb = open();
  return g.__cgDb;
}

// ../../packages/persistence/src/jobs.ts
var QUEUED_JOB_COLUMNS = `id, repo_id, status, progress, message, error, kind, payload_json,
  priority, attempts, max_attempts, lease_until, worker_id, stage, idempotency_key,
  created_at, updated_at`;
function enqueueJob(job) {
  const now = Date.now();
  const key = job.idempotencyKey ?? null;
  if (key !== null) {
    const existing = db().prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(key);
    if (existing) return { id: existing.id, deduplicated: true };
  }
  db().prepare(
    `INSERT INTO jobs
         (id, repo_id, status, progress, message, kind, payload_json,
          priority, attempts, max_attempts, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, 'Queued', ?, ?, ?, 0, ?, ?, ?, ?)`
  ).run(
    job.id,
    job.repoId,
    job.kind,
    JSON.stringify(job.payload ?? {}),
    job.priority ?? 0,
    job.maxAttempts ?? 3,
    key,
    now,
    now
  );
  return { id: job.id, deduplicated: false };
}
function claimJob(workerId, leaseUntil, now = Date.now()) {
  const row = db().prepare(
    `UPDATE jobs
          SET status='leased', worker_id=?, lease_until=?, attempts=attempts+1, updated_at=?
        WHERE id = (
          SELECT id FROM jobs
           WHERE (status='queued')
              OR (status='leased' AND lease_until < ?)
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
        )
        RETURNING ${QUEUED_JOB_COLUMNS}`
  ).get(workerId, leaseUntil, now, now);
  return row ?? null;
}
function heartbeatJob(id, workerId, leaseUntil) {
  const row = db().prepare(
    `UPDATE jobs SET lease_until=?, status='running', updated_at=?
        WHERE id=? AND worker_id=? AND status IN ('leased','running')
        RETURNING id`
  ).get(leaseUntil, Date.now(), id, workerId);
  return row !== void 0;
}
function updateJobProgress(id, workerId, progress, stage, message) {
  const row = db().prepare(
    `UPDATE jobs SET progress=?, stage=?, message=?, status='running', updated_at=?
        WHERE id=? AND worker_id=? AND status IN ('leased','running')
        RETURNING id`
  ).get(progress, stage, message, Date.now(), id, workerId);
  return row !== void 0;
}
function succeedJob(id, workerId, message) {
  db().prepare(
    `UPDATE jobs
          SET status='succeeded', progress=100, message=?, error=NULL,
              lease_until=NULL, updated_at=?
        WHERE id=? AND worker_id=?`
  ).run(message, Date.now(), id, workerId);
}
function failJob(id, workerId, error, permanent = false) {
  const row = db().prepare(
    `UPDATE jobs
          SET status = CASE WHEN ? THEN 'failed'
                            WHEN attempts < max_attempts THEN 'queued'
                            ELSE 'failed' END,
              error=?, lease_until=NULL, worker_id=NULL, updated_at=?
        WHERE id=? AND worker_id=?
        RETURNING status`
  ).get(permanent ? 1 : 0, error, Date.now(), id, workerId);
  return { willRetry: row?.status === "queued" };
}
function cancelJob(id) {
  const row = db().prepare(
    `UPDATE jobs
          SET status='cancelled', message='Cancelled', lease_until=NULL, updated_at=?
        WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')
        RETURNING id`
  ).get(Date.now(), id);
  return row !== void 0;
}
function isJobCancelled(id) {
  const row = db().prepare("SELECT status FROM jobs WHERE id = ?").get(id);
  return row?.status === "cancelled";
}
function findLiveJobForRepo(repoId2) {
  const row = db().prepare(
    `SELECT ${QUEUED_JOB_COLUMNS} FROM jobs
        WHERE repo_id = ? AND status NOT IN ('succeeded','failed','cancelled')
        ORDER BY created_at ASC LIMIT 1`
  ).get(repoId2);
  return row ?? null;
}

// ../../packages/jobs/src/types.ts
var JOB_KINDS = ["analyze", "fix", "timeline"];
function isJobKind(value) {
  return JOB_KINDS.includes(value);
}

// ../../packages/jobs/src/queue.ts
function clampPercent(percent) {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}
function createJobQueue() {
  return {
    enqueue(input) {
      const live = findLiveJobForRepo(input.repoId);
      if (live) {
        return { ok: false, reason: "repo-busy", activeJobId: live.id };
      }
      const result = enqueueJob({
        id: input.id,
        repoId: input.repoId,
        kind: input.kind,
        payload: input.payload,
        ...input.priority !== void 0 ? { priority: input.priority } : {},
        ...input.maxAttempts !== void 0 ? { maxAttempts: input.maxAttempts } : {},
        idempotencyKey: input.idempotencyKey ?? null
      });
      return { ok: true, jobId: result.id, deduplicated: result.deduplicated };
    },
    claim(workerId, leaseMs) {
      const row = claimJob(workerId, Date.now() + leaseMs);
      if (!row) return null;
      const kind = isJobKind(row.kind) ? row.kind : "analyze";
      return {
        id: row.id,
        repoId: row.repo_id,
        kind,
        payload: parsePayload(row.payload_json),
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        workerId
      };
    },
    heartbeat(jobId2, workerId, leaseMs) {
      return heartbeatJob(jobId2, workerId, Date.now() + leaseMs);
    },
    progress(jobId2, workerId, percent, stage, message) {
      return updateJobProgress(jobId2, workerId, clampPercent(percent), stage, message);
    },
    succeed(jobId2, workerId, message) {
      succeedJob(jobId2, workerId, message);
    },
    fail(jobId2, workerId, error, permanent) {
      return failJob(jobId2, workerId, error, permanent ?? false);
    },
    cancel(jobId2) {
      return cancelJob(jobId2);
    },
    isCancelled(jobId2) {
      return isJobCancelled(jobId2);
    },
    liveJobForRepo(repoId2) {
      const row = findLiveJobForRepo(repoId2);
      return row ? { id: row.id, status: row.status } : null;
    }
  };
}
function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ../../packages/jobs/src/runner.ts
var HEARTBEAT_DIVISOR = 3;
var defaultScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer)
};
async function runJob(job, handler, options) {
  const { queue, logger: logger2, leaseMs } = options;
  const scheduler = options.scheduler ?? defaultScheduler;
  let leaseLost = false;
  let cancelled = false;
  const heartbeat = scheduler.setInterval(() => {
    if (!queue.heartbeat(job.id, job.workerId, leaseMs)) {
      leaseLost = true;
      logger2.warn("job lease lost", { jobId: job.id, workerId: job.workerId });
    }
  }, Math.max(1, Math.floor(leaseMs / HEARTBEAT_DIVISOR)));
  const ctx = {
    jobId: job.id,
    repoId: job.repoId,
    attempts: job.attempts,
    progress(percent, stage, message) {
      if (leaseLost) return false;
      const held = queue.progress(job.id, job.workerId, percent, stage, message);
      if (!held) leaseLost = true;
      return held;
    },
    cancelled() {
      if (!cancelled && queue.isCancelled(job.id)) cancelled = true;
      return cancelled;
    }
  };
  try {
    await handler(job.payload, ctx);
    if (leaseLost) {
      logger2.warn("job abandoned after lease loss", { jobId: job.id });
      return { kind: "lease-lost" };
    }
    if (ctx.cancelled()) {
      logger2.info("job cancelled", { jobId: job.id });
      return { kind: "cancelled" };
    }
    queue.succeed(job.id, job.workerId, "Complete");
    return { kind: "succeeded" };
  } catch (error) {
    if (leaseLost) {
      logger2.warn("job threw after lease loss; not recording failure", {
        jobId: job.id,
        err: serializeError(error)
      });
      return { kind: "lease-lost" };
    }
    if (ctx.cancelled()) {
      logger2.info("job cancelled mid-run", { jobId: job.id });
      return { kind: "cancelled" };
    }
    const serialized = serializeError(error);
    const reason = typeof serialized === "string" ? serialized : serialized.message;
    const permanent = typeof error === "object" && error !== null && "permanent" in error ? error.permanent === true : false;
    const { willRetry } = queue.fail(job.id, job.workerId, reason, permanent);
    logger2.error("job failed", {
      jobId: job.id,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      willRetry,
      err: serialized
    });
    return { kind: "failed", error, willRetry };
  } finally {
    scheduler.clearInterval(heartbeat);
  }
}

// src/supervise.ts
import { spawn } from "node:child_process";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// src/exit-codes.ts
var EXIT_BAD_PAYLOAD = 3;

// src/supervise.ts
function executorCommand() {
  const here = fileURLToPath(import.meta.url);
  const dir = path3.dirname(here);
  return here.endsWith(".mjs") || here.endsWith(".js") ? { file: path3.join(dir, "execute.mjs"), nodeArgs: [] } : (
    // `tsx` is a devDependency and is absent from the production runtime, which is
    // why `npm run build` exists and why CG_USE_WORKER stays false until the
    // container runs the compiled output.
    { file: path3.join(dir, "execute.ts"), nodeArgs: ["--import", "tsx"] }
  );
}
var TERM_GRACE_MS = 5e3;
var CANCEL_POLL_MS = 1e3;
var STDERR_KEEP = 4e3;
async function runInChild(jobId2, payload, ctx, logger2, executorPath) {
  const resolved = executorCommand();
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
    env: childEnv()
  });
  child.stdin.end(JSON.stringify({ jobId: jobId2, payload }));
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) forward(line, ctx, logger2, jobId2);
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });
  let cancelling = false;
  const watch = setInterval(() => {
    if (cancelling || !ctx.cancelled()) return;
    cancelling = true;
    logger2.info("cancelling executor", { jobId: jobId2 });
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger2.warn("executor ignored SIGTERM; killing", { jobId: jobId2 });
        child.kill("SIGKILL");
      }
    }, TERM_GRACE_MS).unref();
  }, CANCEL_POLL_MS);
  const exited = Promise.withResolvers();
  child.once("error", exited.reject);
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  try {
    const { code, signal } = await exited.promise;
    if (code === 0) return;
    const tail = stderr.trim().split("\n").slice(-5).join(" | ");
    const cause = signal ? `terminated by ${signal}${signal === "SIGKILL" && !cancelling ? " (no cancellation pending \u2014 likely the OOM killer)" : ""}` : `exited ${code}`;
    const error = new Error(`executor ${cause}${tail ? `: ${tail}` : ""}`);
    if (code === EXIT_BAD_PAYLOAD && !signal) {
      Object.assign(error, { permanent: true });
    }
    if (signal && ctx.attempts >= 2) {
      Object.assign(error, { permanent: true });
      logger2.warn("quarantining after repeated signal deaths", {
        jobId: jobId2,
        attempts: ctx.attempts,
        signal
      });
    }
    throw error;
  } finally {
    clearInterval(watch);
  }
}
function forward(line, ctx, logger2, jobId2) {
  if (!line.trim()) return;
  if (line.startsWith("{")) {
    try {
      const m = JSON.parse(line);
      if (typeof m === "object" && m !== null && "stage" in m) {
        const p = m;
        ctx.progress(
          typeof p.percent === "number" ? p.percent : 0,
          String(p.stage ?? ""),
          typeof p.message === "string" ? p.message : ""
        );
        return;
      }
    } catch {
    }
  }
  logger2.debug("executor output", { jobId: jobId2, line: line.slice(0, 500) });
}

// src/main.ts
var sleep = (ms) => {
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  setTimeout(resolve2, ms).unref();
  return promise;
};
async function runWorker(options = {}) {
  const queue = options.queue ?? createJobQueue();
  const log = options.logger ?? logger;
  const id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const leaseMs = config.workerLeaseMs;
  const pollMs = config.workerPollIntervalMs;
  if (leaseMs <= pollMs * 3) {
    throw new Error(
      `CG_WORKER_LEASE_MS (${leaseMs}) must exceed 3x CG_WORKER_POLL_INTERVAL_MS (${pollMs}); otherwise a healthy job loses its lease between heartbeats`
    );
  }
  let draining = false;
  const drain = (signal) => {
    if (draining) return;
    draining = true;
    log.info("draining: will exit after the current job", { workerId: id, signal });
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
  log.info("worker started", { workerId: id, leaseMs, pollMs });
  let claimed = 0;
  while (!draining && (options.maxJobs === void 0 || claimed < options.maxJobs)) {
    const job = queue.claim(id, leaseMs);
    if (!job) {
      await sleep(pollMs);
      continue;
    }
    claimed += 1;
    log.info("claimed job", {
      jobId: job.id,
      kind: job.kind,
      repoId: job.repoId,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts
    });
    const outcome = await runJob(
      job,
      (payload, ctx) => runInChild(job.id, payload, ctx, log, options.executorPath),
      { queue, logger: log, leaseMs }
    );
    log.info("job finished", { jobId: job.id, outcome: outcome.kind });
  }
  log.info("worker exiting", { workerId: id, claimed });
}

// src/start.ts
runWorker().catch((e) => {
  logger.error("worker crashed", { err: e instanceof Error ? e : String(e) });
  process.exit(1);
});
//# sourceMappingURL=start.mjs.map
