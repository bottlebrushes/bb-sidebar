import { useEffect, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "../../components/Icon";
import type { BoardColumn, BoardProject, boardRpcContract } from "../contract";
import { COLUMN_CATEGORIES, type ColumnCategory } from "../model";
import { useBoard } from "./useBoard";

const selectClass =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50";
const buttonClass =
  "inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50";
const primaryClass =
  "inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";

const CATEGORY_LABELS: Record<ColumnCategory, string> = {
  backlog: "Backlog",
  unstarted: "Not started",
  started: "In progress",
  completed: "Done",
  canceled: "Canceled",
};

interface LinearOptions {
  teams: Array<{ id: string; key: string; name: string }>;
  projects: Array<{ id: string; name: string; teamIds: string[] }>;
}

/** Settings → BB Sidebar → Board: each project's Linear link or local columns. */
export function BoardSettings() {
  const { projects } = useSidebarThreads();
  const { snapshot, error } = useBoard();
  const rpc = useRpc<typeof boardRpcContract>();
  const [linear, setLinear] = useState<LinearOptions | null>(null);
  const [linearError, setLinearError] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot?.linearConfigured || linear) return;
    rpc.call("listLinearTeams", {}).then(setLinear, (caught: unknown) =>
      setLinearError(caught instanceof Error ? caught.message : String(caught)));
  }, [linear, rpc, snapshot?.linearConfigured]);

  return (
    <section aria-labelledby="settings-board">
      <div className="mb-3">
        <h2 id="settings-board" className="text-sm font-semibold text-foreground">Board</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Drag the sidebar wider than its usual maximum to see the board. Each project has its own columns:
          local ones you edit here, or a Linear team's workflow, synced both ways.
        </p>
        {snapshot && !snapshot.linearConfigured ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Linear sync needs an API key: <code className="rounded bg-muted px-1">bb plugin config bb-sidebar set linearApiKey &lt;key&gt;</code>
          </p>
        ) : null}
        {linearError ? <p className="mt-1 text-xs text-destructive-text">Linear: {linearError}</p> : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {!snapshot ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{error ?? "Loading…"}</p>
        ) : projects.map((project) => {
          const boardProject = snapshot.projects.find((candidate) => candidate.projectId === project.id);
          return (
            <ProjectBoardRow
              key={project.id}
              name={project.isPersonal ? "Personal" : project.name}
              projectId={project.id}
              boardProject={boardProject ?? null}
              columns={snapshot.columns.filter((column) => column.projectId === project.id)}
              linear={snapshot.linearConfigured ? linear : null}
            />
          );
        })}
      </div>
    </section>
  );
}

