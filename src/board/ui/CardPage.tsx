// A board card without a thread opens here: its own page
// (`/plugins/bb-sidebar/card/<cardId>`), so bb's back and forward walk
// between cards and threads like any other route. The body is bb's
// new-thread composer, seeded with the card and keeping a draft per card.
// Sending starts the card's thread already linked to the card and its Linear
// issue.
import { useEffect, useState, type ComponentProps } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { boardRpcContract, BoardCard } from "../contract";
import { useBoard } from "./useBoard";

export const CARD_PAGE_PATH = "card";

/**
 * bb's git worktree environment from the project's default branch, the same
 * provider and input bb's own compose screen uses. The pinned SDK typings
 * predate provider environments, so the running bb's shape is cast here.
 */
const CARD_THREAD_ENVIRONMENT = {
  type: "provider",
  environmentProviderId: "git-worktree",
  inputs: { branch: { kind: "default" } },
} as unknown as NonNullable<ComponentProps<typeof NewThreadComposer>["defaultEnvironment"]>;

function useCard(cardId: string): { card: BoardCard | null; loaded: boolean } {
  const { snapshot } = useBoard();
  return {
    card: snapshot?.cards.find((candidate) => candidate.id === cardId) ?? null,
    loaded: snapshot !== null,
  };
}

/**
 * Where the Linear Card plugin puts its header chip for this card's issue.
 * Its app portals the chip into any element carrying `data-linear-card-draft`
 * (the issue) and `data-project-id`; without that plugin this stays empty.
 */
export function CardPageHeader({ subPath }: PluginNavPanelProps) {
  const { card } = useCard(subPath);
  if (!card?.linear) return null;
  return <span className="contents" data-linear-card-draft={card.linear.identifier} data-project-id={card.projectId} />;
}

export function CardPage({ subPath }: PluginNavPanelProps) {
  const { card, loaded } = useCard(subPath);
  const navigate = useBbNavigate();
  if (!card) {
    return (
      <p role="status" className="px-6 py-10 text-center text-sm text-muted-foreground">
        {loaded ? "This card is no longer on the board." : "Loading card…"}
      </p>
    );
  }
  // Reached by going back after the thread started: no redirect, so back keeps working.
  if (card.threadId) {
    const threadId = card.threadId;
    return (
      <p className="px-6 py-10 text-center text-sm text-muted-foreground">
        This card's thread has started.{" "}
        <button type="button" className="text-foreground underline" onClick={() => navigate.toThread(threadId)}>
          Open it
        </button>
      </p>
    );
  }
  return <CardComposer key={card.id} card={card} />;
}

function CardComposer({ card }: { card: BoardCard }) {
  const rpc = useRpc<typeof boardRpcContract>();
  const navigate = useBbNavigate();
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("cardThreadPrompt", { cardId: card.id }).then(
      (result) => live && setPrompt(result.prompt),
      (error: unknown) => toast.error("Could not load the card", { description: error instanceof Error ? error.message : undefined }),
    );
    return () => {
      live = false;
    };
  }, [rpc, card.id]);

  const submit = async (request: NewThreadRequest) => {
    try {
      const { threadId } = await rpc.call("startCardThread", { cardId: card.id, request });
      navigate.toThread(threadId);
    } catch (error) {
      toast.error("Could not start the card's thread", { description: error instanceof Error ? error.message : undefined });
      // Rethrown so the composer keeps the draft.
      throw error;
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-6 py-6">
      {prompt === null ? null : (
        <NewThreadComposer
          defaultProjectId={card.projectId}
          // Unseeded, this composer picks the shared project checkout, so two
          // card threads fight over one directory ("Workspace is being
          // prepared by another thread"). Each card thread gets its own
          // worktree from the default branch, like bb's own compose screen.
          defaultEnvironment={CARD_THREAD_ENVIRONMENT}
          initialPrompt={prompt}
          draftKey={`board-card:${card.id}`}
          focusRequest={1}
          className="min-h-0 flex-1"
          onSubmit={submit}
        />
      )}
    </div>
  );
}
