import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  type ThreadLhcHistoryImportCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { makeFixtureHistory, FIXTURE_SOURCE_THREAD_ID } from "./lhcHistoryFixture.ts";
import { planLhcHistory } from "./lhcHistoryImport.ts";
import { deriveImportedThreadId } from "./lhcImportIds.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-09T12:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = deriveImportedThreadId(FIXTURE_SOURCE_THREAD_ID);

const readModelWithProject = Effect.gen(function* () {
  return yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
});

const makeCommand = (
  overrides: Partial<ThreadLhcHistoryImportCommand> = {},
): ThreadLhcHistoryImportCommand => ({
  type: "thread.lhc-history.import",
  commandId: CommandId.make("command-lhc-import"),
  threadId,
  sourceThreadId: FIXTURE_SOURCE_THREAD_ID,
  projectId,
  title: "Wren (imported)",
  modelSelection: { instanceId: ProviderInstanceId.make("claude-lhc"), model: "claude-fable-5-1" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  providerName: "claudeAgent",
  history: makeFixtureHistory(),
  createdAt,
  ...overrides,
});

// Planned events lack `sequence`; nothing below reads it, and the full event
// type keeps the `type` discriminant narrowable.
const asEvents = (decided: unknown): ReadonlyArray<OrchestrationEvent> =>
  (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<OrchestrationEvent>;

it.layer(NodeServices.layer)("thread.lhc-history.import", (it) => {
  it.effect("emits the created event and the planned history in one decision, all flagged", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithProject;
      const command = makeCommand();
      const events = asEvents(yield* decideOrchestrationCommand({ command, readModel }));
      const plan = planLhcHistory({
        history: command.history,
        sourceThreadId: command.sourceThreadId,
        threadId,
        providerName: command.providerName,
        providerInstanceId: command.modelSelection.instanceId,
        runtimeMode: command.runtimeMode,
      });

      assert.lengthOf(events, plan.events.length + 1);
      assert.strictEqual(events[0]?.type, "thread.created");
      assert.strictEqual(events[0]?.occurredAt, createdAt);
      assert.deepStrictEqual(
        events.slice(1).map((event) => [event.type, event.occurredAt]),
        plan.events.map((event) => [event.type, event.occurredAt]),
      );
      for (const event of events) {
        assert.deepStrictEqual(event.metadata, { historyImport: true });
        assert.strictEqual(event.commandId, command.commandId);
        assert.strictEqual(event.aggregateId, threadId);
      }
      // Never a turn start: three reactors act on it live.
      assert.deepStrictEqual([...new Set(events.map((event) => event.type))].sort(), [
        "thread.activity-appended",
        "thread.created",
        "thread.message-sent",
        "thread.session-set",
      ]);
      const userMessages = events.filter(
        (event) => event.type === "thread.message-sent" && event.payload.role === "user",
      );
      assert.lengthOf(userMessages, 2);
      for (const event of userMessages) {
        if (event.type === "thread.message-sent") {
          assert.isNotNull(event.payload.turnId);
          assert.isFalse(event.payload.streaming);
        }
      }

      // The projector accepts the whole sequence: the thread ends stopped with
      // both turns settled and four messages.
      let next = readModel;
      let sequence = 1;
      for (const event of events) {
        sequence += 1;
        next = yield* projectEvent(next, { ...event, sequence });
      }
      const thread = next.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.strictEqual(thread?.messages.length, 4);
      assert.strictEqual(thread?.session?.status, "stopped");
      assert.strictEqual(thread?.latestTurn?.state, "interrupted");
      assert.strictEqual(thread?.activities.length, 5);
    }),
  );

  it.effect("imports an empty history as a flagged shell", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithProject;
      const events = asEvents(
        yield* decideOrchestrationCommand({
          command: makeCommand({ history: { ...makeFixtureHistory(), turns: [] } }),
          readModel,
        }),
      );
      assert.deepStrictEqual(
        events.map((event) => [event.type, event.metadata]),
        [["thread.created", { historyImport: true }]],
      );
    }),
  );

  it.effect("refuses a missing project, a deleted project, and an existing thread", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithProject;

      const missingProject = yield* decideOrchestrationCommand({
        command: makeCommand({ projectId: ProjectId.make("project-gone") }),
        readModel,
      }).pipe(Effect.flip);
      assert.include(String(missingProject), "does not exist");

      const events = asEvents(
        yield* decideOrchestrationCommand({ command: makeCommand(), readModel }),
      );
      const withThread = yield* projectEvent(readModel, { ...events[0]!, sequence: 2 });
      const existing = yield* decideOrchestrationCommand({
        command: makeCommand({ commandId: CommandId.make("command-lhc-import-again") }),
        readModel: withThread,
      }).pipe(Effect.flip);
      assert.include(String(existing), "already exists");

      const deletedAt = "2026-09-09T12:30:00.000Z";
      const withDeletedProject = yield* projectEvent(readModel, {
        sequence: 2,
        eventId: EventId.make("event-project-deleted"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.deleted",
        occurredAt: deletedAt,
        commandId: CommandId.make("command-project-deleted"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-deleted"),
        metadata: {},
        payload: { projectId, deletedAt },
      });
      const deleted = yield* decideOrchestrationCommand({
        command: makeCommand(),
        readModel: withDeletedProject,
      }).pipe(Effect.flip);
      assert.include(String(deleted), "is deleted");
    }),
  );
});
