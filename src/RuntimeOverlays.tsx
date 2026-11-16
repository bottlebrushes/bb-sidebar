import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRpc, type PluginSidebarThread, type PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./server";
import type { RuntimeOverlay } from "./runtime-overlays";

/**
 * bb's indicators plus this plugin's own, overlaid from the thread's runtime
 * (see runtime-overlays.ts): waiting on its machine, or a queue that stopped
 * draining.
 */
export type SidebarIndicator = PluginSidebarThreadIndicator | "host-waking" | "stalled";

type OverlayMap = ReadonlyMap<string, RuntimeOverlay>;

const RuntimeOverlayContext = createContext<OverlayMap>(new Map());

function sameOverlays(left: OverlayMap, right: OverlayMap): boolean {
  if (left.size !== right.size) return false;
  for (const [threadId, entry] of left) {
    const other = right.get(threadId);
    if (other?.kind !== entry.kind || other.graceExpiresAt !== entry.graceExpiresAt) return false;
  }
  return true;
}

/** A reconnect resolves in seconds, so this polls faster than the port scan. */
const POLL_MS = 5_000;

export function RuntimeOverlayProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [overlays, setOverlays] = useState<OverlayMap>(new Map());

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isHidden = () => document.visibilityState === "hidden";
    function publish(next: OverlayMap) {
      if (!disposed) setOverlays((previous) => (sameOverlays(previous, next) ? previous : next));
    }
    async function refresh() {
      if (disposed || inFlight || isHidden()) return;
      inFlight = true;
      try {
        const snapshot = await rpc.call("getRuntimeOverlays", {});
        publish(new Map(snapshot.threads.map((entry) => [entry.threadId, entry])));
      } catch {
        // Without an answer, fall back to bb's own indicator rather than a stale glyph.
        publish(new Map());
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

export function useRuntimeOverlay(threadId: string | null | undefined): RuntimeOverlay | undefined {
  const overlays = useContext(RuntimeOverlayContext);
  return threadId ? overlays.get(threadId) : undefined;
}

export function overlayIndicator(overlay: RuntimeOverlay): SidebarIndicator {
  return overlay.kind === "stalled-queue" ? "stalled" : "host-waking";
}

export function overlayLabel(overlay: RuntimeOverlay): string {
  switch (overlay.kind) {
    case "host-reconnecting":
      return "Reconnecting to machine";
    case "waiting-for-host":
      return "Waiting for machine to resume";
    case "stalled-queue":
      return "Stuck: queued messages are not starting";
  }
}

/**
 * The glyph a thread shows: a raised hand first, then a runtime overlay, then
 * bb's own indicator.
 */
export function useThreadIndicator(thread: PluginSidebarThread | null | undefined): SidebarIndicator | null {
  const overlay = useRuntimeOverlay(thread?.id);
  if (!thread) return null;
  if (thread.hasPendingInteraction) return "waiting-for-input";
  return overlay ? overlayIndicator(overlay) : thread.indicator;
}
