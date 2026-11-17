import type { ServerContext, ServerHandlers } from "./server-context";

/**
 * A settle asked for while the thread is still working (an agent settling its
 * own thread mid-turn). Settling now would stop the runtime that very turn
 * runs on, so it waits for the thread to go idle. Any explicit shelf choice,
 * a failed turn, or deletion drops it.
 */
export const PENDING_SETTLES_MIGRATION = `CREATE TABLE IF NOT EXISTS pending_settles (
     thread_id     TEXT PRIMARY KEY,
     requested_at  INTEGER NOT NULL
   )`;

type ShelfHandlers = Pick<ServerHandlers, "pin" | "park" | "resume" | "settle" | "unsettle" | "snooze" | "unsnooze">;

export function createServerPendingSettle(ctx: ServerContext, handlers: ShelfHandlers) {
  const drop = (threadId: string): boolean =>
    ctx.db.prepare(`DELETE FROM pending_settles WHERE thread_id = ?`).run(threadId).changes > 0;

  ctx.bb.events.on("thread.idle", async ({ thread }) => {
    if (!drop(thread.id)) return;
    try {
      await handlers.settle({ threadId: thread.id });
    } catch (error) {
      ctx.bb.log.error(
        `Pending settle of ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  ctx.bb.events.on("thread.failed", ({ thread }) => {
    drop(thread.id);
  });
  ctx.bb.events.on("thread.deleted", ({ thread }) => {
    drop(thread.id);
  });

  // Every other shelf choice supersedes a settle waiting for the turn's end.
  const superseding =
    <Input extends { threadId: string }, Output>(handler: (input: Input) => Output | Promise<Output>) =>
    async (input: Input) => {
      drop(input.threadId);
      return await handler(input);
    };

  return {
    handlers: {
      pin: superseding(handlers.pin),
      park: superseding(handlers.park),
      resume: superseding(handlers.resume),
      settle: superseding(handlers.settle),
      unsettle: superseding(handlers.unsettle),
      snooze: superseding(handlers.snooze),
      unsnooze: superseding(handlers.unsnooze),
    } satisfies ShelfHandlers,
    /** Settle now when idle; otherwise once the current turn ends. */
    async settleOrDefer(threadId: string): Promise<"settled" | "deferred"> {
      const thread = await ctx.bb.sdk.threads.get({ threadId });
      if (thread.status === "idle" || thread.status === "error") {
        drop(threadId);
        await handlers.settle({ threadId });
        return "settled";
      }
      ctx.db
        .prepare(
          `INSERT INTO pending_settles (thread_id, requested_at) VALUES (?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET requested_at = excluded.requested_at`,
        )
        .run(threadId, Date.now());
      return "deferred";
    },
  };
}
