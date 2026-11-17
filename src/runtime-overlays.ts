/**
 * Thread and machine states bb's sidebar snapshot does not distinguish, read
 * on the server so the sidebar can draw them (see `resolveOverlay` in
 * RuntimeOverlays.tsx for how they combine):
 *
 * Per thread, from its runtime:
 * - `host-reconnecting`: the host dropped and bb is holding the turn for it
 *   (the snapshot shows the ordinary working spinner);
 * - `waiting-for-host`: the thread cannot start until its host is online
 *   (the snapshot shows nothing);
 * - `queued`: the thread is not running yet holds queued messages. `stalled`
 *   once that has lasted STALL_AFTER_MS: bb dispatches the queue as soon as a
 *   thread goes idle, so a queue that outlives it is stuck.
 *
 * Per machine, from its lifecycle: a devbox that is suspending, suspended or
 * resuming. bb shows "Machine is resuming…" in the chat, but the snapshot
 * carries no machine state and the thread itself reads idle.
 */
export const THREAD_STATES = ["host-reconnecting", "waiting-for-host", "queued"] as const;
export const PAUSED_HOST_PHASES = ["suspending", "suspended", "resuming"] as const;
export type PausedHostPhase = (typeof PAUSED_HOST_PHASES)[number];

export interface ThreadState {
  threadId: string;
  kind: (typeof THREAD_STATES)[number];
  /** A queue that has not drained for STALL_AFTER_MS. */
  stalled: boolean;
  /** When bb stops waiting for a reconnecting host; null when unbounded. */
  graceExpiresAt: number | null;
}

interface PausedHost {
  hostId: string;
  phase: PausedHostPhase;
}

export interface RuntimeOverlaySnapshot {
  threads: ThreadState[];
  hosts: PausedHost[];
}

export interface ThreadRuntimeRow {
  id: string;
  /** Queued follow-ups: still waiting to start, or failed to send. */
  queuedWork: "none" | "waiting" | "failed";
  /** bb 0.49 no longer reports a reconnect grace; older servers did. */
  runtime: { displayStatus: string; hostReconnectGraceExpiresAt?: number | null };
}

/**
 * A host as bb's server returns it. The SDK's `Host` type predates machine
 * lifecycles, so the field is read as optional.
 */
export interface HostLifecycleRow {
  id: string;
  lifecycle?: { phase?: string } | null;
}

export interface ThreadOverlay {
  indicator: "host-waking" | "stalled";
  label: string;
}

/**
 * How a thread's runtime state and its machine's lifecycle combine:
 * - a reconnecting or waited-for host, or a machine that is resuming, is the
 *   yellow power glyph whether or not anything is queued;
 * - a queue behind a suspending or suspended machine is the same glyph at
 *   once (it starts when the machine is back);
 * - any other queue that has not drained for the stall window is a failure.
 * A sleeping machine with nothing waiting on it draws nothing.
 */
export function resolveOverlay(
  state: ThreadState | undefined,
  hostPhase: PausedHostPhase | undefined,
): ThreadOverlay | undefined {
  if (state?.kind === "host-reconnecting") return { indicator: "host-waking", label: "Reconnecting to machine" };
  if (state?.kind === "waiting-for-host") return { indicator: "host-waking", label: "Waiting for machine to resume" };
  if (hostPhase === "resuming") return { indicator: "host-waking", label: "Machine is resuming" };
  if (state?.kind !== "queued") return undefined;
  if (hostPhase) return { indicator: "host-waking", label: "Queued until the paused machine resumes" };
  if (state.stalled) return { indicator: "stalled", label: "Stuck: queued messages are not starting" };
  return undefined;
}

/** Long enough for bb to start the next queued turn after one ends. */
export const STALL_AFTER_MS = 30_000;

/**
 * Classifies threads, remembering in `queuedSince` when each idle-with-queue
 * thread was first seen so a queue that is about to drain is not reported as
 * stalled.
 */
export function threadStates(
  threads: readonly ThreadRuntimeRow[],
  now: number,
  queuedSince: Map<string, number>,
): ThreadState[] {
  const states: ThreadState[] = [];
  const queuedNow = new Set<string>();
  for (const thread of threads) {
    const graceExpiresAt = thread.runtime.hostReconnectGraceExpiresAt ?? null;
    const { displayStatus } = thread.runtime;
    if (displayStatus === "host-reconnecting" || displayStatus === "waiting-for-host") {
      states.push({ threadId: thread.id, kind: displayStatus, stalled: false, graceExpiresAt });
      continue;
    }
    if ((displayStatus === "idle" || displayStatus === "error") && thread.queuedWork !== "none") {
      queuedNow.add(thread.id);
      const since = queuedSince.get(thread.id) ?? now;
      queuedSince.set(thread.id, since);
      states.push({ threadId: thread.id, kind: "queued", stalled: now - since >= STALL_AFTER_MS, graceExpiresAt });
    }
  }
  for (const threadId of queuedSince.keys()) if (!queuedNow.has(threadId)) queuedSince.delete(threadId);
  return states;
}

export function pausedHosts(hosts: readonly HostLifecycleRow[]): PausedHost[] {
  const paused: PausedHost[] = [];
  for (const host of hosts) {
    const phase = host.lifecycle?.phase;
    if (phase === "suspending" || phase === "suspended" || phase === "resuming") {
      paused.push({ hostId: host.id, phase });
    }
  }
  return paused;
}
