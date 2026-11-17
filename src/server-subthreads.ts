import type { ServerContext, ServerHandlers } from "./server-context";

/** The "New subthread" composer: the parent's execution defaults, and the spawn itself. */
export function createServerSubthreads(ctx: ServerContext) {
  return {
    async getSubthreadDefaults({ threadId }) {
      const options = await ctx.bb.sdk.threads.defaultExecutionOptions({ threadId });
      return options
        ? {
            model: options.model,
            reasoningLevel: options.reasoningLevel,
            serviceTier: options.serviceTier,
            permissionMode: options.permissionMode,
          }
        : null;
    },
    async createSubthread({ parentThreadId, request }) {
      const thread = await ctx.bb.sdk.threads.spawn({ ...request, parentThreadId });
      return { threadId: thread.id };
    },
  } satisfies Pick<ServerHandlers, "getSubthreadDefaults" | "createSubthread">;
}
