// Fork-only helpers for LhcSidebar.tsx (copy of LegacySidebar.tsx): the
// last-turn sort key, the Agents partition/grouping, and row surfaces.
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSummary } from "../types";
import {
  hasUnseenCompletion,
  resolveThreadStatusPill,
  type ThreadStatusPill,
} from "./Sidebar.logic";

export interface LhcSortableThread {
  readonly createdAt: string;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
}

/**
 * Newest stamp on the latest turn: a thread rises when a turn is requested,
 * starts, and completes. Threads with no turn fall back to createdAt. Never
 * updatedAt (pins, renames, title regeneration would reorder) and never
 * latestUserMessageAt (a queued steer would reorder).
 */
export function lastTurnActivityMs(thread: LhcSortableThread): number {
  const turn = thread.latestTurn;
  const stamps = turn
    ? [turn.completedAt ?? undefined, turn.startedAt ?? undefined, turn.requestedAt]
    : [thread.createdAt];
  let best = Number.NEGATIVE_INFINITY;
  for (const stamp of stamps) {
    const ms = toSortableTimestamp(stamp);
    if (ms !== null && ms > best) best = ms;
  }
  if (best === Number.NEGATIVE_INFINITY) {
    best = toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return best;
}

/** The ISO stamp behind `lastTurnActivityMs`, for the row's age label (same source as the sort). */
export function lastTurnActivityStamp(thread: LhcSortableThread): string {
  const turn = thread.latestTurn;
  const stamps = turn
    ? [turn.completedAt ?? undefined, turn.startedAt ?? undefined, turn.requestedAt]
    : [thread.createdAt];
  let best: { stamp: string; ms: number } | null = null;
  for (const stamp of stamps) {
    if (stamp === undefined) continue;
    const ms = toSortableTimestamp(stamp);
    if (ms !== null && (best === null || ms > best.ms)) best = { stamp, ms };
  }
  return best?.stamp ?? thread.createdAt;
}

/** Newest activity first; ties by createdAt desc, then stable. */
export function sortThreadsByLastTurn<T extends LhcSortableThread>(threads: ReadonlyArray<T>): T[] {
  return threads
    .map((thread, index) => ({ thread, index, key: lastTurnActivityMs(thread) }))
    .sort(
      (left, right) =>
        right.key - left.key ||
        (toSortableTimestamp(right.thread.createdAt) ?? 0) -
          (toSortableTimestamp(left.thread.createdAt) ?? 0) ||
        left.index - right.index,
    )
    .map((entry) => entry.thread);
}

export interface LhcAgentCandidate extends LhcSortableThread {
  readonly pinnedAt?: string | null | undefined;
  readonly archivedAt: string | null;
}

/** Pinned, non-archived threads are agents; everything else stays in the Projects tree. */
export function isLhcAgent(thread: LhcAgentCandidate): boolean {
  return thread.pinnedAt != null && thread.archivedAt === null;
}

/**
 * Projects that own at least one agent, ordered by their newest agent's last
 * turn (newest first). `projectKeyOf` maps a thread to its (logical) project key.
 */
export function orderAgentProjects<
  TProject extends { readonly projectKey: string },
  TThread extends LhcAgentCandidate,
>(
  projects: ReadonlyArray<TProject>,
  agents: ReadonlyArray<TThread>,
  projectKeyOf: (thread: TThread) => string,
): TProject[] {
  const newestByProject = new Map<string, number>();
  for (const agent of agents) {
    const key = projectKeyOf(agent);
    const ms = lastTurnActivityMs(agent);
    const current = newestByProject.get(key);
    if (current === undefined || ms > current) newestByProject.set(key, ms);
  }
  return projects
    .map((project, index) => ({ project, index, key: newestByProject.get(project.projectKey) }))
    .filter(
      (entry): entry is { project: TProject; index: number; key: number } =>
        entry.key !== undefined,
    )
    .sort((left, right) => right.key - left.key || left.index - right.index)
    .map((entry) => entry.project);
}

/** Per-project collapse under Agents is its own state (hide my agents vs hide my scratch work). */
export const LHC_AGENTS_EXPANSION_PREFIX = "lhc-agents:";

/**
 * Row surfaces: the stock tokens (hover zinc-25, active white) vanish on a
 * light sidebar, so hover, selection and the open thread get visible tints.
 */
export function lhcRowSurfaceClassName(input: {
  readonly isActive: boolean;
  readonly isSelected: boolean;
}): string {
  if (input.isActive)
    return "bg-foreground/10 ring-1 ring-inset ring-foreground/15 hover:bg-foreground/10";
  if (input.isSelected)
    return "bg-foreground/7 ring-1 ring-inset ring-foreground/10 hover:bg-foreground/8";
  return "hover:bg-foreground/6";
}

// ── Row activity (slice 5) ─────────────────────────────────────────────────
// Three questions per row: in progress, new since I last looked, finished/failed.
// Agents rows use upstream's status pill as-is; when it is null (turn settled
// and already seen) the terminal state of the latest turn is shown instead.

export type LhcTerminalKind = "completed" | "failed" | "interrupted";

export interface LhcAgentRowStatus {
  /** Upstream pill (Working, Connecting, Pending Approval, Awaiting Input, Completed…). */
  readonly pill: ThreadStatusPill | null;
  /** Shown when no pill applies: the latest turn's end state, or null for a fresh thread. */
  readonly terminal: LhcTerminalKind | null;
  /** Title bolding + dot: a completion the user has not looked at. */
  readonly isUnread: boolean;
  readonly isRunning: boolean;
}

type LhcAgentRowInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
>;

export function resolveLhcAgentRowStatus(
  thread: LhcAgentRowInput,
  lastVisitedAt: string | undefined,
): LhcAgentRowStatus {
  const withVisit = { ...thread, lastVisitedAt };
  const pill = resolveThreadStatusPill({ thread: withVisit });
  const isRunning = thread.session?.status === "running" || thread.session?.status === "starting";
  const isUnread = !isRunning && hasUnseenCompletion(withVisit);
  let terminal: LhcTerminalKind | null = null;
  if (!pill && thread.latestTurn) {
    const state = thread.latestTurn.state;
    if (state === "error" || thread.session?.status === "error") terminal = "failed";
    else if (state === "interrupted") terminal = "interrupted";
    else if (state === "completed") terminal = "completed";
  } else if (!pill && thread.session?.status === "error") {
    terminal = "failed";
  }
  return { pill, terminal, isUnread, isRunning };
}

export interface LhcRoundtableRowInput {
  readonly members: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly working?: ReadonlyArray<string> | undefined;
  readonly latestSeq?: number | undefined;
  readonly latestAt?: string | null | undefined;
}

export interface LhcRoundtableRowStatus {
  /** Labels of members working on a reply, in member order. */
  readonly working: ReadonlyArray<string>;
  /** "Sable working" / "2 working" / "" when idle. */
  readonly workingLabel: string;
  readonly isUnread: boolean;
  /** Stamp of the latest line for the resting-state age, null when empty. */
  readonly latestAt: string | null;
}

export function resolveLhcRoundtableRowStatus(
  group: LhcRoundtableRowInput,
  seenSeq: number,
): LhcRoundtableRowStatus {
  const workingIds = new Set(group.working ?? []);
  const working = group.members.filter((m) => workingIds.has(m.id)).map((m) => m.label);
  const workingLabel =
    working.length === 0
      ? ""
      : working.length === 1
        ? `${working[0]} working`
        : `${working.length} working`;
  const latestSeq = group.latestSeq ?? 0;
  return {
    working,
    workingLabel,
    isUnread: latestSeq > seenSeq,
    latestAt: group.latestAt ?? null,
  };
}
