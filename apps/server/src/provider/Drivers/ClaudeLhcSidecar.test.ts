// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeClaudeLhcCreateQuery, resolveClaudeLhcSidecarPath } from "./ClaudeLhcSidecar.ts";

// A fake sidecar: echoes each user prompt back as an assistant message, asks for
// tool approval on the first prompt, answers setModel, and reports control
// activity through result messages. Node so the test does not need bun.
const FAKE_SIDECAR = `
const readline = require("node:readline");
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let model = "unset";
let reqId = 0;
const pending = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "start") {
    write({ type: "msg", message: { type: "system", subtype: "init", session_id: frame.options.sessionId, model: frame.options.model, has_callbacks: typeof frame.options.canUseTool, env_marker: frame.options.env && frame.options.env.SIDECAR_TEST_MARKER } });
  } else if (frame.type === "user") {
    const text = frame.message.message.content[0].text;
    const id = ++reqId;
    pending.set(id, text);
    write({ type: "req", id, method: "canUseTool", params: { toolName: "Read", input: { file_path: text }, toolUseID: "toolu_" + id } });
  } else if (frame.type === "res") {
    const text = pending.get(frame.id);
    write({ type: "msg", message: { type: "assistant", session_id: "s", approval: frame.ok ? frame.value : { error: frame.error }, echo: text, model } });
  } else if (frame.type === "req") {
    if (frame.method === "setModel") model = frame.params.model;
    write({ type: "res", id: frame.id, ok: true, value: null });
  }
}).on("close", () => process.exit(0));
`;

function makeFakeSidecar(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-lhc-fake-"));
  const script = NodePath.join(dir, "sidecar.cjs");
  NodeFS.writeFileSync(script, FAKE_SIDECAR);
  const launcher = NodePath.join(dir, "claude-lhc");
  NodeFS.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, {
    mode: 0o755,
  });
  return launcher;
}

describe("ClaudeLhcSidecar", () => {
  it("resolves the launcher from CLAUDE_LHC_SIDECAR, else the bare command", () => {
    expect(resolveClaudeLhcSidecarPath({ CLAUDE_LHC_SIDECAR: " /x/claude-lhc " })).toBe(
      "/x/claude-lhc",
    );
    expect(resolveClaudeLhcSidecarPath({})).toBe("claude-lhc");
  });

  it("bridges prompts, messages, approvals and controls over stdio and ends the stream on close", async () => {
    const launcher = makeFakeSidecar();
    const createQuery = makeClaudeLhcCreateQuery({
      environment: { ...process.env, CLAUDE_LHC_SIDECAR: launcher },
    });
    let releasePrompt: (() => void) | undefined;
    const prompts = (async function* () {
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "one" }] },
        parent_tool_use_id: null,
        session_id: "",
      } as never;
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    })();
    const approvals: Array<{ toolName: string; toolUseID: string | undefined }> = [];
    const runtime = createQuery({
      prompt: prompts,
      options: {
        sessionId: "sess-1",
        model: "claude-sonnet-5",
        env: { ...process.env, SIDECAR_TEST_MARKER: "present" },
        canUseTool: async (toolName, input, options) => {
          approvals.push({ toolName, toolUseID: options.toolUseID });
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    const iterator = runtime[Symbol.asyncIterator]();
    const init = (await iterator.next()).value as Record<string, unknown>;
    expect(init).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-sonnet-5",
      env_marker: "present",
    });
    expect(init.has_callbacks).toBe("undefined");

    const echoed = (await iterator.next()).value as Record<string, unknown>;
    expect(echoed).toMatchObject({
      type: "assistant",
      echo: "one",
      approval: { behavior: "allow", updatedInput: { file_path: "one" } },
    });
    expect(approvals).toEqual([{ toolName: "Read", toolUseID: "toolu_1" }]);

    await runtime.setModel("claude-opus-5");
    runtime.close();
    releasePrompt?.();
    const done = await iterator.next();
    expect(done.done).toBe(true);
  });
});
