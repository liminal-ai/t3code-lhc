import { describe, expect, it } from "vite-plus/test";
import {
  isLhcAgent,
  lastTurnActivityMs,
  orderAgentProjects,
  resolveLhcAgentRowStatus,
  resolveLhcRoundtableRowStatus,
  sortThreadsByLastTurn,
} from "./LhcSidebar.logic";

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

describe("isLhcAgent / orderAgentProjects", () => {
  it("treats pinned, non-archived threads as agents", () => {
    const base = thread("a", "2026-09-01T00:00:00.000Z", null);
    expect(isLhcAgent({ ...base, pinnedAt: "2026-09-02T00:00:00.000Z", archivedAt: null })).toBe(
      true,
    );
    expect(isLhcAgent({ ...base, pinnedAt: null, archivedAt: null })).toBe(false);
    expect(isLhcAgent({ ...base, archivedAt: null })).toBe(false);
    expect(
      isLhcAgent({
        ...base,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        archivedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("orders projects by their newest agent and drops projects without agents", () => {
    const projects = [{ projectKey: "p1" }, { projectKey: "p2" }, { projectKey: "p3" }];
    const agent = (id: string, project: string, requestedAt: string) => ({
      ...thread(id, "2026-09-01T00:00:00.000Z", { requestedAt }),
      pinnedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
      project,
    });
    const agents = [
      agent("a", "p1", "2026-09-10T00:00:00.000Z"),
      agent("b", "p3", "2026-09-12T00:00:00.000Z"),
      agent("c", "p1", "2026-09-11T00:00:00.000Z"),
    ];
    expect(orderAgentProjects(projects, agents, (t) => t.project).map((p) => p.projectKey)).toEqual(
      ["p3", "p1"],
    );
  });
});

describe("resolveLhcAgentRowStatus (slice 5: in progress / new / finished)", () => {
  const base = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    backgroundLiveness: null,
  };
  const turn = (
    state: "running" | "completed" | "error" | "interrupted",
    completedAt: string | null,
  ) =>
    ({
      turnId: "t1",
      state,
      requestedAt: "2026-09-22T10:00:00.000Z",
      startedAt: "2026-09-22T10:00:01.000Z",
      completedAt,
      assistantMessageId: null,
    }) as never;
  const session = (status: "running" | "ready" | "error" | "stopped") =>
    ({ status, activeTurnId: status === "running" ? "t1" : null }) as never;

  it("in progress: upstream Working pill with pulse, never unread", () => {
    const status = resolveLhcAgentRowStatus(
      { ...base, latestTurn: turn("running", null), session: session("running") },
      "2026-09-01T00:00:00.000Z",
    );
    expect(status.pill?.label).toBe("Working");
    expect(status.pill?.pulse).toBe(true);
    expect(status.isRunning).toBe(true);
    expect(status.isUnread).toBe(false);
    expect(status.terminal).toBeNull();
  });

  it("new since last look: Completed pill + unread when the turn ended after the last visit", () => {
    const thread = {
      ...base,
      latestTurn: turn("completed", "2026-09-22T10:05:00.000Z"),
      session: session("ready"),
    };
    const unseen = resolveLhcAgentRowStatus(thread, "2026-09-22T10:00:00.000Z");
    expect(unseen.pill?.label).toBe("Completed");
    expect(unseen.isUnread).toBe(true);
    // Never visited counts as read (Theo's rule): no pill, terminal state instead.
    const never = resolveLhcAgentRowStatus(thread, undefined);
    expect(never.pill).toBeNull();
    expect(never.isUnread).toBe(false);
    expect(never.terminal).toBe("completed");
  });

  it("finished / failed: terminal state once the settled turn has been seen", () => {
    const seen = "2026-09-22T11:00:00.000Z";
    expect(
      resolveLhcAgentRowStatus(
        {
          ...base,
          latestTurn: turn("completed", "2026-09-22T10:05:00.000Z"),
          session: session("ready"),
        },
        seen,
      ),
    ).toMatchObject({ pill: null, terminal: "completed", isUnread: false });
    expect(
      resolveLhcAgentRowStatus(
        {
          ...base,
          latestTurn: turn("error", "2026-09-22T10:05:00.000Z"),
          session: session("error"),
        },
        seen,
      ),
    ).toMatchObject({ pill: null, terminal: "failed" });
    expect(
      resolveLhcAgentRowStatus(
        {
          ...base,
          latestTurn: turn("interrupted", "2026-09-22T10:05:00.000Z"),
          session: session("stopped"),
        },
        seen,
      ),
    ).toMatchObject({ pill: null, terminal: "interrupted" });
    expect(
      resolveLhcAgentRowStatus({ ...base, latestTurn: null, session: session("stopped") }, seen),
    ).toMatchObject({ pill: null, terminal: null });
  });

  it("attention states from upstream outrank everything", () => {
    const status = resolveLhcAgentRowStatus(
      {
        ...base,
        hasPendingApprovals: true,
        latestTurn: turn("running", null),
        session: session("running"),
      },
      undefined,
    );
    expect(status.pill?.label).toBe("Pending Approval");
  });
});

describe("resolveLhcRoundtableRowStatus", () => {
  const members = [
    { id: "sable", label: "Sable" },
    { id: "flint", label: "Flint" },
  ];
  it("working label names one member, counts more; unread compares latestSeq to the seen seq", () => {
    expect(
      resolveLhcRoundtableRowStatus(
        { members, working: ["flint"], latestSeq: 5, latestAt: "t" },
        5,
      ),
    ).toMatchObject({
      working: ["Flint"],
      workingLabel: "Flint working",
      isUnread: false,
      latestAt: "t",
    });
    expect(
      resolveLhcRoundtableRowStatus({ members, working: ["flint", "sable"], latestSeq: 6 }, 5),
    ).toMatchObject({ working: ["Sable", "Flint"], workingLabel: "2 working", isUnread: true });
    expect(
      resolveLhcRoundtableRowStatus({ members, failed: ["sable"], latestSeq: 1 }, 1),
    ).toMatchObject({ failed: ["Sable"], failedLabel: "Sable failed", workingLabel: "" });
    expect(resolveLhcRoundtableRowStatus({ members, failed: ["sable", "flint"] }, 0)).toMatchObject(
      { failedLabel: "2 failed" },
    );
    // Working again outranks a stale failure.
    expect(
      resolveLhcRoundtableRowStatus({ members, failed: ["sable"], working: ["sable"] }, 0),
    ).toMatchObject({ failed: [], failedLabel: "", workingLabel: "Sable working" });
    expect(resolveLhcRoundtableRowStatus({ members }, 0)).toMatchObject({
      working: [],
      workingLabel: "",
      failed: [],
      failedLabel: "",
      isUnread: false,
      latestAt: null,
    });
  });
  it("ignores unknown working ids from a stale console", () => {
    expect(resolveLhcRoundtableRowStatus({ members, working: ["reed"] }, 0).working).toEqual([]);
  });
});
