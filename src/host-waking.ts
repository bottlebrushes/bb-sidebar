import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Threads waiting on their machine: the host dropped and bb is holding the
 * turn for it to come back (`host-reconnecting`), or the thread cannot start
 * until its host is online (`waiting-for-host`, e.g. a sleeping devbox).
 *
 * The sidebar's thread snapshot folds the first into the "runtime" spinner and
 * the second into no indicator at all, so the plugin reads the runtime status
 * itself to draw a distinct glyph.
 */
export const HOST_WAKING_STATUSES = ["host-reconnecting", "waiting-for-host"] as const;
export type HostWakingStatus = (typeof HOST_WAKING_STATUSES)[number];

export const hostWakingThreadSchema = z
  .object({
    threadId: z.string(),
    status: z.enum(HOST_WAKING_STATUSES),
    /** When bb stops waiting for a reconnecting host; null when unbounded. */
    graceExpiresAt: z.number().nullable(),
  })
  .strict();
export type HostWakingThread = z.infer<typeof hostWakingThreadSchema>;

export const hostWakingSnapshotSchema = z
  .object({ threads: z.array(hostWakingThreadSchema) })
  .strict();
export type HostWakingSnapshot = z.infer<typeof hostWakingSnapshotSchema>;

interface ThreadRuntimeRow {
  id: string;
  runtime: { displayStatus: string; hostReconnectGraceExpiresAt: number | null };
}

function isHostWakingStatus(status: string): status is HostWakingStatus {
  return (HOST_WAKING_STATUSES as readonly string[]).includes(status);
}

export function hostWakingThreads(threads: readonly ThreadRuntimeRow[]): HostWakingThread[] {
  const waking: HostWakingThread[] = [];
  for (const thread of threads) {
    const { displayStatus, hostReconnectGraceExpiresAt } = thread.runtime;
    if (!isHostWakingStatus(displayStatus)) continue;
    waking.push({ threadId: thread.id, status: displayStatus, graceExpiresAt: hostReconnectGraceExpiresAt });
  }
  return waking;
}

/** Every open window polls this; one listing serves them all for a few seconds. */
const CACHE_MS = 3_000;

export function createHostWakingLookup(bb: BbPluginApi) {
  let cached: HostWakingSnapshot = { threads: [] };
  let listedAt = -Infinity;
  let pending: Promise<HostWakingSnapshot> | null = null;

  async function list(): Promise<HostWakingSnapshot> {
    const threads: ThreadRuntimeRow[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: pageSize, offset });
      threads.push(...page);
      if (page.length < pageSize) break;
    }
    return { threads: hostWakingThreads(threads) };
  }

  return function getHostWakingThreads(): Promise<HostWakingSnapshot> {
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
