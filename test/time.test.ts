import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pause } from "../src/time.ts";

describe("pause", () => {
  it("resolves after the delay", async () => {
    const t0 = performance.now();
    await pause(40);
    assert.ok(performance.now() - t0 >= 35);
  });

  it("resolves as soon as the signal aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t0 = performance.now();
    await pause(10_000, ac.signal);
    assert.ok(performance.now() - t0 < 1_000);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const t0 = performance.now();
    await pause(10_000, AbortSignal.abort());
    assert.ok(performance.now() - t0 < 1_000);
  });
});
