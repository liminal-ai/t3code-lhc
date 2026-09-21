import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LhcGroupsApiError, makeLhcGroupsClient } from "./lhcGroups";

vi.mock("~/environments/primary", () => ({
  // Mirrors the real resolver: pathname assignment plus a separate query.
  resolvePrimaryEnvironmentHttpUrl: (path: string, searchParams?: Record<string, string>) => {
    const url = new URL("http://t3.test/");
    url.pathname = path;
    if (searchParams) url.search = new URLSearchParams(searchParams).toString();
    return url.toString();
  },
}));

afterEach(() => vi.restoreAllMocks());

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

describe("group proxy client", () => {
  it("reads with credentials through this server's /api/groups", async () => {
    const { fetchFn, calls } = fakeFetch(200, { messages: [], lastSeq: 3 });
    const client = makeLhcGroupsClient(fetchFn);
    expect(await client.messages("spec-group", 2)).toEqual({ messages: [], lastSeq: 3 });
    expect(calls[0]?.url).toBe("http://t3.test/api/groups/spec-group/messages?since=2");
    expect(calls[0]?.init?.credentials).toBe("include");
    await client.list();
    await client.detail("spec group");
    expect(calls.map((c) => c.url)).toEqual([
      "http://t3.test/api/groups/spec-group/messages?since=2",
      "http://t3.test/api/groups",
      "http://t3.test/api/groups/spec%20group",
    ]);
  });

  it("posts the owner message with a client id as JSON", async () => {
    const { fetchFn, calls } = fakeFetch(202, {
      seq: 4,
      wakes: [{ jobId: "j", memberId: "flint" }],
    });
    const result = await makeLhcGroupsClient(fetchFn).post("spec-group", "@flint hi", "c1");
    expect(result).toEqual({ seq: 4, wakes: [{ jobId: "j", memberId: "flint" }] });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: "@flint hi", id: "c1" });
  });

  it("surfaces console errors with their status and message", async () => {
    const { fetchFn } = fakeFetch(404, { error: "unknown group: nope" });
    await expect(makeLhcGroupsClient(fetchFn).detail("nope")).rejects.toMatchObject({
      name: "LhcGroupsApiError",
      status: 404,
      message: "unknown group: nope",
    });
    const down = fakeFetch(502, "Console unreachable");
    const err = await makeLhcGroupsClient(down.fetchFn)
      .list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhcGroupsApiError);
    expect((err as LhcGroupsApiError).status).toBe(502);
  });

  it("falls back to the list when the console has no detail route", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/api/groups")) {
        return new Response(
          JSON.stringify([
            {
              id: "spec-group",
              name: "spec-group",
              description: "d",
              members: [{ id: "flint", label: "Flint" }],
              channels: ["photon"],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    };
    const detail = await makeLhcGroupsClient(fetchFn).detail("spec-group");
    expect(detail.members).toEqual([{ id: "flint", label: "Flint", cursorSeq: 0 }]);
    expect(detail.lastSeq).toBe(0);
    expect(calls).toEqual(["http://t3.test/api/groups/spec-group", "http://t3.test/api/groups"]);
    await expect(makeLhcGroupsClient(fetchFn).detail("nope")).rejects.toMatchObject({
      status: 404,
    });
  });
});
