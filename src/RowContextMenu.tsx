import { useRef, useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import { ParentThreadMenu } from "./ParentThreadMenu";
import { DeleteThreadDialog } from "./DeleteThreadDialog";
import { Icon, type IconName } from "./components/Icon";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import { ProjectActions } from "./ProjectContextMenu";
import {
  canParkThread,
  formatSnoozeWakeTime,
  resolveConfiguredSnoozePreset,
  type ConfiguredSnoozePreset,
} from "./lifecycle";
import { beginTitleGeneration, finishTitleGeneration, useTitleGenerating } from "./title-generation-state";
import { openSubthreadComposer } from "./subthread-composer-state";

// Mute state is owned by the Chime (Notifications & Sounds) plugin. Muting a
// thread silences it and every descendant; the item is hidden when Chime is
// not installed.
const CHIME_HTTP = "/api/v1/plugins/chime/http";
const MUTE_CHANGED_EVENT = "chime:thread-mute-changed";

type MuteState = { muted: boolean; inheritedFrom: string | null };

/**
 * This sidebar's own right-click menu.
 *
 * The plugin API ships no menu component on purpose, so a replaced sidebar
 * owns this surface. Native actions use
 * `experimental_useSidebarThreadActions`. The destructive one goes through
 * this sidebar's own confirmation, which names the thread and project, and
 * then the plugin's `deleteThread` rpc; nothing deletes a subtree silently.
 */
export function RowContextMenu({
  thread,
  children,
  canSnooze = false,
  canArchive = true,
  snoozePresets = [],
  onSnooze,
  onPark,
  onResume,
  onSettle,
  onUnsettle,
  onWake,
  onRename,
}: {
  thread: PluginSidebarThread;
  children: ReactNode;
  canSnooze?: boolean;
  canArchive?: boolean;
  snoozePresets?: readonly ConfiguredSnoozePreset[];
  onSnooze?: (snoozedUntil: number) => void;
  onPark?: () => void;
  onResume?: () => void;
  onSettle?: () => void;
  onUnsettle?: () => void;
  onWake?: () => void;
  onRename?: () => void;
}) {
  const actions = useSidebarThreadActions();
  const { projects, threads } = useSidebarThreads();
  const project = projects.find((project) => project.id === thread.projectId);
  // The sidebar may file a thread under another project; bb still owns the
  // one it was created in, which links and resets use.
  const homeProjectId =
    threads.find((candidate) => candidate.id === thread.id)?.projectId ??
    thread.projectId;
  const portalScope = usePortalScopeProps();
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const regenerating = useTitleGenerating(thread.id);
  const renameAfterClose = useRef(false);
  const subthreadAfterClose = useRef(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [mute, setMute] = useState<MuteState | null>(null);
  const loadMute = (open: boolean) => {
    if (!open) return;
    setMute(null);
    void fetch(`${CHIME_HTTP}/thread-mute?threadId=${encodeURIComponent(thread.id)}`)
      .then((response) => (response.ok ? response.json() as Promise<MuteState> : null))
      .then(setMute, () => setMute(null));
  };
  const toggleMute = async (muted: boolean) => {
    try {
      const response = await fetch(`${CHIME_HTTP}/mute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: thread.id, muted }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      window.dispatchEvent(new Event(MUTE_CHANGED_EVENT));
    } catch (error) {
      toast.error(muted ? "Could not mute thread" : "Could not unmute thread", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  // Archive takes the children with it, and bb leaves every idle one's agent
  // session loaded. Release them alongside the archive. Working children are
  // skipped, so this never interrupts a turn archive itself would not.
  const archive = () => {
    actions.archive(thread.id);
    const threadIds = [
      thread.id,
      ...threads
        .filter(
          (child) =>
            child.parentThreadId === thread.id && canParkThread(child),
        )
        .map((child) => child.id),
    ];
    void rpc.call("releaseRuntimes", { threadIds }).catch(() => {
      void 0; // A missed release costs memory, not correctness.
    });
  };
  const regenerate = async () => {
    if (!beginTitleGeneration(thread.id)) return;
    try {
      await rpc.call("regenerateTitle", { threadId: thread.id });
      toast.success("Thread title regenerated");
    } catch (error) {
      toast.error("Could not regenerate title", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      finishTitleGeneration(thread.id);
    }
  };
  const togglePin = async () => {
    try {
      if (thread.isPinned) {
        await actions.setPinned(thread.id, false);
      } else {
        await rpc.call("pin", { threadId: thread.id });
      }
    } catch (error) {
      toast.error(thread.isPinned ? "Could not unpin thread" : "Could not pin thread", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <>
    <ProjectActions project={project}>
    {({ items: projectItems, onOpenChange, onCloseAutoFocus }) => (
    <ContextMenu.Root onOpenChange={loadMute}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          aria-label="Thread actions"
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            // The delete dialog takes focus next; do not pull it back to the row.
            if (confirmingDelete) event.preventDefault();
            if (subthreadAfterClose.current) {
              subthreadAfterClose.current = false;
              // The composer takes focus next; do not pull it back to the row.
              event.preventDefault();
              openSubthreadComposer(thread.id);
              return;
            }
            if (!renameAfterClose.current) return;
            renameAfterClose.current = false;
            // Hand focus to the editor after the menu releases its focus scope.
            event.preventDefault();
            onRename?.();
          }}
          className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item onSelect={() => actions.open(thread.id, { split: true })}>
            Open in split
          </Item>
          <Item onSelect={() => { subthreadAfterClose.current = true; }}>
            New subthread
          </Item>
          <ParentThreadMenu thread={thread} />
          {projectItems ? (
            <ContextMenu.Sub onOpenChange={onOpenChange}>
              <ContextMenu.SubTrigger className="flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent">
                Project
                <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent {...portalScope} aria-label="Project actions" sideOffset={4}
                  className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <ContextMenu.Label className="max-w-64 truncate px-2 py-1 text-xs text-muted-foreground">{project?.name}</ContextMenu.Label>
                  {projectItems}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          ) : null}
          <ProjectPlacementSubmenu thread={thread} homeProjectId={homeProjectId} />
          <Separator />
          <Item icon={thread.isPinned ? "PinOff" : "Pin"} onSelect={() => void togglePin()}>
            {thread.isPinned ? "Unpin" : "Pin"}
          </Item>
          {mute === null ? null : mute.muted ? (
            <Item icon="Notification" onSelect={() => void toggleMute(false)}>Unmute notifications</Item>
          ) : mute.inheritedFrom !== null ? (
            <Item icon="NotificationOff" disabled onSelect={() => {}}>Muted by parent thread</Item>
          ) : (
            <Item icon="NotificationOff" onSelect={() => void toggleMute(true)}>Mute notifications</Item>
          )}
          {onPark ? <Item icon="Car" onSelect={onPark}>Park thread</Item> : null}
          {onResume ? <Item icon="Pulse" onSelect={onResume}>Resume</Item> : null}
          {onSettle ? <Item icon="Meditation" onSelect={onSettle}>Settle</Item> : null}
          {onUnsettle ? <Item icon="Pulse" onSelect={onUnsettle}>Un-settle</Item> : null}
          {canSnooze && onSnooze && snoozePresets.length > 0 ? (
            <SnoozeSubmenu presets={snoozePresets} onSnooze={onSnooze} />
          ) : null}
          {onWake ? <Item icon="Pulse" onSelect={onWake}>Wake now</Item> : null}
          <Separator />
          {onRename ? (
            <Item onSelect={() => { renameAfterClose.current = true; }}>
              Rename
            </Item>
          ) : null}
          <Item disabled={regenerating} onSelect={() => void regenerate()}>
            {regenerating ? "Regenerating title…" : "Regenerate title"}
          </Item>
          <Item
            onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
          >
            {thread.isUnread ? "Mark read" : "Mark unread"}
          </Item>
          <Separator />
          <CopySubmenu thread={thread} homeProjectId={homeProjectId} />
          <Separator />
          <Item
            disabled={!canArchive}
            onSelect={archive}
          >
            Archive
          </Item>
          <Item destructive onSelect={() => setConfirmingDelete(true)}>
            Delete
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    )}
    </ProjectActions>
    <DeleteThreadDialog thread={thread} open={confirmingDelete} onOpenChange={setConfirmingDelete} />
    </>
  );
}

function ProjectPlacementSubmenu({
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
    (left, right) =>
      Number(right.isPersonal) - Number(left.isPersonal) ||
      left.name.localeCompare(right.name),
  );
  const place = async (projectId: string) => {
    try {
      await rpc.call("setThreadProject", {
        threadId: thread.id,
        projectId: projectId === homeProjectId ? null : projectId,
      });
    } catch (error) {
      toast.error("Could not move thread", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none",
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
              title={
                candidate.id === homeProjectId
                  ? "The project this thread was created in"
                  : undefined
              }
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

function CopySubmenu({
  thread,
  homeProjectId,
}: {
  thread: PluginSidebarThread;
  homeProjectId: string;
}) {
  const { projects } = useSidebarThreads();
  const portalScope = usePortalScopeProps();
  const branchName = thread.environment?.branchName;
  const copy = (text: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text);
  };
  const copyThreadLink = async () => {
    const isPersonal = projects.some(
      (project) => project.id === homeProjectId && project.isPersonal,
    );
    const threadPath = `/threads/${encodeURIComponent(thread.id)}`;
    const path = isPersonal
      ? threadPath
      : `/projects/${encodeURIComponent(homeProjectId)}${threadPath}`;
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      toast.success("Thread link copied");
    } catch {
      toast.error("Failed to copy thread link");
    }
  };

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none",
          "data-[state=open]:bg-accent data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        )}
      >
        Copy
        <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...portalScope}
          aria-label="Copy thread data"
          sideOffset={4}
          className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item onSelect={() => void copyThreadLink()}>Copy thread link</Item>
          {branchName ? (
            <Item onSelect={() => copy(branchName)}>
              Copy branch
            </Item>
          ) : null}
          <Item onSelect={() => copy(thread.id)}>Copy thread ID</Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function SnoozeSubmenu({
  presets,
  onSnooze,
}: {
  presets: readonly ConfiguredSnoozePreset[];
  onSnooze: (snoozedUntil: number) => void;
}) {
  const portalScope = usePortalScopeProps();
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
          "data-[state=open]:bg-accent data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        )}
      >
        <Icon name="Clock" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        Snooze
        <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...portalScope}
          aria-label="Snooze times"
          sideOffset={4}
          className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {presets.map((preset) => {
            const wake = resolveConfiguredSnoozePreset(preset);
            return (
              <Item
                key={preset.id}
                disabled={wake === null}
                title={wake === null ? "Today's time has passed" : formatSnoozeWakeTime(wake)}
                onSelect={() => {
                  const selectedWake = resolveConfiguredSnoozePreset(preset);
                  if (selectedWake !== null) onSnooze(selectedWake);
                }}
              >
                {preset.label}
              </Item>
            );
          })}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function Item({
  children,
  icon,
  destructive = false,
  disabled = false,
  title,
  onSelect,
}: {
  children: ReactNode;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      title={title}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        destructive && "text-destructive-text",
      )}
    >
      {icon ? <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      {children}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
