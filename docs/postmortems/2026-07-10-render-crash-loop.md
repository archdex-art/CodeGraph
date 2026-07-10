# Postmortem: Container crash-looped after the disk-permission fix shipped

**Date:** 2026-07-10 · **Severity:** Critical (service unreachable, 502s) · **Fixed in:** `1505ed3`

## Summary
The fix for the disk-permission crash (prior postmortem) introduced a new failure: the container now crashed on every single start, before ever binding a port. Render kept restarting it, producing an infinite crash loop visible to users as intermittent 502 Bad Gateway responses and jobs frozen at whatever status they last reached before a restart wiped the in-flight process.

## Impact
- Live deployment intermittently returned 502s.
- Any job's status could freeze forever mid-restart, with no error surfaced (the process that would have updated it was gone).
- User-visible: a job stuck at "Initializing Tree-sitter parsers…" that was actually a *different* container instance than the one that started it.

## Root Cause
The disk-permission fix added a root-starting Docker entrypoint that used `setpriv --reuid=node --regid=node --init-groups` to drop privileges to the non-root `node` user after fixing `/app/data` ownership. Render's container runtime does not grant `CAP_SETUID`/`CAP_SETGID` to the container, so `setpriv` failed outright on every start:

```
setpriv: setresuid failed: Operation not permitted
```

That's a hard, immediate exit before the Node server ever started — Render restarted the container, which failed identically, forever.

Reproduced directly: rebuilding the exact pre-fix image and running it with `docker run --cap-drop=SETUID --cap-drop=SETGID` (simulating a capability-restricted sandbox like Render's) crash-looped with the exact same error, on demand, every time.

## Detection
User report ("still not working," then a screenshot of a live 502 page). No automated signal caught this — the container never got far enough to serve `/api/health`.

## Resolution
Removed the privilege-drop entirely. The container now runs as `root` for its whole lifetime (the base image's actual default user — no `USER` directive needed). Root can read/write `/app/data` regardless of what UID the platform's disk mount assigns it, so the *original* disk-permission problem is sidestepped structurally rather than patched with a privilege-drop step that depends on a capability this platform doesn't grant.

Verified under the same adversarial conditions that killed the previous fix — root-owned disk mount **and** `SETUID`/`SETGID` capabilities dropped — the new image starts cleanly and indexes a real repo end-to-end.

## Prevention / Action Items
- [x] CI's Docker smoke-test job runs the built image under a root-owned `--tmpfs` mount on every push, which would have caught the original disk-permission bug immediately — the crash-loop fix itself doesn't need a *capability-drop* simulation in CI, since the real fix is "never attempt privilege drop at all," which is enforced simply by the container starting and completing a smoke test.
- [ ] If a future change reintroduces any privilege-drop step (`setpriv`, `gosu`, `su-exec`, `USER` directive), treat it as high-risk and verify locally with `--cap-drop=SETUID --cap-drop=SETGID` before merging, since standard local Docker testing doesn't reproduce Render's capability restrictions by default.
