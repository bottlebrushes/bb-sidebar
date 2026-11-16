import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Thread states bb's sidebar snapshot does not distinguish, read from each
 * thread's runtime so the sidebar can draw them:
 *
 * - `host-reconnecting`: the host dropped and bb is holding the turn for it
 *   (the snapshot shows the ordinary working spinner);
 * - `waiting-for-host`: the thread cannot start until its host is online, e.g.
 *   a sleeping devbox (the snapshot shows nothing);
 * - `stalled-queue`: the thread is not running yet still holds queued
 *   messages. bb dispatches the queue as soon as a thread goes idle, so a
 *   queue that outlives STALL_AFTER_MS is stuck, typically behind a paused
 *   machine after an interrupted turn (the snapshot shows nothing).
 */
export const RUNTIME_OVERLAY_KINDS = ["host-reconnecting", "waiting-for-host", "stalled-queue"] as const;
export type RuntimeOverlayKind = (typeof RUNTIME_OVERLAY_KINDS)[number];

export const runtimeOverlaySchema = z
  .object({
    threadId: z.string(),
    kind: z.enum(RUNTIME_OVERLAY_KINDS),
    /** When bb stops waiting for a reconnecting host; null when unbounded. */
    graceExpiresAt: z.number().nullable(),
  })
  .strict();
export type RuntimeOverlay = z.infer<typeof runtimeOverlaySchema>;

export const runtimeOverlaySnapshotSchema = z
  .object({ threads: z.array(runtimeOverlaySchema) })
  .strict();
export type RuntimeOverlaySnapshot = z.infer<typeof runtimeOverlaySnapshotSchema>;

export interface ThreadRuntimeRow {
  id: string;
  /** Queued follow-ups: still waiting to start, or failed to send. */
  queuedWork: "none" | "waiting" | "failed";
  runtime: { displayStatus: string; hostReconnectGraceExpiresAt: number | null };
}

/** Long enough for bb to start the next queued turn after one ends. */
export const STALL_AFTER_MS = 30_000;

/**
 * Classifies threads, remembering in `stalledSince` when each idle-with-queue
 * thread was first seen so a queue that is about to drain is not reported.
 */
export function runtimeOverlays(
  threads: readonly ThreadRuntimeRow[],
  now: number,
  stalledSince: Map<string, number>,
): RuntimeOverlay[] {
  const overlays: RuntimeOverlay[] = [];
  const stalledNow = new Set<string>();
  for (const thread of threads) {
    const { displayStatus, hostReconnectGraceExpiresAt } = thread.runtime;
    const base = { threadId: thread.id, graceExpiresAt: hostReconnectGraceExpiresAt };
    if (displayStatus === "host-reconnecting" || displayStatus === "waiting-for-host") {
      overlays.push({ ...base, kind: displayStatus });
      continue;
    }
    if ((displayStatus === "idle" || displayStatus === "error") && thread.queuedWork !== "none") {
      stalledNow.add(thread.id);
      const since = stalledSince.get(thread.id) ?? now;
      stalledSince.set(thread.id, since);
      if (now - since >= STALL_AFTER_MS) overlays.push({ ...base, kind: "stalled-queue" });
    }
  }
  for (const threadId of stalledSince.keys()) if (!stalledNow.has(threadId)) stalledSince.delete(threadId);
  return overlays;
}

/** Every open window polls this; one listing serves them all for a few seconds. */
const CACHE_MS = 3_000;

export function createRuntimeOverlayLookup(bb: BbPluginApi) {
  const stalledSince = new Map<string, number>();
  let cached: RuntimeOverlaySnapshot = { threads: [] };
  let listedAt = -Infinity;
  let pending: Promise<RuntimeOverlaySnapshot> | null = null;

  async function list(): Promise<RuntimeOverlaySnapshot> {
    const threads: ThreadRuntimeRow[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: pageSize, offset });
      threads.push(...page);
      if (page.length < pageSize) break;
    }
    return { threads: runtimeOverlays(threads, Date.now(), stalledSince) };
  }

  return function getRuntimeOverlays(): Promise<RuntimeOverlaySnapshot> {
    if (pending) return pending;
    if (Date.now() - listedAt < CACHE_MS) return Promise.resolve(cached);
    pending = list()
      .then((snapshot) => {
        cached = snapshot;
        listedAt = Date.now();
        return snapshot;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
