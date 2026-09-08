// @effect-diagnostics nodeBuiltinImport:off - test support: writes an LHC-shaped fixture database for import tests.
/**
 * Test support for the LHC import: a small cc-lhc-shaped thread and a writer
 * that materializes it as the SQLite subset `lhcThreadSource.ts` reads
 * (thread_metadata, event, turns, message, message_block). Not used by the
 * server at runtime.
 */
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";

import type { LhcSourceMessage, LhcSourceThread, LhcSourceTurn } from "./lhcThreadSource.ts";

export const FIXTURE_SOURCE_THREAD_ID = "th_7d75762e6e311944";

const T0 = 1_757_000_000_000; // 2025-09-04T15:33:20.000Z

const at = (offsetMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(T0 + offsetMillis));

function message(
  order: number,
  turnId: string,
  kind: string,
  offsetMillis: number,
  blocks: LhcSourceMessage["blocks"],
): LhcSourceMessage {
  return {
    messageId: `m${order}`,
    kind,
    turnId,
    sourceEventOrder: order,
    recordedAt: at(offsetMillis),
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
 *  t1 prompted: prompt, thinking, Bash call/result, assistant text
 *  t2 prompt-less segment (mid-turn compaction split): compaction note, Read
 *     call/result (error), assistant text, plain runtime note — folds into t1
 *  t3 prompted with a pasted image, one Bash call with no result, turn still open
 * Two events share a millisecond (m4/m5) to exercise the monotonic clock.
 */
export function makeFixtureThread(): LhcSourceThread {
  const turns: ReadonlyArray<LhcSourceTurn> = [
    { turnId: "t1", turnOrder: 1, status: "closed", outcome: null, outcomeReason: null },
    {
      turnId: "t2",
      turnOrder: 2,
      status: "closed",
      outcome: "completed",
      outcomeReason: "cc_lhc_segment",
    },
    { turnId: "t3", turnOrder: 3, status: "open", outcome: null, outcomeReason: null },
  ];
  const messages: ReadonlyArray<LhcSourceMessage> = [
    message(1, "t1", "user_prompt", 0, [
      { blockType: "text", content: { text: "List the repo root." } },
    ]),
    message(2, "t1", "assistant_thinking", 1_000, [
      { blockType: "text", content: { text: "I should run ls.", signature: "sig" } },
    ]),
    message(3, "t1", "tool_call", 1_500, [
      {
        blockType: "tool_call",
        content: {
          toolCallId: "toolu_01",
          toolName: "Bash",
          arguments: { command: "ls -1", description: "List root" },
        },
      },
    ]),
    message(4, "t1", "tool_result", 2_000, [
      {
        blockType: "tool_result",
        content: { toolCallId: "toolu_01", content: "README.md\npackage.json", isError: false },
      },
    ]),
    message(5, "t1", "assistant_text", 2_000, [
      { blockType: "text", content: { text: "Two files at the root.", model: "claude-fable-5-1" } },
    ]),
    message(6, "t2", "runtime_note", 3_000, [
      {
        blockType: "text",
        content: {
          text: "[lhc compact:auto] trigger context 150k; rebuilt LHC view 42k (70k target).",
        },
      },
    ]),
    message(7, "t2", "tool_call", 3_500, [
      {
        blockType: "tool_call",
        content: {
          toolCallId: "toolu_02",
          toolName: "Read",
          arguments: { file_path: "/repo/missing.txt" },
        },
      },
    ]),
    message(8, "t2", "tool_result", 4_000, [
      {
        blockType: "tool_result",
        content: { toolCallId: "toolu_02", content: "File does not exist.", isError: true },
      },
    ]),
    message(9, "t2", "assistant_text", 4_500, [
      { blockType: "text", content: { text: "The file is missing; stopping here." } },
    ]),
    message(10, "t2", "runtime_note", 5_000, [
      { blockType: "text", content: { text: "Task notification: background job finished." } },
    ]),
    message(11, "t3", "user_prompt", 6_000, [
      {
        blockType: "text",
        content: { text: "What is in this screenshot?\n[image · image/png · 4.0 KB]" },
      },
      { blockType: "image", content: IMAGE_BLOCK },
    ]),
    message(12, "t3", "tool_call", 6_500, [
      {
        blockType: "tool_call",
        content: { toolCallId: "toolu_03", toolName: "Bash", arguments: { command: "sleep 60" } },
      },
    ]),
  ];
  return { threadId: FIXTURE_SOURCE_THREAD_ID, turns, messages };
}

/** Write the fixture as an LHC-shaped SQLite file (the subset the importer reads). */
export function writeLhcSourceDatabase(path: string, thread: LhcSourceThread): void {
  const db = new NodeSqlite.DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE thread_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), thread_id TEXT NOT NULL, created_at TEXT NOT NULL, token_estimator TEXT NOT NULL, parts_activated_at TEXT);
      CREATE TABLE event (event_order INTEGER PRIMARY KEY, event_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, harness TEXT NOT NULL, payload TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY, turn_order INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, opened_at_event_order INTEGER NOT NULL, closed_at_event_order INTEGER, outcome TEXT, outcome_reason TEXT, started_at TEXT, ended_at TEXT, deleted_at TEXT);
      CREATE TABLE message (message_id TEXT PRIMARY KEY, source_event_order INTEGER NOT NULL UNIQUE REFERENCES event(event_order), kind TEXT NOT NULL, token_estimate INTEGER NOT NULL, actor TEXT NOT NULL, harness TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(turn_id), provider_usage TEXT, step_index INTEGER, deleted_at TEXT);
      CREATE TABLE message_block (message_id TEXT NOT NULL REFERENCES message(message_id), block_index INTEGER NOT NULL, block_type TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (message_id, block_index));
    `);
    db.prepare(
      "INSERT INTO thread_metadata (id, thread_id, created_at, token_estimator) VALUES (1, ?, ?, 'fixture')",
    ).run(thread.threadId, at(0));
    const insertTurn = db.prepare(
      "INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order, closed_at_event_order, outcome, outcome_reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const turn of thread.turns) {
      const orders = thread.messages
        .filter((entry) => entry.turnId === turn.turnId)
        .map((entry) => entry.sourceEventOrder);
      insertTurn.run(
        turn.turnId,
        turn.turnOrder,
        turn.status,
        Math.min(...orders, Number.MAX_SAFE_INTEGER),
        turn.status === "closed" ? Math.max(...orders, 0) : null,
        turn.outcome,
        turn.outcomeReason,
      );
    }
    const insertEvent = db.prepare(
      "INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertMessage = db.prepare(
      "INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertBlock = db.prepare(
      "INSERT INTO message_block (message_id, block_index, block_type, content) VALUES (?, ?, ?, ?)",
    );
    for (const entry of thread.messages) {
      const actor =
        entry.kind === "user_prompt"
          ? "user"
          : entry.kind === "tool_result"
            ? "tool"
            : entry.kind === "runtime_note"
              ? "system"
              : "assistant";
      insertEvent.run(
        entry.sourceEventOrder,
        entry.kind,
        `fixture:${entry.sourceEventOrder}`,
        actor,
        "cc",
        JSON.stringify(entry.blocks[0]?.content ?? {}),
        entry.recordedAt,
      );
      insertMessage.run(
        entry.messageId,
        entry.sourceEventOrder,
        entry.kind,
        1,
        actor,
        "cc",
        entry.turnId,
      );
      for (const [index, block] of entry.blocks.entries()) {
        insertBlock.run(entry.messageId, index, block.blockType, JSON.stringify(block.content));
      }
    }
  } finally {
    db.close();
  }
}
