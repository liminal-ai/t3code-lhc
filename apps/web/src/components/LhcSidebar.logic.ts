// Fork-only helpers for LhcSidebar.tsx (copy of LegacySidebar.tsx): the
// last-turn sort key, the Agents partition/grouping, and row surfaces.
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";

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
