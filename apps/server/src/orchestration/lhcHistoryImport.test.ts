import { assert, describe, it } from "@effect/vitest";
import { type LhcHistoryExport, ProviderInstanceId } from "@t3tools/contracts";

import { makeFixtureHistory, FIXTURE_SOURCE_THREAD_ID } from "./lhcHistoryFixture.ts";
import { type LhcHistoryPlannedEvent, planLhcHistory } from "./lhcHistoryImport.ts";
import { deriveImportedThreadId, deriveImportedTurnId } from "./lhcImportIds.ts";

const threadId = deriveImportedThreadId(FIXTURE_SOURCE_THREAD_ID);

const plan = (history: LhcHistoryExport = makeFixtureHistory()) =>
  planLhcHistory({
    history,
    sourceThreadId: FIXTURE_SOURCE_THREAD_ID,
    threadId,
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claude-lhc"),
    runtimeMode: "full-access",
  });

const label = (event: LhcHistoryPlannedEvent): string => {
  switch (event.type) {
    case "thread.session-set":
      return `session:${event.payload.session.status}`;
    case "thread.activity-appended":
      return `activity:${event.payload.activity.kind}`;
    case "thread.message-sent":
      return event.payload.role;
  }
};

const activities = (events: ReadonlyArray<LhcHistoryPlannedEvent>) =>
  events.flatMap((event) =>
    event.type === "thread.activity-appended" ? [event.payload.activity] : [],
  );

const messages = (events: ReadonlyArray<LhcHistoryPlannedEvent>) =>
  events.flatMap((event) => (event.type === "thread.message-sent" ? [event.payload] : []));

const asRecord = (value: unknown) => value as Record<string, unknown>;

