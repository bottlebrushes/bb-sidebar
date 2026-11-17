// Pulls one linked project's Linear issues into the board.
//
// Incremental pulls ask only for issues changed since the cursor (the newest
// `updatedAt` seen). Linear does not bump an issue when it leaves the scope
// (reassigned, moved team) or when a relation is removed, so a full pull runs
// every FULL_SYNC_MS: it refreshes the team's workflow states, re-reads every
// issue in scope, and drops cards whose issue is gone.
import { blockingEdges, duplicateEdges, fetchIssues, fetchTeam, type LinearClient, type LinearIssue } from "./linear";
import type { BoardStore, CardRow, ColumnRow, ProjectRow } from "./store";

export const FULL_SYNC_MS = 5 * 60_000;

export interface SyncResult {
  full: boolean;
  applied: number;
  removed: number;
}

export async function syncLinkedProject(
  store: BoardStore,
  client: LinearClient,
  project: ProjectRow,
  options: {
    now: number;
    forceFull?: boolean;
    onColumnChange?: (change: { card: CardRow; from: ColumnRow; to: ColumnRow }) => void;
  },
): Promise<SyncResult> {
  const teamId = project.linear_team_id;
  if (!teamId) return { full: false, applied: 0, removed: 0 };
  const full = options.forceFull === true
    || project.sync_cursor === null
    || project.last_full_sync_at === null
    || options.now - project.last_full_sync_at >= FULL_SYNC_MS;
  try {
    if (full) store.syncStateColumns(project.project_id, (await fetchTeam(client, teamId)).columns);
    const issues = await fetchIssues(
      client,
      { teamId, linearProjectId: project.linear_project_id, assignee: project.assignee_scope },
      { updatedAfter: full ? null : project.sync_cursor, now: options.now },
    );
    const removed = applyIssues(store, project.project_id, issues, full, options.onColumnChange);
    const newest = issues.reduce<string | null>(
      (latest, issue) => (latest === null || issue.updatedAt > latest ? issue.updatedAt : latest),
      project.sync_cursor,
    );
    store.recordSync(project.project_id, {
      cursor: newest,
      ...(full ? { fullSyncAt: options.now } : {}),
      error: null,
    });
    return { full, applied: issues.length, removed };
  } catch (error) {
    store.recordSync(project.project_id, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Upsert cards, then parents and relations (both need every card to exist first). */
export function applyIssues(
  store: BoardStore,
  projectId: string,
  issues: readonly LinearIssue[],
  full: boolean,
  onColumnChange?: (change: { card: CardRow; from: ColumnRow; to: ColumnRow }) => void,
): number {
  let removed = 0;
  const changes: Array<{ card: CardRow; from: ColumnRow; to: ColumnRow }> = [];
  store.db.transaction(() => {
    const cardOfIssue = new Map<string, string>();
    for (const issue of issues) {
      const existing = store.cardByIssue(issue.id);
      const from = existing ? store.column(existing.column_id) : undefined;
      const card = store.upsertIssue(projectId, {
        linearIssueId: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        title: issue.title,
        description: issue.description ?? "",
        linearStateId: issue.state.id,
        position: issue.sortOrder,
        priority: issue.priority,
        linearProject: issue.project,
        assignee: issue.assignee,
      }, Date.parse(issue.updatedAt));
      if (card) {
        cardOfIssue.set(issue.id, card.id);
        if (from && from.id !== card.column_id) changes.push({ card, from, to: store.column(card.column_id) });
      }
    }
    const cardIdFor = (issueId: string) => cardOfIssue.get(issueId) ?? store.cardByIssue(issueId)?.id;
    // Each relation is listed on both issues; collect the batch first so one
    // issue's partial list cannot erase an edge the other issue reported.
    const edges = new Map<string, { blockerCardId: string; blockedCardId: string; linearRelationId: string }>();
    for (const issue of issues) {
      for (const edge of blockingEdges(issue)) {
        const blockerCardId = cardIdFor(edge.blocker);
        const blockedCardId = cardIdFor(edge.blocked);
        if (blockerCardId && blockedCardId) edges.set(edge.relationId, { blockerCardId, blockedCardId, linearRelationId: edge.relationId });
      }
    }
    const duplicates = new Map<string, { duplicateCardId: string; mainCardId: string; linearRelationId: string }>();
    for (const issue of issues) {
      for (const edge of duplicateEdges(issue)) {
        const duplicateCardId = cardIdFor(edge.duplicate);
        const mainCardId = cardIdFor(edge.main);
        if (duplicateCardId && mainCardId) duplicates.set(edge.relationId, { duplicateCardId, mainCardId, linearRelationId: edge.relationId });
      }
    }
    for (const issue of issues) {
      const cardId = cardOfIssue.get(issue.id);
      if (!cardId) continue;
      store.setParentFromLinear(cardId, issue.parent?.id ?? null);
      store.replaceLinearRelations(cardId, [...edges.values()].filter((edge) =>
        edge.blockerCardId === cardId || edge.blockedCardId === cardId));
      store.replaceLinearDuplicates(cardId, [...duplicates.values()].filter((edge) =>
        edge.duplicateCardId === cardId || edge.mainCardId === cardId));
    }
    if (full) removed = store.pruneIssues(projectId, new Set(issues.map((issue) => issue.id)));
  })();
  for (const change of changes) onColumnChange?.(change);
  return removed;
}
