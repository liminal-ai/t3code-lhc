// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "./auth/EnvironmentAuth.ts";
import { lhcConsoleGroupsProxyRouteLayer, resolveConsoleTarget } from "./lhcConsoleGroupsProxy.ts";

const disposers: Array<() => Promise<void>> = [];
let tokenFile: string;
beforeEach(() => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lhc-groups-proxy-"));
  tokenFile = NodePath.join(dir, "relay-token");
  NodeFS.writeFileSync(tokenFile, "console-secret\n", { mode: 0o600 });
  process.env.LHC_CONSOLE_URL = "http://console.test:5959/";
  process.env.LHC_CONSOLE_TOKEN_FILE = tokenFile;
});
afterEach(async () => {
  delete process.env.LHC_CONSOLE_URL;
  delete process.env.LHC_CONSOLE_TOKEN_FILE;
  for (const dispose of disposers.splice(0)) await dispose();
});

interface Seen {
  url: string;
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string | undefined;
}

const fixture = (
  scopes: ReadonlyArray<AuthEnvironmentScope> | "unauthenticated",
  upstream: { status: number; body: string } | "down" = { status: 200, body: "[]" },
) => {
  const seen: Seen[] = [];
  const client = HttpClient.make((request, _url, _signal) =>
    Effect.gen(function* () {
      let body: string | undefined;
      if (request.body._tag === "Stream") {
        const chunks: Uint8Array[] = [];
        yield* Stream.runForEach(Stream.orDie(request.body.stream), (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        );
        body = Buffer.concat(chunks).toString();
      }
      seen.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      if (upstream === "down") return yield* Effect.die(new Error("ECONNREFUSED"));
      return HttpClientResponse.fromWeb(
        request,
        new Response(upstream.body, {
          status: upstream.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      );
    }),
  );
  const auth = Layer.succeed(EnvironmentAuth, {
    authenticateHttpRequest: () =>
      scopes === "unauthenticated"
        ? Effect.fail(new ServerAuthMissingCredentialError({}))
        : Effect.succeed({
            sessionId: AuthSessionId.make("test"),
            subject: "test",
            method: "browser-session-cookie",
            scopes,
          }),
  } as unknown as EnvironmentAuth["Service"]);
  const { handler, dispose } = HttpRouter.toWebHandler(
    lhcConsoleGroupsProxyRouteLayer.pipe(
      Layer.provideMerge(auth),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(NodeFileSystem.layer),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, seen };
};

describe("lhc console groups proxy", () => {
  it("resolves the console target from env with a home default", () => {
    expect(resolveConsoleTarget({})).toEqual({
      origin: "http://127.0.0.1:5959",
      tokenFile: expect.stringMatching(/\.lhc-console\/relay-token$/),
    });
    expect(resolveConsoleTarget({ LHC_CONSOLE_URL: "http://x:1/" }).origin).toBe("http://x:1");
  });

  it("forwards reads with the console bearer and passes status and body through", async () => {
    const { handler, seen } = fixture([AuthOrchestrationReadScope], {
      status: 200,
      body: '{"messages":[],"lastSeq":3}',
    });
    const response = await handler(
      new Request("http://t3.test/api/groups/spec-group/messages?since=2"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [], lastSeq: 3 });
    expect(seen).toEqual([
      {
        url: "http://console.test:5959/api/groups/spec-group/messages?since=2",
        method: "GET",
        authorization: "Bearer console-secret",
        contentType: undefined,
        body: undefined,
      },
    ]);
    const list = await handler(new Request("http://t3.test/api/groups"));
    expect(list.status).toBe(200);
    expect(seen[1]?.url).toBe("http://console.test:5959/api/groups");
  });

  it("forwards posts with the JSON body and requires operate scope", async () => {
    const readOnly = fixture([AuthOrchestrationReadScope]);
    const post = () =>
      new Request("http://t3.test/api/groups/spec-group/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"text":"@flint hi","id":"c1"}',
      });
    expect((await readOnly.handler(post())).status).toBe(403);
    expect(readOnly.seen).toEqual([]);

    const operator = fixture([AuthOrchestrationOperateScope], {
      status: 202,
      body: '{"seq":4,"wakes":[]}',
    });
    const response = await operator.handler(post());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ seq: 4, wakes: [] });
    expect(operator.seen[0]).toMatchObject({
      method: "POST",
      authorization: "Bearer console-secret",
      // The console (fastify) answers 415 to anything but JSON here.
      contentType: "application/json",
      body: '{"text":"@flint hi","id":"c1"}',
    });
  });

  it("rejects unauthenticated browsers before touching the console", async () => {
    const { handler, seen } = fixture("unauthenticated");
    const response = await handler(new Request("http://t3.test/api/groups"));
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("passes console errors through, maps a console 401 to 502, and reports a down console", async () => {
    const notFound = fixture([AuthOrchestrationReadScope], {
      status: 404,
      body: '{"error":"unknown group: nope"}',
    });
    const missing = await notFound.handler(new Request("http://t3.test/api/groups/nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown group: nope" });

    const badToken = fixture([AuthOrchestrationReadScope], {
      status: 401,
      body: '{"error":"unauthorized"}',
    });
    expect((await badToken.handler(new Request("http://t3.test/api/groups"))).status).toBe(502);

    const down = fixture([AuthOrchestrationReadScope], "down");
    expect((await down.handler(new Request("http://t3.test/api/groups"))).status).toBe(502);
  });

  it("refuses paths and methods outside the four group routes", async () => {
    const { handler, seen } = fixture([AuthOrchestrationOperateScope]);
    expect((await handler(new Request("http://t3.test/api/groups/x/cursors"))).status).toBe(404);
    expect(
      (await handler(new Request("http://t3.test/api/groups/x", { method: "DELETE" }))).status,
    ).toBe(405);
    expect(seen).toEqual([]);
  });

  it("answers 503 when the token file is missing", async () => {
    process.env.LHC_CONSOLE_TOKEN_FILE = NodePath.join(
      NodeOS.tmpdir(),
      "does-not-exist-relay-token",
    );
    const { handler, seen } = fixture([AuthOrchestrationReadScope]);
    expect((await handler(new Request("http://t3.test/api/groups"))).status).toBe(503);
    expect(seen).toEqual([]);
  });
});
