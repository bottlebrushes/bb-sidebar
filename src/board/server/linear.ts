// Linear's GraphQL API, reduced to what the board reads and writes.
import { z } from "zod";
import type { ColumnCategory } from "../contract";
import { CATEGORY_RANK, type StateSpec } from "./store";

const LINEAR_API = "https://api.linear.app/graphql";

const graphqlResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export class LinearNotConfiguredError extends Error {
  constructor() {
    super("Linear API key is not set: bb plugin config bb-sidebar set linearApiKey <key>");
  }
}

export interface LinearClient {
  request<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>;
}

export function createLinearClient(apiKey: () => Promise<string | null>): LinearClient {
  return {
    async request(query, variables, schema) {
      const key = await apiKey();
      if (!key) throw new LinearNotConfiguredError();
      const response = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = graphqlResponseSchema.parse(await response.json());
      if (body.errors?.length) throw new Error(`Linear: ${body.errors[0]!.message}`);
      if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
      return schema.parse(body.data);
    },
  };
}

/** Linear state types the board folds: triage waits like backlog, duplicate ends like canceled. */
const CATEGORY_BY_STATE_TYPE: Record<string, ColumnCategory> = {
  triage: "backlog",
  backlog: "backlog",
  unstarted: "unstarted",
  started: "started",
  completed: "completed",
  canceled: "canceled",
  duplicate: "canceled",
};

const stateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  color: z.string().nullable(),
  position: z.number(),
});
type LinearState = z.infer<typeof stateSchema>;

/** Workflow states as columns: Linear's board order (category, then position). */
export function statesToColumns(states: readonly LinearState[]): StateSpec[] {
  return states
    .map((state) => ({ state, category: CATEGORY_BY_STATE_TYPE[state.type] ?? "backlog" }))
    .sort((left, right) =>
      CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category]
      || left.state.position - right.state.position)
    .map(({ state, category }) => ({
      linearStateId: state.id,
      name: state.name,
      category,
      color: state.color,
    }));
}

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  priority: z.number(),
  sortOrder: z.number(),
  updatedAt: z.string(),
  state: z.object({ id: z.string() }),
  parent: z.object({ id: z.string() }).nullable(),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  relations: z.object({
    nodes: z.array(z.object({ id: z.string(), type: z.string(), relatedIssue: z.object({ id: z.string() }) })),
  }),
  inverseRelations: z.object({
    nodes: z.array(z.object({ id: z.string(), type: z.string(), issue: z.object({ id: z.string() }) })),
  }),
});
export type LinearIssue = z.infer<typeof issueSchema>;

const ISSUE_FIELDS = `id identifier title description url priority sortOrder updatedAt
  state { id } parent { id } assignee { id name }
  relations(first: 50) { nodes { id type relatedIssue { id } } }
  inverseRelations(first: 50) { nodes { id type issue { id } } }`;

/**
 * Duplicate edges of one issue, both directions. Linear stores "A duplicates
 * B" as a relation of type `duplicate` on A pointing at B, the main issue.
 */
export function duplicateEdges(issue: LinearIssue) {
  return [
    ...issue.relations.nodes
      .filter((relation) => relation.type === "duplicate")
      .map((relation) => ({ duplicate: issue.id, main: relation.relatedIssue.id, relationId: relation.id })),
    ...issue.inverseRelations.nodes
      .filter((relation) => relation.type === "duplicate")
      .map((relation) => ({ duplicate: relation.issue.id, main: issue.id, relationId: relation.id })),
  ];
}

/** Blocking edges of one issue, both directions, as `{ blocker, blocked, relationId }` issue ids. */
export function blockingEdges(issue: LinearIssue) {
  return [
    ...issue.relations.nodes
      .filter((relation) => relation.type === "blocks")
      .map((relation) => ({ blocker: issue.id, blocked: relation.relatedIssue.id, relationId: relation.id })),
    ...issue.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks")
      .map((relation) => ({ blocker: relation.issue.id, blocked: issue.id, relationId: relation.id })),
  ];
}

export interface IssueScope {
  teamId: string;
  linearProjectId: string | null;
  assignee: "me" | "anyone";
}

/** Days a completed or canceled issue stays on the board. */
export const FINISHED_ISSUE_DAYS = 14;

/**
 * Every issue in scope: open ones, plus ones finished in the last
 * FINISHED_ISSUE_DAYS. With `updatedAfter`, only issues changed since then
 * (finished ones included, so a card moved to Done in Linear follows).
 */
