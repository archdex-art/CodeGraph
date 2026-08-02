# Spike results — decisions that were blocking P1

Two questions were left open by [`HLD.md`](./HLD.md) and had to be answered before the
package extraction could start. Both are now resolved, by experiment rather than by assumption.

---

## Spike 1 — Does the monorepo layout survive Next 16's standalone build?

**Question.** The LLD moves `app/` into an npm-workspaces monorepo. Next 16 + Turbopack +
workspaces + `output: "standalone"` is a known-fiddly combination, and the whole P1 plan depends
on it. Does the production build still emit a bootable server that can reach a workspace
package?

**Method.** Built the real application — not a toy — in the target layout:

```
/tmp/spike/
├── package.json                    { "workspaces": ["apps/*", "packages/*"] }
├── packages/core-domain/           TS source only, exports: { ".": "./src/index.ts" }
└── apps/web/                       the actual CodeGraph app, unmodified except:
                                      - depends on @codegraph/core-domain
                                      - /api/health calls tierRank("ast") from it
                                      - outputFileTracingRoot → monorepo root
                                      - next/font removed (sandbox blocks Google Fonts)
```

Then: `next build` → boot `.next/standalone/**/server.js` → `curl /api/health`.

### Verdict: ✅ **works.**

```
✓ Compiled successfully in 4.0s
$ curl localhost:4111/api/health
{"status":"ok","spikeTierRank":2,"localAccessAllowed":false}
```

`spikeTierRank: 2` is `tierRank("ast")` — a function defined in the workspace package, compiled
into the server bundle, executing at runtime inside the standalone output. That is the whole
question answered end to end.

### Four findings that change the P1 plan

**1. The standalone entrypoint moves. This breaks the Dockerfile.**

`outputFileTracingRoot` must point at the monorepo root so files under `packages/*` are traced.
That changes the output layout:

| | Path to `server.js` |
|---|---|
| today | `.next/standalone/server.js` |
| monorepo | `.next/standalone/apps/web/server.js` |

`app/Dockerfile:36` does `COPY --from=builder /app/.next/standalone ./` and `:56` runs
`CMD ["node", "server.js"]`. Both break. `render.yaml` also pins `dockerContext: ./app`, which
must become the repo root once the build needs `packages/`.

**This is the single most likely thing to break the deploy during P1**, and it fails at
container start, not at build — so CI's build step would stay green while production
crash-loops. The Docker smoke test must run before the migration is considered done.

**2. `transpilePackages` was not needed.** Turbopack compiled the workspace package's raw TS
directly. No build step for `packages/*`, no `main`/`types` juggling. Publishing `src/index.ts`
straight from `exports` works, which is what the LLD assumed but had not verified.

**3. `exports: { ".": "./src/index.ts" }` blocks `require.resolve("pkg/package.json")`.**
Observed as `ERR_PACKAGE_PATH_NOT_EXPORTED`. Several tools do this internally. Every package
manifest needs:

```jsonc
"exports": {
  ".": "./src/index.ts",
  "./package.json": "./package.json"   // some tooling resolves this; without it, hard errors
}
```

**4. Commit the root lockfile.** A cold `npm install` at the workspace root with no lockfile did
not finish in several minutes (full metadata resolution for ~500 packages); `npm ci` against a
lockfile took 23 s. The root `package-lock.json` is a required artifact, not an optional one,
and CI must use `npm ci`.

### Consequence for P1

No change of direction — the plan holds. Add three tasks:

- Update `app/Dockerfile` for the nested standalone path, and `render.yaml`'s docker context.
- Add `"./package.json"` to every package's `exports`.
- Generate and commit the root lockfile; switch CI to `npm ci` at the root.

And one gate: **the Docker adversarial smoke test must pass before the monorepo migration
merges.** Typecheck and unit tests cannot catch this class of failure.

---

## Spike 2 — Can Render host the test-execution verification gate?

**Question.** ADR-005 makes `verified` mean something by running the target repository's own
test suite. That is arbitrary code execution and requires real isolation: no network, capped
memory/CPU/pids, wall-clock kill. Can the live deployment do that?

**Method.** Checked Render's documented capabilities and their staff's public answer on
privileged containers.

### Verdict: ❌ **no. Confirmed, not inferred.**

Render staff, [community forum](https://community.render.com/t/run-docker-container-in-privileged-mode/1814):

> *"Unfortunately, we do not allow Render services to run docker in privileged mode."*

Without privileged mode there is no Docker-in-Docker, and no reliable way to deny network access
or enforce resource limits on a child process. The containment available inside a stock Render
container — wall-clock timeout, `ulimit`, `--max-old-space-size` — is weak, and weak containment
around `npm test` on an arbitrary cloned repository is not acceptable at any severity of caveat.

### Resolution: tier the gate by host capability, and say so in the UI

This does not weaken ADR-005; it makes its `level` field mean something concrete. Each gate now
has a known availability:

| Gate | What it does | Render | Self-hosted Docker | CLI / Desktop |
|---|---|:--:|:--:|:--:|
| 1 · syntax | re-parse the edited file | ✅ | ✅ | ✅ |
| 2 · types | `tsc --noEmit` if configured | ✅ | ✅ | ✅ |
| 3 · **tests** | run the repo's suite, isolated | ❌ | ✅ | ✅ |
| 4 · re-analysis | target fingerprint gone, none introduced | ✅ | ✅ | ✅ |
| **Resulting claim** | | `verified: partial` | `verified: full` | `verified: full` |

`CG_ALLOW_TEST_VERIFICATION` stays **off by default** and is only honoured where the operator
controls the container runtime and can pass `--network none --memory --pids-limit --read-only`.

The UI must render the two levels differently and never let `partial` read as `full`. The public
demo will show `verified: partial (no test execution on this host)` — which is accurate, and
being accurate about it is worth more than the stronger-sounding claim.

### The better consequence: the CLI becomes the primary vehicle for verified fixes

Working through where gate 3 *can* run pointed somewhere useful. The developer's own machine is
where the test suite already runs, where the dependencies are already installed, and where the
isolation question is the developer's own call. `apps/cli` running `codegraph fix --verify` is a
**better** product than a hosted button — it is faster, it needs no credentials, and the code
never leaves the machine.

That is not a workaround for a hosting limitation. It is consistent with what CodeGraph already
is: a tool you run on your own code, on your own machine, with no key
([`IDENTITY.md`](./IDENTITY.md) §2). The hosted instance is a demo of the graph and the score;
the full loop lives where the developer lives.

**P4 sequencing changes accordingly:** build gate 3 in the CLI first, then expose it in the web
UI for self-hosted operators. Do not build it hosted-first and then discover it cannot ship.

---

## Sources

- [Run Docker Container in privileged mode — Render community (staff answer)](https://community.render.com/t/run-docker-container-in-privileged-mode/1814)
- [Docker on Render — Render Docs](https://render.com/docs/docker)
