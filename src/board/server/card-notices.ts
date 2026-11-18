// What the board tells a card's thread, and the archive of a shipped card's
// thread.
//
// A notice to a working thread queues behind its turn, and bb can hold a
// queued message for days: a manual stop pauses the queue, and an archived
// thread or an offline host never drains it. Delivered that late, a notice
// states a column the card left long ago ("moved from QA to Done", "shipped.
// This thread is archived now."). So the board withdraws its still-queued
// notices to a thread when the card moves again, when the thread is archived,
// and when the card leaves the thread. A move into a shipped column is
// announced, and the thread archived, only after Linear confirms the issue is
// in a shipped state right then.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fetchIssueStateId, type LinearClient } from "./linear";
import type { BoardStore, CardRow, ColumnRow } from "./store";

/** How every board notice to a thread starts; only these are ever withdrawn. */
const NOTICE_PREFIXES = ["[board] ", "[bb board] "];

type BoardThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

const isThreadWorking = (thread: BoardThread) =>
  thread.status === "active" ||
  thread.status === "pending" ||
  thread.status === "starting" ||
  thread.status === "stopping" ||
  ("hasPendingInteraction" in thread && thread.hasPendingInteraction) ||
  !["idle", "error"].includes(thread.runtime.displayStatus);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCardNotices(bb: BbPluginApi, store: BoardStore, linear: LinearClient) {
  /** Queue a notice behind the thread's running turn, or start a turn. */
  async function sendNotice(threadId: string, text: string) {
    await bb.sdk.threads.send({
      threadId,
      input: [{ type: "text", text, mentions: [] }],
      mode: "queue-if-active",
    });
  }

  /** Delete this plugin's board notices still waiting in the thread's queue. */
  async function withdrawNotices(threadId: string) {
    try {
      for (const message of await bb.sdk.threads.queuedMessages.list({ threadId })) {
        if (message.originPluginId !== bb.pluginId) continue;
        const first = message.content[0];
        const text = first?.type === "text" ? first.text : "";
        if (!NOTICE_PREFIXES.some((prefix) => text.startsWith(prefix))) continue;
        try {
          await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: message.id });
        } catch (error) {
          bb.log.warn(`withdrawing board notice ${message.id} queued for ${threadId} failed: ${errorText(error)}`);
        }
      }
    } catch (error) {
      bb.log.warn(`reading the queue of ${threadId} to withdraw board notices failed: ${errorText(error)}`);
    }
  }

  /**
   * Whether Linear has the card's issue in a shipped state now. A card without
   * a Linear issue has only the board's column. A failed read is not a yes.
   */
  async function linearShipped(card: CardRow): Promise<boolean> {
    if (!card.linear_issue_id) return true;
    const identifier = card.linear_identifier ?? card.id;
    try {
      const stateId = await fetchIssueStateId(linear, card.linear_issue_id);
      if (store.shippedStateIds(card.project_id).includes(stateId)) return true;
      bb.log.warn(`board has ${identifier} in a shipped column but Linear does not; its thread stays open`);
    } catch (error) {
      bb.log.warn(`checking ${identifier} in Linear before archiving its thread failed: ${errorText(error)}`);
    }
    return false;
  }

  /**
   * Tell a shipped card's thread once, then archive it when it is not working
   * (thread.idle retries). `confirmed` skips the Linear read the caller just made.
   */
  async function archiveShippedCard(card: CardRow, thread?: BoardThread, confirmed = false) {
    const threadId = card.thread_id;
    if (!threadId) return;
    const current = thread ?? (await bb.sdk.threads.get({ threadId }));
    if (current.archivedAt !== null) {
      store.clearPendingArchive(card.id);
      return;
    }
    if (!confirmed && !(await linearShipped(card))) {
      store.clearPendingArchive(card.id);
      await withdrawNotices(threadId);
      return;
    }
    store.ensurePendingArchive(card.id, threadId);
    const pending = store.pendingArchive(card.id);
    if (pending?.notified_at === null) {
      const column = store.column(card.column_id);
      const identifier = card.linear_identifier ?? card.id;
      try {
        await sendNotice(threadId, `[board] ${identifier} is in ${column.name}: shipped. This thread is archived now.`);
        store.markArchiveNotified(card.id);
      } catch (error) {
        bb.log.warn(`telling ${threadId} about shipped ${identifier} failed: ${errorText(error)}`);
      }
    }
    const latest = await bb.sdk.threads.get({ threadId }).catch(() => current);
    if (isThreadWorking(latest)) return;
    if (store.pendingArchive(card.id)?.requested_at !== null) return;
    try {
      await bb.sdk.threads.archive({ threadId });
      store.markArchiveRequested(card.id);
    } catch (error) {
      bb.log.warn(`archiving shipped thread ${threadId} failed: ${errorText(error)}`);
    }
  }

  async function notifyCardMove(card: CardRow, from: ColumnRow, to: ColumnRow, byThreadId: string | null = null) {
    if (from.id === to.id || !card.thread_id) return;
    const threadId = card.thread_id;
    await withdrawNotices(threadId);
    let thread: BoardThread;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      return;
    }
    if (thread.archivedAt !== null) return;
    const shipped = store.isShipped(card.project_id, to);
    if (shipped && !(await linearShipped(card))) {
      store.clearPendingArchive(card.id);
      return;
    }
    const identifier = card.linear_identifier ?? card.id;
    if (byThreadId !== threadId) {
      const url = card.linear_url ? `\n${card.linear_url}` : "";
      try {
        await sendNotice(
          threadId,
          `[board] ${identifier} "${card.title}" moved from ${from.name} to ${to.name}.${url}`,
        );
      } catch (error) {
        bb.log.warn(`telling ${threadId} about ${identifier} moving failed: ${errorText(error)}`);
      }
    }
    if (shipped) {
      await archiveShippedCard(card, thread, true);
    } else {
      store.clearPendingArchive(card.id);
    }
  }

  async function archiveShippedCards(projectId: string) {
    for (const card of store.projectCards(projectId)) {
      const column = store.column(card.column_id);
      if (store.isShipped(projectId, column) && card.thread_id) await archiveShippedCard(card);
    }
  }

  return { sendNotice, withdrawNotices, archiveShippedCard, notifyCardMove, archiveShippedCards };
}