function ProjectBoardRow({ name, projectId, boardProject, columns, linear }: {
  name: string;
  projectId: string;
  boardProject: BoardProject | null;
  columns: BoardColumn[];
  linear: LinearOptions | null;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const [busy, setBusy] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [linearProjectId, setLinearProjectId] = useState("");
  const [assignee, setAssignee] = useState<"me" | "anyone">("me");
  const [editing, setEditing] = useState(false);
  const link = boardProject?.linear ?? null;

  const act = async (label: string, work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      toast.error(label, { description: caught instanceof Error ? caught.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</p>
        {link ? (
          <>
            <span className="text-xs text-muted-foreground">
              Linear {link.teamKey}{link.linearProjectName ? ` / ${link.linearProjectName}` : ""} · {link.assignee === "me" ? "my issues" : "all issues"}
            </span>
            <button type="button" disabled={busy} className={buttonClass}
              onClick={() => void act("Linear sync failed", () => rpc.call("syncNow", { projectId }))}>
              <Icon name="Refresh" className="size-3.5" /> Sync now
            </button>
            <button type="button" disabled={busy} className={buttonClass}
              onClick={() => void act("Could not unlink", () => rpc.call("setProjectLinear", { projectId, linear: null }))}>
              Unlink
            </button>
          </>
        ) : linear ? (
          <>
            <select aria-label={`Linear team for ${name}`} value={teamId} disabled={busy} className={selectClass}
              onChange={(event) => {
                setTeamId(event.target.value);
                setLinearProjectId("");
              }}>
              <option value="">Linear team…</option>
              {linear.teams.map((team) => <option key={team.id} value={team.id}>{team.key} · {team.name}</option>)}
            </select>
            {teamId ? (
              <>
                <select aria-label={`Linear project for ${name}`} value={linearProjectId} disabled={busy} className={selectClass}
                  onChange={(event) => setLinearProjectId(event.target.value)}>
                  <option value="">Whole team</option>
                  {linear.projects.filter((candidate) => candidate.teamIds.includes(teamId))
                    .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                </select>
                <select aria-label={`Linear issues for ${name}`} value={assignee} disabled={busy} className={selectClass}
                  onChange={(event) => setAssignee(event.target.value === "anyone" ? "anyone" : "me")}>
                  <option value="me">My issues</option>
                  <option value="anyone">All issues</option>
                </select>
                <button type="button" disabled={busy} className={primaryClass}
                  onClick={() => void act("Could not link to Linear", () => rpc.call("setProjectLinear", {
                    projectId,
                    linear: { teamId, linearProjectId: linearProjectId || null, assignee },
                  }))}>
                  {busy ? "Linking…" : "Link"}
                </button>
              </>
            ) : null}
          </>
        ) : null}
        <button type="button" className={buttonClass} aria-expanded={editing} onClick={() => setEditing((open) => !open)}>
          Columns
        </button>
      </div>
      {editing ? (
        link
          ? <>
              <ColumnOrderEditor projectId={projectId} columns={columns} onDone={() => setEditing(false)} />
              <ShippedColumnsEditor
                projectId={projectId}
                columns={columns}
                shippedStateIds={boardProject?.shippedStateIds ?? null}
              />
            </>
          : <ColumnEditor projectId={projectId} columns={columns} onDone={() => setEditing(false)} />
        ) : link ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {boardProject?.syncError
            ? <span className="text-destructive-text">Sync failed: {boardProject.syncError}</span>
            : boardProject?.lastSyncedAt
              ? `Last synced ${new Date(boardProject.lastSyncedAt).toLocaleTimeString()}`
              : "Not synced yet"}
          {" · "}
          {columns.map((column) => column.name).join(", ")}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{columns.map((column) => column.name).join(", ")}</p>
      )}
    </div>
  );
}

function ColumnEditor({ projectId, columns, onDone }: {
  projectId: string;
  columns: BoardColumn[];
  onDone(): void;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const [draft, setDraft] = useState<Array<{ id?: string; name: string; category: ColumnCategory }>>(
    () => columns.map((column) => ({ id: column.id, name: column.name, category: column.category })),
  );
  const [saving, setSaving] = useState(false);
  const update = (index: number, change: Partial<(typeof draft)[number]>) =>
    setDraft((rows) => rows.map((row, position) => (position === index ? { ...row, ...change } : row)));
  const move = (index: number, offset: number) =>
    setDraft((rows) => {
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(index + offset, 0, row!);
      return next;
    });
  const valid = draft.length > 0 && draft.every((row) => row.name.trim() !== "");

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {draft.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="flex items-center gap-1.5">
          <input
            aria-label={`Column ${index + 1} name`}
            value={row.name}
            onChange={(event) => update(index, { name: event.target.value })}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          />
          <select aria-label={`Column ${index + 1} kind`} value={row.category} className={selectClass}
            onChange={(event) => {
              const category = COLUMN_CATEGORIES.find((candidate) => candidate === event.target.value);
              if (category) update(index, { category });
            }}>
            {COLUMN_CATEGORIES.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
          </select>
          <button type="button" aria-label="Move up" disabled={index === 0} className={buttonClass} onClick={() => move(index, -1)}>
            <Icon name="ChevronUp" className="size-3.5" />
          </button>
          <button type="button" aria-label="Move down" disabled={index === draft.length - 1} className={buttonClass} onClick={() => move(index, 1)}>
            <Icon name="ChevronDown" className="size-3.5" />
          </button>
          <button type="button" aria-label={`Remove ${row.name || "column"}`} disabled={draft.length === 1} className={buttonClass}
            onClick={() => setDraft((rows) => rows.filter((_, position) => position !== index))}>
            <Icon name="Delete" className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button type="button" className={buttonClass} disabled={draft.length >= 20}
          onClick={() => setDraft((rows) => [...rows, { name: "", category: "started" }])}>
          <Icon name="Add" className="size-3.5" /> Add column
        </button>
        <span className="flex-1 text-[11px] text-muted-foreground">Cards in a removed column move to the first column of the same kind.</span>
        <button type="button" className={buttonClass} onClick={onDone}>Cancel</button>
        <button type="button" disabled={!valid || saving} className={primaryClass}
          onClick={() => {
            setSaving(true);
            rpc.call("setLocalColumns", {
              projectId,
              columns: draft.map((row) => ({ ...(row.id ? { id: row.id } : {}), name: row.name.trim(), category: row.category })),
            }).then(() => {
              toast.success("Columns saved");
              onDone();
            }, (caught: unknown) => {
              toast.error("Could not save columns", { description: caught instanceof Error ? caught.message : undefined });
            }).finally(() => setSaving(false));
          }}>
          Save
        </button>
      </div>
    </div>
  );
}

/** A Linear-linked project's columns are Linear's states: only their order on the board is ours. */
function ColumnOrderEditor({ projectId, columns, onDone }: {
  projectId: string;
  columns: BoardColumn[];
  onDone(): void;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const [draft, setDraft] = useState(columns);
  const [saving, setSaving] = useState(false);
  const move = (index: number, offset: number) =>
    setDraft((rows) => {
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(index + offset, 0, row!);
      return next;
    });
  const save = (columnIds: string[] | null, done: string) => {
    setSaving(true);
    rpc.call("setColumnOrder", { projectId, columnIds }).then(() => {
      toast.success(done);
      onDone();
    }, (caught: unknown) => {
      toast.error("Could not reorder columns", { description: caught instanceof Error ? caught.message : undefined });
    }).finally(() => setSaving(false));
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {draft.map((column, index) => (
        <div key={column.id} className="flex items-center gap-1.5">
          <span className="h-8 min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 text-xs leading-8 text-foreground">
            {column.name}
          </span>
          <button type="button" aria-label={`Move ${column.name} up`} disabled={index === 0} className={buttonClass} onClick={() => move(index, -1)}>
            <Icon name="ChevronUp" className="size-3.5" />
          </button>
          <button type="button" aria-label={`Move ${column.name} down`} disabled={index === draft.length - 1} className={buttonClass}
            onClick={() => move(index, 1)}>
            <Icon name="ChevronDown" className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button type="button" disabled={saving} className={buttonClass} onClick={() => save(null, "Columns follow Linear's order")}>
          Use Linear's order
        </button>
        <span className="flex-1 text-[11px] text-muted-foreground">Names and states come from Linear; this only changes the board.</span>
        <button type="button" className={buttonClass} onClick={onDone}>Cancel</button>
        <button type="button" disabled={saving} className={primaryClass}
          onClick={() => save(draft.map((column) => column.id), "Column order saved")}>
          Save
        </button>
      </div>
    </div>
  );
}
function ShippedColumnsEditor({ projectId, columns, shippedStateIds }: {
  projectId: string;
  columns: BoardColumn[];
  shippedStateIds: string[] | null;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const selectable = columns.filter((column) => column.linearStateId !== null);
  const [draft, setDraft] = useState<string[]>(() => shippedStateIds ?? selectable
    .filter((column) => column.category === "completed")
    .map((column) => column.linearStateId!));
  const [saving, setSaving] = useState(false);
  const save = (linearStateIds: string[] | null, message: string) => {
    setSaving(true);
    rpc.call("setShippedColumns", { projectId, linearStateIds }).then(() => {
      toast.success(message);
    }, (caught: unknown) => {
      toast.error("Could not save shipped columns", { description: caught instanceof Error ? caught.message : undefined });
    }).finally(() => setSaving(false));
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-xs font-medium text-foreground">Shipped columns</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Entering a selected completed column archives the linked thread. Canceled and duplicate columns only notify.
      </p>
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        {selectable.map((column) => (
          <label key={column.id} className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={draft.includes(column.linearStateId!)}
              disabled={saving}
              onChange={(event) => setDraft((current) => event.target.checked
                ? [...current, column.linearStateId!]
                : current.filter((id) => id !== column.linearStateId))}
            />
            {column.name}
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled={saving} className={buttonClass}
          onClick={() => save(null, "Shipped columns use completed states")}>
          Use completed states
        </button>
        <button type="button" disabled={saving} className={primaryClass}
          onClick={() => save(draft, "Shipped columns saved")}>
          Save shipped columns
        </button>
      </div>
    </div>
  );
}
