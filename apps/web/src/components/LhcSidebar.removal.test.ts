// Fork-only regression (LHC sidebar hardening, item 2): the project removal
// inventory counts every thread of the member project, pinned agents included;
// the LHC view's pinned filter is presentation only and never reaches it.
import { describe, expect, it } from "vite-plus/test";
import { projectRemovalThreads } from "./LegacySidebar";

const ref = { environmentId: "env-1", projectId: "proj-1" };
const threads = [
  {
    id: "agent",
    environmentId: "env-1",
    projectId: "proj-1",
    pinnedAt: "2026-09-02T00:00:00.000Z",
  },
  { id: "scratch", environmentId: "env-1", projectId: "proj-1", pinnedAt: null },
  {
    id: "elsewhere",
    environmentId: "env-1",
    projectId: "proj-2",
    pinnedAt: "2026-09-02T00:00:00.000Z",
  },
  { id: "other-env", environmentId: "env-2", projectId: "proj-1", pinnedAt: null },
];

describe("projectRemovalThreads (LHC fork)", () => {
  it("counts pinned agents alongside unpinned threads of the same project", () => {
    expect(projectRemovalThreads(threads, ref).map((thread) => thread.id)).toEqual([
      "agent",
      "scratch",
    ]);
  });
  it("accepts a map's values iterator, as the removal path passes", () => {
    const byKey = new Map(threads.map((thread) => [thread.id, thread] as const));
    expect(projectRemovalThreads(byKey.values(), ref)).toHaveLength(2);
  });
});
