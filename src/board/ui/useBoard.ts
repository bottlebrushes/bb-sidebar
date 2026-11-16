import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { boardRpcContract, BoardSnapshot } from "../contract";
import { BOARD_CHANNEL } from "../model";

export interface BoardData {
  snapshot: BoardSnapshot | null;
  error: string | null;
  refresh(): Promise<void>;
  /** Show a local change at once; the next refresh replaces it. */
  patch(update: (snapshot: BoardSnapshot) => BoardSnapshot): void;
}

/** First and longest wait before refetching after a failed load. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * The board snapshot, refetched whenever the server publishes a change.
 * A failed load (e.g. a 504 while bb connect's tunnel reconnects) is retried
 * with backoff and on window focus, so a blip does not leave the board dead.
 */
export function useBoard(): BoardData {
  const rpc = useRpc<typeof boardRpcContract>();
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Responses can land out of order; only the latest request may apply.
  const latest = useRef(0);
  const failures = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const request = ++latest.current;
    window.clearTimeout(retryTimer.current);
    try {
      const next = await rpc.call("getBoard", {});
      if (request !== latest.current) return;
      failures.current = 0;
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (request !== latest.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      const delay = Math.min(RETRY_BASE_MS * 2 ** failures.current, RETRY_MAX_MS);
      failures.current += 1;
      retryTimer.current = window.setTimeout(() => void refresh(), delay);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (failures.current > 0) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      latest.current += 1;
      window.clearTimeout(retryTimer.current);
    };
  }, [refresh]);
  useRealtime(BOARD_CHANNEL, () => {
    void refresh();
  });

  const patch = useCallback((update: (current: BoardSnapshot) => BoardSnapshot) => {
    setSnapshot((current) => (current ? update(current) : current));
  }, []);

  return { snapshot, error, refresh, patch };
}
