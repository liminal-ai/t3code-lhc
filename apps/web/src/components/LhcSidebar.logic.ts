// Fork-only helpers for LhcSidebar.tsx: the last-turn sort key and the drop
// filter that keeps shelf moves while dropping in-shelf reordering.
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { planSidebarThreadDrop, type SidebarThreadDropPlan } from "./Sidebar.logic";

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
  if (best === Number.NEGATIVE_INFINITY)
    best = toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
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

/**
 * Theo's planner, minus in-shelf reordering: pinned-to-pinned and
 * active-to-active drops become no-ops; pin, unpin (move-active from another
 * shelf), settle and unsettle keep their plans.
 */
export function planLhcSidebarThreadDrop(
  input: Parameters<typeof planSidebarThreadDrop>[0],
): SidebarThreadDropPlan {
  const plan = planSidebarThreadDrop(input);
  if (plan.kind === "reorder-pinned") return { kind: "none" };
  if (plan.kind === "move-active" && input.activeSection === "active") return { kind: "none" };
  return plan;
}
