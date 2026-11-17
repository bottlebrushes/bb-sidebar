import type { ServerContext, ServerHandlers } from "./server-context";
import { THREAD_PROJECTS_CHANNEL } from "./thread-projects";

/**
 * The project a thread is filed under in this sidebar, when it differs from
 * the project bb created it in. bb cannot move a thread between projects, so
 * this only changes where the sidebar sorts it.
 */
export const THREAD_PROJECTS_MIGRATION = `CREATE TABLE IF NOT EXISTS thread_projects (
     thread_id   TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL
   )`;

export function createServerThreadProjects(ctx: ServerContext) {
  const publish = (threadId?: string) =>
    ctx.bb.realtime.publish(THREAD_PROJECTS_CHANNEL, threadId === undefined ? {} : { threadId });

  const handlers = {
    async listThreadProjects() {
      return {
        rows: ctx.db
          .prepare(`SELECT thread_id AS threadId, project_id AS projectId FROM thread_projects`)
          .all() as Array<{ threadId: string; projectId: string }>,
      };
    },
    async setThreadProject({ threadId, projectId }) {
      const thread = await ctx.bb.sdk.threads.get({ threadId });
      if (projectId === null || projectId === thread.projectId) {
        ctx.db.prepare(`DELETE FROM thread_projects WHERE thread_id = ?`).run(threadId);
      } else {
        await ctx.bb.sdk.projects.get({ projectId });
        ctx.db
          .prepare(
            `INSERT INTO thread_projects (thread_id, project_id) VALUES (?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET project_id = excluded.project_id`,
          )
          .run(threadId, projectId);
      }
      publish(threadId);
      return { ok: true as const };
    },
  } satisfies Pick<ServerHandlers, "listThreadProjects" | "setThreadProject">;

  return {
    handlers,
    forgetThread(threadId: string) {
      if (ctx.db.prepare(`DELETE FROM thread_projects WHERE thread_id = ?`).run(threadId).changes > 0) {
        publish(threadId);
      }
    },
    forgetProject(projectId: string) {
      if (ctx.db.prepare(`DELETE FROM thread_projects WHERE project_id = ?`).run(projectId).changes > 0) {
        publish();
      }
    },
  };
}
