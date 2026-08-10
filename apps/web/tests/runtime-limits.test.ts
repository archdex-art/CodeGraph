import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSlotGate } from "@codegraph/jobs";
import { GET as eventsGet, resetEventStreamsForTests } from "@/app/api/jobs/[id]/events/route";
import { config } from "@codegraph/config";

/**
 * Two ceilings this deployment did not have.
 *
 * The per-repo mutex only ever serialised ONE repository, so N distinct repositories meant N
 * concurrent CPU- and memory-bound index passes on a 0.5 vCPU / 512 MB host; and
 * `/api/jobs/:id/events` opened a 500ms SQLite poll per connection, for up to fifteen minutes,
 * with nothing bounding how many a single client could hold.
 */

describe("slot gate (host concurrency ceiling)", () => {
  it("runs up to the limit immediately and makes the rest wait", async () => {
    const gate = createSlotGate(1);
    const order: string[] = [];
    let releaseFirst = () => {};
    const first = new Promise<void>((r) => (releaseFirst = r));

    const a = gate.run(async () => {
      order.push("a:start");
      await first;
      order.push("a:end");
    });
    // Dispatched in the same tick as `a`, while the only slot is taken.
    const b = gate.run(async () => {
      order.push("b:start");
    });

    // `b` has not started, and the gate says so rather than leaving it invisible.
    expect(order).toEqual(["a:start"]);
    expect(gate.stats()).toEqual({ active: 1, waiting: 1, limit: 1 });

    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    expect(gate.stats()).toEqual({ active: 0, waiting: 0, limit: 1 });
  });

  it("frees the slot when a task rejects, rather than closing the gate forever", async () => {
    const gate = createSlotGate(1);
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
    expect(gate.stats().active).toBe(0);
  });

  it("frees the slot when a task throws BEFORE returning a promise", async () => {
    // The synchronous-throw path is separate: without its own release the slot leaks and the
    // gate wedges after `limit` such throws.
    const gate = createSlotGate(1);
    await expect(gate.run((() => { throw new Error("sync"); }) as () => Promise<never>)).rejects.toThrow("sync");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("refuses a ceiling that would wedge every task", () => {
    expect(() => createSlotGate(0)).toThrow(/>= 1/);
  });
});

describe("SSE stream ceiling", () => {
  const jobId = "00000000-0000-4000-8000-000000000000";
  const params = Promise.resolve({ id: jobId });
  const request = () =>
    new NextRequest(`http://localhost/api/jobs/${jobId}/events`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });

  beforeEach(() => resetEventStreamsForTests());
  afterEach(() => resetEventStreamsForTests());

  it("does not consume a slot for a request that never gets a stream", async () => {
    // No such job → 404 before the ceiling is touched. A refused request that still burned a
    // slot would let anyone exhaust the pool by asking for job ids that do not exist.
    const res = await eventsGet(request(), { params });
    expect(res.status).toBe(404);

    // Proof the pool is untouched: the ceiling's worth of acquisitions all still succeed.
    for (let i = 0; i < config.maxEventStreamsPerIp; i++) {
      const again = await eventsGet(request(), { params });
      expect(again.status).toBe(404);
    }
  });
});
