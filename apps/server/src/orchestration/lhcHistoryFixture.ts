// @effect-diagnostics nodeBuiltinImport:off - test support: writes an LHC export fixture for import tests.
/**
 * Test support for the LHC import: a small cc-lhc-shaped thread in the neutral
 * export form `lhc thread export` produces (turns → messages → blocks), and a
 * writer that saves it as the JSON file `t3 thread import --history` reads.
 * Not used by the server at runtime.
 */
import * as NodeFS from "node:fs";

import type { LhcHistoryExport, LhcHistoryMessage, LhcHistoryTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const FIXTURE_SOURCE_THREAD_ID = "th_7d75762e6e311944";

const T0 = 1_757_000_000_000; // 2025-09-04T15:33:20.000Z

const at = (offsetMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(T0 + offsetMillis));

function message(
  order: number,
  kind: string,
  offsetMillis: number,
  blocks: LhcHistoryMessage["blocks"],
): LhcHistoryMessage {
  const actor =
    kind === "user_prompt"
      ? "user"
      : kind === "tool_result"
        ? "tool"
        : kind === "runtime_note"
          ? "system"
          : "assistant";
  return {
    messageId: `m${order}`,
    kind,
    eventOrder: order,
    recordedAt: at(offsetMillis),
    actor,
    harness: "cc",
    blocks,
  };
}

const IMAGE_BLOCK = {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: {
      $blob: "sha256:5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
      bytes: 4096,
    },
  },
};

/**
 * Three source turns:
 *  t1 prompted: prompt, Bash call/result, assistant text (thinking omitted by the exporter)
 *  t2 prompt-less segment (mid-turn compaction split): compaction note, Read
 *     call/result (error), assistant text, plain runtime note — folds into t1
 *  t3 prompted with a pasted image, one Bash call with no result, turn still open
 * Two events share a millisecond (m4/m5) to exercise the monotonic clock.
 */
export function makeFixtureHistory(): LhcHistoryExport {
  const turns: ReadonlyArray<LhcHistoryTurn> = [
    {
      turnId: "t1",
      order: 1,
      status: "closed",
      outcome: null,
      outcomeReason: null,
      messages: [
        message(1, "user_prompt", 0, [
          { blockType: "text", content: { text: "List the repo root." } },
        ]),
        message(3, "tool_call", 1_500, [
          {
            blockType: "tool_call",
            content: {
              toolCallId: "toolu_01",
              toolName: "Bash",
              arguments: { command: "ls -1", description: "List root" },
            },
          },
        ]),
        message(4, "tool_result", 2_000, [
          {
            blockType: "tool_result",
            content: { toolCallId: "toolu_01", content: "README.md\npackage.json", isError: false },
          },
        ]),
        message(5, "assistant_text", 2_000, [
          {
            blockType: "text",
            content: { text: "Two files at the root.", model: "claude-fable-5-1" },
          },
        ]),
      ],
    },
    {
      turnId: "t2",
      order: 2,
      status: "closed",
      outcome: "completed",
      outcomeReason: "cc_lhc_segment",
      messages: [
        message(6, "runtime_note", 3_000, [
          {
            blockType: "text",
            content: {
              text: "[lhc compact:auto] trigger context 150k; rebuilt LHC view 42k (70k target).",
            },
          },
        ]),
        message(7, "tool_call", 3_500, [
          {
            blockType: "tool_call",
            content: {
              toolCallId: "toolu_02",
              toolName: "Read",
              arguments: { file_path: "/repo/missing.txt" },
            },
          },
        ]),
        message(8, "tool_result", 4_000, [
          {
            blockType: "tool_result",
            content: { toolCallId: "toolu_02", content: "File does not exist.", isError: true },
          },
        ]),
        message(9, "assistant_text", 4_500, [
          { blockType: "text", content: { text: "The file is missing; stopping here." } },
        ]),
        message(10, "runtime_note", 5_000, [
          { blockType: "text", content: { text: "Task notification: background job finished." } },
        ]),
      ],
    },
    {
      turnId: "t3",
      order: 3,
      status: "open",
      outcome: null,
      outcomeReason: null,
      messages: [
        message(11, "user_prompt", 6_000, [
          {
            blockType: "text",
            content: { text: "What is in this screenshot?\n[image · image/png · 4.0 KB]" },
          },
          { blockType: "image", content: IMAGE_BLOCK },
        ]),
        message(12, "tool_call", 6_500, [
          {
            blockType: "tool_call",
            content: {
              toolCallId: "toolu_03",
              toolName: "Bash",
              arguments: { command: "sleep 60" },
            },
          },
        ]),
      ],
    },
  ];
  return {
    threadId: FIXTURE_SOURCE_THREAD_ID,
    exportedAt: at(10_000),
    turns,
    omitted: { assistant_thinking: 1 },
  };
}

/** Save the fixture as the JSON file the CLI reads. */
export function writeLhcHistoryExport(path: string, history: LhcHistoryExport): void {
  NodeFS.writeFileSync(path, JSON.stringify(history));
}
