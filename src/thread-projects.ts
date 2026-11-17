import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

/** Channel the frontend re-reads sidebar project placements on. */
export const THREAD_PROJECTS_CHANNEL = "thread-projects";

/**
 * The threads as this sidebar files them. bb fixes a thread's project when
 * the thread is created, so a thread that later moved to another checkout
 * would otherwise stay under its original project. A stored placement files
 * it under the chosen project for grouping, scoping, and its card label.
 *
 * A placement naming a project that no longer exists is ignored, and the
 * thread falls back to its own project. Unplaced threads keep their identity.
 */
export function placeThreadsInProjects(
  threads: readonly PluginSidebarThread[],
  placements: ReadonlyMap<string, string>,
  projects: readonly { id: string }[],
): readonly PluginSidebarThread[] {
  if (placements.size === 0) return threads;
  const projectIds = new Set(projects.map((project) => project.id));
  let changed = false;
  const placed = threads.map((thread) => {
    const projectId = placements.get(thread.id);
    if (projectId === undefined || projectId === thread.projectId || !projectIds.has(projectId)) {
      return thread;
    }
    changed = true;
    return { ...thread, projectId };
  });
  return changed ? placed : threads;
}
