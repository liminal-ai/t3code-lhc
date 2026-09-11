import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createEmptyReadModel } from "./projector.ts";
import { rejectForbiddenRuntimeMode } from "./runtimeModePolicy.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const restricted = { allowedRuntimeModes: ["approval-required"] as const };

const empty = createEmptyReadModel(now);
const storedApprovalRequired = {
  ...empty,
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      latestTurn: null,
      latestUserMessageAt: null,
      deletedAt: null,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      snoozedUntil: null,
      titleRegeneration: null,
      session: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    },
  ],
};

describe("rejectForbiddenRuntimeMode", () => {
  it("permits every mode when no policy is supplied", () => {
    expect(
      rejectForbiddenRuntimeMode(
        {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-1"),
          threadId,
          runtimeMode: "full-access",
          createdAt: now,
        },
        empty,
        undefined,
      ),
    ).toBeUndefined();
  });

  it("does not gate history import", () => {
    expect(
      rejectForbiddenRuntimeMode(
        {
          type: "thread.lhc-history.import",
          commandId: CommandId.make("cmd-import"),
          threadId,
          sourceThreadId: "source-thread",
          projectId: ProjectId.make("project-1"),
          title: "Imported",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          providerName: "claudeAgent",
          history: { version: 1, turns: [] },
          createdAt: now,
        } as never,
        empty,
        restricted,
      ),
    ).toBeUndefined();
  });

  it("rejects an explicit forbidden create/set and an inherited stored start mode", () => {
    expect(
      rejectForbiddenRuntimeMode(
        {
          type: "thread.create",
          commandId: CommandId.make("cmd-create"),
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        empty,
        restricted,
      ),
    ).toMatch(/full-access/);

    const storedFullAccess = {
      ...storedApprovalRequired,
      threads: storedApprovalRequired.threads.map((thread) => ({
        ...thread,
        runtimeMode: "full-access" as const,
      })),
    };
    expect(
      rejectForbiddenRuntimeMode(
        {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn"),
          threadId,
          createdAt: now,
          runtimeMode: "full-access",
          interactionMode: "default",
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "hi",
            attachments: [],
          },
        },
        storedFullAccess,
        restricted,
      ),
    ).toMatch(/full-access/);
  });

  it("does not reject a start whose stored mode is allowed even if the command defaulted to full-access", () => {
    expect(
      rejectForbiddenRuntimeMode(
        {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-allowed"),
          threadId,
          createdAt: now,
          runtimeMode: "full-access",
          interactionMode: "default",
          message: {
            messageId: MessageId.make("message-2"),
            role: "user",
            text: "hi",
            attachments: [],
          },
        },
        storedApprovalRequired,
        restricted,
      ),
    ).toBeUndefined();
  });

  it("uses stored mode for turn.start even when bootstrap.createThread is present", () => {
    const bootstrapStart = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-bootstrap"),
      threadId,
      createdAt: now,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
      },
      message: {
        messageId: MessageId.make("message-bootstrap"),
        role: "user" as const,
        text: "hi",
        attachments: [],
      },
    };
    expect(
      rejectForbiddenRuntimeMode(bootstrapStart, storedApprovalRequired, restricted),
    ).toBeUndefined();
    const storedFullAccess = {
      ...storedApprovalRequired,
      threads: storedApprovalRequired.threads.map((thread) => ({
        ...thread,
        runtimeMode: "full-access" as const,
      })),
    };
    expect(rejectForbiddenRuntimeMode(bootstrapStart, storedFullAccess, restricted)).toMatch(
      /full-access/,
    );
  });
});
