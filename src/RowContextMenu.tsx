import { useThreadActions, useSidebarThreads } from "./bb-sdk";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useBbNavigate, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { errorDetail, toast } from "./lib/toast";
import type { bbSidebarRpcContract } from "./contract";
import { ParentThreadMenu } from "./ParentThreadMenu";
import { notifiesParent, ParentNotificationsMenu } from "./ParentNotificationsMenu";
import { DeleteThreadDialog } from "./DeleteThreadDialog";
import { SnoozePickerDialog } from "./SnoozePickerDialog";
import { Icon } from "./components/Icon";
import { Item, Separator } from "./components/MenuItem";
import { ProjectPlacementSubmenu } from "./ProjectPlacementSubmenu";
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
import { openSubthreadComposer } from "./useSubthreadComposer";

// Mute state is owned by the Chime (Notifications & Sounds) plugin. Muting a
// thread silences it and every descendant; the item is hidden when Chime is
// not installed.
const CHIME_HTTP = "/api/v1/plugins/chime/http";
const MUTE_CHANGED_EVENT = "chime:thread-mute-changed";

type MuteState = { muted: boolean; inheritedFrom: string | null };

type RowContextMenuProps = {
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
};

/** Keep the plugin's menus, but build their actions and dialogs only on first open. */
export function RowContextMenu({ children, ...props }: RowContextMenuProps) {
  const [activated, setActivated] = useState(false);
  // Counts opens so the menu re-reads state another plugin owns each time.
  const [openCount, setOpenCount] = useState(0);
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (!open) return;
        setActivated(true);
        setOpenCount((count) => count + 1);
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      {activated ? <RowMenuContents {...props} openCount={openCount} /> : null}
    </ContextMenu.Root>
  );
}

