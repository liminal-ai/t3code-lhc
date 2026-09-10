// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
/**
 * ClaudeLhcSidecar — the `createQuery` seam for LHC-backed Claude instances.
 *
 * Instead of calling the Claude Agent SDK in-process, an LHC instance spawns the
 * `claude-lhc` sidecar (Node, compiled JS) and speaks its JSONL
 * protocol over stdio. The sidecar runs the same SDK against the same binary,
 * records every message into LHC, and forwards the native `SDKMessage` stream
 * unchanged, so the adapter's parsing, approvals, and usage meter work as they
 * do for the native path.
 *
 * Wire (one JSON object per line):
 *   adapter → sidecar: `start` (SDK options minus callbacks), `user` (one
 *     SDKUserMessage), `req` (setModel / setPermissionMode / setMaxThinkingTokens),
 *     `res` (answer to a sidecar request), `abort`; stdin EOF closes the session.
 *   sidecar → adapter: `msg` (SDKMessage), `req` (canUseTool / onUserDialog),
 *     `res`, `abort` (the SDK aborted its own request), `error` (fatal).
 *
 * Sidecar location: `CLAUDE_LHC_SIDECAR` is the Node JS entry file. The server
 * always `spawn(process.execPath, [entry], { windowsHide: true })`. There is no
 * PATH fallback and no Bun launcher. LHC state is under `T3CODE_LHC_HOME`.
 *
 * @module provider/Drivers/ClaudeLhcSidecar
 */
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import type { ClaudeAdapterLiveOptions } from "../Layers/ClaudeAdapter.ts";

type CreateQuery = NonNullable<ClaudeAdapterLiveOptions["createQuery"]>;
type QueryRuntime = ReturnType<CreateQuery>;

type SidecarFrame =
  | { type: "msg"; message: SDKMessage }
  | {
      type: "req";
      id: number;
      method: "canUseTool" | "onUserDialog";
      params: Record<string, unknown>;
    }
  | { type: "res"; id: number; ok: true; value: unknown }
  | { type: "res"; id: number; ok: false; error: string }
  | { type: "abort"; id: number }
  | { type: "error"; message: string };

type AdapterFrame =
  | { type: "start"; options: Record<string, unknown> }
  | { type: "user"; message: SDKUserMessage }
  | { type: "req"; id: number; method: string; params: unknown }
  | { type: "res"; id: number; ok: true; value: unknown }
  | { type: "res"; id: number; ok: false; error: string }
  | { type: "abort"; id: number };

const CLOSE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 5_000;

/** Options members that cannot cross the process boundary; the sidecar supplies its own. */
const NON_WIRE_OPTIONS = new Set([
  "canUseTool",
  "onUserDialog",
  "abortController",
  "stderr",
  "spawnClaudeCodeProcess",
  "sessionStore",
  "hooks",
]);

export function resolveClaudeLhcSidecarPath(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CLAUDE_LHC_SIDECAR?.trim();
  if (configured === undefined || configured === "") {
    throw new Error("CLAUDE_LHC_SIDECAR must be set to the compiled claude-lhc JS entry");
  }
  return configured;
}

function toWireOptions(options: ClaudeQueryOptions): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (NON_WIRE_OPTIONS.has(key) || typeof value === "function" || value === undefined) continue;
    wire[key] = value;
  }
  return wire;
}

/** An async queue of messages the runtime iterator drains; `fail` rejects the pending pull and every later one. */
class MessageQueue {
  readonly #items: SDKMessage[] = [];
  #ended = false;
  #failure: Error | undefined;
  #wake: (() => void) | undefined;

  push(message: SDKMessage): void {
    this.#items.push(message);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  fail(cause: Error): void {
    this.#failure ??= cause;
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) {
        if (this.#failure !== undefined) throw this.#failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = undefined;
          resolve();
        };
      });
    }
  }
}

export interface ClaudeLhcSidecarOptions {
  readonly environment: NodeJS.ProcessEnv;
}

export function makeClaudeLhcCreateQuery(sidecar: ClaudeLhcSidecarOptions): CreateQuery {
  return (input) => startSidecarQuery(input, sidecar);
}

