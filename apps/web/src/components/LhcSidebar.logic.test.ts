import { describe, expect, it } from "vite-plus/test";
import {
  lastTurnActivityMs,
  planLhcSidebarThreadDrop,
  sortThreadsByLastTurn,
} from "./LhcSidebar.logic";
import { planSidebarThreadDrop } from "./Sidebar.logic";

const t = (iso: string) => Date.parse(iso);
const thread = (
  id: string,
  createdAt: string,
  latestTurn: {
    requestedAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
  } | null,
  updatedAt = "2026-09-13T23:59:00.000Z",
) => ({
  id,
  createdAt,
  updatedAt,
  latestTurn: latestTurn
    ? {
        requestedAt: latestTurn.requestedAt,
        startedAt: latestTurn.startedAt ?? null,
        completedAt: latestTurn.completedAt ?? null,
      }
    : null,
});

describe("lastTurnActivityMs", () => {
  it("is the newest stamp on the latest turn", () => {
    const requested = "2026-09-13T10:00:00.000Z";
    const started = "2026-09-13T10:00:05.000Z";
    const completed = "2026-09-13T10:30:00.000Z";
    expect(
      lastTurnActivityMs(thread("a", "2026-09-01T00:00:00.000Z", { requestedAt: requested })),
    ).toBe(t(requested));
    expect(
      lastTurnActivityMs(
        thread("a", "2026-09-01T00:00:00.000Z", { requestedAt: requested, startedAt: started }),
      ),
    ).toBe(t(started));
    expect(
      lastTurnActivityMs(
        thread("a", "2026-09-01T00:00:00.000Z", {
          requestedAt: requested,
          startedAt: started,
          completedAt: completed,
        }),
      ),
    ).toBe(t(completed));
  });

  it("falls back to createdAt when the thread has no turn and ignores updatedAt", () => {
    const created = "2026-09-02T00:00:00.000Z";
    expect(lastTurnActivityMs(thread("a", created, null, "2026-09-13T00:00:00.000Z"))).toBe(
      t(created),
    );
  });
});

describe("sortThreadsByLastTurn", () => {
  it("orders by last turn activity, newest first, regardless of updatedAt", () => {
    const oldButRenamed = thread(
      "renamed",
      "2026-09-01T00:00:00.000Z",
      { requestedAt: "2026-09-05T00:00:00.000Z" },
      "2026-09-13T12:00:00.000Z",
    );
    const recentTurn = thread(
      "recent",
      "2026-09-02T00:00:00.000Z",
      { requestedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T01:00:00.000Z" },
      "2026-09-12T01:00:00.000Z",
    );
    const running = thread(
      "running",
      "2026-09-03T00:00:00.000Z",
      { requestedAt: "2026-09-13T00:00:00.000Z", startedAt: "2026-09-13T00:00:01.000Z" },
      "2026-09-13T00:00:01.000Z",
    );
    const noTurn = thread("fresh", "2026-09-10T00:00:00.000Z", null, "2026-09-13T13:00:00.000Z");
    expect(
      sortThreadsByLastTurn([oldButRenamed, noTurn, recentTurn, running]).map((x) => x.id),
    ).toEqual(["running", "recent", "fresh", "renamed"]);
  });

  it("breaks ties by createdAt desc, then keeps input order", () => {
    const stamp = { requestedAt: "2026-09-12T00:00:00.000Z" };
    const a = thread("a", "2026-09-01T00:00:00.000Z", stamp);
    const b = thread("b", "2026-09-02T00:00:00.000Z", stamp);
    const c = thread("c", "2026-09-02T00:00:00.000Z", stamp);
    expect(sortThreadsByLastTurn([a, b, c]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("planLhcSidebarThreadDrop", () => {
  const keys = new Map<string, string | null>([
    ["p1", "b"],
    ["p2", "d"],
    ["a1", null],
    ["a2", null],
  ]);
  const base = {
    pinnedOrder: ["p1", "p2"],
    pinnedKeysById: keys,
    reorderableKeys: new Set(["p1", "p2", "a1", "a2"]),
    activeOrder: ["a1", "a2"],
    activeKeysById: keys,
    // The component adds every visible thread when the server supports active reorder.
    activeReorderableKeys: new Set(["p1", "p2", "a1", "a2"]),
  } as const;

  it("turns in-shelf reorders into no-ops", () => {
    const pinnedReorder = {
      ...base,
      activeKey: "p2",
      activeSection: "pinned" as const,
      target: { section: "pinned" as const, pinnedOrder: ["p2", "p1"], activeOrder: ["a1", "a2"] },
    };
    expect(planSidebarThreadDrop(pinnedReorder).kind).toBe("reorder-pinned");
    expect(planLhcSidebarThreadDrop(pinnedReorder)).toEqual({ kind: "none" });
    const activeReorder = {
      ...base,
      activeKey: "a2",
      activeSection: "active" as const,
      target: { section: "active" as const, pinnedOrder: ["p1", "p2"], activeOrder: ["a2", "a1"] },
    };
    expect(planSidebarThreadDrop(activeReorder).kind).toBe("move-active");
    expect(planLhcSidebarThreadDrop(activeReorder)).toEqual({ kind: "none" });
  });

  it("keeps shelf changes: pin, unpin, settle", () => {
    const pin = {
      ...base,
      activeKey: "a1",
      activeSection: "active" as const,
      target: { section: "pinned" as const, pinnedOrder: ["a1", "p1", "p2"], activeOrder: ["a2"] },
    };
    expect(planLhcSidebarThreadDrop(pin).kind).toBe("pin");
    const unpin = {
      ...base,
      activeKey: "p1",
      activeSection: "pinned" as const,
      target: { section: "active" as const, pinnedOrder: ["p2"], activeOrder: ["p1", "a1", "a2"] },
    };
    expect(planLhcSidebarThreadDrop(unpin).kind).toBe("move-active");
    const settle = {
      ...base,
      activeKey: "a1",
      activeSection: "active" as const,
      target: { section: "settled" as const, pinnedOrder: ["p1", "p2"], activeOrder: ["a2"] },
    };
    expect(planLhcSidebarThreadDrop(settle).kind).toBe("settle");
  });
});
