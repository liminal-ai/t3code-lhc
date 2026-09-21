// Fork-only (LHC): proxy the lhc-console group-line API for the group chat
// page. The browser calls /api/groups/* on this server with its pairing
// session; the server forwards to the console on loopback with the console's
// owner bearer, read from ~/.lhc-console/relay-token per request. The console
// stays the source of truth: nothing here knows what a group is beyond the
// four routes it forwards. Precedent: device/DeviceHubProxy.ts.
import * as NodeOS from "node:os";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "./auth/http.ts";

export const LHC_CONSOLE_GROUPS_ROUTE_PREFIX = "/api/groups";
const DEFAULT_CONSOLE_URL = "http://127.0.0.1:5959";

/** Console origin and token file; env overrides exist for tests and odd hosts. */
export function resolveConsoleTarget(env: NodeJS.ProcessEnv = process.env): {
  origin: string;
  tokenFile: string;
} {
  return {
    origin: (env.LHC_CONSOLE_URL ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, ""),
    tokenFile: env.LHC_CONSOLE_TOKEN_FILE ?? `${NodeOS.homedir()}/.lhc-console/relay-token`,
  };
}

/** GET list/detail/messages are reads; POST messages wakes agents: operate. */
const ALLOWED: ReadonlyArray<{
  method: "GET" | "POST";
  path: RegExp;
  scope: AuthEnvironmentScope;
}> = [
  { method: "GET", path: /^\/api\/groups$/, scope: AuthOrchestrationReadScope },
  { method: "GET", path: /^\/api\/groups\/[^/]+$/, scope: AuthOrchestrationReadScope },
  { method: "GET", path: /^\/api\/groups\/[^/]+\/messages$/, scope: AuthOrchestrationReadScope },
  {
    method: "POST",
    path: /^\/api\/groups\/[^/]+\/messages$/,
    scope: AuthOrchestrationOperateScope,
  },
];

const authenticate = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const pathname = url.value.pathname;
  const route = ALLOWED.find((r) => r.method === request.method && r.path.test(pathname));
  if (!route) {
    const known = ALLOWED.some((r) => r.path.test(pathname));
    return HttpServerResponse.text(known ? "Method Not Allowed" : "Not Found", {
      status: known ? 405 : 404,
    });
  }
  yield* authenticate(route.scope);

  const target = resolveConsoleTarget();
  const fs = yield* FileSystem.FileSystem;
  const token = yield* fs.readFileString(target.tokenFile).pipe(
    Effect.map((text) => text.trim()),
    Effect.catch(() => Effect.succeed("")),
  );
  if (!token) {
    return HttpServerResponse.text("Console token unavailable", { status: 503 });
  }

  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const upstream = HttpClientRequest.make(request.method)(
    `${target.origin}${pathname}${url.value.search}`,
  ).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("accept", "application/json"),
    // bodyStream stamps its own content type (octet-stream by default), so the
    // browser's JSON type has to travel as the body option, not as a header.
    request.method === "POST"
      ? HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"] ?? "application/json",
        })
      : (self) => self,
  );
  const response = yield* httpClient
    .execute(upstream)
    .pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (response === null) {
    return HttpServerResponse.text("Console unreachable", { status: 502 });
  }
  // Status and JSON body pass through unchanged; the console's own 401 shows
  // up here as 502-class misconfiguration, never as the browser's fault.
  const body = yield* response.text.pipe(Effect.catchCause(() => Effect.succeed("")));
  const status = response.status === 401 ? 502 : response.status;
  return HttpServerResponse.text(
    status === 502 && response.status === 401 ? "Console rejected the server token" : body,
    {
      status,
      contentType: response.headers["content-type"] ?? "application/json",
    },
  );
});

/** `/api/groups/*` also matches the bare list path (the wildcard may be empty). */
export const lhcConsoleGroupsProxyRouteLayer = HttpRouter.add(
  "*",
  `${LHC_CONSOLE_GROUPS_ROUTE_PREFIX}/*`,
  handler,
);
