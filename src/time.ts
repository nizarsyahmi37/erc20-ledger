import { setTimeout as sleep } from "node:timers/promises";

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects on abort, so callers just re-check the signal. */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (e) {
    if (!(e instanceof Error && e.name === "AbortError")) throw e;
  }
}
