import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRpc, type PluginSidebarThread, type PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./server";
import {
  resolveOverlay,
  type PausedHostPhase,
  type RuntimeOverlaySnapshot,
  type ThreadOverlay,
  type ThreadState,
} from "./runtime-overlays";

/**
 * bb's indicators plus this plugin's own, overlaid from thread runtimes and
 * machine lifecycles (see runtime-overlays.ts): waiting on its machine, or a
 * queue that stopped draining.
 */
export type SidebarIndicator = PluginSidebarThreadIndicator | "host-waking" | "stalled";

interface Overlays {
  threads: ReadonlyMap<string, ThreadState>;
  hosts: ReadonlyMap<string, PausedHostPhase>;
  /** The server's answer, compared to skip rerendering on an unchanged poll. */
  key: string;
}

const EMPTY: Overlays = { threads: new Map(), hosts: new Map(), key: "" };

const RuntimeOverlayContext = createContext<Overlays>(EMPTY);

/** A reconnect resolves in seconds, so this polls faster than the port scan. */
const POLL_MS = 5_000;

function toOverlays(snapshot: RuntimeOverlaySnapshot): Overlays {
  return {
    threads: new Map(snapshot.threads.map((entry) => [entry.threadId, entry])),
    hosts: new Map(snapshot.hosts.map((entry) => [entry.hostId, entry.phase])),
    key: JSON.stringify(snapshot),
  };
}

export function RuntimeOverlayProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [overlays, setOverlays] = useState<Overlays>(EMPTY);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isHidden = () => document.visibilityState === "hidden";
    function publish(next: Overlays) {
      if (!disposed) setOverlays((previous) => (previous.key === next.key ? previous : next));
    }
    async function refresh() {
      if (disposed || inFlight || isHidden()) return;
      inFlight = true;
      try {
        publish(toOverlays(await rpc.call("getRuntimeOverlays", {})));
      } catch {
        // Without an answer, fall back to bb's own indicator rather than a stale glyph.
        publish(EMPTY);
      } finally {
        inFlight = false;
        if (!disposed && !isHidden()) timer = setTimeout(refresh, POLL_MS);
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (!isHidden()) void refresh();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [rpc]);

  return <RuntimeOverlayContext.Provider value={overlays}>{children}</RuntimeOverlayContext.Provider>;
}

/** The overlay a thread shows, if any; a raised hand always wins over it. */
export function useThreadOverlay(thread: PluginSidebarThread | null | undefined): ThreadOverlay | undefined {
  const overlays = useContext(RuntimeOverlayContext);
  if (!thread || thread.hasPendingInteraction) return undefined;
  const hostPhase = thread.host ? overlays.hosts.get(thread.host.id) : undefined;
  return resolveOverlay(overlays.threads.get(thread.id), hostPhase);
}

/**
 * The glyph a thread shows: a raised hand first, then a runtime overlay, then
 * bb's own indicator.
 */
export function useThreadIndicator(thread: PluginSidebarThread | null | undefined): SidebarIndicator | null {
  const overlay = useThreadOverlay(thread);
  if (!thread) return null;
  if (thread.hasPendingInteraction) return "waiting-for-input";
  return overlay?.indicator ?? thread.indicator;
}
