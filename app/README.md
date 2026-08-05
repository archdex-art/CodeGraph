# `app/` — a compatibility shim for one stale Render setting

**This directory holds no code and is safe to delete once the setting below is fixed.**

## Why it exists

The Render service is configured with **Root Directory = `app`**, and every deploy fails
before it starts:

```
==> Checking out commit 8ece0bc… in branch main
==> Root directory "app" does not exist. Verify the Root Directory configured in your service settings.
```

`app/` was this repository's layout before P1 (`1d62a62`, "npm-workspaces monorepo, app/ ->
apps/web/"). The service setting was never updated, so it points at a path that stopped
existing. The check runs immediately after checkout — before Docker, and before
`render.yaml` is consulted — so nothing in the build configuration can clear it.

**And `render.yaml` cannot clear it either**, which is the part worth writing down because a
previous attempt assumed otherwise. Evidence: `main`'s `render.yaml` currently declares
`rootDir: .`, while the platform is using `app`. If the Blueprint were being applied to this
service, Root Directory would read `.`. It does not, and the deploy log also reports
`It looks like we don't have access to your repo` — this service is not Blueprint-linked, so
`render.yaml` is not being read for it at all. Adding `rootDir: .` to that file (commit
`1d990cb`) therefore could not have worked, and did not.

That leaves exactly one lever inside the repository: make the path exist. A directory Render
can `cd` into is enough to get past the checkout gate, because `dockerfilePath` and
`dockerContext` are resolved from the repository root — which is how the original blueprint
worked with `dockerfilePath: ./app/Dockerfile` while the dashboard already said `app`
(`916e894`).

## The actual fix, which this shim is NOT

Dashboard → the service → **Settings → Build & Deploy → Root Directory** → clear it, leaving
it **EMPTY** (not `.`) → Save → **Manual Deploy → Clear build cache & deploy**.

Or via the API, with a Render API key:

```sh
SERVICE=srv-xxxxxxxxxxxx   # dashboard URL: /web/srv-xxxxxxxxxxxx
curl -sS -X PATCH "https://api.render.com/v1/services/$SERVICE" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"serviceDetails":{"envSpecificDetails":{"dockerContext":".","dockerfilePath":"./apps/web/Dockerfile"}},"rootDir":""}'
```

Or delete the service and let the Blueprint recreate it from `render.yaml`, which is also
what reconnects it to that file — a fresh service has no stale field. Back up `/app/data`
first: the disk is recreated empty.

## Deleting this directory

`git rm -r app/` once any of the above is done. Nothing imports it, no build step reads it,
`.dockerignore` keeps it out of the image, and no test references it. It is a placeholder for
a platform setting, and it should not outlive that setting.