describe("planLhcHistory", () => {
  it("folds prompt-less segment turns and orders each prompted turn as the live path does", () => {
    const { events, report } = plan();
    assert.deepStrictEqual(events.map(label), [
      // t1 (with t2 folded in)
      "user",
      "session:running",
      "activity:tool.completed",
      "assistant",
      "activity:context-compaction",
      "activity:tool.completed",
      "assistant",
      "activity:runtime.note",
      "session:ready",
      // t3, still open in the source
      "user",
      "session:running",
      "activity:tool.completed",
      "session:interrupted",
      "session:stopped",
    ]);
    assert.strictEqual(report.turnCount, 2);
    assert.strictEqual(report.userMessages, 2);
    assert.strictEqual(report.assistantMessages, 2);
    assert.strictEqual(report.toolActivities, 3);
    assert.strictEqual(report.noteActivities, 2);
    assert.isTrue(report.interruptedTail);
    assert.deepStrictEqual(report.skipped, []);
    assert.deepStrictEqual(report.orphanToolResults, []);
    assert.deepStrictEqual(report.omitted, { assistant_thinking: 1 });

    const firstTurnId = deriveImportedTurnId(FIXTURE_SOURCE_THREAD_ID, "m1");
    const secondTurnId = deriveImportedTurnId(FIXTURE_SOURCE_THREAD_ID, "m11");
    const running = events.filter(
      (event) => event.type === "thread.session-set" && event.payload.session.status === "running",
    );
    assert.deepStrictEqual(
      running.map((event) =>
        event.type === "thread.session-set" ? event.payload.session.activeTurnId : null,
      ),
      [firstTurnId, secondTurnId],
    );
    // Every message is bound to its folded turn, user prompts included: the
    // live path binds through a pending turn start, which this import never emits.
    assert.deepStrictEqual(
      messages(events).map((message) => [message.role, message.turnId, message.streaming]),
      [
        ["user", firstTurnId, false],
        ["assistant", firstTurnId, false],
        ["assistant", firstTurnId, false],
        ["user", secondTurnId, false],
      ],
    );
    // Everything from source turn t2 carries the first t3code turn id.
    const foldedTurnIds = activities(events)
      .slice(0, 4)
      .map((activity) => activity.turnId);
    assert.deepStrictEqual(foldedTurnIds, [firstTurnId, firstTurnId, firstTurnId, firstTurnId]);
    for (const event of events) {
      if (event.type === "thread.session-set" && event.payload.session.status !== "running") {
        assert.isNull(event.payload.session.activeTurnId);
        assert.isNull(event.payload.session.lastError);
      }
    }
  });

  it("never plans a turn start: three reactors act on it live", () => {
    const types = new Set(plan().events.map((event) => event.type));
    assert.deepStrictEqual([...types].sort(), [
      "thread.activity-appended",
      "thread.message-sent",
      "thread.session-set",
    ]);
  });

  it("maps tool calls to one completed activity each with the adapter's classification", () => {
    const { events, report } = plan();
    const tools = activities(events).filter((activity) => activity.kind === "tool.completed");
    assert.lengthOf(tools, 3);
    const [bash, read, dangling] = tools.map((activity) => asRecord(activity.payload));
    assert.deepStrictEqual(bash, {
      itemType: "command_execution",
      toolCallId: "toolu_01",
      status: "completed",
      title: "Command run",
      detail: "Bash: ls -1",
      data: {
        toolName: "Bash",
        input: { command: "ls -1", description: "List root" },
        result: {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "README.md\npackage.json",
          is_error: false,
        },
      },
    });
    assert.strictEqual(read?.status, "failed");
    assert.strictEqual(read?.itemType, "dynamic_tool_call"); // the adapter classifies Read this way today
    assert.strictEqual(asRecord(asRecord(read?.data).result).is_error, true);
    assert.deepStrictEqual(dangling, {
      itemType: "command_execution",
      toolCallId: "toolu_03",
      status: "failed",
      title: "Command run",
      detail: "No result recorded before the turn ended",
      data: { toolName: "Bash", input: { command: "sleep 60" } },
    });
    assert.deepStrictEqual(report.danglingToolCalls, [
      { sourceMessageId: "m12", toolCallId: "toolu_03", toolName: "Bash" },
    ]);
    assert.isTrue(tools.every((activity) => activity.tone === "tool"));
  });

  it("turns runtime notes into compaction or info activities", () => {
    const { events } = plan();
    const notes = activities(events).filter((activity) => activity.tone === "info");
    assert.lengthOf(notes, 2);
    const [compaction, note] = notes;
    assert.strictEqual(compaction?.kind, "context-compaction");
    assert.strictEqual(compaction?.summary, "Compacted context 150.0K → 42.0K tokens");
    assert.deepStrictEqual(compaction?.payload, {
      state: "compacted",
      beforeTokens: 150_000,
      afterTokens: 42_000,
      detail: "[lhc compact:auto] trigger context 150k; rebuilt LHC view 42k (70k target).",
    });
    assert.strictEqual(note?.kind, "runtime.note");
    assert.strictEqual(note?.summary, "Task notification: background job finished.");
  });

  it("keeps the text projection of unsupported blocks and reports them", () => {
    const { events, report } = plan();
    const secondPrompt = messages(events).find(
      (message) => message.role === "user" && message.text.includes("screenshot"),
    );
    assert.isDefined(secondPrompt);
    assert.strictEqual(
      secondPrompt?.text,
      "What is in this screenshot?\n[image · image/png · 4.0 KB]",
    );
    assert.deepStrictEqual(report.unsupportedBlocks, [
      {
        sourceMessageId: "m11",
        kind: "user_prompt",
        blockType: "image",
        description: "image · image/png · 4096 bytes",
      },
    ]);
  });

  it("feeds a strictly increasing clock from source timestamps and numbers activities monotonically", () => {
    const { events } = plan();
    const stamps = events.map((event) => event.occurredAt);
    for (let index = 1; index < stamps.length; index += 1) {
      assert.isTrue(
        stamps[index]! > stamps[index - 1]!,
        `occurredAt must increase at event ${index}: ${stamps[index - 1]} → ${stamps[index]}`,
      );
    }
    assert.strictEqual(stamps[0], "2025-09-04T15:33:20.000Z");
    // m4 and m5 share 2000ms in the source: the assistant text lands one ms after the tool activity.
    const sequences = activities(events).map((activity) => activity.sequence);
    assert.deepStrictEqual(sequences, [1, 2, 3, 4, 5]);
    for (const event of events) {
      const stamp =
        event.type === "thread.session-set"
          ? event.payload.session.updatedAt
          : event.type === "thread.activity-appended"
            ? event.payload.activity.createdAt
            : event.payload.createdAt;
      assert.strictEqual(stamp, event.occurredAt);
    }
  });

  it("closes legacy null outcomes as completed and aborted or open turns as interrupted", () => {
    const base = makeFixtureHistory();
    const closedTail: LhcHistoryExport = {
      ...base,
      turns: base.turns.map((turn) =>
        turn.turnId === "t3" ? { ...turn, status: "closed", outcome: null } : turn,
      ),
    };
    const closed = plan(closedTail);
    assert.isFalse(closed.report.interruptedTail);
    assert.deepStrictEqual(closed.events.map(label).slice(-3), [
      "activity:tool.completed",
      "session:ready",
      "session:stopped",
    ]);
    const abortedTail: LhcHistoryExport = {
      ...base,
      turns: base.turns.map((turn) =>
        turn.turnId === "t3" ? { ...turn, status: "closed", outcome: "aborted" } : turn,
      ),
    };
    assert.isTrue(plan(abortedTail).report.interruptedTail);
  });

  it("orders by turn order and event order, not array position", () => {
    const base = makeFixtureHistory();
    const shuffled: LhcHistoryExport = {
      ...base,
      turns: [...base.turns].reverse().map((turn) => ({
        ...turn,
        messages: [...turn.messages].reverse(),
      })),
    };
    assert.deepStrictEqual(plan(shuffled).events, plan(base).events);
  });

  it("is deterministic and drops nothing silently", () => {
    const first = plan();
    const second = plan();
    assert.deepStrictEqual(first.events, second.events);
    const base = makeFixtureHistory();
    const orphan: LhcHistoryExport = {
      ...base,
      turns: base.turns.map((turn) =>
        turn.turnId !== "t3"
          ? turn
          : {
              ...turn,
              messages: [
                ...turn.messages,
                {
                  messageId: "m13",
                  kind: "tool_result",
                  eventOrder: 13,
                  recordedAt: "2025-09-04T15:33:27.000Z",
                  actor: "tool",
                  harness: "cc",
                  blocks: [
                    {
                      blockType: "tool_result",
                      content: { toolCallId: "toolu_99", content: "late", isError: false },
                    },
                  ],
                },
                {
                  messageId: "m14",
                  kind: "mystery",
                  eventOrder: 14,
                  recordedAt: "2025-09-04T15:33:28.000Z",
                  actor: "assistant",
                  harness: "cc",
                  blocks: [],
                },
              ],
            },
      ),
    };
    const { report } = plan(orphan);
    assert.deepStrictEqual(report.orphanToolResults, [
      { sourceMessageId: "m13", toolCallId: "toolu_99" },
    ]);
    assert.deepStrictEqual(report.skipped, [
      { sourceMessageId: "m14", kind: "mystery", reason: "unknown message kind" },
    ]);
    assert.deepStrictEqual(plan({ ...base, turns: [] }).events, []);
  });
});
