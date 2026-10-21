import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import { threadDisplayTitle } from "./inbox";
import { usePortalScopeProps } from "./lib/portal-scope";
import { closeSubthreadComposer, useSubthreadComposerTarget } from "./subthread-composer-state";

type SubthreadDefaults = {
  model: string;
  reasoningLevel: NewThreadRequest["reasoningLevel"];
  serviceTier: NonNullable<NewThreadRequest["serviceTier"]>;
  permissionMode: NewThreadRequest["permissionMode"];
};

/**
 * bb's own new-thread composer, filed under a parent thread. Opened from a
 * row's right-click menu or the "New subthread" command, both of which only
 * name the parent; this window-wide overlay owns the dialog.
 *
 * The composer has no parent prop, so the plugin adds `parentThreadId` when it
 * spawns. Its pickers start from the parent's provider, model, permission mode
 * and environment, so the child runs where the parent does unless changed.
 */
export function SubthreadComposer() {
  const parentThreadId = useSubthreadComposerTarget();
  const { status, threads, projects } = useSidebarThreads();
  const portalScope = usePortalScopeProps();
  const parent = parentThreadId === null
    ? undefined
    : threads.find((thread) => thread.id === parentThreadId);

  // A parent that is gone (archived, deleted, or never in the list) has
  // nothing to file under.
  useEffect(() => {
    if (parentThreadId === null || status !== "ready" || parent) return;
    closeSubthreadComposer();
    toast.error("Could not start a subthread", {
      description: "That thread is not in the sidebar.",
    });
  }, [parent, parentThreadId, status]);

  const project = parent ? projects.find((candidate) => candidate.id === parent.projectId) : undefined;
  const projectName = project && !project.isPersonal ? project.name : "Personal";

  return (
    <Dialog.Root open={parent !== undefined} onOpenChange={(open) => { if (!open) closeSubthreadComposer(); }}>
      <Dialog.Portal>
        <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...portalScope}
          aria-describedby={undefined}
          // The composer focuses its own editor; Radix would pick the first button.
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="fixed left-1/2 top-[12vh] z-50 box-border flex max-h-[76vh] w-[calc(100%_-_2rem)] max-w-2xl -translate-x-1/2 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
        >
          {parent ? (
            <>
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-semibold leading-5">New subthread</Dialog.Title>
                <div className="truncate text-xs text-muted-foreground" title={threadDisplayTitle(parent)}>
                  Under <span className="text-foreground">{threadDisplayTitle(parent)}</span>
                  {" · "}
                  {projectName}
                </div>
              </div>
              <SubthreadComposerBody key={parent.id} parent={parent} />
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SubthreadComposerBody({ parent }: { parent: PluginSidebarThread }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const navigate = useBbNavigate();
  // Seeds re-seed every picker when they change, so mount the composer only
  // once the parent's settings are known.
  const [defaults, setDefaults] = useState<SubthreadDefaults | null | "loading">("loading");
  const [focusRequest] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    rpc.call("getSubthreadDefaults", { threadId: parent.id }).then(
      (result) => { if (!cancelled) setDefaults(result); },
      // Without them the composer falls back to the project's defaults.
      () => { if (!cancelled) setDefaults(null); },
    );
    return () => {
      cancelled = true;
    };
  }, [parent.id, rpc]);

  if (defaults === "loading") {
    return <div className="h-28 animate-pulse rounded-lg bg-muted" aria-label="Loading composer" />;
  }

  const submit = async (request: NewThreadRequest) => {
    try {
      const { threadId } = await rpc.call("createSubthread", { parentThreadId: parent.id, request });
      // Navigate while this component is still mounted, then close; the new
      // thread may not be in the sidebar list yet, which `actions.open` needs.
      navigate.toThread(threadId);
      closeSubthreadComposer();
    } catch (error) {
      toast.error("Could not start subthread", {
        description: error instanceof Error ? error.message : undefined,
      });
      // Rethrow so the composer keeps the draft.
      throw error;
    }
  };

  return (
    <NewThreadComposer
      layout="document"
      draftKey={`bb-sidebar:subthread:${parent.id}`}
      focusRequest={focusRequest}
      placeholder="What should the subthread do?"
      defaultProjectId={parent.projectId}
      defaultProviderId={parent.providerId}
      {...(defaults
        ? {
          defaultModel: defaults.model,
          defaultReasoningLevel: defaults.reasoningLevel,
          defaultServiceTier: defaults.serviceTier,
          defaultPermissionMode: defaults.permissionMode,
        }
        : {})}
      {...(parent.environment?.id
        ? { defaultEnvironment: { type: "reuse" as const, environmentId: parent.environment.id } }
        : {})}
      onSubmit={submit}
    />
  );
}