export async function fetchIssues(
  client: LinearClient,
  scope: IssueScope,
  options: { updatedAfter: string | null; now: number },
): Promise<LinearIssue[]> {
  const filter: Record<string, unknown> = { team: { id: { eq: scope.teamId } } };
  if (scope.linearProjectId) filter.project = { id: { eq: scope.linearProjectId } };
  if (scope.assignee === "me") filter.assignee = { isMe: { eq: true } };
  if (options.updatedAfter) {
    filter.updatedAt = { gt: options.updatedAfter };
  } else {
    const finishedSince = new Date(options.now - FINISHED_ISSUE_DAYS * 86_400_000).toISOString();
    filter.or = [
      { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
      { completedAt: { gt: finishedSince } },
      { canceledAt: { gt: finishedSince } },
    ];
  }
  const pageSchema = z.object({
    issues: z.object({
      nodes: z.array(issueSchema),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  });
  const issues: LinearIssue[] = [];
  let after: string | null = null;
  do {
    const page: z.infer<typeof pageSchema> = await client.request(
      `query($filter: IssueFilter, $after: String) {
        issues(first: 100, after: $after, filter: $filter) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, after },
      pageSchema,
    );
    issues.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

export async function fetchTeam(client: LinearClient, teamId: string) {
  const data = await client.request(
    `query($id: String!) { team(id: $id) { id key name states { nodes { id name type color position } } } }`,
    { id: teamId },
    z.object({
      team: z.object({
        id: z.string(),
        key: z.string(),
        name: z.string(),
        states: z.object({ nodes: z.array(stateSchema) }),
      }),
    }),
  );
  return { ...data.team, columns: statesToColumns(data.team.states.nodes) };
}

export async function fetchTeamsAndProjects(client: LinearClient) {
  const data = await client.request(
    `{ teams(first: 100) { nodes { id key name } }
       projects(first: 250) { nodes { id name state teams { nodes { id } } } } }`,
    {},
    z.object({
      teams: z.object({ nodes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })) }),
      projects: z.object({
        nodes: z.array(z.object({
          id: z.string(),
          name: z.string(),
          state: z.string(),
          teams: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
        })),
      }),
    }),
  );
  return {
    teams: data.teams.nodes,
    projects: data.projects.nodes
      .filter((project) => project.state !== "completed" && project.state !== "canceled")
      .map((project) => ({ id: project.id, name: project.name, teamIds: project.teams.nodes.map((team) => team.id) })),
  };
}

export async function fetchProjectName(client: LinearClient, projectId: string): Promise<string> {
  const data = await client.request(
    `query($id: String!) { project(id: $id) { name } }`,
    { id: projectId },
    z.object({ project: z.object({ name: z.string() }) }),
  );
  return data.project.name;
}

export async function fetchViewer(client: LinearClient): Promise<{ id: string; name: string }> {
  const data = await client.request(
    `{ viewer { id name } }`,
    {},
    z.object({ viewer: z.object({ id: z.string(), name: z.string() }) }),
  );
  return data.viewer;
}

const successSchema = (field: string) => z.object({ [field]: z.object({ success: z.boolean() }) });

export async function updateIssue(client: LinearClient, issueId: string, input: Record<string, unknown>) {
  const data = await client.request(
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: issueId, input },
    successSchema("issueUpdate"),
  );
  if (!data.issueUpdate!.success) throw new Error("Linear rejected the issue update");
}

export async function createIssue(client: LinearClient, input: Record<string, unknown>) {
  const data = await client.request(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url sortOrder } } }`,
    { input },
    z.object({
      issueCreate: z.object({
        success: z.boolean(),
        issue: z.object({ id: z.string(), identifier: z.string(), url: z.string(), sortOrder: z.number() }).nullable(),
      }),
    }),
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("Linear rejected the new issue");
  return data.issueCreate.issue;
}

/** `blocks`: issue blocks related. `duplicate`: issue is a duplicate of related (the main). */
export async function createRelation(
  client: LinearClient,
  type: "blocks" | "duplicate",
  issueId: string,
  relatedIssueId: string,
) {
  const data = await client.request(
    `mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id } } }`,
    { input: { type, issueId, relatedIssueId } },
    z.object({
      issueRelationCreate: z.object({ success: z.boolean(), issueRelation: z.object({ id: z.string() }).nullable() }),
    }),
  );
  if (!data.issueRelationCreate.success || !data.issueRelationCreate.issueRelation) {
    throw new Error("Linear rejected the relation");
  }
  return data.issueRelationCreate.issueRelation.id;
}

export async function deleteRelation(client: LinearClient, relationId: string) {
  const data = await client.request(
    `mutation($id: String!) { issueRelationDelete(id: $id) { success } }`,
    { id: relationId },
    successSchema("issueRelationDelete"),
  );
  if (!data.issueRelationDelete!.success) throw new Error("Linear rejected removing the relation");
}

/** First `<teamKey>-123` in a branch name. */
export function identifierFromBranch(branchName: string, teamKey: string): string | null {
  const key = teamKey.toUpperCase();
  for (const match of branchName.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})(?![0-9])/gu)) {
    if (match[1]!.toUpperCase() === key) return `${key}-${match[2]}`;
  }
  return null;
}
