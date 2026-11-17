import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useSidebarThreads } from "./bb-sdk";
import type { bbSidebarRpcContract } from "./contract";
import { Icon } from "./components/Icon";
import { Item } from "./components/MenuItem";
import { errorDetail, toast } from "./lib/toast";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn } from "./lib/utils";

/**
 * Sort under: files the thread under another project in this sidebar only;
 * bb cannot move a thread between projects. Picking the project bb created it
 * in (`homeProjectId`) clears the placement.
 */
export function ProjectPlacementSubmenu({
  thread,
  homeProjectId,
}: {
  thread: PluginSidebarThread;
  homeProjectId: string;
}) {
  const { projects } = useSidebarThreads();
  const portalScope = usePortalScopeProps();
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  if (projects.length < 2) return null;
  const ordered = [...projects].sort(
    (left, right) => Number(right.isPersonal) - Number(left.isPersonal) || left.name.localeCompare(right.name),
  );
  const place = async (projectId: string) => {
    try {
      await rpc.call("setThreadProject", {
        threadId: thread.id,
        projectId: projectId === homeProjectId ? null : projectId,
      });
    } catch (error) {
      toast.error("Could not move thread", { description: errorDetail(error) });
    }
  };
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center rounded-md px-2 py-[0.3125rem] text-xs outline-none",
          "data-[state=open]:bg-accent data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        )}
      >
        Sort under
        <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...portalScope}
          aria-label="Sort under project"
          sideOffset={4}
          className="z-50 max-h-80 min-w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {ordered.map((candidate) => (
            <Item
              key={candidate.id}
              title={candidate.id === homeProjectId ? "The project this thread was created in" : undefined}
              onSelect={() => void place(candidate.id)}
            >
              <Icon
                name="Check"
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground",
                  candidate.id !== thread.projectId && "invisible",
                )}
                aria-hidden="true"
              />
              <span className="truncate">{candidate.name}</span>
            </Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
