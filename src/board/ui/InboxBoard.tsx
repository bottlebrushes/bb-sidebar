import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useInboxActions, useInboxActivity, useInboxEnvironment } from "../../InboxContext";
import { DEFAULT_SIDEBAR_SETTINGS } from "../../sidebar-settings";
import { BoardView } from "./BoardView";

/**
 * The board in place of the inbox's shelves, fed from the inbox context so it
 * shares child expansion, settle, and navigation with the list. One selected
 * project shows that project's columns; none or several show every project's,
 * with pinned projects' cards first in each column. Only the selected
 * projects' threads get cards of their own, but a card shows its linked
 * thread from any project.
 */
export function InboxBoard({
  scope,
  threads,
  expandedChildParentIds,
}: {
  scope: readonly string[];
  threads: readonly PluginSidebarThread[];
  expandedChildParentIds: ReadonlySet<string>;
}) {
  const {
    providerById,
    projectIconRevision,
    projects,
    sidebarSettings,
    lifecycle,
    childrenByParentId,
    pinnedProjects,
  } = useInboxEnvironment();
  const { onNavigate, settleThread, toggleChildExpansion } = useInboxActions();
  const { activeThreadId, now } = useInboxActivity();
  return (
    <BoardView
      projectId={scope.length === 1 ? scope[0]! : null}
      threads={threads}
      threadProjectIds={scope}
      pinnedProjectIds={pinnedProjects}
      projects={projects}
      isSettled={(thread) => lifecycle.settledAtFor(thread) !== null}
      activeThreadId={activeThreadId}
      providerById={providerById}
      projectIconRevision={projectIconRevision}
      onNavigate={onNavigate}
      childrenByParent={childrenByParentId}
      expandedChildParentIds={expandedChildParentIds}
      showRunningChildrenWhenCollapsed={
        sidebarSettings?.showRunningChildrenWhenCollapsed ?? DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed
      }
      onToggleChildren={toggleChildExpansion}
      now={now}
      onSettleThread={settleThread}
    />
  );
}