function RowMenuContents({
  thread,
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
  openCount,
}: Omit<RowContextMenuProps, "children"> & { openCount: number }) {
  const { projects, threads } = useSidebarThreads();
  // The sidebar may file a thread under another project; bb still owns the
  // one it was created in, which its own actions (links, routes) use.
  const hostThread = threads.find((candidate) => candidate.id === thread.id) ?? thread;
  const actions = useThreadActions(hostThread, {
    keys: [
      "bb--core/split",
      "bb--core/copyLink",
      "bb--core/pin",
      "bb--core/read",
      "bb--core/rename",
      "bb--core/archive",
    ],
    requestRename: () => onRename?.(),
  });
  const navigate = useBbNavigate();
  // bb 0.46 always supplies pin/read/rename/archive for sidebar rows, and bb
  // 0.49 copyLink. Split is omitted in compact mode and for the focused pane;
  // navigation handles both.
  const run = (key: string) => {
    const entry = actions.find((entry) => entry.key === `bb--core/${key}`);
    if (!entry && key === "split") return navigate.toThread(thread.id, { split: true });
    return entry?.action.run();
  };
  const project = projects.find((project) => project.id === thread.projectId);
  const portalScope = usePortalScopeProps();
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const regenerating = useTitleGenerating(thread.id);
  const renameAfterClose = useRef(false);
  const subthreadAfterClose = useRef(false);
  const [mute, setMute] = useState<MuteState | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMute(null);
    void fetch(`${CHIME_HTTP}/thread-mute?threadId=${encodeURIComponent(thread.id)}`)
      .then((response) => (response.ok ? (response.json() as Promise<MuteState>) : null))
      .then(
        (state) => {
          if (!cancelled) setMute(state);
        },
        () => {
          if (!cancelled) setMute(null);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [openCount, thread.id]);
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
      toast.error(muted ? "Could not mute thread" : "Could not unmute thread", { description: errorDetail(error) });
    }
  };
  // Outlives the portaled submenu, which unmounts when a choice closes the menu.
  const pendingNotificationSave = useRef<Promise<void> | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pickingSnooze, setPickingSnooze] = useState(false);
  // Archive takes the children with it, and bb leaves every idle one's agent
  // session loaded. Release them alongside the archive. Working children are
  // skipped, so this never interrupts a turn archive itself would not.
  const archive = () => {
    void run("archive");
    const threadIds = [
      thread.id,
      ...threads.filter((child) => child.parentThreadId === thread.id && canParkThread(child)).map((child) => child.id),
    ];
    void rpc.call("releaseRuntimes", { threadIds }).catch(() => {
      void 0; // A missed release costs memory, not correctness.
    });
  };
  const regenerate = async () => {
    if (!beginTitleGeneration(thread.id)) return;
    try {
      const { changed } = await rpc.call("regenerateTitle", { threadId: thread.id });
      toast.success(changed ? "Thread title regenerated" : "The current title still fits");
    } catch (error) {
      toast.error("Could not regenerate title", { description: errorDetail(error) });
    } finally {
      finishTitleGeneration(thread.id);
    }
  };
  const hasPinLifecycleItems = !!(
    thread.isPinned ||
    thread.parentThreadId == null ||
    onPark ||
    onResume ||
    onSettle ||
    onUnsettle ||
    onWake ||
    (canSnooze && onSnooze && snoozePresets.length > 0)
  );
  const togglePin = async () => {
    if (thread.isPinned) {
      await run("pin");
      return;
    }
    if (thread.parentThreadId != null) return;
    try {
      await rpc.call("pin", { threadId: thread.id });
    } catch (error) {
      toast.error("Could not pin thread", { description: errorDetail(error) });
    }
  };

  return (
    <>
      <ProjectActions project={project}>
        {({ items: projectItems, onOpenChange, onCloseAutoFocus }) => (
          <ContextMenu.Portal>
            <ContextMenu.Content
              {...portalScope}
              aria-label="Thread actions"
              onCloseAutoFocus={(event) => {
                onCloseAutoFocus?.(event);
                // A dialog takes focus next; do not pull it back to the row.
                if (confirmingDelete || pickingSnooze) event.preventDefault();
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
                void run("rename");
              }}
              className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <Item onSelect={() => void run("split")}>Open in split</Item>
              <Item
                onSelect={() => {
                  subthreadAfterClose.current = true;
                }}
              >
                New subthread
              </Item>
              <ParentThreadMenu thread={thread} />
              {notifiesParent(thread) ? (
                <ParentNotificationsMenu thread={thread} pendingSave={pendingNotificationSave} />
              ) : null}
              {projectItems ? (
                <ContextMenu.Sub onOpenChange={onOpenChange}>
                  <ContextMenu.SubTrigger className="flex cursor-pointer items-center rounded-md px-2 py-[0.3125rem] text-xs outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent">
                    Project
                    <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
                  </ContextMenu.SubTrigger>
                  <ContextMenu.Portal>
                    <ContextMenu.SubContent
                      {...portalScope}
                      aria-label="Project actions"
                      sideOffset={4}
                      className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
                    >
                      <ContextMenu.Label className="max-w-64 truncate px-2 py-1 text-xs text-muted-foreground">
                        {project?.name}
                      </ContextMenu.Label>
                      {projectItems}
                    </ContextMenu.SubContent>
                  </ContextMenu.Portal>
                </ContextMenu.Sub>
              ) : null}
              <ProjectPlacementSubmenu thread={thread} homeProjectId={hostThread.projectId} />
              {hasPinLifecycleItems ? <Separator /> : null}
              {thread.isPinned || thread.parentThreadId == null ? (
                <Item icon={thread.isPinned ? "PinOff" : "Pin"} onSelect={() => void togglePin()}>
                  {thread.isPinned ? "Unpin" : "Pin"}
                </Item>
              ) : null}
              {mute === null ? null : mute.muted ? (
                <Item icon="Notification" onSelect={() => void toggleMute(false)}>
                  Unmute notifications
                </Item>
              ) : mute.inheritedFrom !== null ? (
                <Item icon="NotificationOff" disabled onSelect={() => {}}>
                  Muted by parent thread
                </Item>
              ) : (
                <Item icon="NotificationOff" onSelect={() => void toggleMute(true)}>
                  Mute notifications
                </Item>
              )}
              {canSnooze && onSnooze && snoozePresets.length > 0 ? (
                <SnoozeSubmenu presets={snoozePresets} onSnooze={onSnooze} onPick={() => setPickingSnooze(true)} />
              ) : null}
              {onWake ? (
                <Item icon="Pulse" onSelect={onWake}>
                  Wake now
                </Item>
              ) : null}
              {onPark ? (
                <Item icon="Car" onSelect={onPark}>
                  Park thread
                </Item>
              ) : null}
              {onResume ? (
                <Item icon="Pulse" onSelect={onResume}>
                  Resume
                </Item>
              ) : null}
              {onSettle ? (
                <Item icon="Meditation" onSelect={onSettle}>
                  Settle
                </Item>
              ) : null}
              {onUnsettle ? (
                <Item icon="Pulse" onSelect={onUnsettle}>
                  Un-settle
                </Item>
              ) : null}
              <Separator />
              {onRename ? (
                <Item
                  onSelect={() => {
                    renameAfterClose.current = true;
                  }}
                >
                  Rename
                </Item>
              ) : null}
              <Item disabled={regenerating} onSelect={() => void regenerate()}>
                {regenerating ? "Regenerating title…" : "Regenerate title"}
              </Item>
              <Item onSelect={() => void run("read")}>{thread.isUnread ? "Mark read" : "Mark unread"}</Item>
              <Separator />
              <CopySubmenu thread={thread} onCopyLink={() => void run("copyLink")} />
              <Separator />
              <Item disabled={!canArchive} onSelect={archive}>
                Archive
              </Item>
              <Item destructive onSelect={() => setConfirmingDelete(true)}>
                Delete
              </Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        )}
      </ProjectActions>
      <DeleteThreadDialog thread={thread} open={confirmingDelete} onOpenChange={setConfirmingDelete} />
      {onSnooze ? (
        <SnoozePickerDialog open={pickingSnooze} onOpenChange={setPickingSnooze} onSnooze={onSnooze} />
      ) : null}
    </>
  );
}

/** Copy thread link is bb's own Copy link action: same URL, toasts and errors. */
function CopySubmenu({ thread, onCopyLink }: { thread: PluginSidebarThread; onCopyLink: () => void }) {
  const portalScope = usePortalScopeProps();
  const branchName = thread.environment?.branchName;
  const copy = (text: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text);
  };

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center rounded-md px-2 py-[0.3125rem] text-xs outline-none",
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
          <Item onSelect={onCopyLink}>Copy thread link</Item>
          {branchName ? <Item onSelect={() => copy(branchName)}>Copy branch</Item> : null}
          <Item onSelect={() => copy(thread.id)}>Copy thread ID</Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function SnoozeSubmenu({
  presets,
  onSnooze,
  onPick,
}: {
  presets: readonly ConfiguredSnoozePreset[];
  onSnooze: (snoozedUntil: number) => void;
  onPick: () => void;
}) {
  const portalScope = usePortalScopeProps();
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md px-2 py-[0.3125rem] text-xs outline-none",
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
          <Separator />
          <Item icon="Calendar" onSelect={onPick}>
            Pick date & time…
          </Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