function startSidecarQuery(
  input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: ClaudeQueryOptions },
  sidecar: ClaudeLhcSidecarOptions,
): QueryRuntime {
  const sidecarPath = resolveClaudeLhcSidecarPath(sidecar.environment);
  const messages = new MessageQueue();
  const pendingControls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();
  const inflightRequests = new Map<number, AbortController>();
  let nextControlId = 0;
  let closed = false;
  let stdinOpen = true;

  const childEnv: NodeJS.ProcessEnv = { ...sidecar.environment, ...(input.options.env ?? {}) };
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(process.execPath, [sidecarPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      windowsHide: true,
    });
  } catch (cause) {
    throw new Error(
      `Failed to spawn claude-lhc sidecar at ${sidecarPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const log = (line: string): void => {
    process.stderr.write(`[claude-lhc:${child.pid ?? "?"}] ${line}\n`);
  };

  const send = (frame: AdapterFrame): void => {
    if (!stdinOpen || child.stdin === null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const endStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin?.end();
  };
  const failAll = (cause: Error): void => {
    for (const waiter of pendingControls.values()) waiter.reject(cause);
    pendingControls.clear();
    for (const controller of inflightRequests.values()) controller.abort();
    inflightRequests.clear();
  };

  child.on("error", (cause) => {
    messages.fail(
      new Error(`claude-lhc sidecar failed to start (${sidecarPath}): ${cause.message}`),
    );
    failAll(cause);
  });
  child.on("exit", (code, signal) => {
    stdinOpen = false;
    if (closed || code === 0) messages.end();
    else
      messages.fail(
        new Error(`claude-lhc sidecar exited (code ${code ?? "null"}, signal ${signal ?? "none"})`),
      );
    failAll(new Error("claude-lhc sidecar exited"));
  });
  child.stdin?.on("error", (cause) => {
    log(`stdin: ${cause.message}`);
  });
  if (child.stderr !== null) {
    NodeReadline.createInterface({ input: child.stderr }).on("line", (line) => log(line));
  }

  const answerRequest = async (frame: Extract<SidecarFrame, { type: "req" }>): Promise<void> => {
    const controller = new AbortController();
    inflightRequests.set(frame.id, controller);
    try {
      let value: unknown;
      if (frame.method === "canUseTool") {
        const { toolName, input: toolInput, ...rest } = frame.params;
        if (input.options.canUseTool === undefined) throw new Error("canUseTool is not configured");
        value = await input.options.canUseTool(
          String(toolName),
          (toolInput ?? {}) as Record<string, unknown>,
          { ...rest, signal: controller.signal } as Parameters<
            NonNullable<ClaudeQueryOptions["canUseTool"]>
          >[2],
        );
      } else {
        if (input.options.onUserDialog === undefined)
          throw new Error("onUserDialog is not configured");
        // SDK >= 0.3.260 hands `onUserDialog` a `requestId`; the sidecar's
        // frame id is the per-request identity on this side of the pipe, and
        // any `requestId` the sidecar forwards from the SDK overrides it.
        const { request, ...dialogOptions } = frame.params;
        value = await input.options.onUserDialog(
          request as Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[0],
          {
            requestId: String(frame.id),
            ...dialogOptions,
            signal: controller.signal,
          } as Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[1],
        );
      }
      if (!controller.signal.aborted) send({ type: "res", id: frame.id, ok: true, value });
    } catch (cause) {
      if (!controller.signal.aborted) {
        send({
          type: "res",
          id: frame.id,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    } finally {
      inflightRequests.delete(frame.id);
    }
  };

  if (child.stdout !== null) {
    NodeReadline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
      "line",
      (line) => {
        if (line.trim() === "") return;
        let frame: SidecarFrame;
        try {
          frame = JSON.parse(line) as SidecarFrame;
        } catch (cause) {
          log(`unreadable frame: ${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        switch (frame.type) {
          case "msg":
            messages.push(frame.message);
            return;
          case "req":
            void answerRequest(frame);
            return;
          case "res": {
            const waiter = pendingControls.get(frame.id);
            if (waiter === undefined) return;
            pendingControls.delete(frame.id);
            if (frame.ok) waiter.resolve(frame.value);
            else waiter.reject(new Error(frame.error));
            return;
          }
          case "abort":
            inflightRequests.get(frame.id)?.abort();
            return;
          case "error":
            messages.fail(new Error(frame.message));
            return;
        }
      },
    );
  }

  const control = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || !stdinOpen) {
        reject(new Error("claude-lhc sidecar is closed"));
        return;
      }
      const id = ++nextControlId;
      pendingControls.set(id, { resolve, reject });
      send({ type: "req", id, method, params });
    });

  send({ type: "start", options: toWireOptions(input.options) });

  void (async () => {
    try {
      for await (const message of input.prompt) {
        if (closed) break;
        send({ type: "user", message });
      }
    } catch (cause) {
      log(`prompt stream failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      endStdin();
    }
  })();

  const close = (): void => {
    if (closed) return;
    closed = true;
    endStdin();
    const term = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }, CLOSE_GRACE_MS);
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CLOSE_GRACE_MS + KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    messages.end();
  };

  return {
    [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
    setModel: async (model?: string) => {
      await control("setModel", { model });
    },
    setPermissionMode: async (mode: PermissionMode) => {
      await control("setPermissionMode", { mode });
    },
    setMaxThinkingTokens: async (maxThinkingTokens: number | null) => {
      await control("setMaxThinkingTokens", { maxThinkingTokens });
    },
    close,
  };
}
