import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type OrchestrationCommand } from "@t3tools/contracts";

import { planLhcHistory } from "./lhcHistory.ts";
import { deriveImportedThreadId, deriveImportedTurnId } from "./lhcImportIds.ts";
import { FIXTURE_SOURCE_THREAD_ID, makeFixtureThread } from "./lhcSourceFixture.ts";
import type { LhcSourceThread } from "./lhcThreadSource.ts";

const threadId = deriveImportedThreadId(FIXTURE_SOURCE_THREAD_ID);

const plan = (source: LhcSourceThread = makeFixtureThread()) =>
  planLhcHistory({
    source,
    sourceThreadId: FIXTURE_SOURCE_THREAD_ID,
    threadId,
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claude-lhc"),
    runtimeMode: "full-access",
  });

const commandLabel = (command: OrchestrationCommand): string => {
  switch (command.type) {
    case "thread.session.set":
      return `session:${command.session.status}`;
    case "thread.activity.append":
      return `activity:${command.activity.kind}`;
    case "thread.message.assistant.delta":
      return "assistant.delta";
    case "thread.message.assistant.complete":
      return "assistant.complete";
    default:
      return command.type;
  }
};

const activities = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity] : [],
  );

const asRecord = (value: unknown) => value as Record<string, unknown>;

describe("planLhcHistory", () => {
  it("folds prompt-less segment turns and orders each prompted turn as the live path does", () => {
    const { commands, report } = plan();
    assert.deepStrictEqual(commands.map(commandLabel), [
      // t1 (with t2 folded in)
      "thread.turn.start",
      "session:running",
      "activity:tool.completed",
      "assistant.delta",
      "assistant.complete",
      "activity:context-compaction",
      "activity:tool.completed",
      "assistant.delta",
      "assistant.complete",
      "activity:runtime.note",
      "session:ready",
      // t3, still open in the source
      "thread.turn.start",
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

    const firstTurnId = deriveImportedTurnId(FIXTURE_SOURCE_THREAD_ID, "m1");
    const secondTurnId = deriveImportedTurnId(FIXTURE_SOURCE_THREAD_ID, "m11");
    const running = commands.filter(
      (command) => command.type === "thread.session.set" && command.session.status === "running",
    );
    assert.deepStrictEqual(
      running.map((command) =>
        command.type === "thread.session.set" ? command.session.activeTurnId : null,
      ),
      [firstTurnId, secondTurnId],
    );
    // Everything from source turn t2 carries the first t3code turn id.
    const foldedTurnIds = activities(commands)
      .slice(0, 4)
      .map((activity) => activity.turnId);
    assert.deepStrictEqual(foldedTurnIds, [firstTurnId, firstTurnId, firstTurnId, firstTurnId]);
    const settledSessions = commands.filter((command) => command.type === "thread.session.set");
    for (const command of settledSessions) {
      if (command.type === "thread.session.set" && command.session.status !== "running") {
        assert.isNull(command.session.activeTurnId);
        assert.isNull(command.session.lastError);
      }
    }
  });

  it("maps tool calls to one completed activity each with the adapter's classification", () => {
    const { commands, report } = plan();
    const tools = activities(commands).filter((activity) => activity.kind === "tool.completed");
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
    const { commands } = plan();
    const notes = activities(commands).filter((activity) => activity.tone === "info");
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
    const { commands, report } = plan();
    const secondPrompt = commands.find(
      (command) =>
        command.type === "thread.turn.start" && command.message.text.includes("screenshot"),
    );
    assert.isDefined(secondPrompt);
    if (secondPrompt?.type === "thread.turn.start") {
      assert.strictEqual(
        secondPrompt.message.text,
        "What is in this screenshot?\n[image · image/png · 4.0 KB]",
      );
    }
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
    const { commands } = plan();
    const stamps = commands.map((command) => ("createdAt" in command ? command.createdAt : ""));
    for (let index = 1; index < stamps.length; index += 1) {
      assert.isTrue(
        stamps[index]! > stamps[index - 1]!,
        `createdAt must increase at command ${index}: ${stamps[index - 1]} → ${stamps[index]}`,
      );
    }
    assert.strictEqual(stamps[0], "2025-09-04T15:33:20.000Z");
    // m4 and m5 share 2000ms in the source: the assistant delta lands one ms after the tool activity.
    const sequences = activities(commands).map((activity) => activity.sequence);
    assert.deepStrictEqual(sequences, [1, 2, 3, 4, 5]);
    const sessionUpdates = commands.flatMap((command) =>
      command.type === "thread.session.set"
        ? [command.session.updatedAt === command.createdAt]
        : [],
    );
    assert.isTrue(sessionUpdates.every(Boolean));
  });

  it("closes legacy null outcomes as completed and aborted or open turns as interrupted", () => {
    const base = makeFixtureThread();
    const closedTail: LhcSourceThread = {
      ...base,
      turns: base.turns.map((turn) =>
        turn.turnId === "t3" ? { ...turn, status: "closed", outcome: null } : turn,
      ),
    };
    const closed = plan(closedTail);
    assert.isFalse(closed.report.interruptedTail);
    assert.deepStrictEqual(closed.commands.map(commandLabel).slice(-3), [
      "activity:tool.completed",
      "session:ready",
      "session:stopped",
    ]);
    const abortedTail: LhcSourceThread = {
      ...base,
      turns: base.turns.map((turn) =>
        turn.turnId === "t3" ? { ...turn, status: "closed", outcome: "aborted" } : turn,
      ),
    };
    assert.isTrue(plan(abortedTail).report.interruptedTail);
  });

  it("is deterministic and drops nothing silently", () => {
    const first = plan();
    const second = plan();
    assert.deepStrictEqual(first.commands, second.commands);
    const orphan: LhcSourceThread = {
      ...makeFixtureThread(),
      messages: [
        ...makeFixtureThread().messages,
        {
          messageId: "m13",
          kind: "tool_result",
          turnId: "t3",
          sourceEventOrder: 13,
          recordedAt: "2025-09-04T15:33:27.000Z",
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
          turnId: "t3",
          sourceEventOrder: 14,
          recordedAt: "2025-09-04T15:33:28.000Z",
          blocks: [],
        },
      ],
    };
    const { report } = plan(orphan);
    assert.deepStrictEqual(report.orphanToolResults, [
      { sourceMessageId: "m13", toolCallId: "toolu_99" },
    ]);
    assert.deepStrictEqual(report.skipped, [
      { sourceMessageId: "m14", kind: "mystery", reason: "unknown message kind" },
    ]);
    assert.deepStrictEqual(plan({ ...makeFixtureThread(), messages: [] }).commands, []);
  });
});
