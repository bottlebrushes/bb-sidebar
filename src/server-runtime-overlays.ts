import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  pausedHosts,
  threadStates,
  type HostLifecycleRow,
  type RuntimeOverlaySnapshot,
  type ThreadRuntimeRow,
} from "./runtime-overlays";

/** Every open window polls this; one listing serves them all for a few seconds. */
const CACHE_MS = 3_000;

/** The `getRuntimeOverlays` RPC: machine waits and stuck queues, which bb's sidebar snapshot leaves out. */
export function createRuntimeOverlayLookup(bb: BbPluginApi) {
  const queuedSince = new Map<string, number>();
  let cached: RuntimeOverlaySnapshot = { threads: [], hosts: [] };
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
    const hosts: readonly HostLifecycleRow[] = await bb.sdk.hosts.list();
    return { threads: threadStates(threads, Date.now(), queuedSince), hosts: pausedHosts(hosts) };
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
